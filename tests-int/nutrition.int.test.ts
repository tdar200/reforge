import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { dietEntries, foodPresets } from "@/lib/db/schema";
import { api, loginCookie } from "./helpers";

// Owned date range: 2030-02-01 .. 2030-02-28 only.
const D_MANUAL = "2030-02-10";
const D_PRESET = "2030-02-11";
const D_DELETE = "2030-02-12";
const RANGE_LO = "2030-02-01";
const RANGE_HI = "2030-02-28";

let cookie: string;
let originalSettings: { calorieTarget: number; proteinTarget: number } | null = null;
const createdDietIds: number[] = [];
const createdPresetIds: number[] = [];

type DietRow = {
  id: number; date: string; name: string;
  kcal: number; proteinG: number; carbsG: number | null; fatG: number | null;
};
type PresetRow = Omit<DietRow, "date">;

beforeAll(async () => {
  cookie = await loginCookie();
  const res = await api("/api/settings", { cookie });
  expect(res.status).toBe(200);
  const s = res.json as { id: number; calorieTarget: number; proteinTarget: number };
  originalSettings = { calorieTarget: s.calorieTarget, proteinTarget: s.proteinTarget };
});

afterAll(async () => {
  // Restore the settings singleton first, no matter what failed mid-suite.
  try {
    if (originalSettings) {
      const res = await api("/api/settings", { method: "PUT", body: originalSettings, cookie });
      if (res.status !== 200) throw new Error(`settings restore failed: ${res.status}`);
    }
  } finally {
    for (const id of createdDietIds) {
      await api(`/api/diet/${id}`, { method: "DELETE", cookie });
    }
    // Safety net: nothing of ours may survive in the owned range.
    await db.delete(dietEntries)
      .where(and(gte(dietEntries.date, RANGE_LO), lte(dietEntries.date, RANGE_HI)));
    // Presets have no DELETE endpoint; remove only the exact rows this suite created.
    if (createdPresetIds.length > 0) {
      await db.delete(foodPresets).where(inArray(foodPresets.id, createdPresetIds));
    }
  }
});

describe("auth: every nutrition/config route 401s without the session cookie", () => {
  const cases: [string, string][] = [
    ["GET", "/api/diet"],
    ["POST", "/api/diet"],
    ["DELETE", "/api/diet/1"],
    ["GET", "/api/presets"],
    ["POST", "/api/presets"],
    ["GET", "/api/exercises"],
    ["GET", "/api/settings"],
    ["PUT", "/api/settings"],
  ];
  it.each(cases)("%s %s → 401 unauthorized", async (method, path) => {
    const res = await api(path, { method, body: method === "GET" ? undefined : {} });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "unauthorized" });
  });
});

describe("diet entries: create, list by date, delete", () => {
  it("creates a manual entry with full macros → 201 with the persisted row", async () => {
    const res = await api("/api/diet", {
      method: "POST", cookie,
      body: { date: D_MANUAL, name: "Test chicken bowl", kcal: 650, proteinG: 48, carbsG: 70, fatG: 15 },
    });
    expect(res.status).toBe(201);
    const row = res.json as DietRow;
    expect(row).toMatchObject({
      date: D_MANUAL, name: "Test chicken bowl", kcal: 650, proteinG: 48, carbsG: 70, fatG: 15,
    });
    expect(typeof row.id).toBe("number");
    createdDietIds.push(row.id);
  });

  it("creates a manual entry omitting optional carbs/fat → carbsG/fatG null", async () => {
    const res = await api("/api/diet", {
      method: "POST", cookie,
      body: { date: D_MANUAL, name: "Test protein shake", kcal: 160, proteinG: 30 },
    });
    expect(res.status).toBe(201);
    const row = res.json as DietRow;
    expect(row).toMatchObject({ date: D_MANUAL, name: "Test protein shake", kcal: 160, proteinG: 30 });
    expect(row.carbsG).toBeNull();
    expect(row.fatG).toBeNull();
    createdDietIds.push(row.id);
  });

  it("lists exactly the entries for a date; day totals aggregate from the rows", async () => {
    const res = await api(`/api/diet?date=${D_MANUAL}`, { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as DietRow[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(["Test chicken bowl", "Test protein shake"]);
    expect(rows.every((r) => r.date === D_MANUAL)).toBe(true);
    // No aggregate endpoint exists; totals derive from the list rows.
    expect(rows.reduce((s, r) => s + r.kcal, 0)).toBe(810);
    expect(rows.reduce((s, r) => s + r.proteinG, 0)).toBe(78);
  });

  it("unfiltered GET /api/diet includes rows from our date", async () => {
    const res = await api("/api/diet", { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as DietRow[];
    expect(rows.some((r) => r.date === D_MANUAL && r.name === "Test chicken bowl")).toBe(true);
  });

  it("DELETE /api/diet/:id removes the row; list no longer returns it; re-delete stays 200", async () => {
    const created = await api("/api/diet", {
      method: "POST", cookie,
      body: { date: D_DELETE, name: "Test delete-me", kcal: 100, proteinG: 5 },
    });
    expect(created.status).toBe(201);
    const id = (created.json as DietRow).id;

    const del = await api(`/api/diet/${id}`, { method: "DELETE", cookie });
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true });

    const list = await api(`/api/diet?date=${D_DELETE}`, { cookie });
    expect(list.status).toBe(200);
    expect((list.json as DietRow[]).some((r) => r.id === id)).toBe(false);

    const again = await api(`/api/diet/${id}`, { method: "DELETE", cookie });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ok: true });
  });
});

describe("presets: seeded catalogue and preset-based diet entries", () => {
  const seeded: [string, number, number][] = [
    ["Oats + whey", 420, 35],
    ["3 eggs + toast", 380, 24],
    ["Chicken rice bowl", 650, 48],
    ["Greek yogurt + berries", 220, 18],
    ["Salmon + potatoes", 600, 42],
    ["Protein shake", 160, 30],
    ["Beef mince + pasta", 720, 45],
    ["Takeaway pizza", 1100, 38],
  ];

  it("GET /api/presets returns the seeded catalogue with exact macros", async () => {
    const res = await api("/api/presets", { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as PresetRow[];
    expect(rows.length).toBeGreaterThanOrEqual(seeded.length);
    for (const [name, kcal, proteinG] of seeded) {
      const row = rows.find((r) => r.name === name);
      expect(row, `seeded preset missing: ${name}`).toBeDefined();
      expect(row).toMatchObject({ name, kcal, proteinG });
      expect(typeof row!.id).toBe("number");
    }
  });

  it("logging a diet entry from a seeded preset persists the preset's macros", async () => {
    const presets = await api("/api/presets", { cookie });
    const oats = (presets.json as PresetRow[]).find((r) => r.name === "Oats + whey")!;
    expect(oats).toBeDefined();

    const res = await api("/api/diet", {
      method: "POST", cookie,
      body: { date: D_PRESET, name: oats.name, kcal: oats.kcal, proteinG: oats.proteinG },
    });
    expect(res.status).toBe(201);
    const row = res.json as DietRow;
    expect(row).toMatchObject({ date: D_PRESET, name: "Oats + whey", kcal: 420, proteinG: 35 });
    createdDietIds.push(row.id);

    const list = await api(`/api/diet?date=${D_PRESET}`, { cookie });
    expect((list.json as DietRow[]).map((r) => r.name)).toContain("Oats + whey");
  });

  it("POST /api/presets creates a custom preset that then appears in the catalogue", async () => {
    const name = "INT-TEST custom preset 2030-02";
    const res = await api("/api/presets", {
      method: "POST", cookie,
      body: { name, kcal: 333, proteinG: 22, carbsG: 40, fatG: 9 },
    });
    expect(res.status).toBe(201);
    const row = res.json as PresetRow;
    expect(row).toMatchObject({ name, kcal: 333, proteinG: 22, carbsG: 40, fatG: 9 });
    createdPresetIds.push(row.id);

    const list = await api("/api/presets", { cookie });
    expect((list.json as PresetRow[]).some((r) => r.id === row.id && r.name === name)).toBe(true);
  });
});

describe("exercises: seeded catalogue", () => {
  it("GET /api/exercises returns the full seeded catalogue with the expected shape", async () => {
    const res = await api("/api/exercises", { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(31);
    for (const r of rows) {
      expect(typeof r.id).toBe("number");
      expect(typeof r.name).toBe("string");
      expect(typeof r.muscleGroup).toBe("string");
      expect(typeof r.dayType).toBe("string");
      expect(typeof r.targetSets).toBe("number");
      expect(typeof r.repLow).toBe("number");
      expect(typeof r.repHigh).toBe("number");
      expect(typeof r.orderIndex).toBe("number");
    }
    const bench = rows.find((r) => r.name === "Barbell Bench Press" && r.dayType === "chest_shoulders");
    expect(bench).toMatchObject({
      muscleGroup: "chest", dayType: "chest_shoulders",
      targetSets: 4, repLow: 6, repHigh: 10, supersetGroup: null, orderIndex: 1,
    });
  });

  it("GET /api/exercises?dayType=legs returns the 5 legs-day exercises in orderIndex order", async () => {
    const res = await api("/api/exercises?dayType=legs", { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as { name: string; dayType: string; orderIndex: number }[];
    expect(rows.map((r) => r.name)).toEqual([
      "Goblet Squat",
      "Romanian Deadlift",
      "Side-Lying Hip Abduction",
      "Single-Leg Squat / Step-Down",
      "Single-Leg Bridge",
    ]);
    expect(rows.every((r) => r.dayType === "legs")).toBe(true);
    expect(rows.map((r) => r.orderIndex)).toEqual([1, 2, 3, 4, 5]);
  });

  it("GET /api/exercises?dayType=unknown returns an empty array", async () => {
    const res = await api("/api/exercises?dayType=no_such_day", { cookie });
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
  });
});

describe("settings: singleton read, update, restore", () => {
  it("GET returns the singleton with integer targets", async () => {
    const res = await api("/api/settings", { cookie });
    expect(res.status).toBe(200);
    const s = res.json as { id: number; calorieTarget: number; proteinTarget: number };
    expect(s.id).toBe(1);
    expect(Number.isInteger(s.calorieTarget)).toBe(true);
    expect(Number.isInteger(s.proteinTarget)).toBe(true);
    expect(s.calorieTarget).toBeGreaterThan(0);
    expect(s.proteinTarget).toBeGreaterThan(0);
  });

  it("PUT updates the singleton and GET reflects the new values", async () => {
    const put = await api("/api/settings", {
      method: "PUT", cookie,
      body: { calorieTarget: 2222, proteinTarget: 177 },
    });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ ok: true });

    const get = await api("/api/settings", { cookie });
    expect(get.status).toBe(200);
    expect(get.json).toMatchObject({ id: 1, calorieTarget: 2222, proteinTarget: 177 });
  });
});

describe("validation: 400 on malformed bodies", () => {
  const dietBad: [string, unknown][] = [
    ["non-ISO date", { date: "2030-2-1", name: "x", kcal: 100, proteinG: 10 }],
    ["missing name", { date: D_MANUAL, kcal: 100, proteinG: 10 }],
    ["empty name", { date: D_MANUAL, name: "", kcal: 100, proteinG: 10 }],
    ["negative kcal", { date: D_MANUAL, name: "x", kcal: -1, proteinG: 10 }],
    ["non-integer kcal", { date: D_MANUAL, name: "x", kcal: 100.5, proteinG: 10 }],
    ["negative proteinG", { date: D_MANUAL, name: "x", kcal: 100, proteinG: -2 }],
    ["null body", null],
    ["empty object", {}],
  ];
  it.each(dietBad)("POST /api/diet rejects %s", async (_label, body) => {
    const res = await api("/api/diet", { method: "POST", cookie, body });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });

  const presetBad: [string, unknown][] = [
    ["missing kcal", { name: "x", proteinG: 10 }],
    ["negative proteinG", { name: "x", kcal: 100, proteinG: -1 }],
    ["empty name", { name: "", kcal: 100, proteinG: 10 }],
    ["empty object", {}],
  ];
  it.each(presetBad)("POST /api/presets rejects %s", async (_label, body) => {
    const res = await api("/api/presets", { method: "POST", cookie, body });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });

  const settingsBad: [string, unknown][] = [
    ["zero calorieTarget", { calorieTarget: 0, proteinTarget: 170 }],
    ["negative proteinTarget", { calorieTarget: 2000, proteinTarget: -5 }],
    ["non-integer calorieTarget", { calorieTarget: 2000.5, proteinTarget: 170 }],
    ["missing proteinTarget", { calorieTarget: 2000 }],
    ["empty object", {}],
  ];
  it.each(settingsBad)("PUT /api/settings rejects %s", async (_label, body) => {
    const res = await api("/api/settings", { method: "PUT", cookie, body });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });
});
