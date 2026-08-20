import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { dietEntries } from "@/lib/db/schema";
import { NutritionPanel } from "@/lib/ai/nutrition";
import { api, loginCookie } from "./helpers";

// Assigned date range for this suite: 2030-06-01 .. 2030-06-05 only.
const RANGE_LO = "2030-06-01";
const RANGE_HI = "2030-06-05";
const D_STORED = "2030-06-02";
const D_LIVE = "2030-06-03";
const D_PREFILLED = "2030-06-04";

const AI_LIVE = !!process.env.AI_LIVE;
const UNKNOWN_ID = 2_147_483_000; // int4-safe, far beyond any serial id in the shared DB

type DietRow = {
  id: number; date: string; name: string;
  kcal: number; proteinG: number; carbsG: number | null; fatG: number | null;
  nutrition: NutritionPanel | null;
};

let cookie: string;
const createdIds: number[] = [];

// Hand-written, schema-valid panel. Float-exact values (halves/quarters) so the
// jsonb round-trip deep-equals bit for bit.
const storedPanel: NutritionPanel = NutritionPanel.parse({
  estimated: true,
  macros: { kcal: 512, proteinG: 30, carbsG: 55.5, fatG: 18.25, saturatedFatG: 6.5, fiberG: 4, sugarG: 9.75, saltG: 1.5 },
  micros: {
    vitaminA_ug: 120, vitaminC_mg: 8.5, vitaminD_ug: 1.25, vitaminE_mg: 2.5, vitaminB12_ug: 1.5,
    folate_ug: 60, calcium_mg: 180, iron_mg: 3.5, potassium_mg: 620, magnesium_mg: 55, zinc_mg: 2.75,
  },
  advice: {
    verdict: "ok",
    summary: "Hand-written test panel: 512 kcal with 30g protein is a fair lunch.",
    swap: "Chicken salad wrap from the same shop, roughly 420 kcal and 35g protein.",
  },
});

async function cleanupRange(): Promise<void> {
  for (const id of createdIds) await api(`/api/diet/${id}`, { method: "DELETE", cookie });
  // Safety net: nothing of ours may survive in the owned range.
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
  createdIds.push(row.id);
  return row;
}

const rowById = async (id: number) => {
  const rows = await db.select().from(dietEntries).where(eq(dietEntries.id, id));
  expect(rows).toHaveLength(1);
  return rows[0];
};

describe("POST /api/ai/nutrition: deterministic contract", () => {
  test("401 without the session cookie", async () => {
    const res = await api("/api/ai/nutrition", { method: "POST", body: { entryId: 1 } });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "unauthorized" });
  });

  const badBodies: [string, unknown][] = [
    ["missing entryId", {}],
    ["string entryId", { entryId: "7" }],
    ["zero entryId", { entryId: 0 }],
    ["negative entryId", { entryId: -3 }],
    ["float entryId", { entryId: 1.5 }],
    ["null body", null],
  ];
  test.each(badBodies)("400 bad request on %s", async (_label, body) => {
    const res = await api("/api/ai/nutrition", { method: "POST", cookie, body });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });

  test("404 not_found for an unknown entry id", async () => {
    const res = await api("/api/ai/nutrition", { method: "POST", cookie, body: { entryId: UNKNOWN_ID } });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "not_found" });
  });

  test("entry with a stored panel → 200 with exactly that panel, no model call", async () => {
    const entry = await createEntry({ date: D_STORED, name: "Test stored-panel meal", kcal: 512, proteinG: 30 });
    await db.update(dietEntries).set({ nutrition: storedPanel }).where(eq(dietEntries.id, entry.id));

    const res = await api("/api/ai/nutrition", { method: "POST", cookie, body: { entryId: entry.id } });
    expect(res.status).toBe(200); // 200 not 201: served from storage, works even keyless
    expect(res.json).toEqual({ nutrition: storedPanel });
  });

  test("GET /api/diet returns the stored nutrition on the row", async () => {
    const res = await api(`/api/diet?date=${D_STORED}`, { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as DietRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].nutrition).toEqual(storedPanel);
  });
});

describe("POST /api/ai/nutrition: live model (AI_LIVE)", () => {
  let liveId: number;
  let livePanel: NutritionPanel;

  test.runIf(AI_LIVE)("201 analyzes a fresh entry: pinned kcal/protein, estimated, verdict in enum", async () => {
    const entry = await createEntry({ date: D_LIVE, name: "Tesco chicken katsu curry ready meal", kcal: 500, proteinG: 30 });
    liveId = entry.id;
    expect(entry.carbsG).toBeNull();
    expect(entry.fatG).toBeNull();

    const res = await api("/api/ai/nutrition", { method: "POST", cookie, body: { entryId: liveId } });
    expect(res.status).toBe(201);
    livePanel = NutritionPanel.parse((res.json as { nutrition: unknown }).nutrition);
    expect(livePanel.macros.kcal).toBe(500);
    expect(livePanel.macros.proteinG).toBe(30);
    expect(livePanel.estimated).toBe(true);
    expect(["good", "ok", "poor"]).toContain(livePanel.advice.verdict);
  }, 120_000);

  test.runIf(AI_LIVE)("re-POST → 200 with the same persisted panel, deep-equal", async () => {
    const res = await api("/api/ai/nutrition", { method: "POST", cookie, body: { entryId: liveId } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ nutrition: livePanel });
  }, 120_000);

  test.runIf(AI_LIVE)("analysis backfilled the row's null carbsG/fatG from the panel", async () => {
    const row = await rowById(liveId);
    expect(row.carbsG).not.toBeNull();
    expect(row.fatG).not.toBeNull();
    // carbs_g/fat_g are float4; the panel keeps full jsonb precision.
    expect(row.carbsG!).toBeCloseTo(livePanel.macros.carbsG, 1);
    expect(row.fatG!).toBeCloseTo(livePanel.macros.fatG, 1);
  });

  test.runIf(AI_LIVE)("backfill only fills nulls: user-logged carbsG/fatG survive analysis", async () => {
    const entry = await createEntry({ date: D_PREFILLED, name: "Pret chicken avocado sandwich", kcal: 500, proteinG: 30, carbsG: 40, fatG: 10 });

    const res = await api("/api/ai/nutrition", { method: "POST", cookie, body: { entryId: entry.id } });
    expect(res.status).toBe(201);
    NutritionPanel.parse((res.json as { nutrition: unknown }).nutrition);

    const row = await rowById(entry.id);
    expect(row.carbsG).toBe(40);
    expect(row.fatG).toBe(10);
  }, 120_000);
});
