import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MIN_SCORE,
  per100From,
  pickBestMatch,
  scaleToServing,
  scoreHit,
  searchFood,
  tokenize,
  type OffHit,
  type Per100,
} from "../openfoodfacts";

// No test in this file may reach the network: every test runs with a stubbed global fetch
// that fails loudly unless the test deliberately programmed a response.
let unprogrammed: string[];

const unprogrammedFetch = () =>
  vi.fn((url: string, _init: RequestInit): Promise<Response> => {
    // Recorded as well as thrown: searchFood swallows every error, so a test that forgot to
    // programme a response would otherwise "pass" on a null it never earned.
    unprogrammed.push(url);
    throw new Error(`unexpected network call: ${url}`);
  });

let fetchMock: ReturnType<typeof unprogrammedFetch>;

beforeEach(() => {
  unprogrammed = [];
  fetchMock = unprogrammedFetch();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  expect(unprogrammed).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- fixtures: the shape real search.openfoodfacts.org hits come back in ----------

const OAT_NUTRIMENTS: Record<string, unknown> = {
  "energy-kcal_100g": 49.2,
  proteins_100g: 1.3,
  carbohydrates_100g: 6.9,
  fat_100g: 1.5,
  "saturated-fat_100g": 0.2,
  fiber_100g: 0.8,
  sugars_100g: 3.9,
  salt_100g: 0.09,
};

const OAT_PER100: Per100 = {
  kcal: 49.2,
  proteinG: 1.3,
  carbsG: 6.9,
  fatG: 1.5,
  saturatedFatG: 0.2,
  fiberG: 0.8,
  sugarG: 3.9,
  saltG: 0.09,
};

const ZERO_PER100: Per100 = {
  kcal: 0,
  proteinG: 0,
  carbsG: 0,
  fatG: 0,
  saturatedFatG: 0,
  fiberG: 0,
  sugarG: 0,
  saltG: 0,
};

const OAT_HIT: OffHit = {
  code: "5060482840445",
  product_name: "Actileaf Oat Drink",
  brands: "Actileaf",
  serving_quantity: 200,
  countries_tags: ["en:united-kingdom"],
  nutriments: OAT_NUTRIMENTS,
};

// Same brand, a flavour the user never typed: the case the strict scorer exists for.
const CHERRY_HIT: OffHit = {
  code: "5449000267412",
  product_name: "Coca-Cola Zero Cherry",
  brands: ["Coca-Cola"],
  serving_quantity: 330,
  countries_tags: ["en:united-kingdom", "en:ireland"],
  nutriments: { "energy-kcal_100g": 0.3, proteins_100g: 0, carbohydrates_100g: 0, salt_100g: 0.01 },
};

// The plain variant the flavoured one must never stand in for.
const COKE_ZERO_HIT: OffHit = {
  code: "5449000131805",
  product_name: "Coca-Cola Zero",
  brands: "Coca-Cola",
  serving_quantity: 330,
  countries_tags: ["en:united-kingdom"],
  nutriments: { "energy-kcal_100g": 0.9, proteins_100g: 0, carbohydrates_100g: 0, salt_100g: 0.01 },
};

// A genuinely zero-calorie product: kcal 0 is label truth, not a missing value.
const SPARKLING_HIT: OffHit = {
  code: "5000112637939",
  product_name: "Sparkling Water",
  brands: "Highland Spring",
  serving_quantity: 500,
  countries_tags: ["en:united-kingdom"],
  nutriments: {
    "energy-kcal_100g": 0,
    proteins_100g: 0,
    carbohydrates_100g: 0,
    fat_100g: 0,
    salt_100g: 0,
  },
};

// Diacritics in both the name and the brand; users type it either way.
const MULLER_HIT: OffHit = {
  code: "4025500198336",
  product_name: "Müller Corner",
  brands: "Müller",
  serving_quantity: 149,
  nutriments: { "energy-kcal_100g": 118, proteins_100g: 4.1, sugars_100g: 15 },
};

const hit = (over: Partial<OffHit>): OffHit => ({ ...OAT_HIT, ...over });

// The GENERIC set after the fix: nutritionally neutral words ONLY. Diet modifiers were
// removed deliberately, because they change the macros.
const GENERIC_WORDS = [
  "original",
  "classic",
  "new",
  "fresh",
  "natural",
  "organic",
  "uht",
  "long",
  "life",
  "gb",
  "uk",
];
// Exactly ten of them: one extra apiece is a 0.05 deduction, so ten lands on MIN_SCORE.
const TEN_GENERICS = "Original Classic New Organic Natural Uht Long Life Fresh Gb";

// ---------- tokenize ----------

describe("tokenize", () => {
  const cases: [string, string, string[]][] = [
    ["a trailing pack size is dropped", "Coca Cola Zero 330ml", ["coca", "cola", "zero"]],
    ["hyphens are split, not kept", "Coca-Cola", ["coca", "cola"]],
    ["everything is lowercased", "ACTILEAF Oat MILK", ["actileaf", "oat", "milk"]],
    [
      "noise words 'style' and 'drink' are dropped",
      "Actileaf Barista Style Oat Drink",
      ["actileaf", "barista", "oat"],
    ],
    // Single characters are own-brand identity ("M&S", "B&M"); dropping them let an
    // unrelated generic record look like an exact match.
    ["single-character tokens are KEPT", "a big oat drink", ["a", "big", "oat"]],
    [
      "a bare size and the noise words go, but a stray 'g' survives and 'oats' is singularised",
      "500 g pack of oats",
      ["g", "oat"],
    ],
    ["a decimal size goes, its detached unit letter stays", "1.5 l semi skimmed milk", ["l", "semi", "skimmed", "milk"]],
    [
      "punctuation is split into tokens, including the possessive 's'",
      "my nan's leftover biryani!",
      ["my", "nan", "s", "leftover", "biryani"],
    ],
    [
      "percentages and gram sizes go, real words stay",
      "Yeo Valley 0% Fat Natural Yogurt 450g",
      ["yeo", "valley", "fat", "natural", "yogurt"],
    ],
    ["an all-noise name tokenizes to nothing", "the drink with style", []],
    ["an empty string tokenizes to nothing", "", []],
    ["whitespace tokenizes to nothing", "   ", []],
    ["a bare pack size tokenizes to nothing", "500ml", []],
  ];

  test.each(cases)("%s", (_label, input, expected) => {
    expect(tokenize(input)).toEqual(expected);
  });

  // ---- diacritics: NFD-stripped before anything else ----

  const accented: [string, string, string[]][] = [
    ["an accented name", "Müller Corner", ["muller", "corner"]],
    ["the same name typed without accents", "Muller Corner", ["muller", "corner"]],
    ["an accented brand", "Nestlé", ["nestle"]],
    ["a plain brand", "Nestle", ["nestle"]],
    ["a name full of accents", "Crème Brûlée Dessert", ["creme", "brulee", "dessert"]],
  ];
  test.each(accented)("diacritics are stripped: %s", (_label, input, expected) => {
    expect(tokenize(input)).toEqual(expected);
  });

  test("both spellings of Müller tokenize identically", () => {
    expect(tokenize("Müller Corner")).toEqual(tokenize("Muller Corner"));
  });

  // ---- singularisation ----

  const stems: [string, string, string[]][] = [
    ["a plural longer than three letters loses its 's'", "oats", ["oat"]],
    ["'digestives' becomes 'digestive'", "digestives", ["digestive"]],
    ["'crisps' becomes 'crisp'", "crisps", ["crisp"]],
    ["a word ending in 'ss' is left alone", "glass", ["glass"]],
    ["'dress' is left alone", "dress", ["dress"]],
    ["'swiss' is left alone", "swiss", ["swiss"]],
    ["a three-letter word ending in 's' is left alone", "gas", ["gas"]],
    ["'bus' is left alone", "bus", ["bus"]],
    ["a lone 's' is left alone", "s", ["s"]],
    ["a possessive brand keeps its split 's'", "McVitie's digestives", ["mcvitie", "s", "digestive"]],
    ["an ampersand brand becomes two single-letter tokens", "M&S", ["m", "s"]],
  ];
  test.each(stems)("singularisation: %s", (_label, input, expected) => {
    expect(tokenize(input)).toEqual(expected);
  });
});

// ---------- scoreHit ----------

describe("scoreHit", () => {
  // [label, logged name, candidate hit, expected score]
  const cases: [string, string, OffHit, number][] = [
    [
      "an exact match scores 1",
      "coca cola zero",
      { product_name: "Coca-Cola Zero", brands: ["Coca-Cola"] },
      1,
    ],
    [
      "the UK bonus is capped: an exact UK match is still 1",
      "coca cola zero",
      { product_name: "Coca-Cola Zero", brands: ["Coca-Cola"], countries_tags: ["en:united-kingdom"] },
      1,
    ],
    [
      "a logged word the product never mentions scores 0",
      "tesco chicken katsu curry",
      { product_name: "Chicken Curry", brands: "Tesco" },
      0,
    ],
    [
      "TRAP: an extra flavour disqualifies the product outright",
      "coca cola zero",
      CHERRY_HIT,
      0,
    ],
    [
      "TRAP: an extra flavour AND a missing logged word scores 0",
      "actileaf barista oat",
      { product_name: "Actileaf Chocolate Oat Drink", brands: "Actileaf" },
      0,
    ],
    [
      "one generic extra still matches, a notch lower",
      "actileaf oat",
      { product_name: "Actileaf Organic Oat Drink", brands: "Actileaf" },
      0.95,
    ],
    [
      "a generic extra plus the UK bonus lands back on 1",
      "actileaf oat",
      {
        product_name: "Actileaf Organic Oat Drink",
        brands: "Actileaf",
        countries_tags: ["en:united-kingdom", "en:ireland"],
      },
      1,
    ],
    [
      "TRAP: 'gluten free' is no longer generic — it is a different product",
      "actileaf oat",
      { product_name: "Actileaf Gluten Free Oat Drink", brands: "Actileaf" },
      0,
    ],
    [
      "a brand given as a plain string is scored like an array",
      "actileaf oat drink",
      { product_name: "Oat Drink", brands: "Actileaf" },
      1,
    ],
    [
      "a brand given as an array is scored like a string",
      "actileaf oat drink",
      { product_name: "Oat Drink", brands: ["Actileaf"] },
      1,
    ],
    [
      "a logged word carried only by the brand still counts",
      "warburtons toastie loaf",
      { product_name: "Toastie Loaf", brands: ["Warburtons"] },
      1,
    ],
    [
      "a hit with neither name nor brands scores 0",
      "coca cola zero",
      { code: "1234567890123", nutriments: OAT_NUTRIMENTS },
      0,
    ],
    [
      "a hit whose name and brands are empty strings scores 0",
      "coca cola zero",
      { product_name: "", brands: "" },
      0,
    ],
    [
      "a hit whose brands are null scores on the name alone",
      "actileaf oat",
      { product_name: "Actileaf Oat Drink", brands: null },
      1,
    ],
    [
      "a query of nothing but noise words scores 0",
      "the drink with style",
      OAT_HIT,
      0,
    ],
  ];

  test.each(cases)("%s", (_label, query, candidate, expected) => {
    expect(scoreHit(tokenize(query), candidate)).toBe(expected);
  });

  test("an empty token list scores 0 even against a perfect product", () => {
    expect(scoreHit([], OAT_HIT)).toBe(0);
  });

  test("ten generic extras land exactly on MIN_SCORE, eleven fall below it", () => {
    const ten = { product_name: `${TEN_GENERICS} Actileaf Oat` };
    const eleven = { product_name: `${TEN_GENERICS} Uk Actileaf Oat` };
    const query = tokenize("actileaf oat");
    expect(scoreHit(query, ten)).toBe(MIN_SCORE);
    expect(scoreHit(query, eleven)).toBeCloseTo(0.45, 10);
    expect(scoreHit(query, eleven)).toBeLessThan(MIN_SCORE);
  });

  test("every score stays inside [0, 1]", () => {
    const all: OffHit[] = [
      OAT_HIT,
      CHERRY_HIT,
      SPARKLING_HIT,
      MULLER_HIT,
      { product_name: "Actileaf Organic Uht Oat Drink", brands: "Actileaf", countries_tags: ["en:united-kingdom"] },
      { product_name: "", brands: "" },
    ];
    for (const h of all) {
      for (const q of ["actileaf oat", "coca cola zero", "", "the drink", "M&S chicken tikka"]) {
        const score = scoreHit(tokenize(q), h);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  // ---- diacritics ----

  describe("diacritics", () => {
    test.each([["Müller Corner"], ["Muller Corner"]])(
      "%s matches the accented record either way round",
      (query) => {
        expect(scoreHit(tokenize(query), MULLER_HIT)).toBe(1);
      },
    );

    test("an accent-only difference in the brand is not an extra", () => {
      // Brand "Müller" is carried by the record; the user typed the plain spelling.
      expect(scoreHit(tokenize("muller corner"), { product_name: "Corner", brands: "Müller" })).toBe(1);
      expect(scoreHit(tokenize("nestle kitkat"), { product_name: "KitKat", brands: "Nestlé" })).toBe(1);
    });
  });

  // ---- single-character identity ----

  describe("single-character own-brand tokens", () => {
    test("M&S does not match a brandless generic record", () => {
      // The "m" and "s" tokens are unaccounted for, so this is not the logged product.
      expect(tokenize("M&S chicken tikka")).toEqual(["m", "s", "chicken", "tikka"]);
      expect(scoreHit(tokenize("M&S chicken tikka"), { product_name: "Chicken Tikka" })).toBe(0);
      expect(scoreHit(tokenize("M&S chicken tikka"), { product_name: "Chicken Tikka", brands: "Tesco" })).toBe(0);
    });

    test("M&S matches the M&S-branded record", () => {
      expect(scoreHit(tokenize("M&S chicken tikka"), { product_name: "Chicken Tikka", brands: "M&S" })).toBe(1);
      expect(
        scoreHit(tokenize("M&S chicken tikka"), { product_name: "Chicken Tikka", brands: ["Marks & Spencer", "M&S"] }),
      ).toBe(1);
    });

    test("the same holds for B&M", () => {
      expect(scoreHit(tokenize("B&M salted peanuts"), { product_name: "Salted Peanut" })).toBe(0);
      expect(scoreHit(tokenize("B&M salted peanuts"), { product_name: "Salted Peanut", brands: "B&M" })).toBe(1);
    });
  });

  // ---- singularisation ----

  describe("singularisation", () => {
    test("a plural logged name matches the record's singular", () => {
      expect(scoreHit(tokenize("McVitie's digestives"), { product_name: "Digestive", brands: "McVitie's" })).toBe(1);
    });

    test("it works in the other direction too", () => {
      expect(scoreHit(tokenize("quaker oats"), { product_name: "Oats", brands: "Quaker" })).toBe(1);
      expect(scoreHit(tokenize("quaker oat"), { product_name: "Oats", brands: "Quaker" })).toBe(1);
    });

    test("an -ss word is not stemmed into a false match", () => {
      // "glass" must not become "glas": a record named "Glas" is a different word.
      expect(scoreHit(tokenize("glass bottle"), { product_name: "Glas Bottle" })).toBe(0);
      expect(scoreHit(tokenize("glass bottle"), { product_name: "Glass Bottle" })).toBe(1);
    });
  });

  // ---- diet modifiers now disqualify ----

  describe("diet modifiers are NOT generic", () => {
    // [label, logged name, product name, brands] — every one of these must score 0.
    const disqualifying: [string, string, string, string][] = [
      ["gluten free", "warburtons white loaf", "Gluten Free White Loaf", "Warburtons"],
      ["vegan", "greggs sausage roll", "Greggs Vegan Sausage Roll", "Greggs"],
      ["dairy free", "alpro yogurt", "Alpro Dairy Free Yogurt", "Alpro"],
      ["lactose free", "arla milk", "Arla Lactose Free Milk", "Arla"],
      ["no added sugar", "ribena blackcurrant", "Ribena No Added Sugar Blackcurrant", "Ribena"],
      ["a bare 'free'", "actileaf oat", "Actileaf Free Oat Drink", "Actileaf"],
      ["plant based", "actileaf oat", "Actileaf Plant Based Oat Drink", "Actileaf"],
      ["hyphenated gluten-free", "actileaf oat", "Actileaf Gluten-Free Oat Drink", "Actileaf"],
      ["'no' and 'added' on their own", "actileaf oat", "Actileaf No Added Oat Drink", "Actileaf"],
    ];
    test.each(disqualifying)("%s scores 0", (_label, query, productName, brands) => {
      expect(scoreHit(tokenize(query), { product_name: productName, brands })).toBe(0);
    });

    // The same query against the product WITHOUT the modifier still matches, which proves
    // it is the modifier doing the disqualifying and not a broken query.
    const plain: [string, string, string, string][] = [
      ["warburtons white loaf", "warburtons white loaf", "White Loaf", "Warburtons"],
      ["greggs sausage roll", "greggs sausage roll", "Greggs Sausage Roll", "Greggs"],
      ["alpro yogurt", "alpro yogurt", "Alpro Yogurt", "Alpro"],
      ["arla milk", "arla milk", "Arla Milk", "Arla"],
      ["ribena blackcurrant", "ribena blackcurrant", "Ribena Blackcurrant", "Ribena"],
    ];
    test.each(plain)("...but the unmodified '%s' still scores 1", (_label, query, productName, brands) => {
      expect(scoreHit(tokenize(query), { product_name: productName, brands })).toBe(1);
    });

    test("a logged diet modifier still matches the diet product", () => {
      // The user asked for the gluten-free loaf, so the gluten-free loaf is the right label.
      expect(
        scoreHit(tokenize("warburtons gluten free white loaf"), {
          product_name: "Gluten Free White Loaf",
          brands: "Warburtons",
        }),
      ).toBe(1);
      expect(
        scoreHit(tokenize("greggs vegan sausage roll"), { product_name: "Greggs Vegan Sausage Roll", brands: "Greggs" }),
      ).toBe(1);
    });

    test.each(GENERIC_WORDS)("the surviving generic word '%s' costs one notch, not the match", (word) => {
      expect(scoreHit(tokenize("actileaf oat"), { product_name: `Actileaf ${word} Oat Drink`, brands: "Actileaf" })).toBe(
        0.95,
      );
    });
  });

  // ---- multi-brand records ----

  describe("multi-brand records", () => {
    const CHUNKY: OffHit = {
      code: "7613035089242",
      product_name: "Chunky",
      serving_quantity: 40,
      nutriments: OAT_NUTRIMENTS,
    };

    const spelled: [string, OffHit["brands"]][] = [
      ["a comma-joined string", "Nestlé,Kit Kat"],
      ["an array", ["Nestlé", "Kit Kat"]],
    ];
    test.each(spelled)("parent and sub-brand given as %s both match the logged sub-brand", (_label, brands) => {
      expect(scoreHit(tokenize("kit kat chunky"), { ...CHUNKY, brands })).toBe(1);
    });

    const concatenated: [string, OffHit["brands"]][] = [
      ["a comma-joined string", "Nestlé,KitKat"],
      ["an array", ["Nestlé", "KitKat"]],
    ];
    test.each(concatenated)("the brand the user did NOT type is never an extra (%s)", (_label, brands) => {
      // The whole point of the fix: a record listing parent AND sub-brand used to be
      // auto-rejected because the unlogged half looked like an extra word.
      expect(scoreHit(tokenize("kitkat chunky"), { ...CHUNKY, brands })).toBe(1);
      expect(scoreHit(tokenize("nestle chunky"), { ...CHUNKY, brands })).toBe(1);
      expect(scoreHit(tokenize("nestlé chunky"), { ...CHUNKY, brands })).toBe(1);
      expect(scoreHit(tokenize("nestle kitkat chunky"), { ...CHUNKY, brands })).toBe(1);
    });

    test("no number of brand tokens can push a name-exact match below 1", () => {
      const many = {
        product_name: "Actileaf Oat Drink",
        brands: "Actileaf,Barista Series,Plant Kitchen,Gluten Free Co,Some Other Label",
      };
      expect(scoreHit(tokenize("actileaf oat"), many)).toBe(1);
      expect(scoreHit(tokenize("actileaf oat"), { ...many, brands: many.brands.split(",") })).toBe(1);
    });

    test("brand tokens rescue a logged word, but the NAME may still not add one", () => {
      const brands = ["Nestlé", "Kit Kat"];
      // "chunky" is logged and carried by the name — fine.
      expect(scoreHit(tokenize("kit kat chunky"), { product_name: "Chunky", brands })).toBe(1);
      // "White" is a variant the user never typed, and it is in the NAME — rejected.
      expect(scoreHit(tokenize("kit kat chunky"), { product_name: "Chunky White", brands })).toBe(0);
    });
  });
});

// ---------- per100From ----------

describe("per100From", () => {
  test("a full nutriments block yields all eight per-100 fields", () => {
    expect(per100From(OAT_HIT)).toEqual(OAT_PER100);
  });

  test("absent optional values default to 0, kcal and protein are kept", () => {
    expect(per100From({ nutriments: { "energy-kcal_100g": 49.2, proteins_100g: 1.3 } })).toEqual({
      kcal: 49.2,
      proteinG: 1.3,
      carbsG: 0,
      fatG: 0,
      saturatedFatG: 0,
      fiberG: 0,
      sugarG: 0,
      saltG: 0,
    });
  });

  test("string numerics are coerced", () => {
    expect(
      per100From({
        nutriments: {
          "energy-kcal_100g": "49.2",
          proteins_100g: "1.3",
          carbohydrates_100g: "6.9",
          fat_100g: "1.5",
          "saturated-fat_100g": "0.2",
          fiber_100g: "0.8",
          sugars_100g: "3.9",
          salt_100g: "0.09",
        },
      }),
    ).toEqual(OAT_PER100);
  });

  const nullCases: [string, OffHit][] = [
    ["no nutriments key at all", { code: "1", product_name: "Oat Drink" }],
    ["a null nutriments block", { nutriments: null }],
    ["an empty nutriments block", { nutriments: {} }],
    ["kcal missing", { nutriments: { proteins_100g: 1.3 } }],
    ["kcal negative", { nutriments: { "energy-kcal_100g": -10, proteins_100g: 1.3 } }],
    ["kcal not a number", { nutriments: { "energy-kcal_100g": "about 50", proteins_100g: 1.3 } }],
    ["kcal infinite", { nutriments: { "energy-kcal_100g": Infinity, proteins_100g: 1.3 } }],
    ["kcal null", { nutriments: { "energy-kcal_100g": null, proteins_100g: 1.3 } }],
    // A blank string used to slip through as a real 0 via Number("").
    ["kcal is a blank string", { nutriments: { "energy-kcal_100g": "", proteins_100g: 1.3 } }],
    ["protein missing", { nutriments: { "energy-kcal_100g": 49.2 } }],
    ["protein null", { nutriments: { "energy-kcal_100g": 49.2, proteins_100g: null } }],
    ["protein negative", { nutriments: { "energy-kcal_100g": 49.2, proteins_100g: -1 } }],
    ["protein not a number", { nutriments: { "energy-kcal_100g": 49.2, proteins_100g: "trace" } }],
    ["protein is a blank string", { nutriments: { "energy-kcal_100g": 49.2, proteins_100g: "" } }],
    ["both are blank strings", { nutriments: { "energy-kcal_100g": "", proteins_100g: "" } }],
  ];
  test.each(nullCases)("null when %s", (_label, candidate) => {
    expect(per100From(candidate)).toBeNull();
  });

  // ---- a declared 0 kcal is label truth, not a missing value ----

  describe("zero calories", () => {
    test("kcal 0 with a real protein value yields a Per100", () => {
      expect(per100From({ nutriments: { "energy-kcal_100g": 0, proteins_100g: 1.3 } })).toEqual({
        ...ZERO_PER100,
        proteinG: 1.3,
      });
    });

    test("kcal '0' as a string yields a Per100 too", () => {
      expect(per100From({ nutriments: { "energy-kcal_100g": "0", proteins_100g: "1.3" } })).toEqual({
        ...ZERO_PER100,
        proteinG: 1.3,
      });
    });

    test("sparkling water: every declared value is 0 and the record is still usable", () => {
      expect(per100From(SPARKLING_HIT)).toEqual(ZERO_PER100);
    });

    test("a zero-cal drink scales to a zero-cal serving rather than to no label at all", () => {
      const per100 = per100From(SPARKLING_HIT);
      expect(per100).not.toBeNull();
      expect(scaleToServing(per100!, 500)).toEqual({ kcal: 0, proteinG: 0 });
    });
  });

  test("zero protein is a real value, not a missing one", () => {
    // Diet drinks legitimately declare 0 g protein.
    expect(per100From(CHERRY_HIT)).toEqual({
      kcal: 0.3,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      saturatedFatG: 0,
      fiberG: 0,
      sugarG: 0,
      saltG: 0.01,
    });
  });

  const rejectedOptional: [string, unknown][] = [
    ["negative", -3],
    ["infinite", Infinity],
    ["not a number", "n/a"],
    ["null", null],
    // Number("") is 0; this must be treated as "absent", which happens to also be 0 here.
    ["blank string", ""],
  ];
  test.each(rejectedOptional)("a %s optional value falls back to 0", (_label, value) => {
    expect(
      per100From({
        nutriments: {
          "energy-kcal_100g": 49.2,
          proteins_100g: 1.3,
          sugars_100g: value,
          fat_100g: value,
        },
      }),
    ).toEqual({
      kcal: 49.2,
      proteinG: 1.3,
      carbsG: 0,
      fatG: 0,
      saturatedFatG: 0,
      fiberG: 0,
      sugarG: 0,
      saltG: 0,
    });
  });

  test("a blank optional does not shadow a real declared 0 elsewhere", () => {
    expect(
      per100From({
        nutriments: { "energy-kcal_100g": 0, proteins_100g: 0, sugars_100g: "", salt_100g: 0.01 },
      }),
    ).toEqual({ ...ZERO_PER100, saltG: 0.01 });
  });
});

// ---------- pickBestMatch ----------

describe("pickBestMatch", () => {
  test("a single clean hit becomes the match, brand and serving carried over", () => {
    expect(pickBestMatch("Actileaf Oat Drink", [OAT_HIT])).toEqual({
      code: "5060482840445",
      productName: "Actileaf Oat Drink",
      brand: "Actileaf",
      per100: OAT_PER100,
      servingQuantityG: 200,
      score: 1,
    });
  });

  test("the highest scorer wins, whatever the order", () => {
    const generic = hit({ code: "generic", product_name: "Actileaf Organic Oat Drink", countries_tags: [] });
    const exact = hit({ code: "exact", product_name: "Actileaf Oat Drink", countries_tags: [] });
    expect(pickBestMatch("actileaf oat drink", [generic, exact])?.code).toBe("exact");
    expect(pickBestMatch("actileaf oat drink", [exact, generic])?.code).toBe("exact");
    expect(pickBestMatch("actileaf oat drink", [generic, exact])?.score).toBe(1);
    expect(pickBestMatch("actileaf oat drink", [generic])?.score).toBe(0.95);
  });

  test("a UK hit beats an otherwise identical non-UK hit, in either order", () => {
    const uk = hit({ code: "uk", product_name: "Actileaf Organic Oat Drink", countries_tags: ["en:united-kingdom"] });
    const nonUk = hit({ code: "non-uk", product_name: "Actileaf Organic Oat Drink", countries_tags: ["en:france"] });
    expect(pickBestMatch("actileaf oat", [nonUk, uk])?.code).toBe("uk");
    expect(pickBestMatch("actileaf oat", [uk, nonUk])?.code).toBe("uk");
    expect(pickBestMatch("actileaf oat", [nonUk, uk])?.score).toBe(1);
    expect(pickBestMatch("actileaf oat", [nonUk])?.score).toBe(0.95);
  });

  test("on a genuine tie the first hit stays: ties never reshuffle", () => {
    const first = hit({ code: "first" });
    const second = hit({ code: "second" });
    expect(pickBestMatch("actileaf oat drink", [first, second])?.code).toBe("first");
  });

  const skipped: [string, OffHit][] = [
    ["it has no code", hit({ code: undefined })],
    ["its code is empty", hit({ code: "" })],
    ["it has no product_name", hit({ product_name: undefined })],
    ["its product_name is empty", hit({ product_name: "" })],
    ["it has no usable nutriments", hit({ nutriments: {} })],
    ["its kcal is missing", hit({ nutriments: { proteins_100g: 1.3 } })],
    ["its kcal is a blank string", hit({ nutriments: { "energy-kcal_100g": "", proteins_100g: 1.3 } })],
    ["its protein is missing", hit({ nutriments: { "energy-kcal_100g": 49.2 } })],
    ["its protein is a blank string", hit({ nutriments: { "energy-kcal_100g": 49.2, proteins_100g: "" } })],
  ];
  test.each(skipped)("a hit is skipped when %s", (_label, candidate) => {
    expect(pickBestMatch("actileaf oat drink", [candidate])).toBeNull();
    // ...and a good hit alongside it is still found.
    expect(pickBestMatch("actileaf oat drink", [candidate, OAT_HIT])?.code).toBe(OAT_HIT.code);
  });

  test("a zero-kcal hit is a real match now, not a skipped one", () => {
    const zero = hit({ code: "zero-cal", nutriments: { "energy-kcal_100g": 0, proteins_100g: 1.3 } });
    const match = pickBestMatch("actileaf oat drink", [zero]);
    expect(match?.code).toBe("zero-cal");
    expect(match?.per100.kcal).toBe(0);
    expect(match?.per100.proteinG).toBe(1.3);
  });

  test("a zero-calorie drink resolves to a label match, not to null", () => {
    expect(pickBestMatch("Highland Spring sparkling water", [SPARKLING_HIT])).toEqual({
      code: "5000112637939",
      productName: "Sparkling Water",
      brand: "Highland Spring",
      per100: ZERO_PER100,
      servingQuantityG: 500,
      score: 1,
    });
  });

  test("null when no hit clears MIN_SCORE", () => {
    // Every candidate is a different product from the one logged.
    const hits = [
      CHERRY_HIT,
      hit({ code: "choc", product_name: "Actileaf Chocolate Oat Drink" }),
      hit({ code: "soya", product_name: "Alpro Soya Drink", brands: "Alpro" }),
    ];
    expect(pickBestMatch("coca cola zero", hits)).toBeNull();
  });

  test("MIN_SCORE is a real floor: 0.5 is kept, just under is dropped", () => {
    // No UK bonus on either, so the floor is tested on the extras penalty alone.
    const at = hit({
      code: "at-floor",
      brands: null,
      countries_tags: [],
      product_name: `${TEN_GENERICS} Actileaf Oat`,
    });
    const below = hit({
      code: "below-floor",
      brands: null,
      countries_tags: [],
      product_name: `${TEN_GENERICS} Uk Actileaf Oat`,
    });
    expect(pickBestMatch("actileaf oat", [at])?.score).toBe(MIN_SCORE);
    expect(pickBestMatch("actileaf oat", [below])).toBeNull();
  });

  test("null for an empty hit list", () => {
    expect(pickBestMatch("actileaf oat drink", [])).toBeNull();
  });

  const untokenizable: [string, string][] = [
    ["nothing but noise words", "the drink with style"],
    ["a bare pack size", "500ml"],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a size and a noise word", "500 ml pack"],
  ];
  test.each(untokenizable)("null when the query is %s", (_label, query) => {
    expect(pickBestMatch(query, [OAT_HIT, SPARKLING_HIT, CHERRY_HIT])).toBeNull();
  });

  const servings: [string, OffHit["serving_quantity"], number | null][] = [
    ["a number is kept", 200, 200],
    ["a numeric string is coerced", "250", 250],
    ["zero is kept as zero", 0, 0],
    ["a negative is rejected", -5, null],
    ["a non-numeric string is rejected", "one glass", null],
    // Number("") is 0; a blank quantity is no quantity, so the caller can ask the model.
    ["a blank string is rejected", "", null],
    ["null stays null", null, null],
    ["undefined stays null", undefined, null],
  ];
  test.each(servings)("serving_quantity: %s", (_label, raw, expected) => {
    expect(pickBestMatch("actileaf oat drink", [hit({ serving_quantity: raw })])?.servingQuantityG).toBe(
      expected,
    );
  });

  const brands: [string, OffHit["brands"], string | null][] = [
    ["a string brand is kept", "Actileaf", "Actileaf"],
    ["an array brand takes the first entry", ["Actileaf"], "Actileaf"],
    ["a multi-entry array takes the first entry", ["Actileaf", "Oatly"], "Actileaf"],
    ["a comma-joined string takes the text before the first comma", "Actileaf,Oatly", "Actileaf"],
    ["a comma-joined string is trimmed", "  Actileaf , Oatly ", "Actileaf"],
    ["an array entry is trimmed", ["  Actileaf  ", "Oatly"], "Actileaf"],
    ["an empty array becomes null", [], null],
    ["an empty string becomes null", "", null],
    ["a whitespace-only string becomes null", "   ", null],
    ["a leading empty comma field becomes null", ",Oatly", null],
    ["an array of one blank entry becomes null", ["   "], null],
    ["null stays null", null, null],
  ];
  test.each(brands)("brands: %s", (_label, raw, expected) => {
    expect(pickBestMatch("actileaf oat drink", [hit({ product_name: "Actileaf Oat Drink", brands: raw })])?.brand).toBe(
      expected,
    );
  });

  test("a multi-brand record reports the parent brand, not the sub-brand", () => {
    const chunky: OffHit = {
      code: "kitkat",
      product_name: "Chunky",
      brands: "Nestlé,KitKat",
      serving_quantity: 40,
      nutriments: OAT_NUTRIMENTS,
    };
    expect(pickBestMatch("nestle chunky", [chunky])?.brand).toBe("Nestlé");
    expect(pickBestMatch("nestle chunky", [{ ...chunky, brands: ["Nestlé", "KitKat"] }])?.brand).toBe("Nestlé");
    // ...and the record is reachable by the sub-brand alone.
    expect(pickBestMatch("kitkat chunky", [chunky])?.code).toBe("kitkat");
  });

  test("an M&S own-brand record is only picked when the record carries the brand", () => {
    const brandless = hit({ code: "brandless", product_name: "Chicken Tikka", brands: null });
    const ownBrand = hit({ code: "own-brand", product_name: "Chicken Tikka", brands: "M&S" });
    expect(pickBestMatch("M&S chicken tikka", [brandless])).toBeNull();
    expect(pickBestMatch("M&S chicken tikka", [brandless, ownBrand])?.code).toBe("own-brand");
  });

  test("a diet variant is never substituted for the plain product", () => {
    const glutenFree = hit({ code: "gf", product_name: "Gluten Free White Loaf", brands: "Warburtons" });
    const plain = hit({ code: "plain", product_name: "White Loaf", brands: "Warburtons" });
    expect(pickBestMatch("warburtons white loaf", [glutenFree])).toBeNull();
    expect(pickBestMatch("warburtons white loaf", [glutenFree, plain])?.code).toBe("plain");
  });
});

// ---------- scaleToServing ----------

describe("scaleToServing", () => {
  const per100 = (kcal: number, proteinG: number): Per100 => ({
    ...OAT_PER100,
    kcal,
    proteinG,
  });

  const cases: [string, Per100, number, { kcal: number; proteinG: number }][] = [
    ["100 g is the identity", per100(98, 2.6), 100, { kcal: 98, proteinG: 2.6 }],
    ["a 250 ml serving of a 49.2 kcal/100 product", per100(49.2, 1.05), 250, { kcal: 123, proteinG: 2.6 }],
    ["a 200 ml glass of the same oat drink", per100(49.2, 1.3), 200, { kcal: 98, proteinG: 2.6 }],
    ["kcal rounds half up", per100(1, 0.4), 50, { kcal: 1, proteinG: 0.2 }],
    ["protein rounds half up at one decimal", per100(49.2, 1.02), 250, { kcal: 123, proteinG: 2.6 }],
    ["protein keeps one decimal, not two", per100(400, 12.34), 100, { kcal: 400, proteinG: 12.3 }],
    ["a whole 1 l carton", per100(49.2, 1.3), 1000, { kcal: 492, proteinG: 13 }],
    ["a 30 g portion", per100(379, 11), 30, { kcal: 114, proteinG: 3.3 }],
    ["a zero serving scales to zero", per100(49.2, 1.3), 0, { kcal: 0, proteinG: 0 }],
    ["a near-zero drink rounds down to 0 kcal", per100(0.3, 0), 100, { kcal: 0, proteinG: 0 }],
    ["a 330 ml can of a 0.9 kcal/100 drink is 3 kcal", per100(0.9, 0), 330, { kcal: 3, proteinG: 0 }],
    ["a truly zero-cal drink stays at zero", per100(0, 0), 500, { kcal: 0, proteinG: 0 }],
  ];

  test.each(cases)("%s", (_label, per, servingG, expected) => {
    expect(scaleToServing(per, servingG)).toEqual(expected);
  });

  test("kcal is always an integer and protein never carries a second decimal", () => {
    for (const servingG of [17, 33, 125, 240, 333]) {
      const out = scaleToServing(OAT_PER100, servingG);
      expect(Number.isInteger(out.kcal)).toBe(true);
      expect(out.proteinG).toBe(Math.round(out.proteinG * 10) / 10);
    }
  });
});

// ---------- searchFood (stubbed fetch; never the real API) ----------

describe("searchFood", () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const htmlResponse = (status: number) =>
    new Response(
      "<html><head><title>503 Service Unavailable</title></head><body><h1>Service Unavailable</h1></body></html>",
      { status, headers: { "content-type": "text/html; charset=utf-8" } },
    );

  // A Response body can only be read once, and several tests below deliberately fetch
  // twice, so every stub builds a FRESH Response per call.
  const respondJson = (body: unknown, status = 200) =>
    fetchMock.mockImplementation(async () => jsonResponse(body, status));
  const respondHtml = (status: number) => fetchMock.mockImplementation(async () => htmlResponse(status));

  // searchFood memoises by trimmed lowercase name for the lifetime of the module,
  // so every test below uses a product name no other test touches.

  test("a JSON 200 with a matching hit returns the parsed match", async () => {
    respondJson({ hits: [OAT_HIT] });
    await expect(searchFood("Actileaf Oat Drink")).resolves.toEqual({
      code: "5060482840445",
      productName: "Actileaf Oat Drink",
      brand: "Actileaf",
      per100: OAT_PER100,
      servingQuantityG: 200,
      score: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("'Actileaf Oat Milk' finds the label, and a 200 ml glass is 98 kcal / 2.6 g", async () => {
    // Mirrors the live result: the record carries no usable serving quantity, so the
    // caller has to ask for the portion — the per-100 density is still label-true.
    respondJson({
      hits: [hit({ code: "oat-milk", product_name: "Actileaf Oat Milk", serving_quantity: "" })],
    });
    const match = await searchFood("Actileaf Oat Milk");
    expect(match?.productName).toBe("Actileaf Oat Milk");
    expect(match?.servingQuantityG).toBeNull();
    expect(scaleToServing(match!.per100, 200)).toEqual({ kcal: 98, proteinG: 2.6 });
  });

  test("the flavoured variant is rejected: a plain Coke Zero search finds nothing", async () => {
    respondJson({ hits: [CHERRY_HIT] });
    await expect(searchFood("Coca Cola Zero")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("'Coca Cola Zero 330ml' picks the plain Zero over the Cherry variant", async () => {
    respondJson({ hits: [CHERRY_HIT, COKE_ZERO_HIT] });
    const match = await searchFood("Coca Cola Zero 330ml");
    expect(match?.productName).toBe("Coca-Cola Zero");
    expect(match?.brand).toBe("Coca-Cola");
    expect(match?.servingQuantityG).toBe(330);
    expect(scaleToServing(match!.per100, 330)).toEqual({ kcal: 3, proteinG: 0 });
  });

  test("the same flavoured variant IS returned when the user logs the flavour", async () => {
    respondJson({ hits: [CHERRY_HIT] });
    const match = await searchFood("Coca Cola Zero Cherry");
    expect(match?.productName).toBe("Coca-Cola Zero Cherry");
    expect(match?.brand).toBe("Coca-Cola");
    expect(match?.score).toBe(1);
  });

  test("'Warburtons white loaf' finds no label when only the gluten-free variant is listed", async () => {
    respondJson({ hits: [hit({ code: "gf", product_name: "Gluten Free White Loaf", brands: "Warburtons" })] });
    await expect(searchFood("Warburtons white loaf")).resolves.toBeNull();
  });

  test("'Greggs sausage roll' finds no label when only the vegan variant is listed", async () => {
    respondJson({ hits: [hit({ code: "vegan", product_name: "Greggs Vegan Sausage Roll", brands: "Greggs" })] });
    await expect(searchFood("Greggs sausage roll")).resolves.toBeNull();
  });

  test("both spellings of an accented product find the same record", async () => {
    respondJson({ hits: [MULLER_HIT] });
    const plain = await searchFood("Muller Corner");
    expect(plain?.code).toBe("4025500198336");
    expect(plain?.brand).toBe("Müller");

    respondJson({ hits: [MULLER_HIT] });
    const accented = await searchFood("Müller Corner");
    expect(accented).toEqual(plain);
  });

  // ---- answers OFF actually gave ARE cached ----

  test("a repeated lookup is served from the memo cache without a second fetch", async () => {
    respondJson({ hits: [hit({ code: "quaker", product_name: "Quaker Oat So Simple", brands: "Quaker" })] });
    const first = await searchFood("Quaker Oat So Simple");
    expect(first?.code).toBe("quaker");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await searchFood("Quaker Oat So Simple");
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("the memo key is the trimmed lowercased name", async () => {
    respondJson({ hits: [hit({ code: "granola", product_name: "Lizi's Granola", brands: "Lizi's" })] });
    const first = await searchFood("Lizi's Granola");
    expect(first?.code).toBe("granola");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await searchFood("  LIZI'S GRANOLA  ")).toEqual(first);
    expect(await searchFood("lizi's granola")).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a genuine 'not in the database' null is cached: OFF answered, so the miss stands", async () => {
    respondJson({ hits: [] });
    await expect(searchFood("my nan's leftover biryani")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Even a since-populated database is not consulted again inside the TTL.
    respondJson({ hits: [OAT_HIT] });
    await expect(searchFood("my nan's leftover biryani")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a JSON 200 in an unexpected shape is an answer too, and is cached", async () => {
    respondJson({ count: 0 });
    await expect(searchFood("Sainsburys Basmati Rice")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(searchFood("Sainsburys Basmati Rice")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a scored-out answer is cached: OFF answered, the hits just were not the product", async () => {
    respondJson({ hits: [hit({ code: "choc", product_name: "Actileaf Chocolate Oat Drink" })] });
    await expect(searchFood("Actileaf Barista Oat")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(searchFood("Actileaf Barista Oat")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ---- failures are NOT cached: a retry must reach the network again ----

  const failures: [string, string, () => void][] = [
    ["an HTML 503 (the public instance overloaded)", "Cathedral City Mature Cheddar", () => respondHtml(503)],
    ["a 200 that is not JSON", "Alpro Soya Drink", () => respondHtml(200)],
    ["a rate-limited JSON 429", "Innocent Orange Juice", () => respondJson({ error: "too many requests" }, 429)],
    ["a JSON 500", "Kelloggs Corn Flakes", () => respondJson({ error: "boom" }, 500)],
    [
      "malformed JSON in a JSON-typed response",
      "Hovis Seed Sensations Loaf",
      () =>
        fetchMock.mockImplementation(
          async () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
        ),
    ],
    ["a network error", "Warburtons Toastie Loaf", () => fetchMock.mockRejectedValue(new TypeError("fetch failed"))],
  ];

  test.each(failures)("%s resolves to null and is NOT cached", async (_label, name, programme) => {
    programme();
    await expect(searchFood(name)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second look-up must hit the network again, and must see the recovered API.
    respondJson({ hits: [hit({ code: "recovered", product_name: name, brands: null })] });
    const retry = await searchFood(name);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retry?.code).toBe("recovered");
  });

  test("a timeout resolves to null, is NOT cached, and the deadline is 2500 ms", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const requested: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      requested.push(ms);
      return realTimeout(10); // same abort, sooner, so the test does not wait 2.5 s
    });
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    await expect(searchFood("Yeo Valley Natural Yogurt")).resolves.toBeNull();
    expect(requested).toEqual([2500]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    respondJson({ hits: [hit({ code: "after-timeout", product_name: "Yeo Valley Natural Yogurt", brands: null })] });
    const retry = await searchFood("Yeo Valley Natural Yogurt");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retry?.code).toBe("after-timeout");
  });

  // ---- cache lifetime ----

  test("a cached answer expires after the one hour TTL", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);

    respondJson({ hits: [hit({ code: "ttl-a", product_name: "Kelloggs Crunchy Nut", brands: null })] });
    expect((await searchFood("Kelloggs Crunchy Nut"))?.code).toBe("ttl-a");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(t0 + 59 * 60 * 1000);
    respondJson({ hits: [hit({ code: "ttl-b", product_name: "Kelloggs Crunchy Nut", brands: null })] });
    expect((await searchFood("Kelloggs Crunchy Nut"))?.code).toBe("ttl-a");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(t0 + 60 * 60 * 1000 + 1);
    expect((await searchFood("Kelloggs Crunchy Nut"))?.code).toBe("ttl-b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ---- names that never reach the network ----

  const blankNames: [string, string][] = [
    ["an empty name", ""],
    ["a whitespace-only name", "   "],
    ["a name that is nothing but a pack size", "500ml"],
    ["a name that is nothing but noise words", "the drink with style"],
    ["a size plus two noise words", "500 ml pack"],
  ];

  test("a lone unit LETTER is a token, so '1.5 l pack' does reach the network", () => {
    // Single characters survive tokenize (own-brand identity), so this is not a blank name.
    expect(tokenize("1.5 l pack")).toEqual(["l"]);
  });
  test.each(blankNames)("%s never reaches the network", async (_label, name) => {
    await expect(searchFood(name)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a name that tokenizes to nothing is not cached either — it never got that far", async () => {
    await expect(searchFood("500ml")).resolves.toBeNull();
    await expect(searchFood("500ml")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ---- the request itself ----

  test("the request carries the query, page_size 10, the field list and a descriptive User-Agent", async () => {
    respondJson({ hits: [] });
    await searchFood("  Ben and Jerrys Cookie Dough  ");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://search.openfoodfacts.org/search");
    expect(url.searchParams.get("q")).toBe("ben and jerrys cookie dough");
    expect(url.searchParams.get("page_size")).toBe("10");
    expect(url.searchParams.get("fields")?.split(",")).toEqual(
      expect.arrayContaining([
        "code",
        "product_name",
        "brands",
        "serving_quantity",
        "nutriments",
        "countries_tags",
      ]),
    );

    const headers = init.headers as Record<string, string>;
    // OFF blocks anonymous clients: the UA must name the app and carry a contact.
    expect(headers["User-Agent"]).toMatch(/^Reforge\/\d+\.\d+ \(.+\)$/);
    expect(headers.Accept).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });

  test("the query sent is the memo key, so casing never doubles the traffic", async () => {
    respondJson({ hits: [] });
    await searchFood("Müller Corner YOGURT");
    const [rawUrl] = fetchMock.mock.calls[0];
    expect(new URL(rawUrl).searchParams.get("q")).toBe("müller corner yogurt");
  });

  // Last in the file on purpose: filling the cache evicts everything the tests above put in it.
  test("the cache is capped at 500 entries and evicts the oldest first", async () => {
    respondJson({ hits: [hit({ code: "probe", product_name: "Cachecap Probe", brands: null })] });
    expect((await searchFood("Cachecap Probe"))?.code).toBe("probe");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 500 distinct newer keys: the probe can no longer be one of the 500 kept entries.
    respondJson({ hits: [] });
    for (let i = 0; i < 500; i++) await searchFood(`Cachecap Filler ${i}`);
    expect(fetchMock).toHaveBeenCalledTimes(501);

    // The newest filler is still cached...
    await searchFood("Cachecap Filler 499");
    expect(fetchMock).toHaveBeenCalledTimes(501);

    // ...but the probe was evicted, so it goes back to the network.
    respondJson({ hits: [hit({ code: "probe-again", product_name: "Cachecap Probe", brands: null })] });
    expect((await searchFood("Cachecap Probe"))?.code).toBe("probe-again");
    expect(fetchMock).toHaveBeenCalledTimes(502);
  });
});
