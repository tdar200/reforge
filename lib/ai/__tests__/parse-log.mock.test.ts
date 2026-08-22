import { beforeEach, expect, test, vi } from "vitest";
import { NoObjectGeneratedError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { buildParseSystemPrompt, parseQuickLog, type ParseContext } from "../parse-log";

let model: MockLanguageModelV3;
vi.mock("../model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model")>()),
  getModel: () => model,
}));

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  },
  warnings: [],
});

const ctx: ParseContext = {
  date: "2030-04-15",
  dayType: "chest_shoulders",
  exercises: [
    { id: 1, name: "Barbell Bench Press", muscleGroup: "chest", dayType: "chest_shoulders" },
    { id: 9, name: "Barbell Curl", muscleGroup: "biceps", dayType: "arms1" },
  ],
  presets: [{ id: 3, name: "Oats + whey", kcal: 420, proteinG: 35 }],
  lastSets: { 1: [{ weight: 60, reps: 8 }] },
};

beforeEach(() => {
  model = new MockLanguageModelV3({ doGenerate: textResult("{}") });
});

test("valid model output flows through sanitizeParsed: unknown ids nulled, known kept", async () => {
  model = new MockLanguageModelV3({
    doGenerate: textResult(JSON.stringify({
      items: [
        { kind: "set", exerciseId: 1, exerciseName: "Bench", sets: 3, reps: 8, weight: 60 },
        { kind: "set", exerciseId: 999, exerciseName: "Mystery Press", sets: 1, reps: 5, weight: 20 },
        { kind: "meal", name: "Oats + whey", kcal: 420, proteinG: 35, presetId: 3, estimated: false },
        { kind: "meal", name: "Random shake", kcal: 300, proteinG: 25, presetId: 77, estimated: false },
        { kind: "metric", field: "bodyweight", value: 79.6 },
      ],
      note: null,
    })),
  });
  const out = await parseQuickLog("bench 3x8 at 60, weight 79.6", ctx);
  expect(out.items).toHaveLength(5);
  expect(out.items[0]).toMatchObject({ kind: "set", exerciseId: 1, sets: 3, reps: 8, weight: 60 });
  expect(out.items[1]).toMatchObject({ kind: "set", exerciseId: null, exerciseName: "Mystery Press" });
  expect(out.items[2]).toMatchObject({ kind: "meal", presetId: 3, estimated: false });
  expect(out.items[3]).toMatchObject({ kind: "meal", presetId: null, estimated: true });
  expect(out.items[4]).toEqual({ kind: "metric", field: "bodyweight", value: 79.6 });
  expect(out.note).toBeNull();
});

test("sends the built system prompt, the raw text as user prompt, and json response format", async () => {
  model = new MockLanguageModelV3({
    doGenerate: textResult(JSON.stringify({ items: [], note: "nothing" })),
  });
  const out = await parseQuickLog("rest day", ctx);
  expect(out).toEqual({ items: [], note: "nothing" });
  expect(model.doGenerateCalls).toHaveLength(1);
  const call = model.doGenerateCalls[0];
  expect(call.prompt[0]).toMatchObject({ role: "system", content: buildParseSystemPrompt(ctx) });
  expect(call.prompt[1]).toMatchObject({ role: "user", content: [{ type: "text", text: "rest day" }] });
  expect(call.responseFormat?.type).toBe("json");
});

test("schema-invalid model output throws NoObjectGeneratedError", async () => {
  model = new MockLanguageModelV3({
    doGenerate: textResult(JSON.stringify({ items: [{ kind: "set" }], note: null })),
  });
  const err = await parseQuickLog("bench", ctx).catch((e: unknown) => e);
  expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
});

test("non-JSON model output throws NoObjectGeneratedError", async () => {
  model = new MockLanguageModelV3({ doGenerate: textResult("sorry, I cannot do that") });
  const err = await parseQuickLog("bench", ctx).catch((e: unknown) => e);
  expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
});
