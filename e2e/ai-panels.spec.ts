import { expect, test, request as pwRequest, type Page } from "@playwright/test";
import { todayIso } from "../lib/today";

const PASSCODE = process.env.APP_PASSCODE || "reforge-1b3543";
const BASE = process.env.REFORGE_URL || "http://localhost:3100";
const AI_LIVE = Boolean(process.env.AI_LIVE);
const SAMPLE = "bench 3x8 at 60, lateral raises 3x15 at 8, 20 min bike, oats + whey, weight 79.6";
const PARSE_ERROR = "Couldn't parse that — try a shorter line.";
const REVIEW_ERROR = "Review failed — previous one kept.";
const NO_REVIEW = "No review yet. The coach reads your last 14 days of sets, meals, cardio and weight.";
// marker values for AI_LIVE cleanup: no seeded row for today uses kcal 121 / protein 8.5
const MARKER = { kcal: 121, proteinG: 8.5 };

type DietRow = { id: number; kcal: number; proteinG: number };
type Review = { id: number; periodStart: string; periodEnd: string; markdown: string } | null;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Passcode").fill(PASSCODE);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page).toHaveURL(/\/$/);
  // hydration guard: a fill before React hydrates is wiped by the controlled value,
  // leaving Parse disabled forever. Prove interactivity, then reset.
  const textarea = page.getByPlaceholder(SAMPLE);
  const parse = page.getByRole("button", { name: "Parse", exact: true });
  await expect(async () => {
    await textarea.fill("x");
    await expect(parse).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await textarea.fill("");
  await expect(parse).toBeDisabled();
}

/** GET the stored review; retries the rare empty-body hiccup from the dev server. */
async function getReview(page: Page): Promise<Review> {
  for (let i = 0; i < 3; i++) {
    const res = await page.request.get("/api/ai/review");
    if (res.status() === 200) {
      const body = (await res.text()).trim();
      if (body) return JSON.parse(body) as Review;
    }
    await page.waitForTimeout(500);
  }
  throw new Error("GET /api/ai/review returned no JSON");
}

const quickLog = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Quick log", exact: true }) });
const coach = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Coach review", exact: true }) });

/** Records every non-GET /api/* request except /api/login (and optional extra exclusions). */
function collectApiWrites(page: Page, exclude: string[] = []): string[] {
  const writes: string[] = [];
  const skip = new Set(["/api/login", ...exclude]);
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith("/api/") && r.method() !== "GET" && !skip.has(path)) writes.push(`${r.method()} ${path}`);
  });
  return writes;
}

test.afterAll(async () => {
  if (!AI_LIVE) return; // nothing written without live AI
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const res = await ctx.post("/api/login", { data: { passcode: PASSCODE } });
  if (res.status() !== 200) return;
  const rows = (await (await ctx.get(`/api/diet?date=${todayIso()}`)).json()) as DietRow[];
  for (const r of rows.filter((r) => r.kcal === MARKER.kcal && r.proteinG === MARKER.proteinG)) {
    await ctx.delete(`/api/diet/${r.id}`);
  }
  await ctx.dispose();
});

test("QuickLog: empty or whitespace input keeps Parse disabled and fires no request", async ({ page }) => {
  await login(page);
  const writes = collectApiWrites(page);
  const textarea = quickLog(page).getByPlaceholder(SAMPLE);
  const parse = quickLog(page).getByRole("button", { name: "Parse", exact: true });

  await expect(parse).toBeDisabled();
  await textarea.fill("   ");
  await expect(parse).toBeDisabled();
  await parse.click({ force: true }); // disabled button swallows the click
  await page.waitForTimeout(500);
  expect(writes).toEqual([]);

  await textarea.fill("bench 3x8 at 60");
  await expect(parse).toBeEnabled();
  await textarea.fill("");
  await expect(parse).toBeDisabled();
  expect(writes).toEqual([]);
});

test("QuickLog: parse failure without AI_LIVE shows the error, preserves the text, writes nothing", async ({ page }) => {
  test.skip(AI_LIVE, "only valid while the model call fails");
  await login(page);
  const writes = collectApiWrites(page, ["/api/ai/parse"]);
  const panel = quickLog(page);
  await panel.getByPlaceholder(SAMPLE).fill(SAMPLE);

  const resPromise = page.waitForResponse((r) => r.url().endsWith("/api/ai/parse") && r.request().method() === "POST");
  await panel.getByRole("button", { name: "Parse", exact: true }).click();
  expect((await resPromise).status()).toBe(502);

  await expect(panel.getByText(PARSE_ERROR, { exact: true })).toBeVisible();
  await expect(panel.getByPlaceholder(SAMPLE)).toHaveValue(SAMPLE); // typed text preserved
  await expect(panel.getByRole("button", { name: "Parse", exact: true })).toBeEnabled();
  await expect(panel.locator("li")).toHaveCount(0); // no proposal cards
  await expect(panel.getByRole("button", { name: /^Save \d+$/ })).toHaveCount(0);
  expect(writes).toEqual([]); // no commit, no direct writes on failure
});

test("QuickLog: in-flight parse shows Parsing… and a disabled button, then the error state", async ({ page }) => {
  await login(page);
  await page.route("**/api/ai/parse", async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "parse_failed" }) });
  });
  const panel = quickLog(page);
  await panel.getByPlaceholder(SAMPLE).fill("bench 3x8 at 60");
  await panel.getByRole("button", { name: "Parse", exact: true }).click();

  const busy = panel.getByRole("button", { name: "Parsing…", exact: true });
  await expect(busy).toBeVisible();
  await expect(busy).toBeDisabled();
  await expect(panel.getByText(PARSE_ERROR, { exact: true })).toBeVisible();
  await expect(panel.getByPlaceholder(SAMPLE)).toHaveValue("bench 3x8 at 60");
});

test("QuickLog: 503 replaces the composer with the needs-OPENAI_API_KEY notice", async ({ page }) => {
  await login(page);
  await page.route("**/api/ai/parse", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "ai_not_configured" }) }));
  await quickLog(page).getByPlaceholder(SAMPLE).fill("bench 3x8 at 60");
  await quickLog(page).getByRole("button", { name: "Parse", exact: true }).click();

  const notice = page.locator("section", { hasText: "Quick log needs OPENAI_API_KEY on the server." });
  await expect(notice).toBeVisible();
  await expect(notice.locator("code")).toHaveText("OPENAI_API_KEY");
  await expect(page.getByPlaceholder(SAMPLE)).toHaveCount(0); // composer gone
});

test("CoachReview: initial panel reflects the stored review", async ({ page }) => {
  await login(page);
  const review = await getReview(page);
  const panel = coach(page);
  await expect(panel.getByRole("heading", { name: "Coach review", exact: true })).toBeVisible();
  if (review) {
    await expect(panel.getByRole("button", { name: "Review again", exact: true })).toBeEnabled();
    await expect(panel.getByText(`${review.periodStart} → ${review.periodEnd}`)).toBeVisible();
  } else {
    await expect(panel.getByRole("button", { name: "Review my week", exact: true })).toBeEnabled();
    await expect(panel.getByText(NO_REVIEW, { exact: true })).toBeVisible();
  }
});

test("CoachReview: generate without AI_LIVE surfaces the error, keeps prior state, stores nothing", async ({ page }) => {
  test.skip(AI_LIVE, "only valid while the model call fails");
  await login(page);
  const before = await getReview(page);
  const panel = coach(page);
  const label = before ? "Review again" : "Review my week";

  const resPromise = page.waitForResponse((r) => r.url().endsWith("/api/ai/review") && r.request().method() === "POST");
  await panel.getByRole("button", { name: label, exact: true }).click();
  expect((await resPromise).status()).toBe(502);

  await expect(panel.getByText(REVIEW_ERROR, { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: label, exact: true })).toBeEnabled(); // no crash, same state
  if (before) await expect(panel.getByText(`${before.periodStart} → ${before.periodEnd}`)).toBeVisible();
  else await expect(panel.getByText(NO_REVIEW, { exact: true })).toBeVisible();

  const after = await getReview(page);
  expect(after).toEqual(before); // 502 stored no new review
});

test("CoachReview: in-flight generate shows Reviewing… disabled, then the error", async ({ page }) => {
  await login(page);
  await page.route("**/api/ai/review", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "review_failed" }) });
  });
  const panel = coach(page);
  await panel.getByRole("button", { name: /^Review (my week|again)$/ }).click();

  const busy = panel.getByRole("button", { name: "Reviewing…", exact: true });
  await expect(busy).toBeVisible();
  await expect(busy).toBeDisabled();
  await expect(panel.getByText(REVIEW_ERROR, { exact: true })).toBeVisible();
});

test("CoachReview: 503 replaces the panel with the needs-OPENAI_API_KEY notice", async ({ page }) => {
  await login(page);
  await page.route("**/api/ai/review", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "ai_not_configured" }) })
      : route.continue());
  await coach(page).getByRole("button", { name: /^Review (my week|again)$/ }).click();

  const notice = page.locator("section", { hasText: "Weekly review needs OPENAI_API_KEY on the server." });
  await expect(notice).toBeVisible();
  await expect(notice.locator("code")).toHaveText("OPENAI_API_KEY");
  await expect(page.getByRole("heading", { name: "Coach review", exact: true })).toHaveCount(0);
});

test("QuickLog AI_LIVE: proposals are editable cards, Save commits, the row appears", async ({ page }) => {
  test.skip(!AI_LIVE, "needs live OpenAI quota (set AI_LIVE)");
  await login(page);
  const date = todayIso();
  const beforeIds = new Set(((await (await page.request.get(`/api/diet?date=${date}`)).json()) as DietRow[]).map((r) => r.id));

  const panel = quickLog(page);
  await panel.getByPlaceholder(SAMPLE).fill("oats 300 kcal 20 g protein");
  const parseRes = page.waitForResponse((r) => r.url().endsWith("/api/ai/parse") && r.request().method() === "POST");
  await panel.getByRole("button", { name: "Parse", exact: true }).click();
  expect((await parseRes).status()).toBe(200);

  // keep exactly one meal card, remove the rest
  await expect(panel.locator("li").first()).toBeVisible();
  const kinds = await panel.locator("li span.w-12").allTextContents();
  const mealIdx = kinds.findIndex((k) => k.trim() === "meal");
  expect(mealIdx).toBeGreaterThanOrEqual(0);
  for (let i = kinds.length - 1; i >= 0; i--) {
    if (i !== mealIdx) await panel.locator("li").nth(i).locator("button").click();
  }
  await expect(panel.locator("li")).toHaveCount(1);

  // edit the card to marker values
  const inputs = panel.locator("li").first().locator("input");
  await inputs.nth(0).fill(String(MARKER.kcal));
  await inputs.nth(1).fill(String(MARKER.proteinG));

  const commitRes = page.waitForResponse((r) => r.url().endsWith("/api/ai/commit") && r.request().method() === "POST");
  await panel.getByRole("button", { name: "Save 1", exact: true }).click();
  expect((await commitRes).status()).toBe(201);

  await expect(panel.getByPlaceholder(SAMPLE)).toHaveValue(""); // composer reset after save
  await expect(panel.locator("li")).toHaveCount(0);

  const after = (await (await page.request.get(`/api/diet?date=${date}`)).json()) as DietRow[];
  const created = after.find((r) => !beforeIds.has(r.id) && r.kcal === MARKER.kcal);
  expect(created).toBeDefined();
  expect(created!.proteinG).toBe(MARKER.proteinG);

  // clean up the row this test wrote
  expect((await page.request.delete(`/api/diet/${created!.id}`)).status()).toBe(200);
  const final = (await (await page.request.get(`/api/diet?date=${date}`)).json()) as DietRow[];
  expect(final.some((r) => r.id === created!.id)).toBe(false);
});
