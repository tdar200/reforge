import { beforeEach, expect, test, vi } from "vitest";
import { NoObjectGeneratedError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { estimateMeal, ESTIMATE_SYSTEM_PROMPT, MealEstimate } from "../estimate";
import {
  analyzeMeal,
  macrosUnknown,
  NutritionPanel,
  type NutritionContext,
} from "../nutrition";

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

const answering = (value: unknown) =>
  new MockLanguageModelV3({
    doGenerate: textResult(typeof value === "string" ? value : JSON.stringify(value)),
  });

beforeEach(() => {
  model = answering("{}");
});

// ---------- MealEstimate schema ----------

test("MealEstimate accepts a valid pair and both bounds", () => {
  expect(MealEstimate.safeParse({ kcal: 247, proteinG: 8.5 }).success).toBe(true);
  expect(MealEstimate.safeParse({ kcal: 0, proteinG: 0 }).success).toBe(true);
  expect(MealEstimate.safeParse({ kcal: 5000, proteinG: 500 }).success).toBe(true);
});

test("MealEstimate rejects a non-integer kcal", () => {
  expect(MealEstimate.safeParse({ kcal: 247.5, proteinG: 8.5 }).success).toBe(false);
});

test("MealEstimate rejects kcal above 5000", () => {
  expect(MealEstimate.safeParse({ kcal: 5001, proteinG: 8 }).success).toBe(false);
});

test("MealEstimate rejects a negative protein", () => {
  expect(MealEstimate.safeParse({ kcal: 247, proteinG: -1 }).success).toBe(false);
});

test("MealEstimate rejects protein above 500", () => {
  expect(MealEstimate.safeParse({ kcal: 247, proteinG: 501 }).success).toBe(false);
});

test("MealEstimate rejects missing fields", () => {
  expect(MealEstimate.safeParse({ kcal: 247 }).success).toBe(false);
  expect(MealEstimate.safeParse({ proteinG: 8.5 }).success).toBe(false);
  expect(MealEstimate.safeParse({}).success).toBe(false);
});

// ---------- estimateMeal ----------

test("a valid model answer is returned as-is", async () => {
  model = answering({ kcal: 247, proteinG: 8.5 });
  await expect(estimateMeal("Actileaf Barista Style Oat Drink")).resolves.toEqual({
    kcal: 247,
    proteinG: 8.5,
  });
});

test("schema-invalid model output throws NoObjectGeneratedError", async () => {
  model = answering({ kcal: 9999, proteinG: -3 });
  const err = await estimateMeal("Oat drink").catch((e: unknown) => e);
  expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
});

test("non-JSON model output throws NoObjectGeneratedError", async () => {
  model = answering("sorry, I cannot estimate that");
  const err = await estimateMeal("Oat drink").catch((e: unknown) => e);
  expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
});

test("sends ESTIMATE_SYSTEM_PROMPT, the name as prompt, maxOutputTokens 1500 and json format", async () => {
  model = answering({ kcal: 247, proteinG: 8.5 });
  await estimateMeal("Actileaf Barista Style Oat Drink");
  expect(model.doGenerateCalls).toHaveLength(1);
  const call = model.doGenerateCalls[0];
  expect(call.prompt[0]).toMatchObject({ role: "system", content: ESTIMATE_SYSTEM_PROMPT });
  expect(call.prompt[1]).toMatchObject({
    role: "user",
    content: [{ type: "text", text: "Actileaf Barista Style Oat Drink" }],
  });
  expect(call.maxOutputTokens).toBe(1500);
  expect(call.responseFormat?.type).toBe("json");
});

test("a name longer than 120 chars is truncated to exactly 120 in the prompt", async () => {
  model = answering({ kcal: 247, proteinG: 8.5 });
  const long = "a".repeat(119) + "b" + "c".repeat(80);
  await estimateMeal(long);
  const sent = (model.doGenerateCalls[0].prompt[1].content as { type: string; text: string }[])[0];
  expect(sent.text).toHaveLength(120);
  expect(sent.text).toBe(long.slice(0, 120));
  expect(sent.text.endsWith("b")).toBe(true);
});

// ---------- macrosUnknown ----------

test("macrosUnknown is true only for a 0/0 meal", () => {
  expect(macrosUnknown({ kcal: 0, proteinG: 0 })).toBe(true);
  expect(macrosUnknown({ kcal: 0, proteinG: 8.5 })).toBe(false);
  expect(macrosUnknown({ kcal: 247, proteinG: 0 })).toBe(false);
  expect(macrosUnknown({ kcal: 247, proteinG: 8.5 })).toBe(false);
});

// ---------- analyzeMeal pinning branch ----------

const modelPanel = (): NutritionPanel => ({
  estimated: false,
  macros: {
    kcal: 247,
    proteinG: 8.5,
    carbsG: 30,
    fatG: 9,
    saturatedFatG: 1,
    fiberG: 3,
    sugarG: 12,
    saltG: 0.3,
  },
  micros: {
    vitaminA_ug: 100,
    vitaminC_mg: 2,
    vitaminD_ug: 1.5,
    vitaminE_mg: 1,
    vitaminB12_ug: 0.9,
    folate_ug: 20,
    calcium_mg: 300,
    iron_mg: 0.4,
    potassium_mg: 320,
    magnesium_mg: 30,
    zinc_mg: 0.6,
  },
  advice: { verdict: "ok", summary: "Roughly a barista oat drink serving.", swap: null },
});

const ctxFor = (meal: NutritionContext["meal"]): NutritionContext => ({
  meal,
  date: "2030-04-15",
  dayTotals: { kcal: 1200, proteinG: 90 },
  targets: { kcal: 2000, protein: 150 },
});

test("logged macros are pinned over the model's when the meal has real macros", async () => {
  model = answering(modelPanel());
  const panel = await analyzeMeal(
    ctxFor({ name: "Actileaf Barista Style Oat Drink", kcal: 120, proteinG: 4 }),
  );
  expect(panel.macros.kcal).toBe(120);
  expect(panel.macros.proteinG).toBe(4);
  expect(panel.macros.carbsG).toBe(30);
  expect(panel.estimated).toBe(true);
});

test("a 0/0 meal keeps the model's estimated kcal and protein", async () => {
  model = answering(modelPanel());
  const panel = await analyzeMeal(
    ctxFor({ name: "Actileaf Barista Style Oat Drink", kcal: 0, proteinG: 0 }),
  );
  expect(panel.macros.kcal).toBe(247);
  expect(panel.macros.proteinG).toBe(8.5);
  expect(panel.macros).toEqual(modelPanel().macros);
  expect(panel.estimated).toBe(true);
});

test("analyzeMeal sends maxOutputTokens 6000", async () => {
  model = answering(modelPanel());
  await analyzeMeal(ctxFor({ name: "Oat drink", kcal: 0, proteinG: 0 }));
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(model.doGenerateCalls[0].maxOutputTokens).toBe(6000);
});
