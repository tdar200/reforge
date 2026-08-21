import { neonConfig } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page, type Request, type Route } from "@playwright/test";
import type { NutritionPanel } from "../lib/ai/nutrition";

const PASSCODE = process.env.APP_PASSCODE || "reforge-1b3543";
const AI_LIVE = Boolean(process.env.AI_LIVE);

// Owned e2e dates: 2030-06-08 .. 2030-06-12 (the int nutrition-ai suite owns 2030-06-01..05).
const DATE = "2030-06-10";
const CLEAN_LO = "2030-06-08";
const CLEAN_HI = "2030-06-12";

const CAPTION = "AI estimate, anchored to your logged kcal/protein — not label values.";
const ERR_KEY = "Needs OPENAI_API_KEY on the server.";
const ERR_FAIL = "Analysis failed — try again.";
const VERDICTS = ["good", "ok", "poor"];

type Meal = { name: string; kcal: number; proteinG: number };

// Full, schema-valid fixture. Values are halves/quarters so Number->string is exact
// ("61.5", never "61.50000001") and every grid cell is pinnable verbatim.
const PANEL: NutritionPanel = {
  estimated: true,
  macros: { kcal: 640, proteinG: 42, carbsG: 61.5, fatG: 22.25, saturatedFatG: 7.5, fiberG: 6.25, sugarG: 11.5, saltG: 2.75 },
  micros: {
    vitaminA_ug: 210, vitaminC_mg: 14.5, vitaminD_ug: 2.25, vitaminE_mg: 3.75, vitaminB12_ug: 1.25,
    folate_ug: 85, calcium_mg: 240, iron_mg: 5.5, potassium_mg: 780, magnesium_mg: 95, zinc_mg: 4.25,
  },
  advice: {
    verdict: "good",
    summary: "640 kcal with 42g protein leaves room in the day budget and the protein density is strong.",
    swap: "Grilled chicken rice box from the same shop, roughly 520 kcal and 45g protein.",
  },
};

// Same numbers, poor verdict, no swap: pins the red chip and the swap-null branch.
const POOR_PANEL: NutritionPanel = {
  ...PANEL,
  macros: { ...PANEL.macros, kcal: 910, proteinG: 9, saturatedFatG: 18.5, sugarG: 62.5, saltG: 4.5 },
  advice: { verdict: "poor", summary: "910 kcal for 9g protein is nearly a third of the day budget with almost no protein.", swap: null },
};

const OK_PANEL: NutritionPanel = {
  ...PANEL,
  advice: { verdict: "ok", summary: "Reasonable macros, but the salt is high for a single meal.", swap: "Plain tuna and rice, roughly 500 kcal and 40g protein." },
};

// Every row of the 17-cell grid, in render order, with its unit suffix.
const GRID_CELLS = [
  "Carbs61.5g", "Fat22.3g", "Sat fat7.5g", "Fibre6.3g", "Sugar11.5g", "Salt2.8g",
  "Vit A210µg", "Vit C14.5mg", "Vit D2.3µg", "Vit E3.8mg", "B121.3µg", "Folate85µg",
  "Calcium240mg", "Iron5.5mg", "Potassium780mg", "Magnesium95mg", "Zinc4.3mg",
];

// Same panel with two non-terminating floats: the grid must round them to 1 dp.
const ROUND_PANEL: NutritionPanel = {
  ...PANEL,
  micros: { ...PANEL.micros, iron_mg: 3.3333333333333335, magnesium_mg: 94.73684210526316 },
};
const ROUND_CELLS = GRID_CELLS.map((c) =>
  c === "Iron5.5mg" ? "Iron3.3mg" : c === "Magnesium95mg" ? "Magnesium94.7mg" : c);

const pin = (page: Page, iso: string) => page.clock.setFixedTime(new Date(`${iso}T12:00:00`));

const rowFor = (page: Page, name: string) => page.locator("main ul > li").filter({ hasText: name });
const gridOf = (row: Locator) => row.locator("div.grid.grid-cols-3 > div");
const chipOf = (row: Locator) => row.locator("span.uppercase");
const analyzeBtn = (row: Locator) => row.getByRole("button", { name: "Analyze", exact: true });
const infoBtn = (row: Locator) => row.getByRole("button", { name: "Info", exact: true });
const deleteBtn = (row: Locator) => row.getByRole("button", { name: "✕", exact: true });

// Retry connection-phase Neon failures (request never sent) — same hardening as tests-int/setup.ts.
neonConfig.fetchFunction = async (url: string, init: RequestInit) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fetch(url, init); }
    catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); }
  }
  throw lastErr;
};

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return;
  const raw = readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  const line = raw.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL not found in .env");
  process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}

// This suite only ever writes diet_entries, and only inside its owned date window.
async function cleanOwnedRows() {
  loadDatabaseUrl();
  const { db } = await import("../lib/db");
  const { dietEntries } = await import("../lib/db/schema");
  const { and, gte, lte } = await import("drizzle-orm");
  await db.delete(dietEntries).where(and(gte(dietEntries.date, CLEAN_LO), lte(dietEntries.date, CLEAN_HI)));
}

test.beforeAll(cleanOwnedRows); // idempotent reruns
test.beforeEach(cleanOwnedRows); // each test owns the pinned day alone
test.afterAll(cleanOwnedRows);

/**
 * Log in through the API, not the UI: page.request shares the context cookie jar, and
 * landing on "/" first leaves that page's own /api/exercises + /api/ai/review fetches
 * mid-flight across the navigation to /diet, which the quiet-check below can never resolve.
 */
async function login(page: Page) {
  const res = await page.request.post("/api/login", { data: { passcode: PASSCODE } });
  expect(res.status()).toBe(200);
}

/**
 * Tracks in-flight GET /api/* so a test can wait for the page's own loading to stop.
 * Next dev runs the mount effect under StrictMode, so /diet fires load() twice; the
 * later one calls setEntries with the server rows and would clobber a panel that only
 * exists client-side (the POST here is route-mocked, so nothing is persisted).
 */
function apiLoads(page: Page) {
  // identity-tracked: requests already in flight when this attaches must not skew the count
  const inflight = new Set<Request>();
  const state = { lastAt: Date.now() };
  const mine = (r: Request) => r.method() === "GET" && new URL(r.url()).pathname.startsWith("/api/");
  page.on("request", (r) => { if (mine(r)) { inflight.add(r); state.lastAt = Date.now(); } });
  const settled = (r: Request) => { if (inflight.delete(r)) state.lastAt = Date.now(); };
  page.on("requestfinished", settled);
  page.on("requestfailed", settled);
  return () => inflight.size === 0 && Date.now() - state.lastAt > 800;
}

/** Pin the clock, log in, seed rows on the pinned day, open /diet, wait for it to go quiet. */
async function openDiet(page: Page, meals: Meal[]): Promise<Record<string, number>> {
  await pin(page, DATE);
  await login(page);
  const ids: Record<string, number> = {};
  for (const m of meals) {
    const res = await page.request.post("/api/diet", { data: { date: DATE, ...m } });
    expect(res.status()).toBe(201);
    ids[m.name] = ((await res.json()) as { id: number }).id;
  }
  const quiet = apiLoads(page);
  await page.goto("/diet");
  await expect(page.getByRole("heading", { name: `Diet · ${DATE}`, exact: true })).toBeVisible();
  // hydration proof: both the rows and the preset chips only exist after load() resolves client-side
  if (meals.length) await expect(page.locator("main ul > li")).toHaveCount(meals.length);
  else await expect(page.locator("div.flex.flex-wrap button").first()).toBeVisible();
  // every mount-time load() has landed: no late setEntries can land mid-test
  await expect.poll(quiet, { timeout: 20_000, intervals: [100] }).toBe(true);
  return ids;
}

/** Route-mock POST /api/ai/nutrition, answering per entryId. */
async function mockNutrition(
  page: Page,
  respond: (entryId: number) => { status: number; body: unknown },
  delayMs = 0,
) {
  await page.route("**/api/ai/nutrition", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const { entryId } = route.request().postDataJSON() as { entryId: number };
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const { status, body } = respond(entryId);
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

/**
 * Route-mock POST /api/ai/nutrition that stays in flight until the returned release() runs.
 * A gate beats a sleep: the in-flight assertions can never lose a race with a fixed delay.
 */
async function mockNutritionGated(page: Page, respond: (entryId: number) => { status: number; body: unknown }) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/ai/nutrition", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const { entryId } = route.request().postDataJSON() as { entryId: number };
    await gate;
    const { status, body } = respond(entryId);
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return () => release();
}

/**
 * Rewrite GET /api/diet so one row comes back already analyzed, i.e. the stored-panel state
 * the route serves without calling the model. Every other field stays as the server sent it.
 */
async function mockStoredPanel(page: Page, entryId: number, panel: NutritionPanel) {
  await page.route(
    (url) => url.pathname === "/api/diet",
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const rows = (await (await route.fetch()).json()) as { id: number }[];
      const body = JSON.stringify(rows.map((r) => (r.id === entryId ? { ...r, nutrition: panel } : r)));
      await route.fulfill({ status: 200, contentType: "application/json", body });
    },
  );
}

// The error line itself, not just its text: the ✕ button is red too, but it is a <button>.
const errLineOf = (row: Locator) => row.locator("p.text-red-400");
const anyErrLine = (page: Page) => page.locator("main ul > li p.text-red-400");

function countNutritionPosts(page: Page): { n: number } {
  const counter = { n: 0 };
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/ai/nutrition" && r.method() === "POST") counter.n++;
  });
  return counter;
}

async function expectFullPanel(row: Locator, panel: NutritionPanel) {
  await expect(chipOf(row)).toHaveText(panel.advice.verdict);
  await expect(row.getByText(panel.advice.summary, { exact: true })).toBeVisible();
  await expect(gridOf(row)).toHaveCount(17);
  await expect(row.getByText(CAPTION, { exact: true })).toBeVisible();
}

test("Analyze: in-flight Analyzing… (all Analyze buttons disabled), then the full panel", async ({ page }) => {
  const ids = await openDiet(page, [
    { name: "E2E nutri A", kcal: 640, proteinG: 42 },
    { name: "E2E nutri B", kcal: 300, proteinG: 12 },
  ]);
  await mockNutrition(page, (id) => (id === ids["E2E nutri A"]
    ? { status: 201, body: { nutrition: PANEL } }
    : { status: 201, body: { nutrition: OK_PANEL } }), 800);

  const rowA = rowFor(page, "E2E nutri A");
  const rowB = rowFor(page, "E2E nutri B");
  await expect(gridOf(rowA)).toHaveCount(0); // closed before analysis

  await analyzeBtn(rowA).click();

  // in flight: the clicked row swaps label, and every row's button is disabled
  const busy = rowA.getByRole("button", { name: "Analyzing…", exact: true });
  await expect(busy).toBeVisible();
  await expect(busy).toBeDisabled();
  await expect(analyzeBtn(rowB)).toBeDisabled();

  // expanded panel: verdict chip, summary, swap line, the 17-cell grid, caption
  await expectFullPanel(rowA, PANEL);
  await expect(chipOf(rowA)).toHaveClass(/bg-green-600\/20/);
  await expect(chipOf(rowA)).toHaveClass(/text-green-400/);
  await expect(rowA.getByText(`Swap: ${PANEL.advice.swap}`, { exact: true })).toBeVisible();
  expect(await gridOf(rowA).allTextContents()).toEqual(GRID_CELLS);

  // the named micro/macro rows carry value *and* unit
  await expect(rowA.getByText("Vit C14.5mg", { exact: true })).toBeVisible();
  await expect(rowA.getByText("Vit D2.3µg", { exact: true })).toBeVisible(); // 2.25 rounded to 1 dp
  await expect(rowA.getByText("Iron5.5mg", { exact: true })).toBeVisible();
  await expect(rowA.getByText("Salt2.8g", { exact: true })).toBeVisible(); // 2.75 rounded to 1 dp

  // the untouched row stays collapsed and re-enabled
  await expect(gridOf(rowB)).toHaveCount(0);
  await expect(analyzeBtn(rowB)).toBeEnabled();
});

test("Analyze: verdict poor renders the red chip and a null swap renders no Swap line", async ({ page }) => {
  const ids = await openDiet(page, [
    { name: "E2E nutri poor", kcal: 910, proteinG: 9 },
    { name: "E2E nutri ok", kcal: 640, proteinG: 42 },
  ]);
  await mockNutrition(page, (id) => (id === ids["E2E nutri poor"]
    ? { status: 201, body: { nutrition: POOR_PANEL } }
    : { status: 201, body: { nutrition: OK_PANEL } }));

  const poor = rowFor(page, "E2E nutri poor");
  await analyzeBtn(poor).click();
  await expectFullPanel(poor, POOR_PANEL);
  await expect(chipOf(poor)).toHaveClass(/bg-red-600\/20/);
  await expect(chipOf(poor)).toHaveClass(/text-red-400/);
  await expect(poor.getByText("Swap:")).toHaveCount(0); // swap: null -> no line at all
  await expect(page.getByText("Swap:")).toHaveCount(0);

  const ok = rowFor(page, "E2E nutri ok");
  await analyzeBtn(ok).click();
  await expectFullPanel(ok, OK_PANEL);
  await expect(chipOf(ok)).toHaveClass(/bg-amber-600\/20/);
  await expect(chipOf(ok)).toHaveClass(/text-amber-400/);
  await expect(ok.getByText(`Swap: ${OK_PANEL.advice.swap}`, { exact: true })).toBeVisible();
});

test("Analyze once: button becomes Info and toggling the panel fires no further POST", async ({ page }) => {
  await openDiet(page, [{ name: "E2E nutri toggle", kcal: 640, proteinG: 42 }]);
  await mockNutrition(page, () => ({ status: 201, body: { nutrition: PANEL } }));
  const posts = countNutritionPosts(page);
  const row = rowFor(page, "E2E nutri toggle");

  const res = page.waitForResponse((r) => r.url().endsWith("/api/ai/nutrition") && r.request().method() === "POST");
  await analyzeBtn(row).click();
  expect((await res).status()).toBe(201);
  await expectFullPanel(row, PANEL);
  await expect(infoBtn(row)).toBeVisible();
  await expect(analyzeBtn(row)).toHaveCount(0);
  expect(posts.n).toBe(1);

  await infoBtn(row).click(); // closed
  await expect(gridOf(row)).toHaveCount(0);
  await expect(row.getByText(CAPTION, { exact: true })).toHaveCount(0);
  await expect(infoBtn(row)).toBeVisible();

  await infoBtn(row).click(); // open again, from state
  await expectFullPanel(row, PANEL);
  expect(await gridOf(row).allTextContents()).toEqual(GRID_CELLS);

  await page.waitForTimeout(500); // let any stray request land before counting
  expect(posts.n).toBe(1);
});

test("Analyze 503: the OPENAI_API_KEY notice lands on that row only", async ({ page }) => {
  const ids = await openDiet(page, [
    { name: "E2E nutri keyless", kcal: 500, proteinG: 30 },
    { name: "E2E nutri clean", kcal: 200, proteinG: 5 },
  ]);
  await mockNutrition(page, (id) => (id === ids["E2E nutri keyless"]
    ? { status: 503, body: { error: "ai_not_configured" } }
    : { status: 201, body: { nutrition: PANEL } }));

  const bad = rowFor(page, "E2E nutri keyless");
  const clean = rowFor(page, "E2E nutri clean");
  await analyzeBtn(bad).click();

  await expect(bad.getByText(ERR_KEY, { exact: true })).toBeVisible();
  await expect(page.getByText(ERR_KEY, { exact: true })).toHaveCount(1); // scoped to one row
  await expect(clean.getByText(ERR_KEY)).toHaveCount(0);
  await expect(clean.getByText(ERR_FAIL)).toHaveCount(0);
  await expect(gridOf(bad)).toHaveCount(0); // no panel on failure
  await expect(analyzeBtn(bad)).toBeEnabled(); // still says Analyze, retryable
  await expect(analyzeBtn(clean)).toBeEnabled();

  // the clean row still analyzes normally
  await analyzeBtn(clean).click();
  await expectFullPanel(clean, PANEL);
  await expect(bad.getByText(ERR_KEY, { exact: true })).toBeVisible();
});

test("Analyze 502: shows the retry error and the row is still deletable", async ({ page }) => {
  await openDiet(page, [
    { name: "E2E nutri boom", kcal: 700, proteinG: 25 },
    { name: "E2E nutri keep", kcal: 100, proteinG: 2 },
  ]);
  await mockNutrition(page, () => ({ status: 502, body: { error: "nutrition_failed" } }));

  const boom = rowFor(page, "E2E nutri boom");
  const res = page.waitForResponse((r) => r.url().endsWith("/api/ai/nutrition") && r.request().method() === "POST");
  await analyzeBtn(boom).click();
  expect((await res).status()).toBe(502);

  await expect(boom.getByText(ERR_FAIL, { exact: true })).toBeVisible();
  await expect(page.getByText(ERR_FAIL, { exact: true })).toHaveCount(1);
  await expect(gridOf(boom)).toHaveCount(0);
  await expect(analyzeBtn(boom)).toBeEnabled();

  const del = page.waitForResponse((r) => /\/api\/diet\/\d+$/.test(new URL(r.url()).pathname) && r.request().method() === "DELETE");
  await deleteBtn(boom).click();
  expect((await del).status()).toBe(200);
  await expect(page.locator("main ul > li")).toHaveCount(1);
  await expect(page.getByText(ERR_FAIL)).toHaveCount(0);
  await expect(rowFor(page, "E2E nutri keep")).toHaveCount(1);
});

test("✕ deletes a row whose nutrition panel is open", async ({ page }) => {
  await openDiet(page, [
    { name: "E2E nutri open", kcal: 640, proteinG: 42 },
    { name: "E2E nutri other", kcal: 250, proteinG: 8 },
  ]);
  await mockNutrition(page, () => ({ status: 201, body: { nutrition: PANEL } }));

  const open = rowFor(page, "E2E nutri open");
  await analyzeBtn(open).click();
  await expectFullPanel(open, PANEL);

  const del = page.waitForResponse((r) => /\/api\/diet\/\d+$/.test(new URL(r.url()).pathname) && r.request().method() === "DELETE");
  await deleteBtn(open).click();
  expect((await del).status()).toBe(200);

  await expect(page.locator("main ul > li")).toHaveCount(1);
  await expect(rowFor(page, "E2E nutri open")).toHaveCount(0);
  await expect(page.getByText(CAPTION)).toHaveCount(0); // panel went with the row
  await expect(page.locator("main ul > li div.grid.grid-cols-3")).toHaveCount(0);
  await expect(analyzeBtn(rowFor(page, "E2E nutri other"))).toBeEnabled();
});

test("Retry after 502: the stale error line is gone once the re-run succeeds", async ({ page }) => {
  await openDiet(page, [
    { name: "E2E nutri retry", kcal: 640, proteinG: 42 },
    { name: "E2E nutri bystander", kcal: 200, proteinG: 5 },
  ]);
  await mockNutrition(page, () => ({ status: 502, body: { error: "nutrition_failed" } }));
  const row = rowFor(page, "E2E nutri retry");
  const other = rowFor(page, "E2E nutri bystander");

  const failed = page.waitForResponse((r) => r.url().endsWith("/api/ai/nutrition") && r.request().method() === "POST");
  await analyzeBtn(row).click();
  expect((await failed).status()).toBe(502);
  await expect(row.getByText(ERR_FAIL, { exact: true })).toBeVisible();
  await expect(gridOf(row)).toHaveCount(0);

  // Same endpoint, now healthy. The retry has to clear this row's error, not stack it under the panel.
  await page.unroute("**/api/ai/nutrition");
  await mockNutrition(page, () => ({ status: 200, body: { nutrition: PANEL } }));

  const ok = page.waitForResponse((r) => r.url().endsWith("/api/ai/nutrition") && r.request().method() === "POST");
  await analyzeBtn(row).click();
  expect((await ok).status()).toBe(200);

  await expectFullPanel(row, PANEL);
  expect(await gridOf(row).allTextContents()).toEqual(GRID_CELLS);
  await expect(infoBtn(row)).toBeVisible();
  await expect(errLineOf(row)).toHaveCount(0);
  await expect(anyErrLine(page)).toHaveCount(0);
  await expect(page.getByText(ERR_FAIL)).toHaveCount(0);
  await expect(gridOf(other)).toHaveCount(0);
});

test("Info on an already-stored panel clears a stale error while it toggles", async ({ page }) => {
  const ids = await openDiet(page, [
    { name: "E2E nutri stale", kcal: 640, proteinG: 42 },
    { name: "E2E nutri spare", kcal: 150, proteinG: 3 },
  ]);
  await mockNutrition(page, () => ({ status: 502, body: { error: "nutrition_failed" } }));
  const posts = countNutritionPosts(page);
  const row = rowFor(page, "E2E nutri stale");

  const failed = page.waitForResponse((r) => r.url().endsWith("/api/ai/nutrition") && r.request().method() === "POST");
  await analyzeBtn(row).click();
  expect((await failed).status()).toBe(502);
  await expect(row.getByText(ERR_FAIL, { exact: true })).toBeVisible();

  // The row now reloads already analyzed, while rowErr survives the reload untouched.
  await mockStoredPanel(page, ids["E2E nutri stale"], PANEL);
  const del = page.waitForResponse((r) => /\/api\/diet\/\d+$/.test(new URL(r.url()).pathname) && r.request().method() === "DELETE");
  await deleteBtn(rowFor(page, "E2E nutri spare")).click();
  expect((await del).status()).toBe(200);

  await expect(page.locator("main ul > li")).toHaveCount(1);
  await expect(infoBtn(row)).toBeVisible(); // stored panel, so no Analyze button
  await expect(analyzeBtn(row)).toHaveCount(0);
  await expect(row.getByText(ERR_FAIL, { exact: true })).toBeVisible(); // the stale error, still stuck to it
  await expect(gridOf(row)).toHaveCount(0); // and the panel is not open yet

  await infoBtn(row).click(); // the early-return branch: it must clear the error before returning
  await expectFullPanel(row, PANEL);
  await expect(errLineOf(row)).toHaveCount(0);
  await expect(page.getByText(ERR_FAIL)).toHaveCount(0);

  await infoBtn(row).click(); // toggles shut, error stays gone
  await expect(gridOf(row)).toHaveCount(0);
  await expect(row.getByText(CAPTION)).toHaveCount(0);
  await expect(anyErrLine(page)).toHaveCount(0);

  await page.waitForTimeout(500); // let any stray request land before counting
  expect(posts.n).toBe(1); // the stored panel never re-POSTs
});

test("✕ is disabled on the analyzing row only, then enabled again when the panel lands", async ({ page }) => {
  await openDiet(page, [
    { name: "E2E nutri busy", kcal: 640, proteinG: 42 },
    { name: "E2E nutri idle", kcal: 220, proteinG: 9 },
  ]);
  const release = await mockNutritionGated(page, () => ({ status: 201, body: { nutrition: PANEL } }));
  const busy = rowFor(page, "E2E nutri busy");
  const idle = rowFor(page, "E2E nutri idle");
  await expect(deleteBtn(busy)).toBeEnabled();
  await expect(deleteBtn(idle)).toBeEnabled();

  await analyzeBtn(busy).click();

  // Held in flight by the gate: the row cannot be deleted out from under its own analysis.
  await expect(busy.getByRole("button", { name: "Analyzing…", exact: true })).toBeVisible();
  await expect(deleteBtn(busy)).toBeDisabled();
  await expect(deleteBtn(idle)).toBeEnabled(); // a different row stays deletable throughout
  await expect(analyzeBtn(idle)).toBeDisabled();
  await expect(deleteBtn(busy)).toBeDisabled(); // still held, nothing raced it back on

  release();

  await expectFullPanel(busy, PANEL);
  await expect(deleteBtn(busy)).toBeEnabled();
  await expect(deleteBtn(idle)).toBeEnabled();
  await expect(analyzeBtn(idle)).toBeEnabled();
});

test("Deleting an analyzed row drops its panel state: a new row renders clean", async ({ page }) => {
  await openDiet(page, [{ name: "E2E nutri gone", kcal: 640, proteinG: 42 }]);
  await mockNutrition(page, () => ({ status: 201, body: { nutrition: PANEL } }));

  const gone = rowFor(page, "E2E nutri gone");
  await analyzeBtn(gone).click();
  await expectFullPanel(gone, PANEL);

  const del = page.waitForResponse((r) => /\/api\/diet\/\d+$/.test(new URL(r.url()).pathname) && r.request().method() === "DELETE");
  await deleteBtn(gone).click();
  expect((await del).status()).toBe(200);
  await expect(page.locator("main ul > li")).toHaveCount(0);

  // A brand-new row must render collapsed, carrying nothing over from the deleted one.
  await page.getByPlaceholder("Food").fill("E2E nutri fresh");
  await page.getByPlaceholder("kcal").fill("330");
  await page.getByPlaceholder("protein").fill("21");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/diet") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  expect((await created).status()).toBe(201);

  const fresh = rowFor(page, "E2E nutri fresh");
  await expect(page.locator("main ul > li")).toHaveCount(1);
  await expect(fresh).toHaveCount(1);
  await expect(analyzeBtn(fresh)).toBeVisible();
  await expect(analyzeBtn(fresh)).toBeEnabled();
  await expect(infoBtn(fresh)).toHaveCount(0);
  await expect(deleteBtn(fresh)).toBeEnabled();
  await expect(gridOf(fresh)).toHaveCount(0);
  await expect(page.locator("main ul > li div.grid.grid-cols-3")).toHaveCount(0);
  await expect(page.getByText(CAPTION)).toHaveCount(0);
  await expect(anyErrLine(page)).toHaveCount(0);
});

test("Panel numbers round to one decimal: repeating floats never reach the DOM", async ({ page }) => {
  await openDiet(page, [{ name: "E2E nutri rounding", kcal: 640, proteinG: 42 }]);
  await mockNutrition(page, () => ({ status: 201, body: { nutrition: ROUND_PANEL } }));

  const row = rowFor(page, "E2E nutri rounding");
  await analyzeBtn(row).click();
  await expectFullPanel(row, ROUND_PANEL);

  await expect(row.getByText("Magnesium94.7mg", { exact: true })).toBeVisible();
  await expect(row.getByText("Iron3.3mg", { exact: true })).toBeVisible();
  expect(await gridOf(row).allTextContents()).toEqual(ROUND_CELLS);
  await expect(row.getByText("94.73684210526316")).toHaveCount(0);
  await expect(row.getByText("3.3333333333333335")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Manual Add form: a blank kcal/protein box is filled in by POST /api/ai/estimate.
// Regression guard for the "Actileaf oat drink logged as 0 kcal / 0 protein" bug,
// where Number("") === 0 silently reached the API.
// ---------------------------------------------------------------------------

const HINT = "Leave kcal or protein blank and the coach estimates them from the name.";
const EST_ERR_KEY = "Estimating needs OPENAI_API_KEY — type the numbers instead.";
const EST_ERR_FAIL = "Couldn't estimate that — type the numbers instead.";

const foodInput = (page: Page) => page.getByPlaceholder("Food");
const kcalInput = (page: Page) => page.getByPlaceholder("kcal");
const proteinInput = (page: Page) => page.getByPlaceholder("protein");
const addBtn = (page: Page) => page.getByRole("button", { name: "Add", exact: true });
const estimatingBtn = (page: Page) => page.getByRole("button", { name: "Estimating…", exact: true });
// The form-level error sits directly under <main>; row errors live inside main ul > li.
const formErrLine = (page: Page) => page.locator("main > p.text-red-400");

const isPost = (r: Request, pathname: string) =>
  r.method() === "POST" && new URL(r.url()).pathname === pathname;
const dietPost = (r: Request) => isPost(r, "/api/diet");
const estimatePost = (r: Request) => isPost(r, "/api/ai/estimate");

/** Reads the live targets so the totals line is asserted verbatim, not against a hardcoded goal. */
async function totalsOf(page: Page) {
  const res = await page.request.get("/api/settings");
  expect(res.status()).toBe(200);
  const s = (await res.json()) as { calorieTarget: number; proteinTarget: number };
  return (kcal: number, proteinG: number) => Promise.all([
    expect(page.getByText(`${kcal} / ${s.calorieTarget} kcal`, { exact: true })).toBeVisible(),
    expect(page.getByText(`${proteinG} / ${s.proteinTarget} g protein`, { exact: true })).toBeVisible(),
  ]);
}

/** Route-mock POST /api/ai/estimate; the returned array collects every request body it saw. */
async function mockEstimate(page: Page, status: number, body: unknown) {
  const seen: unknown[] = [];
  await page.route("**/api/ai/estimate", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    seen.push(route.request().postDataJSON());
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return seen;
}

/** Gated estimate: stays in flight until release() runs, so "Estimating…" can never lose a race. */
async function mockEstimateGated(page: Page, body: unknown) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/ai/estimate", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return () => release();
}

function countRequests(page: Page, match: (r: Request) => boolean): { n: number } {
  const counter = { n: 0 };
  page.on("request", (r) => { if (match(r)) counter.n++; });
  return counter;
}

test("The Add form carries the blank-estimate hint", async ({ page }) => {
  await openDiet(page, []);
  await expect(page.getByText(HINT, { exact: true })).toBeVisible();
  await expect(page.locator("main > p").filter({ hasText: HINT })).toHaveCount(1);
  await expect(formErrLine(page)).toHaveCount(0);
});

test("Add with kcal and protein blank: the estimate fills both, into the row and the day totals", async ({ page }) => {
  const NAME = "E2E est blank both";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  await totals(0, 0);
  const seen = await mockEstimate(page, 200, { kcal: 210, proteinG: 7 });

  await foodInput(page).fill(NAME);
  await expect(kcalInput(page)).toHaveValue("");
  await expect(proteinInput(page)).toHaveValue("");

  const estReq = page.waitForRequest(estimatePost);
  const dietReq = page.waitForRequest(dietPost);
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();

  expect((await estReq).postDataJSON()).toEqual({ name: NAME }); // exactly {name}, nothing else
  expect((await dietReq).postDataJSON()).toEqual({ date: DATE, name: NAME, kcal: 210, proteinG: 7 });
  expect((await dietRes).status()).toBe(201);
  expect(seen).toEqual([{ name: NAME }]);

  const row = rowFor(page, NAME);
  await expect(page.locator("main ul > li")).toHaveCount(1);
  await expect(row.getByText("210kcal · 7g", { exact: true })).toBeVisible();
  await totals(210, 7);

  await expect(foodInput(page)).toHaveValue(""); // form resets after a successful Add
  await expect(addBtn(page)).toBeEnabled();
  await expect(formErrLine(page)).toHaveCount(0);
});

test("Add with one number blank: the estimate fills only that box, the typed one wins", async ({ page }) => {
  const KCAL_BLANK = "E2E est kcal blank";
  const PROTEIN_BLANK = "E2E est protein blank";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  const seen = await mockEstimate(page, 200, { kcal: 300, proteinG: 99 });

  // kcal blank, protein typed: 300 from the estimate, 12 from the box (99 is ignored)
  await foodInput(page).fill(KCAL_BLANK);
  await proteinInput(page).fill("12");
  let estReq = page.waitForRequest(estimatePost);
  let dietReq = page.waitForRequest(dietPost);
  let dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();
  expect((await estReq).postDataJSON()).toEqual({ name: KCAL_BLANK });
  expect((await dietReq).postDataJSON()).toEqual({ date: DATE, name: KCAL_BLANK, kcal: 300, proteinG: 12 });
  expect((await dietRes).status()).toBe(201);
  await expect(rowFor(page, KCAL_BLANK).getByText("300kcal · 12g", { exact: true })).toBeVisible();
  await expect(page.getByText("300kcal · 99g")).toHaveCount(0);
  await totals(300, 12);

  // mirror: protein blank, kcal typed: 150 from the box, 99 from the estimate
  await foodInput(page).fill(PROTEIN_BLANK);
  await kcalInput(page).fill("150");
  estReq = page.waitForRequest(estimatePost);
  dietReq = page.waitForRequest(dietPost);
  dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();
  expect((await estReq).postDataJSON()).toEqual({ name: PROTEIN_BLANK });
  expect((await dietReq).postDataJSON()).toEqual({ date: DATE, name: PROTEIN_BLANK, kcal: 150, proteinG: 99 });
  expect((await dietRes).status()).toBe(201);
  await expect(rowFor(page, PROTEIN_BLANK).getByText("150kcal · 99g", { exact: true })).toBeVisible();
  await expect(page.getByText("300kcal · 99g")).toHaveCount(0);
  await totals(450, 111);

  expect(seen).toEqual([{ name: KCAL_BLANK }, { name: PROTEIN_BLANK }]);
  await expect(formErrLine(page)).toHaveCount(0);
});

test("A typed 0 is respected, never estimated: the row posts kcal 0 and protein 0", async ({ page }) => {
  const NAME = "E2E est typed zero";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  const estimates = countRequests(page, estimatePost);
  await mockEstimate(page, 200, { kcal: 210, proteinG: 7 }); // armed, and must never fire

  await foodInput(page).fill(NAME);
  await kcalInput(page).fill("0");
  await proteinInput(page).fill("0");
  const dietReq = page.waitForRequest(dietPost);
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();

  expect((await dietReq).postDataJSON()).toEqual({ date: DATE, name: NAME, kcal: 0, proteinG: 0 });
  expect((await dietRes).status()).toBe(201);
  await expect(rowFor(page, NAME).getByText("0kcal · 0g", { exact: true })).toBeVisible();
  await totals(0, 0);
  await expect(estimatingBtn(page)).toHaveCount(0);
  await expect(formErrLine(page)).toHaveCount(0);

  await page.waitForTimeout(500); // let any stray request land before counting
  expect(estimates.n).toBe(0);
});

test("Estimating…: the Add button is disabled while the estimate is in flight, then reads Add again", async ({ page }) => {
  const NAME = "E2E est gated";
  await openDiet(page, []);
  const release = await mockEstimateGated(page, { kcal: 210, proteinG: 7 });

  await foodInput(page).fill(NAME);
  await expect(addBtn(page)).toBeEnabled();
  await addBtn(page).click();

  // Held by the gate: the label swaps and the button cannot be pressed again.
  await expect(estimatingBtn(page)).toBeVisible();
  await expect(estimatingBtn(page)).toBeDisabled();
  await expect(addBtn(page)).toHaveCount(0);
  await expect(page.locator("main ul > li")).toHaveCount(0); // nothing posted yet
  await expect(estimatingBtn(page)).toBeDisabled(); // still held, nothing raced it back on

  release();

  await expect(addBtn(page)).toBeVisible();
  await expect(addBtn(page)).toBeEnabled();
  await expect(estimatingBtn(page)).toHaveCount(0);
  await expect(rowFor(page, NAME).getByText("210kcal · 7g", { exact: true })).toBeVisible();
  await expect(formErrLine(page)).toHaveCount(0);
});

test("Estimate 503: the OPENAI_API_KEY notice shows, the typed name survives and no row is created", async ({ page }) => {
  const NAME = "E2E est keyless";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  const diets = countRequests(page, dietPost);
  await mockEstimate(page, 503, { error: "ai_not_configured" });

  await foodInput(page).fill(NAME);
  const res = page.waitForResponse((r) => estimatePost(r.request()));
  await addBtn(page).click();
  expect((await res).status()).toBe(503);

  await expect(formErrLine(page)).toHaveText(EST_ERR_KEY);
  await expect(page.getByText(EST_ERR_KEY, { exact: true })).toBeVisible();
  await expect(page.getByText(EST_ERR_FAIL)).toHaveCount(0);
  await expect(page.locator("main ul > li")).toHaveCount(0); // no row on a failed estimate
  await totals(0, 0);
  await expect(addBtn(page)).toBeEnabled(); // out of the Estimating… state, retryable
  await expect(estimatingBtn(page)).toHaveCount(0);
  await expect(foodInput(page)).toHaveValue(NAME); // the form keeps what was typed
  await expect(page.getByText(HINT, { exact: true })).toBeVisible();

  await page.waitForTimeout(500); // let any stray request land before counting
  expect(diets.n).toBe(0);
});

test("Estimate 502: the retry notice shows, then typing the numbers by hand still adds and clears it", async ({ page }) => {
  const NAME = "E2E est boom";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  const diets = countRequests(page, dietPost);
  const estimates = countRequests(page, estimatePost);
  await mockEstimate(page, 502, { error: "estimate_failed" });

  await foodInput(page).fill(NAME);
  await proteinInput(page).fill("31"); // one blank box is enough to trigger the estimate
  const res = page.waitForResponse((r) => estimatePost(r.request()));
  await addBtn(page).click();
  expect((await res).status()).toBe(502);

  await expect(formErrLine(page)).toHaveText(EST_ERR_FAIL);
  await expect(page.getByText(EST_ERR_FAIL, { exact: true })).toBeVisible();
  await expect(page.getByText(EST_ERR_KEY)).toHaveCount(0);
  await expect(page.locator("main ul > li")).toHaveCount(0);
  await totals(0, 0);
  await page.waitForTimeout(500);
  expect(diets.n).toBe(0);
  expect(estimates.n).toBe(1);

  // Recovery: fill the missing number in, and the manual path works with the error cleared.
  await expect(foodInput(page)).toHaveValue(NAME);
  await expect(proteinInput(page)).toHaveValue("31");
  await kcalInput(page).fill("410");
  const dietReq = page.waitForRequest(dietPost);
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();
  expect((await dietReq).postDataJSON()).toEqual({ date: DATE, name: NAME, kcal: 410, proteinG: 31 });
  expect((await dietRes).status()).toBe(201);

  await expect(rowFor(page, NAME).getByText("410kcal · 31g", { exact: true })).toBeVisible();
  await totals(410, 31);
  await expect(formErrLine(page)).toHaveCount(0);
  await expect(page.getByText(EST_ERR_FAIL)).toHaveCount(0);
  await expect(foodInput(page)).toHaveValue("");
  expect(estimates.n).toBe(1); // both numbers present: no second estimate call
});

test("Blank or whitespace-only Food: Add fires no request at all", async ({ page }) => {
  await openDiet(page, []);
  const apiCalls = countRequests(page, (r) => new URL(r.url()).pathname.startsWith("/api/"));
  await mockEstimate(page, 200, { kcal: 210, proteinG: 7 }); // armed, and must never fire

  await expect(foodInput(page)).toHaveValue("");
  await addBtn(page).click();
  await page.waitForTimeout(600);
  expect(apiCalls.n).toBe(0);

  await foodInput(page).fill("   "); // whitespace only, trimmed away by the form
  await addBtn(page).click();
  await page.waitForTimeout(600);
  expect(apiCalls.n).toBe(0);

  // Numbers alone are not enough either.
  await kcalInput(page).fill("500");
  await proteinInput(page).fill("40");
  await addBtn(page).click();
  await page.waitForTimeout(600);
  expect(apiCalls.n).toBe(0);

  await expect(page.locator("main ul > li")).toHaveCount(0);
  await expect(formErrLine(page)).toHaveCount(0);
  await expect(estimatingBtn(page)).toHaveCount(0);
  await expect(addBtn(page)).toBeEnabled();
});

test("Analyze on a 0/0 row: the panel macros replace the row numbers and the totals follow", async ({ page }) => {
  const NAME = "E2E est unknown macros";
  await openDiet(page, [{ name: NAME, kcal: 0, proteinG: 0 }]);
  const totals = await totalsOf(page);
  const row = rowFor(page, NAME);
  await expect(row.getByText("0kcal · 0g", { exact: true })).toBeVisible();
  await totals(0, 0);

  await mockNutrition(page, () => ({ status: 201, body: { nutrition: PANEL } }));
  await analyzeBtn(row).click();

  await expectFullPanel(row, PANEL);
  await expect(row.getByText("640kcal · 42g", { exact: true })).toBeVisible();
  await expect(page.getByText("0kcal · 0g")).toHaveCount(0);
  await totals(640, 42);
});

// ---------------------------------------------------------------------------
// Open Food Facts label lookup: POST /api/ai/estimate now answers with a source
// ("label" | "estimate") and the matched product name, and the Add form prints a
// note under it saying which one filled the blanks. All route-mocked — no live OFF.
// ---------------------------------------------------------------------------

const LABEL_NAME = "Actileaf Oat Milk";
/**
 * The label note, verbatim: curly quotes around the matched product, an optional portion,
 * then the delete-and-re-add advice. The portion is "" when the answer carries no servingG,
 * " for N g/ml" when the record supplied it, and " for N (assumed) g/ml" when the model did.
 */
const labelNote = (name: string, portion = "") =>
  `From the “${name}” label${portion} — delete and re-add with your own numbers if that is the wrong product.`;
const LABEL_NOTE = labelNote(LABEL_NAME); // LABEL_BODY carries no servingG, so no portion
const COACH_NOTE = "Estimated by the coach — no matching product label found.";

// 2.6 g protein round-trips exactly through the real column; the row renders Math.round(2.6) = 3.
const LABEL_BODY = { kcal: 98, proteinG: 2.6, source: "label", matchedName: LABEL_NAME };
const COACH_BODY = { kcal: 610, proteinG: 32, source: "estimate", matchedName: null };
// Pre-OFF shape: the client must tolerate a body with neither source nor matchedName.
const LEGACY_BODY = { kcal: 415, proteinG: 18.5 };

// The note is the only direct <main> child styled text-neutral-400: the hint is
// text-neutral-500 and the form error is text-red-400.
const noteLine = (page: Page) => page.locator("main > p.text-neutral-400");

test("Estimate source label: the note names the matched product and the row takes the label macros", async ({ page }) => {
  const NAME = "E2E est label oat";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  await totals(0, 0);
  const seen = await mockEstimate(page, 200, LABEL_BODY);
  await expect(noteLine(page)).toHaveCount(0); // nothing before the first add

  await foodInput(page).fill(NAME);
  await expect(kcalInput(page)).toHaveValue("");
  await expect(proteinInput(page)).toHaveValue("");

  const estReq = page.waitForRequest(estimatePost);
  const dietReq = page.waitForRequest(dietPost);
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();

  expect((await estReq).postDataJSON()).toEqual({ name: NAME });
  expect((await dietReq).postDataJSON()).toEqual({ date: DATE, name: NAME, kcal: 98, proteinG: 2.6 });
  expect((await dietRes).status()).toBe(201);
  expect(seen).toEqual([{ name: NAME }]);

  const row = rowFor(page, NAME);
  await expect(page.locator("main ul > li")).toHaveCount(1);
  await expect(row.getByText("98kcal · 3g", { exact: true })).toBeVisible(); // protein rounded for display
  await totals(98, 3);

  await expect(noteLine(page)).toHaveText(LABEL_NOTE); // exact, whole line
  await expect(page.getByText(LABEL_NOTE, { exact: true })).toBeVisible();
  await expect(noteLine(page)).toHaveCount(1);
  await expect(page.getByText(COACH_NOTE)).toHaveCount(0);
  await expect(noteLine(page)).not.toContainText("g/ml"); // no servingG in the answer: no portion clause
  await expect(noteLine(page)).not.toContainText("(assumed)");

  await expect(formErrLine(page)).toHaveCount(0);
  await expect(foodInput(page)).toHaveValue(""); // the note survives the form reset
  await expect(addBtn(page)).toBeEnabled();
  await expect(page.getByText(HINT, { exact: true })).toBeVisible();
});

test("Estimate source estimate: the note says the coach guessed and names no product", async ({ page }) => {
  const NAME = "E2E est coach note";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  const seen = await mockEstimate(page, 200, COACH_BODY);

  await foodInput(page).fill(NAME);
  const dietReq = page.waitForRequest(dietPost);
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();

  expect((await dietReq).postDataJSON()).toEqual({ date: DATE, name: NAME, kcal: 610, proteinG: 32 });
  expect((await dietRes).status()).toBe(201);
  expect(seen).toEqual([{ name: NAME }]);

  await expect(page.locator("main ul > li")).toHaveCount(1);
  await expect(rowFor(page, NAME).getByText("610kcal · 32g", { exact: true })).toBeVisible();
  await totals(610, 32);

  await expect(noteLine(page)).toHaveText(COACH_NOTE);
  await expect(page.getByText(COACH_NOTE, { exact: true })).toBeVisible();
  await expect(noteLine(page)).toHaveCount(1);
  await expect(page.getByText("From the “")).toHaveCount(0); // matchedName null: no label wording at all
  await expect(page.getByText("delete and re-add")).toHaveCount(0);
  await expect(formErrLine(page)).toHaveCount(0);
});

test("Estimate body without source/matchedName still adds the row and shows the coach note", async ({ page }) => {
  const NAME = "E2E est legacy body";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  const seen = await mockEstimate(page, 200, LEGACY_BODY);

  await foodInput(page).fill(NAME);
  const dietReq = page.waitForRequest(dietPost);
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();

  expect((await dietReq).postDataJSON()).toEqual({ date: DATE, name: NAME, kcal: 415, proteinG: 18.5 });
  expect((await dietRes).status()).toBe(201);
  expect(seen).toEqual([{ name: NAME }]);

  await expect(page.locator("main ul > li")).toHaveCount(1);
  await expect(rowFor(page, NAME).getByText("415kcal · 19g", { exact: true })).toBeVisible();
  await totals(415, 19);

  await expect(noteLine(page)).toHaveText(COACH_NOTE); // falls back, never crashes on undefined
  await expect(page.getByText("From the “")).toHaveCount(0);
  await expect(page.getByText("undefined")).toHaveCount(0);
  await expect(formErrLine(page)).toHaveCount(0);
  await expect(addBtn(page)).toBeEnabled();
  await expect(estimatingBtn(page)).toHaveCount(0);
});

test("The source note clears the moment the next add starts, before the new one lands", async ({ page }) => {
  const FIRST = "E2E est note first";
  const SECOND = "E2E est note second";
  await openDiet(page, []);
  await mockEstimate(page, 200, LABEL_BODY);

  await foodInput(page).fill(FIRST);
  const firstRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();
  expect((await firstRes).status()).toBe(201);
  await expect(noteLine(page)).toHaveText(LABEL_NOTE);
  await expect(rowFor(page, FIRST)).toHaveCount(1);

  // Same endpoint, now held open, so the in-flight window can be asserted instead of raced.
  await page.unroute("**/api/ai/estimate");
  const release = await mockEstimateGated(page, COACH_BODY);

  await foodInput(page).fill(SECOND);
  await addBtn(page).click();

  await expect(estimatingBtn(page)).toBeVisible();
  await expect(noteLine(page)).toHaveCount(0); // the previous note is gone while this one is still unknown
  await expect(page.getByText(LABEL_NOTE)).toHaveCount(0);
  await expect(page.getByText(COACH_NOTE)).toHaveCount(0);
  await expect(page.locator("main ul > li")).toHaveCount(1); // nothing added yet
  await expect(estimatingBtn(page)).toBeDisabled(); // still held, nothing raced the note back on
  await expect(noteLine(page)).toHaveCount(0);

  release();

  await expect(noteLine(page)).toHaveText(COACH_NOTE);
  await expect(page.getByText(LABEL_NOTE)).toHaveCount(0); // replaced, not stacked
  await expect(noteLine(page)).toHaveCount(1);
  await expect(page.locator("main ul > li")).toHaveCount(2);
  await expect(rowFor(page, SECOND).getByText("610kcal · 32g", { exact: true })).toBeVisible();
  await expect(rowFor(page, FIRST).getByText("98kcal · 3g", { exact: true })).toBeVisible();
  await expect(addBtn(page)).toBeEnabled();
  await expect(formErrLine(page)).toHaveCount(0);
});

test("Both numbers typed: no estimate call fires and no source note appears", async ({ page }) => {
  const NAME = "E2E est typed both";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  const estimates = countRequests(page, estimatePost);
  await mockEstimate(page, 200, LABEL_BODY); // armed, and must never fire

  await foodInput(page).fill(NAME);
  await kcalInput(page).fill("530");
  await proteinInput(page).fill("41");
  const dietReq = page.waitForRequest(dietPost);
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();

  expect((await dietReq).postDataJSON()).toEqual({ date: DATE, name: NAME, kcal: 530, proteinG: 41 });
  expect((await dietRes).status()).toBe(201);
  await expect(page.locator("main ul > li")).toHaveCount(1);
  await expect(rowFor(page, NAME).getByText("530kcal · 41g", { exact: true })).toBeVisible();
  await totals(530, 41);

  await expect(noteLine(page)).toHaveCount(0);
  await expect(page.getByText(LABEL_NOTE)).toHaveCount(0);
  await expect(page.getByText(COACH_NOTE)).toHaveCount(0);
  await expect(estimatingBtn(page)).toHaveCount(0);
  await expect(formErrLine(page)).toHaveCount(0);
  await expect(page.getByText(HINT, { exact: true })).toBeVisible();

  await page.waitForTimeout(500); // let any stray request land before counting
  expect(estimates.n).toBe(0);
});

// ---------------------------------------------------------------------------
// The portion clause, the sanitiser, and the save-rejected error.
// ---------------------------------------------------------------------------

// The portion the record itself published: printed as fact, with no qualifier.
const SERVING_LABEL_BODY = {
  kcal: 3, proteinG: 0, source: "label", matchedName: "Coca-Cola Zero", servingG: 330, servingSource: "label",
};
// The portion the coach guessed for a record that published none: printed as an assumption.
const SERVING_GUESS_BODY = {
  kcal: 98, proteinG: 2.6, source: "label", matchedName: "Actileaf Oat Drink", servingG: 200, servingSource: "estimate",
};

// Built from char codes so the fixture is unambiguous in source: U+202E RIGHT-TO-LEFT OVERRIDE,
// U+0000, U+0007, U+2066 LEFT-TO-RIGHT ISOLATE, U+007F. OFF product names are world-writable.
const ch = (code: number) => String.fromCharCode(code);
const HOSTILE_NAME = ` ${ch(0x202e)}Acti${ch(0x0000)}leaf${ch(0x0007)} Oat${ch(0x2066)} Drink${ch(0x007f)} `;
const HOSTILE_CLEAN = "Actileaf Oat Drink";
const FORBIDDEN = new RegExp(
  `[${ch(0x0000)}-${ch(0x001f)}${ch(0x007f)}${ch(0x202a)}-${ch(0x202e)}${ch(0x2066)}-${ch(0x2069)}]`,
);

// 77 characters, so the note must cut it at 60 and add an ellipsis.
const LONG_NAME = "Actileaf Barista Style Organic Oat Drink Long Life UHT 1 Litre Carton 12 Pack";
const LONG_CLEAN = "Actileaf Barista Style Organic Oat Drink Long Life UHT 1 Lit…";

const SAVE_ERR = "Couldn't save that — check the numbers.";

test("A serving off the record prints the portion as fact, with no (assumed)", async ({ page }) => {
  const NAME = "E2E est serving label";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  await mockEstimate(page, 200, SERVING_LABEL_BODY);

  await foodInput(page).fill(NAME);
  const dietReq = page.waitForRequest(dietPost);
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();

  expect((await dietReq).postDataJSON()).toEqual({ date: DATE, name: NAME, kcal: 3, proteinG: 0 });
  expect((await dietRes).status()).toBe(201);

  await expect(noteLine(page)).toHaveText(labelNote("Coca-Cola Zero", " for 330 g/ml"));
  await expect(page.getByText(labelNote("Coca-Cola Zero", " for 330 g/ml"), { exact: true })).toBeVisible();
  await expect(noteLine(page)).toHaveCount(1);
  await expect(page.getByText("(assumed)")).toHaveCount(0); // the record said 330, nobody assumed it
  await expect(page.getByText(COACH_NOTE)).toHaveCount(0);

  await expect(rowFor(page, NAME).getByText("3kcal · 0g", { exact: true })).toBeVisible();
  await totals(3, 0); // a 3 kcal can is a real label answer, not a failed one
  await expect(formErrLine(page)).toHaveCount(0);
});

test("A serving the coach guessed is marked (assumed) in the note", async ({ page }) => {
  const NAME = "E2E est serving guessed";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  await mockEstimate(page, 200, SERVING_GUESS_BODY);

  await foodInput(page).fill(NAME);
  const dietReq = page.waitForRequest(dietPost);
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();

  expect((await dietReq).postDataJSON()).toEqual({ date: DATE, name: NAME, kcal: 98, proteinG: 2.6 });
  expect((await dietRes).status()).toBe(201);

  const expected = labelNote("Actileaf Oat Drink", " for 200 (assumed) g/ml");
  await expect(noteLine(page)).toHaveText(expected);
  await expect(page.getByText(expected, { exact: true })).toBeVisible();
  await expect(noteLine(page)).toHaveCount(1);
  await expect(page.getByText(labelNote("Actileaf Oat Drink", " for 200 g/ml"))).toHaveCount(0);

  await expect(rowFor(page, NAME).getByText("98kcal · 3g", { exact: true })).toBeVisible();
  await totals(98, 3);
  await expect(formErrLine(page)).toHaveCount(0);
});

test("A label answer with no usable serving prints no portion clause at all", async ({ page }) => {
  const NULL_NAME = "E2E est serving null";
  const ZERO_NAME = "E2E est serving zero";
  await openDiet(page, []);
  await mockEstimate(page, 200, { ...LABEL_BODY, servingG: null, servingSource: null });

  await foodInput(page).fill(NULL_NAME);
  let dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();
  expect((await dietRes).status()).toBe(201);

  await expect(page.locator("main ul > li")).toHaveCount(1);
  await expect(noteLine(page)).toHaveText(LABEL_NOTE); // the bare label sentence, nothing appended
  await expect(noteLine(page)).not.toContainText("g/ml");
  await expect(noteLine(page)).not.toContainText("(assumed)");

  // A 0 g portion is not a portion either, whatever the servingSource claims.
  await page.unroute("**/api/ai/estimate");
  await mockEstimate(page, 200, { ...LABEL_BODY, servingG: 0, servingSource: "label" });
  await foodInput(page).fill(ZERO_NAME);
  dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();
  expect((await dietRes).status()).toBe(201);

  await expect(page.locator("main ul > li")).toHaveCount(2);
  await expect(noteLine(page)).toHaveText(LABEL_NOTE);
  await expect(noteLine(page)).not.toContainText("g/ml");
  await expect(page.getByText("for 0")).toHaveCount(0);
  await expect(formErrLine(page)).toHaveCount(0);
});

test("A matched name carrying control and bidi characters is sanitised before it is shown", async ({ page }) => {
  const NAME = "E2E est hostile label";
  // The fixture really is hostile, and survives serialisation: this test cannot pass vacuously.
  expect(HOSTILE_NAME).toMatch(FORBIDDEN);
  expect(JSON.stringify({ matchedName: HOSTILE_NAME })).toContain("\\u0000");
  expect(HOSTILE_NAME).not.toBe(HOSTILE_CLEAN);
  await openDiet(page, []);
  await mockEstimate(page, 200, { ...LABEL_BODY, matchedName: HOSTILE_NAME, servingG: 250, servingSource: "estimate" });

  await foodInput(page).fill(NAME);
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();
  expect((await dietRes).status()).toBe(201);

  const expected = labelNote(HOSTILE_CLEAN, " for 250 (assumed) g/ml");
  await expect(noteLine(page)).toHaveText(expected);
  await expect(noteLine(page)).toHaveCount(1);

  // The rendered characters themselves, not just a normalised match: nothing hostile survived.
  const rendered = await noteLine(page).evaluate((el) => el.textContent ?? "");
  expect(rendered).toBe(expected);
  expect(rendered).not.toMatch(FORBIDDEN);
  expect(await page.locator("body").evaluate((el) => el.textContent ?? "")).not.toMatch(FORBIDDEN);
  await expect(rowFor(page, NAME).getByText("98kcal · 3g", { exact: true })).toBeVisible();
});

test("A matched name longer than 60 characters is truncated with an ellipsis", async ({ page }) => {
  const NAME = "E2E est long label";
  expect(LONG_NAME.length).toBe(77);
  expect(LONG_CLEAN.length).toBe(61); // 60 characters plus the ellipsis
  await openDiet(page, []);
  await mockEstimate(page, 200, { ...SERVING_LABEL_BODY, matchedName: LONG_NAME });

  await foodInput(page).fill(NAME);
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();
  expect((await dietRes).status()).toBe(201);

  const expected = labelNote(LONG_CLEAN, " for 330 g/ml");
  await expect(noteLine(page)).toHaveText(expected);
  const rendered = await noteLine(page).evaluate((el) => el.textContent ?? "");
  expect(rendered).toBe(expected);
  expect(rendered).not.toContain("Carton 12 Pack"); // the tail is gone, not wrapped
  expect(rendered).not.toContain(LONG_NAME);
  await expect(page.getByText(LONG_NAME)).toHaveCount(0);
});

test("A rejected diet POST shows the save error and leaves the form filled", async ({ page }) => {
  const NAME = "E2E est save rejected";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  const estimates = countRequests(page, estimatePost);
  await mockEstimate(page, 200, LABEL_BODY); // armed, and must never fire: both numbers are typed

  // Only the POST is rejected; the page's own GET /api/diet must still load normally.
  const dietPath = (url: URL) => url.pathname === "/api/diet";
  const reject = async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "bad request" }) });
  };
  await page.route(dietPath, reject);

  await foodInput(page).fill(NAME);
  await kcalInput(page).fill("6000"); // past the API's 5000 ceiling: the real 400 this guards
  await proteinInput(page).fill("41");
  const rejected = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();
  expect((await rejected).status()).toBe(400);

  await expect(formErrLine(page)).toHaveText(SAVE_ERR);
  await expect(page.getByText(SAVE_ERR, { exact: true })).toBeVisible();
  await expect(page.locator("main ul > li")).toHaveCount(0); // nothing was saved
  await totals(0, 0);
  await expect(noteLine(page)).toHaveCount(0);
  await expect(addBtn(page)).toBeEnabled();
  await expect(estimatingBtn(page)).toHaveCount(0);

  // Every box keeps exactly what was typed, so the bad number can be corrected in place.
  await expect(foodInput(page)).toHaveValue(NAME);
  await expect(kcalInput(page)).toHaveValue("6000");
  await expect(proteinInput(page)).toHaveValue("41");

  // Correcting it and re-adding clears the error and saves for real.
  await page.unroute(dietPath, reject);
  await kcalInput(page).fill("530");
  const saved = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();
  expect((await saved).status()).toBe(201);

  await expect(rowFor(page, NAME).getByText("530kcal · 41g", { exact: true })).toBeVisible();
  await totals(530, 41);
  await expect(formErrLine(page)).toHaveCount(0);
  await expect(page.getByText(SAVE_ERR)).toHaveCount(0);
  await expect(foodInput(page)).toHaveValue(""); // reset only once the row really landed

  await page.waitForTimeout(500); // let any stray request land before counting
  expect(estimates.n).toBe(0);
});

test("A rejected save keeps the label note beside the error", async ({ page }) => {
  const NAME = "E2E est save rejected note";
  await openDiet(page, []);
  await mockEstimate(page, 200, SERVING_GUESS_BODY);

  const dietPath = (url: URL) => url.pathname === "/api/diet";
  await page.route(dietPath, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "bad request" }) });
  });

  await foodInput(page).fill(NAME); // both numbers blank: the estimate fills them, then the save fails
  const rejected = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();
  expect((await rejected).status()).toBe(400);

  await expect(formErrLine(page)).toHaveText(SAVE_ERR);
  await expect(noteLine(page)).toHaveText(labelNote("Actileaf Oat Drink", " for 200 (assumed) g/ml"));
  await expect(page.locator("main ul > li")).toHaveCount(0);
  await expect(foodInput(page)).toHaveValue(NAME);
  await expect(addBtn(page)).toBeEnabled();
});

// ---------------------------------------------------------------------------
// Dropped requests: the client bounds every AI POST with a 45 s timeout and retries
// a *thrown* request exactly once. Regression guard for the "Network error." report,
// where a 7-14 s estimate plus one blip on the wire ended the attempt outright.
// A non-2xx is an answer, not a blip, so it is never retried.
// ---------------------------------------------------------------------------

// Verbatim app copy. The row line is not a prefix of the form line ("connection." vs
// "connection, or"), so a non-exact match of one can never pick up the other.
const EST_ERR_NET = "Couldn't reach the coach — check your connection, or type the numbers in.";
const ROW_ERR_NET = "Couldn't reach the coach — check your connection.";

const nutritionPost = (r: Request) => isPost(r, "/api/ai/nutrition");

const FLAKY_BODY = { kcal: 275, proteinG: 19, source: "estimate", matchedName: null };

/**
 * Route-mock a POST endpoint that aborts its first `failures` requests and fulfils every
 * later one. route.abort() is what a dropped connection looks like to the page: fetch
 * rejects, which is the only failure postJson() is allowed to retry.
 * The returned counter is the handler's own view, independent of the page event stream.
 */
async function mockPostFlaky(
  page: Page,
  pathname: string,
  failures: number,
  respond: () => { status: number; body: unknown },
): Promise<{ n: number }> {
  const state = { n: 0 };
  await page.route(`**${pathname}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    state.n += 1;
    if (state.n <= failures) return route.abort();
    const { status, body } = respond();
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return state;
}

test("Estimate dropped once: the retry succeeds, the row is added and no error is ever shown", async ({ page }) => {
  const NAME = "E2E est retry once";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  await totals(0, 0);
  const estimates = countRequests(page, estimatePost);
  const handler = await mockPostFlaky(page, "/api/ai/estimate", 1, () => ({ status: 200, body: FLAKY_BODY }));

  await foodInput(page).fill(NAME);
  const dietReq = page.waitForRequest(dietPost);
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();

  // The second attempt is the one that answers, and its numbers are the ones saved.
  expect((await dietReq).postDataJSON()).toEqual({ date: DATE, name: NAME, kcal: 275, proteinG: 19 });
  expect((await dietRes).status()).toBe(201);

  const row = rowFor(page, NAME);
  await expect(page.locator("main ul > li")).toHaveCount(1);
  await expect(row.getByText("275kcal · 19g", { exact: true })).toBeVisible();
  await totals(275, 19);
  await expect(noteLine(page)).toHaveText(COACH_NOTE);

  // The blip never reaches the user: no error line, and the form completed normally.
  await expect(formErrLine(page)).toHaveCount(0);
  await expect(page.getByText(EST_ERR_NET)).toHaveCount(0);
  await expect(page.getByText(EST_ERR_FAIL)).toHaveCount(0);
  await expect(foodInput(page)).toHaveValue("");
  await expect(addBtn(page)).toBeEnabled();
  await expect(estimatingBtn(page)).toHaveCount(0);

  await page.waitForTimeout(500); // let any stray request land before counting
  expect(handler.n).toBe(2); // dropped once, retried once: two attempts, one success
  expect(estimates.n).toBe(2);
});

test("Estimate dropped twice: two attempts, the connection error, no row, and the typed values survive", async ({ page }) => {
  const NAME = "E2E est retry exhausted";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  const estimates = countRequests(page, estimatePost);
  const diets = countRequests(page, dietPost);
  const handler = await mockPostFlaky(page, "/api/ai/estimate", Infinity, () => ({ status: 200, body: FLAKY_BODY }));

  await foodInput(page).fill(NAME);
  await proteinInput(page).fill("31"); // one blank box is enough to trigger the estimate
  await addBtn(page).click();

  await expect(formErrLine(page)).toHaveText(EST_ERR_NET);
  await expect(page.getByText(EST_ERR_NET, { exact: true })).toBeVisible();
  await expect(formErrLine(page)).toHaveCount(1);
  await expect(page.getByText(EST_ERR_FAIL)).toHaveCount(0); // not the non-2xx wording
  await expect(page.getByText(EST_ERR_KEY)).toHaveCount(0);
  await expect(page.getByText(ROW_ERR_NET, { exact: true })).toHaveCount(0); // form copy, not row copy

  await expect(page.locator("main ul > li")).toHaveCount(0); // nothing saved on a dropped estimate
  await totals(0, 0);
  await expect(noteLine(page)).toHaveCount(0);
  await expect(addBtn(page)).toBeEnabled(); // out of the Estimating… state, retryable
  await expect(estimatingBtn(page)).toHaveCount(0);

  // Every box keeps what was typed, so the numbers can be filled in by hand instead.
  await expect(foodInput(page)).toHaveValue(NAME);
  await expect(proteinInput(page)).toHaveValue("31");
  await expect(kcalInput(page)).toHaveValue("");
  await expect(page.getByText(HINT, { exact: true })).toBeVisible();

  await page.waitForTimeout(500); // let any stray request land before counting
  expect(handler.n).toBe(2); // two attempts total, never a third
  expect(estimates.n).toBe(2);
  expect(diets.n).toBe(0);

  // Recovery: typing the missing number in saves without touching the estimate again.
  await kcalInput(page).fill("410");
  const dietRes = page.waitForResponse((r) => dietPost(r.request()));
  await addBtn(page).click();
  expect((await dietRes).status()).toBe(201);
  await expect(rowFor(page, NAME).getByText("410kcal · 31g", { exact: true })).toBeVisible();
  await totals(410, 31);
  await expect(formErrLine(page)).toHaveCount(0);
  await expect(page.getByText(EST_ERR_NET)).toHaveCount(0);
  expect(handler.n).toBe(2);
});

test("Estimate 502 is an answer, not a blip: exactly one request, and the estimate error", async ({ page }) => {
  const NAME = "E2E est no retry on 502";
  await openDiet(page, []);
  const totals = await totalsOf(page);
  const estimates = countRequests(page, estimatePost);
  const diets = countRequests(page, dietPost);
  const seen = await mockEstimate(page, 502, { error: "estimate_failed" });

  await foodInput(page).fill(NAME);
  const res = page.waitForResponse((r) => estimatePost(r.request()));
  await addBtn(page).click();
  expect((await res).status()).toBe(502);

  await expect(formErrLine(page)).toHaveText(EST_ERR_FAIL);
  await expect(page.getByText(EST_ERR_FAIL, { exact: true })).toBeVisible();
  await expect(page.getByText(EST_ERR_NET)).toHaveCount(0); // a served 502 is not a connection failure
  await expect(page.locator("main ul > li")).toHaveCount(0);
  await totals(0, 0);
  await expect(addBtn(page)).toBeEnabled();
  await expect(estimatingBtn(page)).toHaveCount(0);
  await expect(foodInput(page)).toHaveValue(NAME);

  await page.waitForTimeout(700); // long enough for a retry to have fired, if one existed
  expect(estimates.n).toBe(1);
  expect(seen).toEqual([{ name: NAME }]); // one body seen by the route, never a second
  expect(diets.n).toBe(0);
});

test("Analyze dropped twice: that row shows the connection error after exactly two requests", async ({ page }) => {
  await openDiet(page, [
    { name: "E2E nutri dropped", kcal: 640, proteinG: 42 },
    { name: "E2E nutri untouched", kcal: 200, proteinG: 5 },
  ]);
  const posts = countRequests(page, nutritionPost);
  const handler = await mockPostFlaky(page, "/api/ai/nutrition", Infinity, () => ({ status: 201, body: { nutrition: PANEL } }));

  const row = rowFor(page, "E2E nutri dropped");
  const other = rowFor(page, "E2E nutri untouched");
  await analyzeBtn(row).click();

  await expect(row.getByText(ROW_ERR_NET, { exact: true })).toBeVisible();
  await expect(errLineOf(row)).toHaveText(ROW_ERR_NET);
  await expect(page.getByText(ROW_ERR_NET, { exact: true })).toHaveCount(1); // scoped to the clicked row
  await expect(errLineOf(other)).toHaveCount(0);
  await expect(page.getByText(ERR_FAIL)).toHaveCount(0); // not the non-2xx wording
  await expect(page.getByText(ERR_KEY)).toHaveCount(0);

  await expect(gridOf(row)).toHaveCount(0); // no panel on a dropped analysis
  await expect(analyzeBtn(row)).toBeEnabled(); // out of Analyzing…, retryable
  await expect(infoBtn(row)).toHaveCount(0);
  await expect(analyzeBtn(other)).toBeEnabled();
  await expect(deleteBtn(row)).toBeEnabled();

  await page.waitForTimeout(500); // let any stray request land before counting
  expect(handler.n).toBe(2); // two attempts total, never a third
  expect(posts.n).toBe(2);

  // Same endpoint, now healthy: the retry clears the stale line and renders the panel.
  await page.unroute("**/api/ai/nutrition");
  await mockNutrition(page, () => ({ status: 201, body: { nutrition: PANEL } }));
  await analyzeBtn(row).click();

  await expectFullPanel(row, PANEL);
  await expect(errLineOf(row)).toHaveCount(0);
  await expect(anyErrLine(page)).toHaveCount(0);
  await expect(page.getByText(ROW_ERR_NET)).toHaveCount(0);
  await expect(gridOf(other)).toHaveCount(0);
});

test("Analyze 502 is not retried: exactly one request, and the analysis error", async ({ page }) => {
  await openDiet(page, [{ name: "E2E nutri 502 once", kcal: 700, proteinG: 25 }]);
  const posts = countRequests(page, nutritionPost);
  await mockNutrition(page, () => ({ status: 502, body: { error: "nutrition_failed" } }));

  const row = rowFor(page, "E2E nutri 502 once");
  const res = page.waitForResponse((r) => nutritionPost(r.request()));
  await analyzeBtn(row).click();
  expect((await res).status()).toBe(502);

  await expect(row.getByText(ERR_FAIL, { exact: true })).toBeVisible();
  await expect(errLineOf(row)).toHaveText(ERR_FAIL);
  await expect(page.getByText(ROW_ERR_NET)).toHaveCount(0); // a served 502 is not a connection failure
  await expect(gridOf(row)).toHaveCount(0);
  await expect(analyzeBtn(row)).toBeEnabled();

  await page.waitForTimeout(700); // long enough for a retry to have fired, if one existed
  expect(posts.n).toBe(1);
});

test("AI_LIVE: a UI-created meal analyzes for real and renders the full panel", async ({ page }) => {
  test.skip(!AI_LIVE, "needs live OpenAI quota (set AI_LIVE)");
  test.setTimeout(180_000);
  await openDiet(page, []);

  // create the entry through the form, not the API
  await page.getByPlaceholder("Food").fill("Tesco chicken katsu curry ready meal");
  await page.getByPlaceholder("kcal").fill("640");
  await page.getByPlaceholder("protein").fill("42");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/diet") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  expect((await created).status()).toBe(201);

  const row = rowFor(page, "Tesco chicken katsu curry ready meal");
  await expect(row).toHaveCount(1);

  const res = page.waitForResponse(
    (r) => r.url().endsWith("/api/ai/nutrition") && r.request().method() === "POST",
    { timeout: 150_000 });
  await analyzeBtn(row).click();
  expect((await res).status()).toBe(201);

  await expect(chipOf(row)).toBeVisible({ timeout: 150_000 });
  expect(VERDICTS).toContain((await chipOf(row).textContent())?.trim());
  await expect(gridOf(row)).toHaveCount(17);
  const cells = await gridOf(row).allTextContents();
  // every cell: its exact label, a real number, its exact unit
  const shape: [string, string][] = [
    ["Carbs", "g"], ["Fat", "g"], ["Sat fat", "g"], ["Fibre", "g"], ["Sugar", "g"], ["Salt", "g"],
    ["Vit A", "µg"], ["Vit C", "mg"], ["Vit D", "µg"], ["Vit E", "mg"], ["B12", "µg"], ["Folate", "µg"],
    ["Calcium", "mg"], ["Iron", "mg"], ["Potassium", "mg"], ["Magnesium", "mg"], ["Zinc", "mg"],
  ];
  shape.forEach(([label, unit], i) => {
    expect(cells[i]).toMatch(new RegExp(`^${label}\\d+(\\.\\d+)?${unit}$`));
  });
  await expect(row.getByText(CAPTION, { exact: true })).toBeVisible();
  await expect(infoBtn(row)).toBeVisible();

  // clean up the row this test wrote (afterAll sweeps the range too)
  const del = page.waitForResponse((r) => /\/api\/diet\/\d+$/.test(new URL(r.url()).pathname) && r.request().method() === "DELETE");
  await deleteBtn(row).click();
  expect((await del).status()).toBe(200);
  await expect(page.locator("main ul > li")).toHaveCount(0);
});
