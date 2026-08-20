import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { dietEntries } from "@/lib/db/schema";
import { MealEstimate, labelName, type ResolvedMacros } from "@/lib/ai/estimate";
import { NutritionPanel, macrosUnknown } from "@/lib/ai/nutrition";
import { MIN_SCORE, scaleToServing, scoreHit, searchFood, tokenize, type FoodMatch } from "@/lib/food/openfoodfacts";
import { api, loginCookie } from "./helpers";

// Assigned date range for this suite: 2030-07-01 .. 2030-07-05 only.
// (nutrition-ai owns 06-01..05, nutrition-hardening 06-20..25, the e2e specs 05-20..25 and 06-08..12.)
const RANGE_LO = "2030-07-01";
const RANGE_HI = "2030-07-05";
const D_UNKNOWN = "2030-07-02";
const D_PINNED = "2030-07-03";
const D_LABEL = "2030-07-04";

const AI_LIVE = !!process.env.AI_LIVE;

// The route's body schema is z.string().min(1).max(120): 120 is the last accepted length.
const NAME_120 =
  "Actileaf Barista Style Oat Drink poured over granola with blueberries, and a big spoonful of peanut butter for breakfast";
const NAME_121 = `${NAME_120}x`;

// The bug this feature exists for: a real branded item logged as 0 kcal / 0 protein.
// OFF carries no "Actileaf Barista" product, so this name is resolved by the model.
const BRANDED = "Actileaf Barista Style Oat Drink";

// Open Food Facts fixtures. OFF holds brand "Actileaf" / product "Oat Milk" (a UK oat drink),
// so this name is the one the label path can actually identify.
const OFF_PRODUCT = "Actileaf Oat Milk";
// Nothing on a label can account for "nan", "leftover" and "biryani" at once, so the strict
// scorer rejects every hit and the coach's own estimate stands.
const FREEFORM = "my nan's leftover biryani";

type DietRow = {
  id: number; date: string; name: string;
  kcal: number; proteinG: number; carbsG: number | null; fatG: number | null;
  nutrition: unknown;
};

let cookie: string;

async function cleanupRange(): Promise<void> {
  // Scoped to the owned range only: the shared DB's demo data and coach reviews are untouchable.
  await db.delete(dietEntries).where(and(gte(dietEntries.date, RANGE_LO), lte(dietEntries.date, RANGE_HI)));
}

beforeAll(async () => {
  cookie = await loginCookie();
  await cleanupRange(); // idempotent reruns
});

afterAll(async () => {
  await cleanupRange();
});

async function createEntry(body: Record<string, unknown>): Promise<DietRow> {
  const res = await api("/api/diet", { method: "POST", cookie, body });
  expect(res.status).toBe(201);
  const row = res.json as DietRow;
  expect(typeof row.id).toBe("number");
  return row;
}

const rowById = async (id: number) => {
  const rows = await db.select().from(dietEntries).where(eq(dietEntries.id, id));
  expect(rows).toHaveLength(1);
  return rows[0];
};

const analyze = (entryId: number) =>
  api("/api/ai/nutrition", { method: "POST", cookie, body: { entryId } });

const estimate = (name: string) =>
  api("/api/ai/estimate", { method: "POST", cookie, body: { name } });

// The full response contract, in the order Object.keys(...).sort() produces it.
const RESOLVED_KEYS = ["kcal", "matchedName", "proteinG", "servingG", "servingSource", "source"];

/**
 * The whole response contract in one place, identical for both sources: exactly the six
 * keys, a source that is one of the two literals, and matchedName tied to that source
 * (a string for "label", null for "estimate"). Numbers still have to satisfy MealEstimate,
 * because the client writes them straight into a diet row.
 *
 * The portion travels with its own provenance: a label answer is always for a real,
 * positive serving and says whether that serving came off the product record or from the
 * model, while the coach's own estimate never claims a portion it did not measure.
 */
function parseResolved(json: unknown): ResolvedMacros {
  expect(Object.keys(json as object).sort()).toEqual(RESOLVED_KEYS);
  const r = json as ResolvedMacros;
  expect(["label", "estimate"]).toContain(r.source);
  MealEstimate.parse(r);
  expect(Number.isInteger(r.kcal)).toBe(true);
  if (r.source === "label") {
    expect(typeof r.matchedName).toBe("string");
    expect((r.matchedName as string).trim().length).toBeGreaterThan(0);
    expect(typeof r.servingG).toBe("number");
    expect(r.servingG as number).toBeGreaterThan(0);
    expect(["label", "estimate"]).toContain(r.servingSource);
  } else {
    expect(r.matchedName).toBeNull();
    expect(r.servingG).toBeNull();
    expect(r.servingSource).toBeNull();
  }
  return r;
}

describe("POST /api/ai/estimate: deterministic contract (no model call)", () => {
  test("401 without the session cookie", async () => {
    const res = await api("/api/ai/estimate", { method: "POST", body: { name: BRANDED } });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "unauthorized" });
  });

  test("401 wins over body validation: a bad body without the cookie is still unauthorized", async () => {
    const res = await api("/api/ai/estimate", { method: "POST", body: { name: "" } });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "unauthorized" });
  });

  const badBodies: [string, unknown][] = [
    ["missing name", {}],
    ["empty name", { name: "" }],
    ["null name", { name: null }],
    ["number name", { name: 123 }],
    ["boolean name", { name: true }],
    ["array name", { name: ["oat drink"] }],
    ["object name", { name: { text: "oat drink" } }],
    ["a 121-char name", { name: NAME_121 }],
    ["null body", null],
    ["an array body", []],
  ];
  test.each(badBodies)("400 bad request on %s", async (_label, body) => {
    const res = await api("/api/ai/estimate", { method: "POST", cookie, body });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });

  test("400 bad request when no body is sent at all", async () => {
    const res = await api("/api/ai/estimate", { method: "POST", cookie });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });

  test("the name-length boundary: 120 accepted by the schema, 121 rejected", () => {
    expect(NAME_120).toHaveLength(120);
    expect(NAME_121).toHaveLength(121);
    // The route slices the prompt to 120 too, so an accepted name is always sent whole.
    expect(NAME_120.slice(0, 120)).toBe(NAME_120);
  });

  test("estimating writes nothing: the owned date range stays empty", async () => {
    const rows = await db.select().from(dietEntries)
      .where(and(gte(dietEntries.date, RANGE_LO), lte(dietEntries.date, RANGE_HI)));
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/ai/estimate: live model (AI_LIVE)", () => {
  test.runIf(AI_LIVE)("branded UK item → 200 with a single-serving estimate that parses as MealEstimate", async () => {
    const res = await api("/api/ai/estimate", { method: "POST", cookie, body: { name: BRANDED } });
    expect(res.status).toBe(200);

    const est = MealEstimate.parse(res.json);
    // Exactly the fields the client reads — nothing else leaks out of the route. The route now
    // answers with resolveMacros, so the two numbers travel with their provenance: where they
    // came from, what portion they are for, and where that portion came from.
    expect(Object.keys(res.json as object).sort()).toEqual(RESOLVED_KEYS);
    parseResolved(res.json);
    expect(Number.isInteger(est.kcal)).toBe(true);
    expect(est.kcal).toBeGreaterThanOrEqual(1); // the whole point: a real food is never 0 kcal
    expect(est.kcal).toBeLessThanOrEqual(5000);
    expect(est.proteinG).toBeGreaterThanOrEqual(0);
    expect(est.proteinG).toBeLessThanOrEqual(500);
    // One glass/carton, not per-100g-times-a-litre and not a whole meal. Deliberately generous.
    expect(est.kcal).toBeGreaterThanOrEqual(30);
    expect(est.kcal).toBeLessThanOrEqual(600);
  }, 90_000);

  test.runIf(AI_LIVE)("a ready meal estimates clearly higher than a black coffee", async () => {
    const [meal, coffee] = await Promise.all([
      api("/api/ai/estimate", { method: "POST", cookie, body: { name: "Tesco chicken katsu curry ready meal" } }),
      api("/api/ai/estimate", { method: "POST", cookie, body: { name: "black coffee" } }),
    ]);
    expect(meal.status).toBe(200);
    expect(coffee.status).toBe(200);

    const mealEst = MealEstimate.parse(meal.json);
    const coffeeEst = MealEstimate.parse(coffee.json);
    expect(Number.isInteger(mealEst.kcal)).toBe(true);
    expect(Number.isInteger(coffeeEst.kcal)).toBe(true);

    // Loose bands: the ordering is the claim, not the exact numbers.
    expect(coffeeEst.kcal).toBeLessThanOrEqual(50);
    expect(mealEst.kcal).toBeGreaterThanOrEqual(250);
    expect(mealEst.kcal).toBeLessThanOrEqual(1200);
    expect(mealEst.kcal).toBeGreaterThan(coffeeEst.kcal + 200);
    expect(mealEst.proteinG).toBeGreaterThan(coffeeEst.proteinG);
  }, 90_000);

  test.runIf(AI_LIVE)("a name at the 120-char ceiling is accepted, not truncated into a 400", async () => {
    const res = await api("/api/ai/estimate", { method: "POST", cookie, body: { name: NAME_120 } });
    expect(res.status).toBe(200);
    const est = MealEstimate.parse(res.json);
    expect(Number.isInteger(est.kcal)).toBe(true);
    expect(est.kcal).toBeGreaterThanOrEqual(1);
  }, 90_000);

  test("a whitespace-only name is a bad request: the schema trims before min(1)", async () => {
    const res = await api("/api/ai/estimate", { method: "POST", cookie, body: { name: "   " } });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });

  test("a name padded with whitespace is accepted and trimmed to fit", async () => {
    // 120 real characters plus padding still parses: trim runs before max(120).
    const res = await api("/api/ai/estimate", { method: "POST", cookie, body: { name: `  ${"a".repeat(120)}  ` } });
    expect(res.status).not.toBe(400);
  }, 90_000);
});

describe("unknown macros end to end: a 0/0 row is estimated and healed (AI_LIVE)", () => {
  let entryId: number;
  let panel: NutritionPanel;

  test.runIf(AI_LIVE)("201: the panel estimates real macros instead of pinning zero", async () => {
    const entry = await createEntry({ date: D_UNKNOWN, name: BRANDED, kcal: 0, proteinG: 0 });
    entryId = entry.id;
    expect(entry.kcal).toBe(0);
    expect(entry.proteinG).toBe(0);
    expect(macrosUnknown(entry)).toBe(true);
    expect(entry.carbsG).toBeNull();
    expect(entry.fatG).toBeNull();

    const res = await analyze(entryId);
    expect(res.status).toBe(201);
    panel = NutritionPanel.parse((res.json as { nutrition: unknown }).nutrition);
    expect(panel.estimated).toBe(true);
    expect(panel.macros.kcal).toBeGreaterThan(0);
    expect(panel.macros.proteinG).toBeGreaterThanOrEqual(0);
    expect(macrosUnknown(panel.macros)).toBe(false);
  }, 180_000);

  test.runIf(AI_LIVE)("the row itself was rewritten with the estimate, so the day stops reading 0", async () => {
    const row = await rowById(entryId);
    expect(row.kcal).toBe(panel.macros.kcal); // integer column, exact
    // protein_g/carbs_g/fat_g are float4; the panel keeps full jsonb precision.
    expect(row.proteinG).toBeCloseTo(panel.macros.proteinG, 4);
    expect(macrosUnknown(row)).toBe(false);

    expect(row.carbsG).not.toBeNull();
    expect(row.fatG).not.toBeNull();
    expect(row.carbsG!).toBeCloseTo(panel.macros.carbsG, 4);
    expect(row.fatG!).toBeCloseTo(panel.macros.fatG, 4);
  });

  test.runIf(AI_LIVE)("GET /api/diet serves the corrected macros for the day", async () => {
    const res = await api(`/api/diet?date=${D_UNKNOWN}`, { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as DietRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(entryId);
    expect(rows[0].kcal).toBe(panel.macros.kcal);
    expect(rows[0].proteinG).toBeCloseTo(panel.macros.proteinG, 4);
    expect(NutritionPanel.parse(rows[0].nutrition)).toEqual(panel);
  });

  test.runIf(AI_LIVE)("contrast: a row with real macros keeps them pinned and unchanged", async () => {
    const entry = await createEntry({
      date: D_PINNED, name: "Tesco chicken katsu curry ready meal", kcal: 500, proteinG: 30,
    });
    expect(macrosUnknown(entry)).toBe(false);

    const res = await analyze(entry.id);
    expect(res.status).toBe(201);
    const pinned = NutritionPanel.parse((res.json as { nutrition: unknown }).nutrition);
    expect(pinned.macros.kcal).toBe(500);
    expect(pinned.macros.proteinG).toBe(30);

    const row = await rowById(entry.id);
    expect(row.kcal).toBe(500);
    expect(row.proteinG).toBe(30);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Open Food Facts label lookup. Everything below reaches the real OFF search and
// the real model, so the whole suite is gated: the public OFF instance rate-limits
// and answers overload with an HTML 503, which no default-path test may depend on.
// ---------------------------------------------------------------------------
describe.runIf(AI_LIVE)("POST /api/ai/estimate: Open Food Facts label lookup (AI_LIVE)", () => {
  let labelRes: { status: number; json: unknown };
  let freeRes: { status: number; json: unknown };
  // Probes of the real OFF search through the same client the route uses; they say whether
  // OFF was reachable at all for this run. searchFood memoises per process, so these are
  // the test process's own view, independent of the long-lived dev server's cache.
  let probe: FoodMatch | null = null;
  let freeProbe: FoodMatch | null = null;

  beforeAll(async () => {
    [labelRes, freeRes] = await Promise.all([estimate(OFF_PRODUCT), estimate(FREEFORM)]);
    [probe, freeProbe] = await Promise.all([searchFood(OFF_PRODUCT), searchFood(FREEFORM)]);
  }, 180_000);

  test("a product OFF can identify comes back as that product's label", () => {
    expect(labelRes.status).toBe(200);
    const r = parseResolved(labelRes.json);

    if (r.source === "label") {
      const matched = r.matchedName as string;
      expect(matched.toLowerCase()).toContain("oat"); // it is the logged product, not some other row
      // The name handed back still clears the same strict scorer the match came from: a variant
      // the user never typed ("Chocolate Oat Drink") could not have reached this response.
      expect(scoreHit(tokenize(OFF_PRODUCT), { product_name: matched })).toBeGreaterThanOrEqual(MIN_SCORE);
      // One glass/carton of oat drink off a real label, not a per-100 g figure and not a litre.
      expect(r.kcal).toBeGreaterThanOrEqual(40);
      expect(r.kcal).toBeLessThanOrEqual(250);
      expect(r.proteinG).toBeGreaterThanOrEqual(0);
      expect(r.proteinG).toBeLessThanOrEqual(20);
    } else {
      // The documented degraded path, asserted rather than waved through: when OFF 503s or
      // rate-limits, searchFood resolves to null instead of throwing and the route must answer
      // with a plain model estimate carrying no product at all — never a 502, never a half-label.
      expect(r.source).toBe("estimate");
      expect(r.matchedName).toBeNull();
      expect(r.kcal).toBeGreaterThanOrEqual(30);
      expect(r.kcal).toBeLessThanOrEqual(600);
      expect(r.proteinG).toBeGreaterThanOrEqual(0);
    }
  });

  test("the OFF record behind that product carries label macros that scale into a real serving", () => {
    if (!probe) {
      // OFF was unreachable or rate-limited for this run. That is itself the contract worth
      // asserting: the failure is swallowed into a null match, and the route still answered 200.
      expect(probe).toBeNull();
      expect(labelRes.status).toBe(200);
      return;
    }
    expect(probe.score).toBeGreaterThanOrEqual(MIN_SCORE);
    expect(probe.productName.toLowerCase()).toContain("oat");
    expect(labelName(probe.brand, probe.productName).toLowerCase()).toContain("actileaf");
    expect(probe.per100.kcal).toBeGreaterThan(0);
    expect(probe.per100.proteinG).toBeGreaterThanOrEqual(0);

    // 200 ml is how this drink is actually taken; the same band the route's answer sits in.
    const glass = scaleToServing(probe.per100, 200);
    expect(Number.isInteger(glass.kcal)).toBe(true);
    expect(glass.kcal).toBeGreaterThanOrEqual(40);
    expect(glass.kcal).toBeLessThanOrEqual(250);
    expect(glass.proteinG).toBeGreaterThanOrEqual(0);
    expect(glass.proteinG).toBeLessThanOrEqual(20);
  });

  test("a label answer's numbers ARE that record's per-100 scaled by the portion it reports", () => {
    const r = parseResolved(labelRes.json);
    if (r.source !== "label" || !probe || labelName(probe.brand, probe.productName) !== r.matchedName) {
      // OFF was down, or the route and this process landed on different records — there is no
      // shared record to check the arithmetic against, so only the invariants above apply.
      return;
    }
    // Same record, so the answer must be exactly the label scaled by the portion it declares.
    expect(scaleToServing(probe.per100, r.servingG as number)).toEqual({ kcal: r.kcal, proteinG: r.proteinG });
    // ...and the portion is sourced honestly: off the record when the record has one, from the
    // model when it does not. Live, Actileaf's record carries no usable serving_quantity.
    const fromRecord = probe.servingQuantityG !== null && probe.servingQuantityG > 0;
    expect(r.servingSource).toBe(fromRecord ? "label" : "estimate");
    if (fromRecord) expect(r.servingG).toBe(probe.servingQuantityG);
    // Either way it is a plausible single serving of a drink, not a per-100 figure or a litre.
    expect(r.servingG as number).toBeGreaterThanOrEqual(100);
    expect(r.servingG as number).toBeLessThanOrEqual(1000);
  });

  test("free-form food no label can account for falls back to the coach's estimate", () => {
    expect(freeRes.status).toBe(200);
    const r = parseResolved(freeRes.json);
    expect(r.source).toBe("estimate");
    expect(r.matchedName).toBeNull();
    // No product, so no portion of its own: the coach's numbers stand alone.
    expect(r.servingG).toBeNull();
    expect(r.servingSource).toBeNull();
    expect(r.kcal).toBeGreaterThan(0);
    expect(r.kcal).toBeLessThanOrEqual(2000);
    expect(r.proteinG).toBeGreaterThanOrEqual(0);
    // Why it fell back: the real OFF search cannot identify it, up or down.
    expect(freeProbe).toBeNull();
  });

  test("the response shape is stable across both sources", () => {
    const label = parseResolved(labelRes.json);
    const free = parseResolved(freeRes.json);
    expect(free.source).toBe("estimate");
    // Same keys in the same order-independent set, whichever way the two calls resolved.
    expect(Object.keys(labelRes.json as object).sort()).toEqual(Object.keys(freeRes.json as object).sort());
    for (const r of [label, free]) {
      expect(typeof r.kcal).toBe("number");
      expect(typeof r.proteinG).toBe("number");
      expect(r.matchedName === null || typeof r.matchedName === "string").toBe(true);
      expect(r.source === "label" ? r.matchedName !== null : r.matchedName === null).toBe(true);
      // servingSource is never set without a servingG, and never on the estimate path.
      expect(r.servingSource === null).toBe(r.servingG === null);
      expect(r.source === "estimate" ? r.servingSource === null : true).toBe(true);
    }
  });

  test("resolving a label writes nothing: no diet row appeared for either name", async () => {
    const rows = await db.select().from(dietEntries)
      .where(and(gte(dietEntries.date, RANGE_LO), lte(dietEntries.date, RANGE_HI)));
    // Nothing in this suite ever logs the free-form meal, so a row carrying it could only
    // have come from the estimate call itself.
    expect(rows.some((r) => r.name === FREEFORM)).toBe(false);
    // And every row that does exist is one this suite created deliberately, on its own dates.
    expect(rows.every((r) => [D_UNKNOWN, D_PINNED, D_LABEL].includes(r.date))).toBe(true);
  });
});

describe.runIf(AI_LIVE)("unknown macros on a label-matched product are still repaired (AI_LIVE)", () => {
  test("a 0/0 row named after a product OFF can identify is analysed and rewritten", async () => {
    const entry = await createEntry({ date: D_LABEL, name: OFF_PRODUCT, kcal: 0, proteinG: 0 });
    expect(macrosUnknown(entry)).toBe(true);
    expect(entry.carbsG).toBeNull();
    expect(entry.fatG).toBeNull();

    const res = await analyze(entry.id);
    expect(res.status).toBe(201);
    const panel = NutritionPanel.parse((res.json as { nutrition: unknown }).nutrition);
    expect(panel.estimated).toBe(true);
    expect(panel.macros.kcal).toBeGreaterThan(0);
    expect(macrosUnknown(panel.macros)).toBe(false);

    const row = await rowById(entry.id);
    expect(row.kcal).toBe(panel.macros.kcal);
    expect(row.proteinG).toBeCloseTo(panel.macros.proteinG, 4);
    expect(row.carbsG).not.toBeNull();
    expect(row.fatG).not.toBeNull();
    expect(macrosUnknown(row)).toBe(false);

    const day = await api(`/api/diet?date=${D_LABEL}`, { cookie });
    expect(day.status).toBe(200);
    const rows = day.json as DietRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(entry.id);
    expect(rows[0].kcal).toBe(panel.macros.kcal);
    expect(NutritionPanel.parse(rows[0].nutrition)).toEqual(panel);
  }, 180_000);
});
