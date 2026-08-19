import { expect, test } from "vitest";
import { planCommit, CommitError } from "../commit";
import type { Proposal } from "../schemas";

const base = { date: "2026-08-19", dayType: "chest_shoulders", sessionId: 7, maxSetByExercise: {}, existingMetric: null };

test("expands a set proposal into numbered set_logs after existing sets", () => {
  const items: Proposal[] = [{ kind: "set", exerciseId: 1, exerciseName: "Bench", sets: 3, reps: 8, weight: 60 }];
  const plan = planCommit(items, { ...base, maxSetByExercise: { 1: 2 } });
  expect(plan.setRows).toEqual([
    { sessionId: 7, exerciseId: 1, setNumber: 3, weight: 60, reps: 8 },
    { sessionId: 7, exerciseId: 1, setNumber: 4, weight: 60, reps: 8 },
    { sessionId: 7, exerciseId: 1, setNumber: 5, weight: 60, reps: 8 },
  ]);
  expect(plan.counts).toEqual({ sets: 3, cardio: 0, meals: 0, metrics: 0 });
});

test("two proposals for the same exercise keep numbering continuous", () => {
  const items: Proposal[] = [
    { kind: "set", exerciseId: 1, exerciseName: "Bench", sets: 2, reps: 8, weight: 60 },
    { kind: "set", exerciseId: 1, exerciseName: "Bench", sets: 1, reps: 6, weight: 65 },
  ];
  const plan = planCommit(items, base);
  expect(plan.setRows.map((r) => r.setNumber)).toEqual([1, 2, 3]);
});

test("throws unresolved_exercise for a set with null exerciseId", () => {
  const items: Proposal[] = [{ kind: "set", exerciseId: null, exerciseName: "Zercher", sets: 1, reps: 5, weight: 80 }];
  expect(() => planCommit(items, base)).toThrow(CommitError);
  try { planCommit(items, base); } catch (e) { expect((e as CommitError).code).toBe("unresolved_exercise"); }
});

test("throws missing_session when sets are present but sessionId is null", () => {
  const items: Proposal[] = [{ kind: "set", exerciseId: 1, exerciseName: "Bench", sets: 1, reps: 5, weight: 80 }];
  try { planCommit(items, { ...base, sessionId: null }); expect.fail("should throw"); }
  catch (e) { expect((e as CommitError).code).toBe("missing_session"); }
});

test("maps cardio and meals to rows with the date", () => {
  const items: Proposal[] = [
    { kind: "cardio", type: "bike", minutes: 20 },
    { kind: "meal", name: "Oats", kcal: 400, proteinG: 20, presetId: null, estimated: true },
  ];
  const plan = planCommit(items, { ...base, sessionId: null });
  expect(plan.cardioRows).toEqual([{ date: "2026-08-19", type: "bike", minutes: 20, notes: null }]);
  expect(plan.mealRows).toEqual([{ date: "2026-08-19", name: "Oats", kcal: 400, proteinG: 20 }]);
  expect(plan.counts).toEqual({ sets: 0, cardio: 1, meals: 1, metrics: 0 });
});

test("metrics merge into one insert when no row exists for the date", () => {
  const items: Proposal[] = [
    { kind: "metric", field: "bodyweight", value: 79.6 },
    { kind: "metric", field: "waist", value: 98 },
  ];
  const plan = planCommit(items, { ...base, sessionId: null });
  expect(plan.metric).toEqual({ op: "insert", values: { date: "2026-08-19", bodyweight: 79.6, waist: 98 } });
  expect(plan.counts.metrics).toBe(2);
});

test("metrics become an update when a row exists for the date", () => {
  const items: Proposal[] = [{ kind: "metric", field: "bodyweight", value: 79.6 }];
  const plan = planCommit(items, { ...base, sessionId: null, existingMetric: { id: 42 } });
  expect(plan.metric).toEqual({ op: "update", id: 42, values: { bodyweight: 79.6 } });
});
