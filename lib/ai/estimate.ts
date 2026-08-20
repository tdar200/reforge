import { generateText, Output } from "ai";
import { z } from "zod";
import { getModel } from "./model";
import { scaleToServing, searchFood } from "../food/openfoodfacts";

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

const ServingGuess = z.object({ grams: z.number().int().min(1).max(3000) });

export const SERVING_SYSTEM_PROMPT =
  "Give the weight in grams (or millilitres for a drink) of one typical UK serving of the named product, as it is normally eaten in one sitting.";

/** Null rather than throwing: a missing portion just sends the caller back to a full estimate. */
export async function guessServingGrams(productName: string): Promise<number | null> {
  try {
    const result = await generateText({
      model: getModel(),
      system: SERVING_SYSTEM_PROMPT,
      prompt: productName.slice(0, 120),
      output: Output.object({ schema: ServingGuess }),
      maxOutputTokens: 1500,
    });
    return ServingGuess.parse(result.output).grams;
  } catch {
    return null;
  }
}

/** Product names often already carry the brand; only prepend it when they don't. */
export function labelName(brand: string | null, productName: string): string {
  const name = productName.trim().replace(/\s+/g, " ");
  const b = (brand ?? "").split(",")[0].trim().replace(/\s+/g, " ");
  if (!b) return name;
  // Punctuation, spacing and accents are spelling differences, not different products:
  // "Co-op" is "Coop" and "Müller" is "Muller".
  const letters = (t: string) =>
    t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
  return letters(name).includes(letters(b)) ? name : `${b} ${name}`;
}

export type ResolvedMacros = MealEstimate & {
  /** "label" = real per-100 g values off a matched product; "estimate" = the model's own guess. */
  source: "label" | "estimate";
  matchedName: string | null;
  /** The portion the numbers are for, and whether it came off the product record or the model. */
  servingG: number | null;
  servingSource: "label" | "estimate" | null;
};

/**
 * Prefer a product's published label, fall back to the model.
 * The label supplies density (per 100 g) and the portion comes from the product record
 * or, failing that, the model — so a real serving is never invented from nothing.
 */
export async function resolveMacros(name: string): Promise<ResolvedMacros> {
  const match = await searchFood(name);
  if (match) {
    const full = labelName(match.brand, match.productName);
    // A junk serving_quantity (0 or blank) means the record has no usable portion, so ask.
    const fromLabel = match.servingQuantityG !== null && match.servingQuantityG > 0;
    const servingG = fromLabel ? match.servingQuantityG! : await guessServingGrams(full);
    if (servingG && servingG > 0) {
      // The label path bypasses the model, so it also bypasses the model's schema — clamp it
      // here or an oversized serving would produce a row the diet API rejects with a 400.
      const scaled = MealEstimate.safeParse(scaleToServing(match.per100, servingG));
      if (scaled.success) {
        return {
          ...scaled.data,
          source: "label",
          matchedName: full,
          servingG,
          servingSource: fromLabel ? "label" : "estimate",
        };
      }
    }
  }
  return { ...(await estimateMeal(name)), source: "estimate", matchedName: null, servingG: null, servingSource: null };
}
