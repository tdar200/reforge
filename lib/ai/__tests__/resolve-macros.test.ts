import { beforeEach, describe, expect, test, vi } from "vitest";
import { NoObjectGeneratedError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  ESTIMATE_SYSTEM_PROMPT,
  SERVING_SYSTEM_PROMPT,
  labelName,
  resolveMacros,
} from "../estimate";
import type { FoodMatch, Per100 } from "../../food/openfoodfacts";

let model: MockLanguageModelV3;
vi.mock("../model", () => ({ getModel: () => model }));

// Only searchFood is replaced: scaleToServing stays the real one, so every number asserted
// below is the number the app would really produce. Nothing in this file touches the network.
let searchResult: FoodMatch | null;
let searchCalls: string[];
vi.mock("../../food/openfoodfacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../food/openfoodfacts")>();
  return {
    ...actual,
    searchFood: async (name: string) => {
      searchCalls.push(name);
      return searchResult;
    },
  };
});

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  },
  warnings: [],
});

/** Answers each model call in turn; an Error is thrown instead of answered. The last answer repeats. */
const answering = (...answers: unknown[]) => {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const answer = answers[Math.min(i, answers.length - 1)];
      i += 1;
      if (answer instanceof Error) throw answer;
      return textResult(typeof answer === "string" ? answer : JSON.stringify(answer));
    },
  });
};

const systemOf = (i: number) => model.doGenerateCalls[i].prompt[0];
const userTextOf = (i: number) =>
  (model.doGenerateCalls[i].prompt[1].content as unknown as { type: string; text: string }[])[0].text;

// A real Actileaf-style oat drink label: 49.2 kcal and 1.3 g protein per 100 ml.
const per100 = (over: Partial<Per100> = {}): Per100 => ({
  kcal: 49.2,
  proteinG: 1.3,
  carbsG: 6.9,
  fatG: 1.5,
  saturatedFatG: 0.2,
  fiberG: 0.8,
  sugarG: 3.9,
  saltG: 0.09,
  ...over,
});

const match = (over: Partial<FoodMatch> = {}): FoodMatch => ({
  code: "5060482840445",
  productName: "Oat Drink",
  brand: "Actileaf",
  per100: per100(),
  servingQuantityG: 200,
  score: 1,
  ...over,
});

/** The estimate branch always reports "no portion of my own": both serving fields are null. */
const ESTIMATE_TAIL = { source: "estimate", matchedName: null, servingG: null, servingSource: null } as const;

beforeEach(() => {
  searchResult = null;
  searchCalls = [];
  // Unprogrammed calls answer with an empty object, which fails every schema loudly.
  model = answering("{}");
});

// ---------- the label path ----------

describe("resolveMacros: a matched product label", () => {
  test("a record with its own serving size is scaled and returned without any model call", async () => {
    searchResult = match({ servingQuantityG: 200 });
    // Primed with an answer that must never be used: the label wins outright.
    model = answering({ kcal: 999, proteinG: 99 });

    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({
      kcal: 98, // 49.2 per 100 ml x 2
      proteinG: 2.6, // 1.3 per 100 ml x 2
      source: "label",
      matchedName: "Actileaf Oat Drink",
      servingG: 200, // straight off the record
      servingSource: "label",
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("the logged name reaches the lookup exactly as typed, once", async () => {
    searchResult = match();
    await resolveMacros("  Actileaf Oat MILK  ");
    expect(searchCalls).toEqual(["  Actileaf Oat MILK  "]);
  });

  test("a product name that already carries the brand is not doubled up", async () => {
    searchResult = match({ productName: "Coca-Cola Zero Cherry", brand: "Coca-Cola", per100: per100({ kcal: 0.3, proteinG: 0 }), servingQuantityG: 330 });
    const res = await resolveMacros("Coca Cola Zero Cherry");
    expect(res.matchedName).toBe("Coca-Cola Zero Cherry");
    expect(res.source).toBe("label");
    expect(res.kcal).toBe(1); // 0.3 x 3.3, rounded
    expect(res.servingG).toBe(330);
    expect(res.servingSource).toBe("label");
  });

  test("a brandless match is named by the product alone", async () => {
    searchResult = match({ brand: null, productName: "Rolled Oats" });
    const res = await resolveMacros("rolled oats");
    expect(res.matchedName).toBe("Rolled Oats");
    expect(res.source).toBe("label");
    expect(res.servingSource).toBe("label");
  });

  test("a zero-calorie drink is still a label: 0 kcal is a real number, not a missing one", async () => {
    // The live shape of "Coca Cola Zero 330ml": a near-zero per-100 ml energy over a 330 ml can.
    searchResult = match({
      productName: "Coca-Cola Zero",
      brand: "Coca-Cola",
      per100: per100({ kcal: 0.9, proteinG: 0 }),
      servingQuantityG: 330,
    });
    await expect(resolveMacros("Coca Cola Zero 330ml")).resolves.toEqual({
      kcal: 3, // 0.9 x 3.3, rounded
      proteinG: 0,
      source: "label",
      matchedName: "Coca-Cola Zero",
      servingG: 330,
      servingSource: "label",
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("a label that scales all the way down to 0 kcal is kept, not thrown away", async () => {
    // 0.3 kcal/100 ml over 100 ml rounds to nothing — which is the truth about sparkling water.
    searchResult = match({
      productName: "Sparkling Water",
      brand: "Highland Spring",
      per100: per100({ kcal: 0.3, proteinG: 0 }),
      servingQuantityG: 100,
    });
    await expect(resolveMacros("Highland Spring sparkling water")).resolves.toEqual({
      kcal: 0,
      proteinG: 0,
      source: "label",
      matchedName: "Highland Spring Sparkling Water",
      servingG: 100,
      servingSource: "label",
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("without a serving quantity the model is asked for grams and the label is scaled by them", async () => {
    searchResult = match({ servingQuantityG: null, per100: per100({ proteinG: 1.05 }) });
    model = answering({ grams: 250 });

    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({
      kcal: 123, // 49.2 per 100 ml x 2.5
      proteinG: 2.6, // 1.05 x 2.5 = 2.625, to one decimal
      source: "label",
      matchedName: "Actileaf Oat Drink",
      servingG: 250, // the model's portion, not the record's
      servingSource: "estimate",
    });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  test("a 0 serving quantity is junk, not a portion: it asks the model instead of giving up on the label", async () => {
    searchResult = match({ servingQuantityG: 0 });
    model = answering({ grams: 250 });

    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({
      kcal: 123, // 49.2 x 2.5
      proteinG: 3.3, // 1.3 x 2.5 = 3.25, to one decimal
      source: "label",
      matchedName: "Actileaf Oat Drink",
      servingG: 250,
      servingSource: "estimate",
    });
    // Exactly one call, and it is the portion question — the label supplies the macros.
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(systemOf(0)).toMatchObject({ content: SERVING_SYSTEM_PROMPT });
  });

  test("a nonsense negative serving quantity is treated the same way", async () => {
    searchResult = match({ servingQuantityG: -200 });
    model = answering({ grams: 200 });

    const res = await resolveMacros("Actileaf Oat Milk");
    expect(res).toMatchObject({ source: "label", servingG: 200, servingSource: "estimate", kcal: 98 });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(systemOf(0)).toMatchObject({ content: SERVING_SYSTEM_PROMPT });
  });

  test("the serving question asks about the full label name, brand included", async () => {
    searchResult = match({ servingQuantityG: null, brand: "Actileaf", productName: "Oat Drink" });
    model = answering({ grams: 250 });
    await resolveMacros("half a carton of that oat stuff");

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(systemOf(0)).toMatchObject({ role: "system", content: SERVING_SYSTEM_PROMPT });
    // "Oat Drink" alone is unanswerable; the brand is what makes the portion knowable.
    expect(userTextOf(0)).toBe("Actileaf Oat Drink");
    expect(model.doGenerateCalls[0].maxOutputTokens).toBe(1500);
    expect(model.doGenerateCalls[0].responseFormat?.type).toBe("json");
  });

  test("the serving question uses the product name alone when the record has no brand", async () => {
    searchResult = match({ servingQuantityG: null, brand: null, productName: "Rolled Oats" });
    model = answering({ grams: 40 });
    await resolveMacros("porridge");

    expect(userTextOf(0)).toBe("Rolled Oats");
  });

  test("a 1 g serving and a 3000 g serving are both honoured", async () => {
    searchResult = match({ servingQuantityG: null, per100: per100({ kcal: 400, proteinG: 10 }) });
    model = answering({ grams: 1 });
    await expect(resolveMacros("one crisp")).resolves.toMatchObject({
      kcal: 4, proteinG: 0.1, source: "label", servingG: 1, servingSource: "estimate",
    });

    searchResult = match({ servingQuantityG: null, per100: per100({ kcal: 40, proteinG: 1 }) });
    model = answering({ grams: 3000 });
    await expect(resolveMacros("a whole tub")).resolves.toMatchObject({
      kcal: 1200, proteinG: 30, source: "label", servingG: 3000, servingSource: "estimate",
    });
  });
});

// ---------- the label path must still produce a row the diet API will accept ----------

describe("resolveMacros: a label that scales out of range", () => {
  test("kcal past the 5000 ceiling falls back to the coach rather than posting a rejected row", async () => {
    // 350 kcal/100 g over a 2 kg record serving is 7000 kcal — MealProposal, and therefore
    // POST /api/diet, would reject it with a 400.
    searchResult = match({ per100: per100({ kcal: 350, proteinG: 8 }), servingQuantityG: 2000 });
    model = answering({ kcal: 247, proteinG: 8.5 });

    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({ kcal: 247, proteinG: 8.5, ...ESTIMATE_TAIL });
    // The serving came off the record, so the only model call is the estimate itself.
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(systemOf(0)).toMatchObject({ content: ESTIMATE_SYSTEM_PROMPT });
  });

  test("protein past the 500 g ceiling falls back too, even with kcal in range", async () => {
    searchResult = match({ per100: per100({ kcal: 100, proteinG: 30 }), servingQuantityG: 2000 });
    model = answering({ kcal: 247, proteinG: 8.5 });

    // 2000 kcal is fine; 600 g of protein is not.
    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({ kcal: 247, proteinG: 8.5, ...ESTIMATE_TAIL });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  test("an oversized model-guessed portion is caught as well, after two calls", async () => {
    searchResult = match({ per100: per100({ kcal: 350, proteinG: 8 }), servingQuantityG: null });
    model = answering({ grams: 3000 }, { kcal: 247, proteinG: 8.5 });

    // 10500 kcal from the label is discarded; the estimate answers instead.
    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({ kcal: 247, proteinG: 8.5, ...ESTIMATE_TAIL });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(systemOf(0)).toMatchObject({ content: SERVING_SYSTEM_PROMPT });
    expect(systemOf(1)).toMatchObject({ content: ESTIMATE_SYSTEM_PROMPT });
  });

  test("the exact ceilings are still a label: 5000 kcal and 500 g protein pass", async () => {
    searchResult = match({ per100: per100({ kcal: 250, proteinG: 25 }), servingQuantityG: 2000 });
    model = answering({ kcal: 1, proteinG: 1 }); // must never be used

    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({
      kcal: 5000,
      proteinG: 500,
      source: "label",
      matchedName: "Actileaf Oat Drink",
      servingG: 2000,
      servingSource: "label",
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

// ---------- the estimate fallback ----------

describe("resolveMacros: falling back to the coach's estimate", () => {
  test("no matching product returns the model's estimate verbatim, with no matched name or portion", async () => {
    searchResult = null;
    model = answering({ kcal: 612, proteinG: 24 });

    await expect(resolveMacros("my nan's leftover biryani")).resolves.toEqual({
      kcal: 612,
      proteinG: 24,
      source: "estimate",
      matchedName: null,
      servingG: null,
      servingSource: null,
    });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(systemOf(0)).toMatchObject({ role: "system", content: ESTIMATE_SYSTEM_PROMPT });
    expect(userTextOf(0)).toBe("my nan's leftover biryani");
  });

  test("a serving guess that throws sends the meal to the estimate, on the logged name", async () => {
    searchResult = match({ servingQuantityG: null });
    model = answering(new Error("upstream 500"), { kcal: 247, proteinG: 8.5 });

    await expect(resolveMacros("Actileaf Barista Style Oat Drink")).resolves.toEqual({
      kcal: 247,
      proteinG: 8.5,
      ...ESTIMATE_TAIL,
    });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(systemOf(0)).toMatchObject({ content: SERVING_SYSTEM_PROMPT });
    expect(systemOf(1)).toMatchObject({ content: ESTIMATE_SYSTEM_PROMPT });
    expect(userTextOf(1)).toBe("Actileaf Barista Style Oat Drink");
  });

  const badGuesses: [string, unknown][] = [
    ["prose instead of JSON", "about a glass"],
    ["grams below the minimum", { grams: 0 }],
    ["grams above the maximum", { grams: 3001 }],
    ["a non-integer gram count", { grams: 240.5 }],
    ["grams as a string", { grams: "250" }],
    ["a negative gram count", { grams: -200 }],
    ["the wrong key", { millilitres: 250 }],
    ["an empty object", {}],
  ];
  test.each(badGuesses)("a serving guess with %s falls back to the estimate", async (_label, guess) => {
    searchResult = match({ servingQuantityG: null });
    model = answering(guess, { kcal: 247, proteinG: 8.5 });

    await expect(resolveMacros("Actileaf Oat Drink")).resolves.toEqual({
      kcal: 247,
      proteinG: 8.5,
      ...ESTIMATE_TAIL,
    });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  test("a record with a 0 quantity AND a broken serving guess still lands on the estimate", async () => {
    searchResult = match({ servingQuantityG: 0 });
    model = answering({ grams: 0 }, { kcal: 247, proteinG: 8.5 });

    await expect(resolveMacros("Actileaf Oat Drink")).resolves.toEqual({
      kcal: 247,
      proteinG: 8.5,
      ...ESTIMATE_TAIL,
    });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  test("a broken model in the fallback path rejects rather than inventing macros", async () => {
    // The route turns this into a 502; silently returning 0/0 would be worse.
    searchResult = null;
    model = answering("sorry, I cannot estimate that");
    const err = await resolveMacros("mystery casserole").catch((e: unknown) => e);
    expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
  });
});

// ---------- the shape the route and the client depend on ----------

describe("resolveMacros: result shape", () => {
  test("both paths return exactly kcal, proteinG, source, matchedName, servingG and servingSource", async () => {
    const KEYS = ["kcal", "matchedName", "proteinG", "servingG", "servingSource", "source"];

    searchResult = match();
    const label = await resolveMacros("Actileaf Oat Milk");
    expect(Object.keys(label).sort()).toEqual(KEYS);
    expect(label.source).toBe("label");
    expect(label.servingSource).toBe("label");

    searchResult = null;
    model = answering({ kcal: 247, proteinG: 8.5 });
    const estimate = await resolveMacros("my nan's leftover biryani");
    expect(Object.keys(estimate).sort()).toEqual(KEYS);
    expect(estimate.source).toBe("estimate");
    // The coach never claims a portion it did not measure.
    expect(estimate.servingG).toBeNull();
    expect(estimate.servingSource).toBeNull();
  });

  test("a label result is always a whole number of kcal and one decimal of protein", async () => {
    searchResult = match({ servingQuantityG: 237, per100: per100({ kcal: 61.7, proteinG: 3.28 }) });
    const res = await resolveMacros("Actileaf Oat Milk");
    expect(res.source).toBe("label");
    expect(Number.isInteger(res.kcal)).toBe(true);
    expect(res.proteinG).toBe(Math.round(res.proteinG * 10) / 10);
  });

  test("servingSource is only ever set alongside a servingG, and only on the label path", async () => {
    searchResult = match({ servingQuantityG: 200 });
    const fromRecord = await resolveMacros("Actileaf Oat Milk");
    expect(fromRecord.servingG).toBe(200);
    expect(fromRecord.servingSource).toBe("label");

    searchResult = match({ servingQuantityG: null });
    model = answering({ grams: 150 });
    const fromModel = await resolveMacros("Actileaf Oat Milk");
    expect(fromModel.servingG).toBe(150);
    expect(fromModel.servingSource).toBe("estimate");

    searchResult = null;
    model = answering({ kcal: 100, proteinG: 1 });
    const guessed = await resolveMacros("something homemade");
    expect(guessed.servingG).toBeNull();
    expect(guessed.servingSource).toBeNull();
  });
});

// ---------- labelName ----------

describe("labelName", () => {
  const cases: [string, string | null, string, string][] = [
    ["prepends a brand the name lacks", "Actileaf", "Oat Drink", "Actileaf Oat Drink"],
    ["leaves a name that already starts with the brand", "Actileaf", "Actileaf Oat Drink", "Actileaf Oat Drink"],
    ["matches the brand case-insensitively", "actileaf", "Actileaf Oat Drink", "Actileaf Oat Drink"],
    ["matches a shouted brand too", "ACTILEAF", "Actileaf Oat Drink", "Actileaf Oat Drink"],
    ["matches a brand written mid-name", "Valley", "Yeo Valley Natural Yogurt", "Yeo Valley Natural Yogurt"],
    ["keeps a hyphenated brand as one", "Coca-Cola", "Coca-Cola Zero Cherry", "Coca-Cola Zero Cherry"],
    // Punctuation is a spelling difference, not a different product: neither side may double up.
    ["a hyphenated brand against an unhyphenated name", "Coca-Cola", "Coca Cola Zero", "Coca Cola Zero"],
    ["an unhyphenated brand against a hyphenated name", "Coca Cola", "Coca-Cola Zero", "Coca-Cola Zero"],
    ["a punctuated brand the name spells solid", "Co-op", "Coop Sausages", "Coop Sausages"],
    ["a solid brand the name spells punctuated", "Coop", "Co-op Sausages", "Co-op Sausages"],
    ["an apostrophe brand against the same name without one", "Sainsbury's", "Sainsburys Baked Beans", "Sainsburys Baked Beans"],
    ["an ampersand brand", "M&S", "M&S Digestives", "M&S Digestives"],
    ["an accented brand against the same accented name", "Müller", "Müller Corner Vanilla", "Müller Corner Vanilla"],
    // OFF lists parent and sub-brand in one comma-joined field; only the first is a name prefix.
    ["a comma-joined brand takes only the first", "Nestlé,KitKat", "Chunky", "Nestlé Chunky"],
    ["a comma-joined brand already in the name is not prepended", "Nestlé,KitKat", "Nestlé KitKat Chunky", "Nestlé KitKat Chunky"],
    ["a padded comma-joined brand is trimmed", " Tesco , Tesco Finest ", "Finest Beans", "Tesco Finest Beans"],
    ["a null brand leaves the product name alone", null, "Rolled Oats", "Rolled Oats"],
    ["a null brand still trims the product name", null, "  Rolled Oats  ", "Rolled Oats"],
    ["an empty brand is treated as no brand", "", "Rolled Oats", "Rolled Oats"],
    ["a whitespace-only brand is treated as no brand", "   ", "Rolled Oats", "Rolled Oats"],
    ["a comma-only brand is treated as no brand", ",", "Rolled Oats", "Rolled Oats"],
    ["a padded brand is compared trimmed", "  Actileaf  ", "Actileaf Oat Drink", "Actileaf Oat Drink"],
    // Product names arrive from a public database with ragged spacing; the note must read cleanly.
    ["internal whitespace in the product name collapses", "Actileaf", "  Oat   Drink  ", "Actileaf Oat Drink"],
    ["internal whitespace collapses without a brand too", null, "Rolled   Oats", "Rolled Oats"],
    ["a tab and newline count as whitespace", "Actileaf", "Oat\tDrink\nBarista", "Actileaf Oat Drink Barista"],
    ["internal whitespace in the brand collapses", "Yeo   Valley", "Natural Yogurt", "Yeo Valley Natural Yogurt"],
    ["a different brand is prepended, not swapped in", "Tesco", "Actileaf Oat Drink", "Tesco Actileaf Oat Drink"],
  ];

  test.each(cases)("%s", (_label, brand, productName, expected) => {
    expect(labelName(brand, productName)).toBe(expected);
  });

  test("the joined name never carries double spaces or ragged ends", () => {
    const joined = labelName("  Actileaf  ", "  Barista   Oat Drink  ");
    expect(joined).toBe("Actileaf Barista Oat Drink");
    expect(joined).toBe(joined.trim());
    expect(joined).not.toMatch(/ {2}/);
  });
});
