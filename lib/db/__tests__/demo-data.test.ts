import { expect, test } from "vitest";
import { generateDemoData, type DemoExercise } from "../demo-data";
import { SEED_EXERCISES } from "../seed-data";

const exercises: DemoExercise[] = SEED_EXERCISES.map((e, i) => ({ id: i + 1, ...e }));

test("is deterministic for the same seed", () => {
  const a = generateDemoData(42, "2026-08-19", exercises);
  const b = generateDemoData(42, "2026-08-19", exercises);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test("covers 21 days ending today with sessions only on training days", () => {
  const d = generateDemoData(42, "2026-08-19", exercises);
  const dates = d.sessions.map((s) => s.date);
  expect(Math.min(...dates.map((x) => Date.parse(x)))).toBeGreaterThanOrEqual(Date.parse("2026-07-30"));
  expect(Math.max(...dates.map((x) => Date.parse(x)))).toBeLessThanOrEqual(Date.parse("2026-08-19"));
  for (const s of d.sessions) expect(s.dayType).not.toBe("rest");
  expect(d.sessions.length).toBeGreaterThanOrEqual(12); // 3 weeks x 5 days, minus the deliberately skipped ones
});

test("weights trend upward across weeks for the same exercise", () => {
  const d = generateDemoData(42, "2026-08-19", exercises);
  const bench = exercises.find((e) => e.name === "Barbell Bench Press")!;
  const benchTop = d.sessions
    .filter((s) => s.sets.some((x) => x.exerciseId === bench.id))
    .map((s) => Math.max(...s.sets.filter((x) => x.exerciseId === bench.id).map((x) => x.weight)));
  expect(benchTop.length).toBeGreaterThanOrEqual(2);
  expect(benchTop[benchTop.length - 1]).toBeGreaterThan(benchTop[0]);
});

test("has meals every day, some cardio, a falling bodyweight trend and presets", () => {
  const d = generateDemoData(42, "2026-08-19", exercises);
  const dietDates = new Set(d.diet.map((x) => x.date));
  expect(dietDates.size).toBe(21);
  expect(d.cardio.length).toBeGreaterThanOrEqual(6);
  const bw = d.metrics.filter((m) => m.bodyweight !== null).map((m) => m.bodyweight!);
  expect(bw[bw.length - 1]).toBeLessThan(bw[0]);
  expect(d.presets.length).toBeGreaterThanOrEqual(6);
});
