import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { and, eq, gte, inArray, like, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { dietEntries, foodPresets } from "@/lib/db/schema";
import { NutritionPanel } from "@/lib/ai/nutrition";
import { api, loginCookie } from "./helpers";

// Assigned date range for this suite: 2030-06-20 .. 2030-06-25 only.
// (nutrition-ai owns 06-01..05, the e2e nutrition spec owns 06-08..12.)
const RANGE_LO = "2030-06-20";
const RANGE_HI = "2030-06-25";
const D_BOUNDS = "2030-06-20";
const D_MALFORMED = "2030-06-21";
const D_HEAL = "2030-06-22";
const D_DELETED = "2030-06-23";
const D_CONCURRENT = "2030-06-24";

const AI_LIVE = !!process.env.AI_LIVE;

// Presets are global (no date column) and have no DELETE endpoint: every preset this
// suite creates is name-prefixed so a crashed run is still self-healable, and removed
// by id with a scoped drizzle delete. The prefix is distinct from nutrition.int's
// "INT-TEST" so neither suite's wildcard cleanup can reach the other's rows.
const PREFIX = "HARDEN-TEST";
const NAME_120 = `${PREFIX} 120-char name `.padEnd(120, "x");
const NAME_121 = `${NAME_120}x`;

type DietRow = {
  id: number; date: string; name: string;
  kcal: number; proteinG: number; carbsG: number | null; fatG: number | null;
  nutrition: unknown;
};
type PresetRow = Omit<DietRow, "date" | "nutrition">;

let cookie: string;
const createdDietIds: number[] = [];
const createdPresetIds: number[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A complete, schema-valid panel. Used as the base for the "almost valid" jsonb below,
// never written whole — this suite's stored panels are all deliberately unreadable.
const VALID_PANEL: NutritionPanel = NutritionPanel.parse({
  estimated: true,
  macros: { kcal: 400, proteinG: 25, carbsG: 40.5, fatG: 12.25, saturatedFatG: 4.5, fiberG: 3.5, sugarG: 7.25, saltG: 1.25 },
  micros: {
    vitaminA_ug: 100, vitaminC_mg: 6.5, vitaminD_ug: 1.5, vitaminE_mg: 2.25, vitaminB12_ug: 1.75,
    folate_ug: 50, calcium_mg: 150, iron_mg: 2.5, potassium_mg: 500, magnesium_mg: 45, zinc_mg: 1.5,
  },
  advice: { verdict: "ok", summary: "Base fixture panel, 400 kcal with 25g protein.", swap: "A leaner option, roughly 350 kcal and 30g protein." },
});

// Legacy/foreign jsonb: nothing a NutritionPanel reader can use.
const JUNK_LEGACY = { legacy: true } as const;
// The nastier shape: looks like a panel, but micros.zinc_mg is absent. Structural
// plausibility must not be enough — only NutritionPanel.safeParse decides.
const JUNK_NO_ZINC = (() => {
  const { zinc_mg: _drop, ...micros } = VALID_PANEL.micros;
  return { ...VALID_PANEL, micros };
})();

async function cleanupRange(): Promise<void> {
  // Safety net: nothing of ours may survive in the owned range.
  await db.delete(dietEntries).where(and(gte(dietEntries.date, RANGE_LO), lte(dietEntries.date, RANGE_HI)));
  if (createdPresetIds.length > 0) await db.delete(foodPresets).where(inArray(foodPresets.id, createdPresetIds));
  // Self-heal: a crashed earlier run can leak presets past the id-tracked cleanup.
  await db.delete(foodPresets).where(like(foodPresets.name, `${PREFIX}%`));
}

beforeAll(async () => {
  cookie = await loginCookie();
  await cleanupRange(); // idempotent reruns
});

afterAll(async () => {
  for (const id of createdDietIds) await api(`/api/diet/${id}`, { method: "DELETE", cookie });
  await cleanupRange();
});

async function createEntry(body: Record<string, unknown>): Promise<DietRow> {
  const res = await api("/api/diet", { method: "POST", cookie, body });
  expect(res.status).toBe(201);
  const row = res.json as DietRow;
  expect(typeof row.id).toBe("number");
  createdDietIds.push(row.id);
  return row;
}

const rowById = async (id: number) => {
  const rows = await db.select().from(dietEntries).where(eq(dietEntries.id, id));
  expect(rows).toHaveLength(1);
  return rows[0];
};

/** Plant unreadable jsonb in the nutrition column, bypassing the API's own typing. */
async function plantNutrition(id: number, value: unknown): Promise<void> {
  await db.update(dietEntries).set({ nutrition: value as NutritionPanel }).where(eq(dietEntries.id, id));
}

describe("POST /api/diet: DietEntryInput bounds", () => {
  const overLimit: [string, Record<string, unknown>][] = [
    ["kcal 5001 (one past the ceiling)", { name: "HARDEN kcal 5001", kcal: 5001, proteinG: 10 }],
    ["kcal 50000", { name: "HARDEN kcal 50000", kcal: 50_000, proteinG: 10 }],
    ["proteinG 501", { name: "HARDEN protein 501", kcal: 100, proteinG: 501 }],
    ["a 121-char name", { name: NAME_121, kcal: 100, proteinG: 10 }],
  ];
  test.each(overLimit)("400 bad request on %s", async (_label, body) => {
    const res = await api("/api/diet", { method: "POST", cookie, body: { date: D_BOUNDS, ...body } });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });

  test("the rejected entries were never written", async () => {
    const rows = await db.select().from(dietEntries).where(eq(dietEntries.date, D_BOUNDS));
    expect(rows).toHaveLength(0);
  });

  test("201 at the kcal ceiling (5000)", async () => {
    const row = await createEntry({ date: D_BOUNDS, name: "HARDEN kcal 5000", kcal: 5000, proteinG: 10 });
    expect(row.kcal).toBe(5000);
    expect((await rowById(row.id)).kcal).toBe(5000);
  });

  test("201 at the protein ceiling (500)", async () => {
    const row = await createEntry({ date: D_BOUNDS, name: "HARDEN protein 500", kcal: 100, proteinG: 500 });
    expect(row.proteinG).toBe(500);
    expect((await rowById(row.id)).proteinG).toBe(500);
  });

  test("201 at the name ceiling (120 chars), stored untruncated", async () => {
    expect(NAME_120).toHaveLength(120);
    expect(NAME_121).toHaveLength(121);
    const row = await createEntry({ date: D_BOUNDS, name: NAME_120, kcal: 100, proteinG: 10 });
    expect(row.name).toBe(NAME_120);
    expect((await rowById(row.id)).name).toBe(NAME_120);
  });
});

describe("POST /api/presets: PresetInput inherits the same bounds", () => {
  const overLimit: [string, Record<string, unknown>][] = [
    ["kcal 5001 (one past the ceiling)", { name: `${PREFIX} kcal 5001`, kcal: 5001, proteinG: 10 }],
    ["kcal 50000", { name: `${PREFIX} kcal 50000`, kcal: 50_000, proteinG: 10 }],
    ["proteinG 501", { name: `${PREFIX} protein 501`, kcal: 100, proteinG: 501 }],
    ["a 121-char name", { name: NAME_121, kcal: 100, proteinG: 10 }],
  ];
  test.each(overLimit)("400 bad request on %s", async (_label, body) => {
    const res = await api("/api/presets", { method: "POST", cookie, body });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });

  test("the rejected presets were never written", async () => {
    const rows = await db.select().from(foodPresets).where(like(foodPresets.name, `${PREFIX}%`));
    expect(rows).toHaveLength(0);
  });

  const boundary: [string, Record<string, unknown>][] = [
    ["kcal ceiling (5000)", { name: `${PREFIX} kcal 5000`, kcal: 5000, proteinG: 10 }],
    ["protein ceiling (500)", { name: `${PREFIX} protein 500`, kcal: 100, proteinG: 500 }],
    ["name ceiling (120 chars)", { name: NAME_120, kcal: 100, proteinG: 10 }],
  ];
  test.each(boundary)("201 at the %s", async (_label, body) => {
    const res = await api("/api/presets", { method: "POST", cookie, body });
    expect(res.status).toBe(201);
    const row = res.json as PresetRow;
    expect(typeof row.id).toBe("number");
    createdPresetIds.push(row.id);
    expect(row).toMatchObject(body);

    const stored = await db.select().from(foodPresets).where(eq(foodPresets.id, row.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject(body);
  });
});

describe("malformed stored nutrition jsonb", () => {
  let legacyId: number;
  let noZincId: number;

  test("plants two unreadable panels on real rows", async () => {
    legacyId = (await createEntry({ date: D_MALFORMED, name: "HARDEN legacy jsonb", kcal: 400, proteinG: 25 })).id;
    noZincId = (await createEntry({ date: D_MALFORMED, name: "HARDEN panel missing zinc", kcal: 400, proteinG: 25 })).id;
    await plantNutrition(legacyId, JUNK_LEGACY);
    await plantNutrition(noZincId, JUNK_NO_ZINC);

    // Both are unreadable by the only reader that matters.
    expect(NutritionPanel.safeParse(JUNK_LEGACY).success).toBe(false);
    expect(NutritionPanel.safeParse(JUNK_NO_ZINC).success).toBe(false);
  });

  test("GET /api/diet still returns both rows, jsonb passed through verbatim", async () => {
    const res = await api(`/api/diet?date=${D_MALFORMED}`, { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as DietRow[];
    expect(rows).toHaveLength(2);

    const legacy = rows.find((r) => r.id === legacyId);
    const noZinc = rows.find((r) => r.id === noZincId);
    expect(legacy).toBeDefined();
    expect(noZinc).toBeDefined();

    // The list endpoint does not validate the column: the client receives the junk as-is,
    // which is exactly why /api/ai/nutrition must re-validate before serving it.
    expect(legacy!.nutrition).toEqual(JUNK_LEGACY);
    expect(noZinc!.nutrition).toEqual(JUNK_NO_ZINC);
    expect(NutritionPanel.safeParse(legacy!.nutrition).success).toBe(false);
    expect(NutritionPanel.safeParse(noZinc!.nutrition).success).toBe(false);
  });

  test("the planted rows keep their logged macros untouched", async () => {
    for (const id of [legacyId, noZincId]) {
      const row = await rowById(id);
      expect(row.kcal).toBe(400);
      expect(row.proteinG).toBe(25);
      expect(row.carbsG).toBeNull();
      expect(row.fatG).toBeNull();
    }
  });
});

describe("POST /api/ai/nutrition: live model (AI_LIVE)", () => {
  const junkCases: [string, unknown][] = [
    ["legacy jsonb", JUNK_LEGACY],
    ["a panel missing micros.zinc_mg", JUNK_NO_ZINC],
  ];
  test.runIf(AI_LIVE).each(junkCases)("%s is re-analyzed, not served: 201 and the row heals", async (label, junk) => {
    const entry = await createEntry({ date: D_HEAL, name: `HARDEN heal ${label}`, kcal: 480, proteinG: 32 });
    await plantNutrition(entry.id, junk);

    const res = await api("/api/ai/nutrition", { method: "POST", cookie, body: { entryId: entry.id } });
    expect(res.status).toBe(201); // 201, not 200: the junk was never treated as an answer
    const panel = NutritionPanel.parse((res.json as { nutrition: unknown }).nutrition);
    expect(panel.macros.kcal).toBe(480);
    expect(panel.macros.proteinG).toBe(32);
    expect(panel.estimated).toBe(true);

    // The row healed in place: what is stored now parses cleanly and is what was served.
    const row = await rowById(entry.id);
    expect(row.nutrition).not.toEqual(junk);
    expect(NutritionPanel.parse(row.nutrition)).toEqual(panel);
  }, 120_000);

  test.runIf(AI_LIVE)("row deleted mid-analysis → 404 not_found, never a lying 201", async () => {
    const entry = await createEntry({ date: D_DELETED, name: "HARDEN deleted mid-analysis", kcal: 520, proteinG: 28 });

    // Fire without awaiting: the model call takes far longer than the delete below.
    const pending = api("/api/ai/nutrition", { method: "POST", cookie, body: { entryId: entry.id } });
    await sleep(1500);
    const del = await api(`/api/diet/${entry.id}`, { method: "DELETE", cookie });
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true });

    const res = await pending;
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "not_found" });

    // The 404 told the truth: the row really is gone, and nothing resurrected it.
    const rows = await db.select().from(dietEntries).where(eq(dietEntries.id, entry.id));
    expect(rows).toHaveLength(0);
  }, 120_000);

  test.runIf(AI_LIVE)("two concurrent POSTs → one 201, one 200, both serving the stored panel", async () => {
    const entry = await createEntry({ date: D_CONCURRENT, name: "HARDEN concurrent double-post", kcal: 610, proteinG: 44 });

    const [a, b] = await Promise.all([
      api("/api/ai/nutrition", { method: "POST", cookie, body: { entryId: entry.id } }),
      api("/api/ai/nutrition", { method: "POST", cookie, body: { entryId: entry.id } }),
    ]);

    // Neither request errored, and exactly one of them did the writing.
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    // Same answer both ways round: the loser did not serve its own analysis.
    expect(a.json).toEqual(b.json);

    const winner = NutritionPanel.parse((a.json as { nutrition: unknown }).nutrition);
    expect(winner.macros.kcal).toBe(610);
    expect(winner.macros.proteinG).toBe(44);

    // And that shared answer is the panel actually persisted on the row.
    const row = await rowById(entry.id);
    expect(NutritionPanel.parse(row.nutrition)).toEqual(winner);
    expect(a.json).toEqual({ nutrition: row.nutrition });
    expect(b.json).toEqual({ nutrition: row.nutrition });
  }, 180_000);
});
