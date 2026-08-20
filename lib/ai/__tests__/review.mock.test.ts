import { beforeEach, expect, test, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { generateWeeklyReview, REVIEW_SYSTEM_PROMPT, type CoachContext } from "../review";

let model: MockLanguageModelV3;
vi.mock("../model", () => ({ getModel: () => model }));

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  },
  warnings: [],
});

const ctx: CoachContext = {
  periodStart: "2030-04-01", periodEnd: "2030-04-14",
  targets: { kcal: 2000, protein: 150 },
  sessions: [{ date: "2030-04-01", dayType: "chest_shoulders", exercises: [{ name: "Bench", topSet: { weight: 60, reps: 8 }, sets: 3 }] }],
  dailyNutrition: [{ date: "2030-04-01", kcal: 1900, proteinG: 140 }],
  cardio: [{ date: "2030-04-02", type: "bike", minutes: 20 }],
  metrics: [{ date: "2030-04-01", bodyweight: 79.6, waist: 98 }],
  adherence: { planned: 10, done: 1 },
};

beforeEach(() => {
  model = new MockLanguageModelV3({
    doGenerate: textResult("  ## What went well\nBench moved up.\n\n## One caution\nSleep.  \n"),
  });
});

test("returns the model text trimmed", async () => {
  const out = await generateWeeklyReview(ctx);
  expect(out).toBe("## What went well\nBench moved up.\n\n## One caution\nSleep.");
});

test("passes maxOutputTokens 2000, the review system prompt, and the context as user prompt", async () => {
  await generateWeeklyReview(ctx);
  expect(model.doGenerateCalls).toHaveLength(1);
  const call = model.doGenerateCalls[0];
  expect(call.maxOutputTokens).toBe(2000);
  expect(call.prompt[0]).toMatchObject({ role: "system", content: REVIEW_SYSTEM_PROMPT });
  expect(call.prompt[1]).toMatchObject({ role: "user", content: [{ type: "text", text: JSON.stringify(ctx) }] });
});
