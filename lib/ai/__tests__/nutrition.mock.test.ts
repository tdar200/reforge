import { beforeEach, expect, test, vi } from "vitest";
import { NoObjectGeneratedError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  analyzeMeal,
  NUTRITION_SYSTEM_PROMPT,
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

const validPanel = (): NutritionPanel => ({
  estimated: true,
  macros: {
    kcal: 420,
    proteinG: 35,
    carbsG: 45,
    fatG: 12,
    saturatedFatG: 3,
    fiberG: 6,
    sugarG: 10,
    saltG: 0.8,
  },
  micros: {
    vitaminA_ug: 120,
    vitaminC_mg: 4,
    vitaminD_ug: 1.2,
    vitaminE_mg: 2,
    vitaminB12_ug: 1.1,
    folate_ug: 40,
    calcium_mg: 220,
    iron_mg: 2.5,
    potassium_mg: 500,
    magnesium_mg: 90,
    zinc_mg: 1.8,
  },
  advice: { verdict: "good", summary: "Solid protein for the kcal.", swap: null },
});

const ctx: NutritionContext = {
  meal: { name: "Oats + whey", kcal: 420, proteinG: 35 },
  date: "2030-04-15",
  dayTotals: { kcal: 1200, proteinG: 90 },
  targets: { kcal: 2000, protein: 150 },
};

beforeEach(() => {
  model = new MockLanguageModelV3({ doGenerate: textResult("{}") });
});

test("NutritionPanel accepts a full valid panel", () => {
  expect(NutritionPanel.safeParse(validPanel()).success).toBe(true);
});

test("NutritionPanel rejects a missing micro", () => {
  const panel: Record<string, unknown> = structuredClone(validPanel());
  delete (panel.micros as Record<string, unknown>).zinc_mg;
  expect(NutritionPanel.safeParse(panel).success).toBe(false);
});

test("NutritionPanel rejects out-of-range values", () => {
  const over = validPanel();
  over.macros.kcal = 6000;
  expect(NutritionPanel.safeParse(over).success).toBe(false);
  const negative = validPanel();
  negative.micros.iron_mg = -1;
  expect(NutritionPanel.safeParse(negative).success).toBe(false);
});

test("NutritionPanel rejects an unknown verdict", () => {
  const panel = structuredClone(validPanel()) as Record<string, unknown>;
  (panel.advice as Record<string, unknown>).verdict = "great";
  expect(NutritionPanel.safeParse(panel).success).toBe(false);
});

test("valid model panel flows through with kcal/proteinG pinned to the logged values", async () => {
  const fromModel = validPanel();
  fromModel.macros.kcal = 999;
  fromModel.macros.proteinG = 1;
  model = new MockLanguageModelV3({ doGenerate: textResult(JSON.stringify(fromModel)) });
  const panel = await analyzeMeal(ctx);
  expect(panel.macros.kcal).toBe(420);
  expect(panel.macros.proteinG).toBe(35);
  expect(panel.macros.carbsG).toBe(45);
  expect(panel.micros).toEqual(validPanel().micros);
  expect(panel.advice).toEqual({ verdict: "good", summary: "Solid protein for the kcal.", swap: null });
});

test("estimated is forced true even when the model says false", async () => {
  const fromModel = validPanel();
  fromModel.estimated = false;
  model = new MockLanguageModelV3({ doGenerate: textResult(JSON.stringify(fromModel)) });
  const panel = await analyzeMeal(ctx);
  expect(panel.estimated).toBe(true);
});

test("schema-invalid model output throws NoObjectGeneratedError", async () => {
  model = new MockLanguageModelV3({
    doGenerate: textResult(JSON.stringify({ estimated: true, macros: {}, micros: {}, advice: {} })),
  });
  const err = await analyzeMeal(ctx).catch((e: unknown) => e);
  expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
});

test("non-JSON model output throws NoObjectGeneratedError", async () => {
  model = new MockLanguageModelV3({ doGenerate: textResult("sorry, I cannot do that") });
  const err = await analyzeMeal(ctx).catch((e: unknown) => e);
  expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
});

test("sends NUTRITION_SYSTEM_PROMPT, JSON.stringify(ctx) as prompt, and maxOutputTokens 6000", async () => {
  model = new MockLanguageModelV3({ doGenerate: textResult(JSON.stringify(validPanel())) });
  await analyzeMeal(ctx);
  expect(model.doGenerateCalls).toHaveLength(1);
  const call = model.doGenerateCalls[0];
  expect(call.prompt[0]).toMatchObject({ role: "system", content: NUTRITION_SYSTEM_PROMPT });
  expect(call.prompt[1]).toMatchObject({
    role: "user",
    content: [{ type: "text", text: JSON.stringify(ctx) }],
  });
  expect(call.maxOutputTokens).toBe(6000);
  expect(call.responseFormat?.type).toBe("json");
});
