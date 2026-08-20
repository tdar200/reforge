import { generateText, Output } from "ai";
import { z } from "zod";
import { getModel } from "./model";

// Bounds match MealProposal so an estimate is always a valid diet entry.
export const MealEstimate = z.object({
  kcal: z.number().int().min(0).max(5000),
  proteinG: z.number().min(0).max(500),
});
export type MealEstimate = z.infer<typeof MealEstimate>;

export const ESTIMATE_SYSTEM_PROMPT = [
  "You estimate the calories and protein of a food a UK shopper just logged.",
  "Answer for ONE typical serving as it would actually be eaten, not per 100 g, unless the name says otherwise.",
  "For branded, supermarket or chain items use that product's usual UK single-serving pack size.",
  "These are best estimates, not label values — always return numbers, never refuse.",
].join("\n");

export async function estimateMeal(name: string): Promise<MealEstimate> {
  const result = await generateText({
    model: getModel(),
    system: ESTIMATE_SYSTEM_PROMPT,
    prompt: name.slice(0, 120),
    output: Output.object({ schema: MealEstimate }),
    // Reasoning tokens count toward this cap on gpt-5 models.
    maxOutputTokens: 1500,
  });
  return MealEstimate.parse(result.output);
}
