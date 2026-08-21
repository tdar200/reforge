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

/** The three lookups resolveMacros fires; they run concurrently, so none may assume an order. */
type Lookup = "searchFood" | "estimateMeal" | "guessServingGrams";

// Recorded on entry and again on exit, so a test can prove a lookup had STARTED while nothing
// had yet ANSWERED — the only way to assert concurrency without leaning on wall-clock timing.
let invoked: Lookup[];
let answered: Lookup[];
// Set only by the concurrency test: each lookup then blocks on its own gate until released.
let gates: Record<Lookup, Promise<void>> | null;

const enter = async (which: Lookup): Promise<void> => {
  invoked.push(which);
  if (gates) await gates[which];
  answered.push(which);
};

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
      await enter("searchFood");
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

type Recorded = MockLanguageModelV3["doGenerateCalls"][number];
const systemOf = (call: Recorded) => (call.prompt[0] as { role: string; content: string }).content;
const userTextOf = (call: Recorded) =>
  (call.prompt[1].content as unknown as { type: string; text: string }[])[0].text;

const callsTo = (system: string) => model.doGenerateCalls.filter((c) => systemOf(c) === system);
const estimateCalls = () => callsTo(ESTIMATE_SYSTEM_PROMPT);
const servingCalls = () => callsTo(SERVING_SYSTEM_PROMPT);

/**
 * Answers by WHICH question arrived rather than by call order: the estimate and the serving
 * guess are now issued together and may reach the model in either order. An Error is thrown
 * instead of answered; an unprogrammed question gets an empty object, which fails its schema.
 */
const answering = (answers: { estimate?: unknown; serving?: unknown }) =>
  new MockLanguageModelV3({
    doGenerate: async (options) => {
      const isServing = systemOf(options as Recorded) === SERVING_SYSTEM_PROMPT;
      await enter(isServing ? "guessServingGrams" : "estimateMeal");
      const answer = (isServing ? answers.serving : answers.estimate) ?? "{}";
      if (answer instanceof Error) throw answer;
      return textResult(typeof answer === "string" ? answer : JSON.stringify(answer));
    },
  });

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
  invoked = [];
  answered = [];
  gates = null;
  // Unprogrammed calls answer with an empty object, which fails every schema loudly.
  model = answering({});
});

// ---------- the three lookups run together, not in a chain ----------

describe("resolveMacros: concurrency", () => {
  test("the lookup, the estimate and the serving guess are all in flight before any answers", async () => {
    searchResult = match({ servingQuantityG: 200 });
    const open = {} as Record<Lookup, () => void>;
    const gate = (which: Lookup) => new Promise<void>((resolve) => { open[which] = resolve; });
    gates = {
      searchFood: gate("searchFood"),
      estimateMeal: gate("estimateMeal"),
      guessServingGrams: gate("guessServingGrams"),
    };
    model = answering({ estimate: { kcal: 999, proteinG: 99 }, serving: { grams: 3000 } });

    let settled = false;
    const pending = resolveMacros("Actileaf Oat Milk").then((r) => { settled = true; return r; });

    // Nothing has been allowed to answer yet. A chained implementation would still be sitting
    // on searchFood and could not possibly have issued the other two — this is the regression
    // guard for the 7-14 s Add that the serial version produced.
    await vi.waitFor(() => expect(invoked).toHaveLength(3));
    expect([...invoked].sort()).toEqual(["estimateMeal", "guessServingGrams", "searchFood"]);
    expect(answered).toEqual([]);
    expect(settled).toBe(false);

    open.searchFood();
    open.estimateMeal();
    open.guessServingGrams();

    await expect(pending).resolves.toEqual({
      kcal: 98,
      proteinG: 2.6,
      source: "label",
      matchedName: "Actileaf Oat Drink",
      servingG: 200,
      servingSource: "label",
    });
  });

  const paths: [string, FoodMatch | null][] = [
    ["a record carrying its own serving", match({ servingQuantityG: 200 })],
    ["a record with no serving", match({ servingQuantityG: null })],
    ["no matching product at all", null],
  ];
  test.each(paths)("with %s, both model questions are asked exactly once", async (_label, result) => {
    searchResult = result;
    model = answering({ estimate: { kcal: 247, proteinG: 8.5 }, serving: { grams: 250 } });

    await resolveMacros("Actileaf Oat Milk");

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(estimateCalls()).toHaveLength(1);
    expect(servingCalls()).toHaveLength(1);
    expect(searchCalls).toEqual(["Actileaf Oat Milk"]);
  });
});

// ---------- the label path ----------

describe("resolveMacros: a matched product label", () => {
  test("a record with its own serving wins, though the model was asked anyway", async () => {
    searchResult = match({ servingQuantityG: 200 });
    // Both answers must lose: 3000 g would scale to 1476 kcal, and the estimate to 999.
    model = answering({ estimate: { kcal: 999, proteinG: 99 }, serving: { grams: 3000 } });

    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({
      kcal: 98, // 49.2 per 100 ml x 2
      proteinG: 2.6, // 1.3 per 100 ml x 2
      source: "label",
      matchedName: "Actileaf Oat Drink",
      servingG: 200, // straight off the record
      servingSource: "label",
    });
    // The portion question is now asked up front rather than only when it is needed; the point
    // is that its answer is discarded, not that the call was skipped.
    expect(servingCalls()).toHaveLength(1);
    expect(userTextOf(servingCalls()[0])).toBe("Actileaf Oat Milk");
    expect(estimateCalls()).toHaveLength(1);
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
    model = answering({ estimate: { kcal: 140, proteinG: 0 }, serving: { grams: 500 } });

    await expect(resolveMacros("Coca Cola Zero 330ml")).resolves.toEqual({
      kcal: 3, // 0.9 x 3.3, rounded
      proteinG: 0,
      source: "label",
      matchedName: "Coca-Cola Zero",
      servingG: 330,
      servingSource: "label",
    });
    expect(model.doGenerateCalls).toHaveLength(2); // asked, and both answers ignored
  });

  test("a label that scales all the way down to 0 kcal is kept, not thrown away", async () => {
    // 0.3 kcal/100 ml over 100 ml rounds to nothing — which is the truth about sparkling water.
    searchResult = match({
      productName: "Sparkling Water",
      brand: "Highland Spring",
      per100: per100({ kcal: 0.3, proteinG: 0 }),
      servingQuantityG: 100,
    });
    model = answering({ estimate: { kcal: 55, proteinG: 1 }, serving: { grams: 750 } });

    await expect(resolveMacros("Highland Spring sparkling water")).resolves.toEqual({
      kcal: 0,
      proteinG: 0,
      source: "label",
      matchedName: "Highland Spring Sparkling Water",
      servingG: 100,
      servingSource: "label",
    });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  test("without a serving quantity the model's grams are what the label is scaled by", async () => {
    searchResult = match({ servingQuantityG: null, per100: per100({ proteinG: 1.05 }) });
    model = answering({ serving: { grams: 250 }, estimate: { kcal: 999, proteinG: 99 } });

    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({
      kcal: 123, // 49.2 per 100 ml x 2.5
      proteinG: 2.6, // 1.05 x 2.5 = 2.625, to one decimal
      source: "label",
      matchedName: "Actileaf Oat Drink",
      servingG: 250, // the model's portion, not the record's
      servingSource: "estimate",
    });
    expect(servingCalls()).toHaveLength(1);
  });

  test("a 0 serving quantity is junk, not a portion: the guessed grams are used instead", async () => {
    searchResult = match({ servingQuantityG: 0 });
    model = answering({ serving: { grams: 250 }, estimate: { kcal: 999, proteinG: 99 } });

    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({
      kcal: 123, // 49.2 x 2.5
      proteinG: 3.3, // 1.3 x 2.5 = 3.25, to one decimal
      source: "label",
      matchedName: "Actileaf Oat Drink",
      servingG: 250,
      servingSource: "estimate",
    });
    // The macros still come off the label; only the portion came from the model.
    expect(servingCalls()).toHaveLength(1);
  });

  test("a nonsense negative serving quantity is treated the same way", async () => {
    searchResult = match({ servingQuantityG: -200 });
    model = answering({ serving: { grams: 200 }, estimate: { kcal: 999, proteinG: 99 } });

    const res = await resolveMacros("Actileaf Oat Milk");
    expect(res).toMatchObject({ source: "label", servingG: 200, servingSource: "estimate", kcal: 98 });
    expect(servingCalls()).toHaveLength(1);
  });

  test("the serving question asks about the logged text, not the matched product name", async () => {
    searchResult = match({ servingQuantityG: null, brand: "Actileaf", productName: "Oat Drink" });
    model = answering({ serving: { grams: 250 }, estimate: { kcal: 999, proteinG: 99 } });
    await resolveMacros("half a carton of that oat stuff");

    const call = servingCalls()[0];
    expect(systemOf(call)).toBe(SERVING_SYSTEM_PROMPT);
    // The question is now asked before any match is known, so the user's own words are all
    // there is to ask about — the matched label name is not available yet.
    expect(userTextOf(call)).toBe("half a carton of that oat stuff");
    expect(call.maxOutputTokens).toBe(1500);
    expect(call.responseFormat?.type).toBe("json");
  });

  test("the serving question is still the logged text when the record has no brand", async () => {
    searchResult = match({ servingQuantityG: null, brand: null, productName: "Rolled Oats" });
    model = answering({ serving: { grams: 40 }, estimate: { kcal: 999, proteinG: 99 } });
    await resolveMacros("porridge");

    expect(userTextOf(servingCalls()[0])).toBe("porridge");
  });

  test("a 1 g serving and a 3000 g serving are both honoured", async () => {
    searchResult = match({ servingQuantityG: null, per100: per100({ kcal: 400, proteinG: 10 }) });
    model = answering({ serving: { grams: 1 }, estimate: { kcal: 999, proteinG: 99 } });
    await expect(resolveMacros("one crisp")).resolves.toMatchObject({
      kcal: 4, proteinG: 0.1, source: "label", servingG: 1, servingSource: "estimate",
    });

    searchResult = match({ servingQuantityG: null, per100: per100({ kcal: 40, proteinG: 1 }) });
    model = answering({ serving: { grams: 3000 }, estimate: { kcal: 999, proteinG: 99 } });
    await expect(resolveMacros("a whole tub")).resolves.toMatchObject({
      kcal: 1200, proteinG: 30, source: "label", servingG: 3000, servingSource: "estimate",
    });
  });

  test("an estimate that throws no longer sinks a request a label can answer", async () => {
    // The whole point of running the three together: the estimate is now speculative work,
    // so its failure must not cost the user a label answer that already resolved.
    searchResult = match({ servingQuantityG: 200 });
    model = answering({ estimate: new Error("upstream 500") });

    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({
      kcal: 98,
      proteinG: 2.6,
      source: "label",
      matchedName: "Actileaf Oat Drink",
      servingG: 200,
      servingSource: "label",
    });
  });

  test("an estimate that throws still leaves a guessed portion usable", async () => {
    searchResult = match({ servingQuantityG: null });
    model = answering({ estimate: new Error("upstream 500"), serving: { grams: 250 } });

    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({
      kcal: 123,
      proteinG: 3.3,
      source: "label",
      matchedName: "Actileaf Oat Drink",
      servingG: 250,
      servingSource: "estimate",
    });
  });
});

// ---------- the label path must still produce a row the diet API will accept ----------

describe("resolveMacros: a label that scales out of range", () => {
  test("kcal past the 5000 ceiling falls back to the coach rather than posting a rejected row", async () => {
    // 350 kcal/100 g over a 2 kg record serving is 7000 kcal — MealProposal, and therefore
    // POST /api/diet, would reject it with a 400.
    searchResult = match({ per100: per100({ kcal: 350, proteinG: 8 }), servingQuantityG: 2000 });
    model = answering({ estimate: { kcal: 247, proteinG: 8.5 }, serving: { grams: 250 } });

    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({ kcal: 247, proteinG: 8.5, ...ESTIMATE_TAIL });
    expect(estimateCalls()).toHaveLength(1);
    expect(userTextOf(estimateCalls()[0])).toBe("Actileaf Oat Milk");
  });

  test("protein past the 500 g ceiling falls back too, even with kcal in range", async () => {
    searchResult = match({ per100: per100({ kcal: 100, proteinG: 30 }), servingQuantityG: 2000 });
    model = answering({ estimate: { kcal: 247, proteinG: 8.5 }, serving: { grams: 250 } });

    // 2000 kcal is fine; 600 g of protein is not.
    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({ kcal: 247, proteinG: 8.5, ...ESTIMATE_TAIL });
  });

  test("an oversized model-guessed portion is caught as well", async () => {
    searchResult = match({ per100: per100({ kcal: 350, proteinG: 8 }), servingQuantityG: null });
    model = answering({ serving: { grams: 3000 }, estimate: { kcal: 247, proteinG: 8.5 } });

    // 10500 kcal from the label is discarded; the estimate already in hand answers instead.
    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({ kcal: 247, proteinG: 8.5, ...ESTIMATE_TAIL });
    expect(estimateCalls()).toHaveLength(1);
    expect(servingCalls()).toHaveLength(1);
  });

  test("an out-of-range label with a failed estimate has nothing left to return", async () => {
    searchResult = match({ per100: per100({ kcal: 350, proteinG: 8 }), servingQuantityG: 2000 });
    model = answering({ estimate: new Error("upstream 500") });

    await expect(resolveMacros("Actileaf Oat Milk")).rejects.toThrow("no macros could be resolved");
  });

  test("the exact ceilings are still a label: 5000 kcal and 500 g protein pass", async () => {
    searchResult = match({ per100: per100({ kcal: 250, proteinG: 25 }), servingQuantityG: 2000 });
    model = answering({ estimate: { kcal: 1, proteinG: 1 }, serving: { grams: 1 } }); // never used

    await expect(resolveMacros("Actileaf Oat Milk")).resolves.toEqual({
      kcal: 5000,
      proteinG: 500,
      source: "label",
      matchedName: "Actileaf Oat Drink",
      servingG: 2000,
      servingSource: "label",
    });
  });
});

// ---------- the estimate fallback ----------

describe("resolveMacros: falling back to the coach's estimate", () => {
  test("no matching product returns the model's estimate verbatim, with no matched name or portion", async () => {
    searchResult = null;
    model = answering({ estimate: { kcal: 612, proteinG: 24 }, serving: { grams: 400 } });

    await expect(resolveMacros("my nan's leftover biryani")).resolves.toEqual({
      kcal: 612,
      proteinG: 24,
      source: "estimate",
      matchedName: null,
      servingG: null,
      servingSource: null,
    });
    expect(estimateCalls()).toHaveLength(1);
    expect(systemOf(estimateCalls()[0])).toBe(ESTIMATE_SYSTEM_PROMPT);
    expect(userTextOf(estimateCalls()[0])).toBe("my nan's leftover biryani");
    // A portion guess with nothing to attach it to is thrown away, not reported.
    expect(servingCalls()).toHaveLength(1);
  });

  test("a serving guess that throws sends the meal to the estimate, on the logged name", async () => {
    searchResult = match({ servingQuantityG: null });
    model = answering({ serving: new Error("upstream 500"), estimate: { kcal: 247, proteinG: 8.5 } });

    await expect(resolveMacros("Actileaf Barista Style Oat Drink")).resolves.toEqual({
      kcal: 247,
      proteinG: 8.5,
      ...ESTIMATE_TAIL,
    });
    expect(userTextOf(estimateCalls()[0])).toBe("Actileaf Barista Style Oat Drink");
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
    model = answering({ serving: guess, estimate: { kcal: 247, proteinG: 8.5 } });

    await expect(resolveMacros("Actileaf Oat Drink")).resolves.toEqual({
      kcal: 247,
      proteinG: 8.5,
      ...ESTIMATE_TAIL,
    });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  test("a record with a 0 quantity AND a broken serving guess still lands on the estimate", async () => {
    searchResult = match({ servingQuantityG: 0 });
    model = answering({ serving: { grams: 0 }, estimate: { kcal: 247, proteinG: 8.5 } });

    await expect(resolveMacros("Actileaf Oat Drink")).resolves.toEqual({
      kcal: 247,
      proteinG: 8.5,
      ...ESTIMATE_TAIL,
    });
  });

  test("no match and a rejecting estimate rejects rather than inventing macros", async () => {
    // The route turns this into a 502; silently returning 0/0, or a half-filled object, is worse.
    searchResult = null;
    model = answering({ estimate: new Error("upstream 500") });

    const err = await resolveMacros("mystery casserole").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("no macros could be resolved");
  });

  test("a broken model in the fallback path rejects with the same failure", async () => {
    searchResult = null;
    model = answering({ estimate: "sorry, I cannot estimate that", serving: "about a glass" });

    const err = await resolveMacros("mystery casserole").catch((e: unknown) => e);
    // The model's own error is swallowed by the concurrent catch and reported as one failure.
    expect(NoObjectGeneratedError.isInstance(err)).toBe(false);
    expect((err as Error).message).toBe("no macros could be resolved");
  });
});

// ---------- how the two model calls are configured ----------

describe("resolveMacros: the model calls it issues", () => {
  test("the estimate is a low-effort recall call capped at 1500 output tokens", async () => {
    searchResult = null;
    model = answering({ estimate: { kcal: 247, proteinG: 8.5 } });
    await resolveMacros("my nan's leftover biryani");

    const call = estimateCalls()[0];
    // Reasoning effort is what took this call from ~9 s to ~4.5 s. The cap stays generous
    // because reasoning tokens are billed against it on gpt-5 models.
    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: "low" } });
    expect(call.maxOutputTokens).toBe(1500);
  });

  test("the serving guess is configured identically", async () => {
    searchResult = match({ servingQuantityG: null });
    model = answering({ serving: { grams: 250 }, estimate: { kcal: 247, proteinG: 8.5 } });
    await resolveMacros("Actileaf Oat Milk");

    const call = servingCalls()[0];
    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: "low" } });
    expect(call.maxOutputTokens).toBe(1500);
  });

  test("both calls go out with reasoningEffort low, on every path", async () => {
    searchResult = match({ servingQuantityG: 200 });
    model = answering({ estimate: { kcal: 247, proteinG: 8.5 }, serving: { grams: 250 } });
    await resolveMacros("Actileaf Oat Milk");

    expect(model.doGenerateCalls).toHaveLength(2);
    for (const call of model.doGenerateCalls) {
      expect(call.providerOptions?.openai?.reasoningEffort).toBe("low");
      expect(call.maxOutputTokens).toBe(1500);
      expect(call.responseFormat?.type).toBe("json");
    }
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
    model = answering({ estimate: { kcal: 247, proteinG: 8.5 } });
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
    model = answering({ serving: { grams: 150 }, estimate: { kcal: 999, proteinG: 99 } });
    const fromModel = await resolveMacros("Actileaf Oat Milk");
    expect(fromModel.servingG).toBe(150);
    expect(fromModel.servingSource).toBe("estimate");

    searchResult = null;
    model = answering({ estimate: { kcal: 100, proteinG: 1 } });
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
