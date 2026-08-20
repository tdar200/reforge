// Open Food Facts lookup: label-true macros per 100 g/ml for branded products.
// The public search is fuzzy and frequently rate-limited, so every failure mode here
// resolves to null and the caller falls back to a model estimate.

const SEARCH_URL = "https://search.openfoodfacts.org/search";
// OFF requires a descriptive, contactable User-Agent.
const USER_AGENT = "Reforge/1.0 (personal fitness tracker; github.com/tdar200/reforge)";
// This sits in front of an interactive Add, and a model call may still follow it.
const TIMEOUT_MS = 2500;
const PAGE_SIZE = 10;
const FIELDS = "code,product_name,brands,serving_size,serving_quantity,nutriments,countries_tags";

export type Per100 = {
  kcal: number; proteinG: number; carbsG: number; fatG: number;
  saturatedFatG: number; fiberG: number; sugarG: number; saltG: number;
};

export type FoodMatch = {
  code: string;
  productName: string;
  brand: string | null;
  per100: Per100;
  servingQuantityG: number | null;
  score: number;
};

export type OffHit = {
  code?: string;
  product_name?: string;
  brands?: string[] | string | null;
  serving_quantity?: number | string | null;
  countries_tags?: string[] | null;
  nutriments?: Record<string, unknown> | null;
};

// Words that carry no distinguishing weight when comparing a logged name to a product name.
const NOISE = new Set(["the", "of", "and", "with", "style", "drink", "pack", "size", "ml", "kg", "cl"]);
// Words a product may add without becoming a NUTRITIONALLY different product. Diet modifiers
// (gluten/dairy/lactose free, vegan, plant based, no added sugar) are deliberately absent:
// they change the macros, so they must disqualify a match rather than be waved through.
const GENERIC = new Set(["original", "classic", "new", "fresh", "natural", "organic", "uht", "long", "life", "gb", "uk"]);
const SIZE = /^\d+(\.\d+)?(ml|l|g|kg|cl|oz|x)?$/;

/** Strips accents so "Müller" and "Muller" tokenize alike; both spellings occur in the wild. */
const deaccent = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Singularised so "digestives" matches the record's "Digestive". */
const stem = (t: string) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);

export function tokenize(text: string): string[] {
  return deaccent(text.toLowerCase())
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    // Single characters are kept: they are own-brand identity ("M&S", "B&M"), and dropping
    // them let an unrelated generic record look like an exact match.
    .filter((t) => t.length > 0 && !NOISE.has(t) && !SIZE.test(t))
    .map(stem);
}

const num = (v: unknown): number | null => {
  if (v === "" || v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
};

const brandTokens = (brands: OffHit["brands"]): string[] => {
  const list = Array.isArray(brands) ? brands : String(brands ?? "").split(",");
  return list.flatMap((b) => tokenize(b));
};

/**
 * Confidence that a product IS the logged food, in [0, 1]; 0 means "not this product".
 *
 * Deliberately strict, because wrong label data is worse than an honest estimate: the
 * product must account for every word logged and its NAME may only add generic words.
 * A flavour or diet variant the user never typed ("Zero Cherry" for "coca cola zero",
 * "Gluten Free White Loaf" for "white loaf") disqualifies the match outright.
 * Brand fields may add tokens freely — OFF records routinely list parent and sub-brand.
 */
export function scoreHit(queryTokens: string[], hit: OffHit): number {
  if (!queryTokens.length) return 0;
  const nameTokens = tokenize(hit.product_name ?? "");
  const brands = brandTokens(hit.brands);
  if (!nameTokens.length && !brands.length) return 0;
  const cand = new Set([...nameTokens, ...brands]);
  const query = new Set(queryTokens);
  if (queryTokens.some((t) => !cand.has(t))) return 0; // something logged is unaccounted for
  const extra = nameTokens.filter((t) => !query.has(t));
  if (extra.some((t) => !GENERIC.has(t))) return 0; // the product is a different variant
  const ukBonus = (hit.countries_tags ?? []).includes("en:united-kingdom") ? 0.05 : 0;
  return Math.min(1, 1 - extra.length * 0.05 + ukBonus);
}

export function per100From(hit: OffHit): Per100 | null {
  const n = hit.nutriments ?? {};
  const kcal = num(n["energy-kcal_100g"]);
  const proteinG = num(n["proteins_100g"]);
  // A true 0 is meaningful (sparkling water, zero-cal drinks); only an absent value disqualifies.
  if (kcal === null || proteinG === null) return null;
  return {
    kcal, proteinG,
    carbsG: num(n["carbohydrates_100g"]) ?? 0,
    fatG: num(n["fat_100g"]) ?? 0,
    saturatedFatG: num(n["saturated-fat_100g"]) ?? 0,
    fiberG: num(n["fiber_100g"]) ?? 0,
    sugarG: num(n["sugars_100g"]) ?? 0,
    saltG: num(n["salt_100g"]) ?? 0,
  };
}

/** scoreHit already returns 0 for anything that is not the same product; this only rejects noise. */
export const MIN_SCORE = 0.5;

export function pickBestMatch(query: string, hits: OffHit[]): FoodMatch | null {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return null;
  let best: FoodMatch | null = null;
  for (const hit of hits) {
    const per100 = per100From(hit);
    if (!per100 || !hit.code || !hit.product_name) continue;
    const score = scoreHit(queryTokens, hit);
    if (score < MIN_SCORE || (best && score <= best.score)) continue;
    const brands = Array.isArray(hit.brands) ? hit.brands[0] : String(hit.brands ?? "").split(",")[0];
    best = {
      code: hit.code,
      productName: hit.product_name,
      brand: brands?.trim() || null,
      per100,
      servingQuantityG: num(hit.serving_quantity),
      score,
    };
  }
  return best;
}

export function scaleToServing(per100: Per100, servingG: number): { kcal: number; proteinG: number } {
  const factor = servingG / 100;
  return {
    kcal: Math.round(per100.kcal * factor),
    proteinG: Math.round(per100.proteinG * factor * 10) / 10,
  };
}

// Answers are cached, but only when OFF actually answered: caching a 503 or a timeout would
// pin a food to "no label" for the life of the process, long after OFF recovered.
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { match: FoodMatch | null; at: number }>();

function cacheGet(key: string): { match: FoodMatch | null } | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { cache.delete(key); return null; }
  return hit;
}

function cacheSet(key: string, match: FoodMatch | null): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { match, at: Date.now() });
}

/** Never throws: any network, status or parse failure resolves to null (and is not cached). */
export async function searchFood(name: string): Promise<FoodMatch | null> {
  const key = name.trim().toLowerCase();
  if (!key || !tokenize(key).length) return null;
  const cached = cacheGet(key);
  if (cached) return cached.match;

  try {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(key)}&page_size=${PAGE_SIZE}&fields=${FIELDS}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The public instance answers overload with an HTML 503.
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) return null;
    const body = (await res.json()) as { hits?: OffHit[] };
    const match = pickBestMatch(key, body.hits ?? []);
    cacheSet(key, match); // OFF answered — a null here means "not in the database"
    return match;
  } catch {
    return null;
  }
}
