import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { dietEntries } from "@/lib/db/schema";
import { MealEstimate } from "@/lib/ai/estimate";
import { NutritionPanel, macrosUnknown } from "@/lib/ai/nutrition";
import { api, loginCookie } from "./helpers";

// Assigned date range for this suite: 2030-07-01 .. 2030-07-05 only.
// (nutrition-ai owns 06-01..05, nutrition-hardening 06-20..25, the e2e specs 05-20..25 and 06-08..12.)
const RANGE_LO = "2030-07-01";
const RANGE_HI = "2030-07-05";
const D_UNKNOWN = "2030-07-02";
const D_PINNED = "2030-07-03";

const AI_LIVE = !!process.env.AI_LIVE;

// The route's body schema is z.string().min(1).max(120): 120 is the last accepted length.
const NAME_120 =
  "Actileaf Barista Style Oat Drink poured over granola with blueberries, and a big spoonful of peanut butter for breakfast";
const NAME_121 = `${NAME_120}x`;

// The bug this feature exists for: a real branded item logged as 0 kcal / 0 protein.
const BRANDED = "Actileaf Barista Style Oat Drink";

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
    // Exactly the two fields the client reads — nothing else leaks out of the route.
    expect(Object.keys(res.json as object).sort()).toEqual(["kcal", "proteinG"]);
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
