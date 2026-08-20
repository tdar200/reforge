import { generateText, Output } from "ai";
import { z } from "zod";
import { getModel } from "./model";

export const NutritionPanel = z.object({
  estimated: z.boolean(),
  macros: z.object({
    kcal: z.number().int().min(0).max(5000),
    proteinG: z.number().min(0).max(500),
    carbsG: z.number().min(0).max(1000),
    fatG: z.number().min(0).max(500),
    saturatedFatG: z.number().min(0).max(200),
    fiberG: z.number().min(0).max(200),
    sugarG: z.number().min(0).max(500),
    saltG: z.number().min(0).max(50),
  }),
  micros: z.object({
    vitaminA_ug: z.number().min(0).max(10000),
    vitaminC_mg: z.number().min(0).max(2000),
    vitaminD_ug: z.number().min(0).max(250),
    vitaminE_mg: z.number().min(0).max(1000),
    vitaminB12_ug: z.number().min(0).max(500),
    folate_ug: z.number().min(0).max(5000),
    calcium_mg: z.number().min(0).max(3000),
    iron_mg: z.number().min(0).max(100),
    potassium_mg: z.number().min(0).max(10000),
    magnesium_mg: z.number().min(0).max(2000),
    zinc_mg: z.number().min(0).max(100),
  }),
  advice: z.object({
    verdict: z.enum(["good", "ok", "poor"]),
    summary: z.string().min(1).max(300),
    swap: z.string().min(1).max(300).nullable(),
  }),
});
export type NutritionPanel = z.infer<typeof NutritionPanel>;

export type NutritionContext = {
  meal: { name: string; kcal: number; proteinG: number };
  date: string;
  dayTotals: { kcal: number; proteinG: number };
  targets: { kcal: number; protein: number };
};

export const NUTRITION_SYSTEM_PROMPT = [
  "You are a nutritionist advising a strength trainee on a slight calorie deficit.",
  "The JSON you receive has one logged meal, the day's totals so far (this meal included), and the daily targets.",
  "Estimate a full per-serving nutrition panel for the meal. When the name reads like a branded, chain, or shop-bought item, use typical UK supermarket portions.",
  "Anchor everything to the logged kcal and proteinG: keep those two values as given and scale every other estimate to be consistent with them.",
  "These are best estimates, not label values — always produce numbers, never refuse.",
  "verdict: 'good' if the meal fits the remaining day budget with solid protein density and reasonable saturated fat, sugar and salt; 'poor' if it clearly works against the targets; otherwise 'ok'.",
  "summary: one or two plain sentences quoting actual numbers from this data.",
  "swap: ONE concrete alternative from the same shop or context that would improve the verdict, with its rough kcal/protein; null if the meal is already a good pick.",
].join("\n");

export async function analyzeMeal(ctx: NutritionContext): Promise<NutritionPanel> {
  const result = await generateText({
    model: getModel(),
    system: NUTRITION_SYSTEM_PROMPT,
    prompt: JSON.stringify(ctx),
    output: Output.object({ schema: NutritionPanel }),
    // Reasoning tokens count toward this cap on gpt-5 models; leave headroom above the panel.
    maxOutputTokens: 2500,
  });
  const raw = NutritionPanel.parse(result.output);
  // Logged values are authoritative — pin them so the row and its panel never disagree,
  // then re-validate so a pinned panel can never escape the schema's own bounds.
  return NutritionPanel.parse({
    ...raw,
    estimated: true,
    macros: { ...raw.macros, kcal: ctx.meal.kcal, proteinG: ctx.meal.proteinG },
  });
}
