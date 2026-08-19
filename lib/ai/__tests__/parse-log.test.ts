import { expect, test } from "vitest";
import { buildParseSystemPrompt, sanitizeParsed, type ParseContext } from "../parse-log";

const ctx: ParseContext = {
  date: "2026-08-19", dayType: "chest_shoulders",
  exercises: [
    { id: 1, name: "Barbell Bench Press", muscleGroup: "chest", dayType: "chest_shoulders" },
    { id: 9, name: "Barbell Curl", muscleGroup: "biceps", dayType: "arms1" },
  ],
  presets: [{ id: 3, name: "Oats + whey", kcal: 420, proteinG: 35 }],
  lastSets: { 1: [{ weight: 60, reps: 8 }, { weight: 60, reps: 7 }] },
};

test("system prompt lists today's exercises first, then others, presets and last sets", () => {
  const p = buildParseSystemPrompt(ctx);
  expect(p.indexOf("Barbell Bench Press")).toBeLessThan(p.indexOf("Barbell Curl"));
  expect(p).toContain("id 1");
  expect(p).toContain("Oats + whey");
  expect(p).toContain("60x8");
  expect(p).toContain("2026-08-19");
  expect(p).toMatch(/never invent/i);
});

test("sanitizeParsed nulls ids that are not in the catalogue", () => {
  const out = sanitizeParsed({
    items: [
      { kind: "set", exerciseId: 999, exerciseName: "Bench", sets: 3, reps: 8, weight: 60 },
      { kind: "set", exerciseId: 1, exerciseName: "Bench", sets: 3, reps: 8, weight: 60 },
      { kind: "meal", name: "Oats", kcal: 420, proteinG: 35, presetId: 77, estimated: false },
      { kind: "meal", name: "Oats", kcal: 420, proteinG: 35, presetId: 3, estimated: false },
    ],
    note: null,
  }, ctx);
  expect(out.items[0]).toMatchObject({ kind: "set", exerciseId: null });
  expect(out.items[1]).toMatchObject({ kind: "set", exerciseId: 1 });
  expect(out.items[2]).toMatchObject({ kind: "meal", presetId: null, estimated: true });
  expect(out.items[3]).toMatchObject({ kind: "meal", presetId: 3, estimated: false });
});
