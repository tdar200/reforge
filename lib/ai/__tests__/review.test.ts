import { expect, test } from "vitest";
import { buildCoachContext, periodFor, REVIEW_SYSTEM_PROMPT, type ReviewInput } from "../review";

const input: ReviewInput = {
  periodStart: "2026-08-06", periodEnd: "2026-08-19",
  targets: { kcal: 2000, protein: 150 },
  sessions: [
    { id: 1, date: "2026-08-10", dayType: "chest_shoulders" }, // Mon
    { id: 2, date: "2026-08-11", dayType: "arms1" },           // Tue
  ],
  sets: [
    { sessionId: 1, exerciseId: 1, exerciseName: "Bench", weight: 60, reps: 8 },
    { sessionId: 1, exerciseId: 1, exerciseName: "Bench", weight: 62.5, reps: 6 },
    { sessionId: 1, exerciseId: 1, exerciseName: "Bench", weight: 62.5, reps: 8 },
    { sessionId: 2, exerciseId: 9, exerciseName: "Curl", weight: 20, reps: 10 },
  ],
  diet: [
    { date: "2026-08-10", kcal: 800, proteinG: 60 }, { date: "2026-08-10", kcal: 900, proteinG: 70 },
    { date: "2026-08-11", kcal: 1500, proteinG: 90 },
  ],
  cardio: [{ date: "2026-08-12", type: "bike", minutes: 20 }],
  metrics: [{ date: "2026-08-10", bodyweight: 80, waist: 100 }],
};

test("top set is the heaviest weight, ties broken by reps", () => {
  const ctx = buildCoachContext(input);
  const bench = ctx.sessions[0].exercises[0];
  expect(bench).toEqual({ name: "Bench", topSet: { weight: 62.5, reps: 8 }, sets: 3 });
});

test("daily nutrition sums per date and sorts by date", () => {
  const ctx = buildCoachContext(input);
  expect(ctx.dailyNutrition).toEqual([
    { date: "2026-08-10", kcal: 1700, proteinG: 130 },
    { date: "2026-08-11", kcal: 1500, proteinG: 90 },
  ]);
});

test("adherence counts planned training weekdays in the window and sessions with sets", () => {
  const ctx = buildCoachContext(input);
  // 2026-08-06 (Thu) .. 2026-08-19 (Wed) = 14 days, 2 Sat + 2 Sun rest -> 10 planned
  expect(ctx.adherence).toEqual({ planned: 10, done: 2 });
});

test("periodFor returns a 14-day window ending today", () => {
  expect(periodFor("2026-08-19")).toEqual({ periodStart: "2026-08-06", periodEnd: "2026-08-19" });
});

test("system prompt pins the required sections and length", () => {
  expect(REVIEW_SYSTEM_PROMPT).toContain("What went well");
  expect(REVIEW_SYSTEM_PROMPT).toContain("What slipped");
  expect(REVIEW_SYSTEM_PROMPT).toContain("Next week");
  expect(REVIEW_SYSTEM_PROMPT).toContain("One caution");
  expect(REVIEW_SYSTEM_PROMPT).toContain("250 words");
});
