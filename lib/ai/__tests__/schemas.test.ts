import { expect, test } from "vitest";
import { Proposal, ParsedLog, ParseRequest, CommitRequest } from "../schemas";

test("accepts one of each proposal kind", () => {
  const items = [
    { kind: "set", exerciseId: 1, exerciseName: "Barbell Bench Press", sets: 3, reps: 8, weight: 60 },
    { kind: "set", exerciseId: null, exerciseName: "Zercher squat", sets: 2, reps: 5, weight: 80 },
    { kind: "cardio", type: "bike", minutes: 20 },
    { kind: "meal", name: "2 eggs + oats", kcal: 420, proteinG: 22, presetId: null, estimated: true },
    { kind: "metric", field: "bodyweight", value: 79.6 },
  ];
  const r = ParsedLog.safeParse({ items, note: null });
  expect(r.success).toBe(true);
});

test("rejects out-of-range numbers and unknown kinds", () => {
  expect(Proposal.safeParse({ kind: "set", exerciseId: 1, exerciseName: "x", sets: 0, reps: 8, weight: 60 }).success).toBe(false);
  expect(Proposal.safeParse({ kind: "set", exerciseId: 1, exerciseName: "x", sets: 3, reps: 8, weight: 600 }).success).toBe(false);
  expect(Proposal.safeParse({ kind: "cardio", type: "bike", minutes: 0 }).success).toBe(false);
  expect(Proposal.safeParse({ kind: "meal", name: "x", kcal: -1, proteinG: 0, presetId: null, estimated: false }).success).toBe(false);
  expect(Proposal.safeParse({ kind: "metric", field: "height", value: 180 }).success).toBe(false);
  expect(Proposal.safeParse({ kind: "sleep", hours: 8 }).success).toBe(false);
});

test("ParsedLog caps items at 40", () => {
  const item = { kind: "cardio", type: "walk", minutes: 10 };
  expect(ParsedLog.safeParse({ items: Array(40).fill(item), note: null }).success).toBe(true);
  expect(ParsedLog.safeParse({ items: Array(41).fill(item), note: null }).success).toBe(false);
});

test("request schemas validate text length, date format and non-empty commit", () => {
  expect(ParseRequest.safeParse({ text: "bench 3x8 at 60", date: "2026-08-19" }).success).toBe(true);
  expect(ParseRequest.safeParse({ text: "", date: "2026-08-19" }).success).toBe(false);
  expect(ParseRequest.safeParse({ text: "x".repeat(1001), date: "2026-08-19" }).success).toBe(false);
  expect(ParseRequest.safeParse({ text: "x", date: "19/08/2026" }).success).toBe(false);
  expect(CommitRequest.safeParse({ date: "2026-08-19", items: [] }).success).toBe(false);
});
