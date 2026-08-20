import { neonConfig } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const PASSCODE = process.env.APP_PASSCODE || "reforge-1b3543";
const SAMPLE = "bench 3x8 at 60, lateral raises 3x15 at 8, 20 min bike, oats + whey, weight 79.6";

// Owned e2e dates: 2030-05-20 .. 2030-05-25 (the int gaps suite owns 2030-05-06..10).
const QL_DATE = "2030-05-20"; // Mon -> chest_shoulders
const DIET_DATE = "2030-05-21"; // Tue
const REST_DATE = "2030-05-25"; // Sat -> rest
const CLEAN_LO = "2030-05-20";
const CLEAN_HI = "2030-05-25";
const PRESET_PREFIX = "E2E gaps preset ";

type Ex = { id: number; name: string; targetSets: number; repLow: number; repHigh: number; supersetGroup: string | null };
type DietRow = { id: number; date: string; name: string; kcal: number; proteinG: number };
type MetricRow = { id: number; date: string; bodyweight: number | null };
type SessionRow = { id: number; date: string; dayType: string };
type Settings = { calorieTarget: number; proteinTarget: number };

const PARSED = {
  items: [
    { kind: "set", exerciseId: null, exerciseName: "mystery press", sets: 3, reps: 8, weight: 60 },
    { kind: "cardio", type: "bike", minutes: 20 },
    { kind: "meal", name: "oats + whey", kcal: 420, proteinG: 35, presetId: null, estimated: true },
    { kind: "metric", field: "bodyweight", value: 79.6 },
  ],
  note: "shadowboxing rounds",
};

const REVIEW = {
  id: 999999,
  createdAt: "2030-05-20T10:00:00.000Z",
  periodStart: "2030-05-06",
  periodEnd: "2030-05-19",
  markdown: [
    "## Training",
    "Solid week overall.",
    "- bench up 2.5 kg",
    "- squat steady",
    "Keep pushing.",
    "",
    "## Diet",
    "* protein on target",
    "",
    "Final paragraph.",
  ].join("\n"),
};

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Passcode").fill(PASSCODE);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page).toHaveURL(/\/$/);
}

// hydration guard: a fill before React hydrates is wiped by the controlled value.
async function loginQuickLogReady(page: Page) {
  await login(page);
  const textarea = page.getByPlaceholder(SAMPLE);
  const parse = page.getByRole("button", { name: "Parse", exact: true });
  await expect(async () => {
    await textarea.fill("x");
    await expect(parse).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await textarea.fill("");
  await expect(parse).toBeDisabled();
}

const quickLog = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Quick log", exact: true }) });
const coach = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Coach review", exact: true }) });

const pin = (page: Page, iso: string) => page.clock.setFixedTime(new Date(`${iso}T12:00:00`));


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

// Direct scoped deletes for everything this suite can write (sessions cascade set_logs).
// Diet rows have an API delete, but the drizzle sweep also covers crashed runs.
async function cleanOwnedRows() {
  loadDatabaseUrl();
  const { db } = await import("../lib/db");
  const { dietEntries, bodyMetrics, workoutSessions, foodPresets } = await import("../lib/db/schema");
  const { and, gte, lte, like } = await import("drizzle-orm");
  await db.delete(dietEntries).where(and(gte(dietEntries.date, CLEAN_LO), lte(dietEntries.date, CLEAN_HI)));
  await db.delete(bodyMetrics).where(and(gte(bodyMetrics.date, CLEAN_LO), lte(bodyMetrics.date, CLEAN_HI)));
  await db.delete(workoutSessions).where(and(gte(workoutSessions.date, CLEAN_LO), lte(workoutSessions.date, CLEAN_HI)));
  await db.delete(foodPresets).where(like(foodPresets.name, `${PRESET_PREFIX}%`));
}

test.beforeAll(cleanOwnedRows); // idempotent reruns
test.afterAll(cleanOwnedRows);

test("QuickLog: mocked parse renders proposal cards per kind; edit, remove, guard, select, Save commits", async ({ page }) => {
  await pin(page, QL_DATE);
  await page.route("**/api/ai/parse", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PARSED) }));
  await loginQuickLogReady(page);
  const panel = quickLog(page);

  let commits = 0;
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/ai/commit") commits++; });

  await panel.getByPlaceholder(SAMPLE).fill("mystery press 3x8 at 60, 20 min bike, oats + whey, weight 79.6, shadowboxing rounds");
  const parseRes = page.waitForResponse((r) => r.url().endsWith("/api/ai/parse") && r.request().method() === "POST");
  await panel.getByRole("button", { name: "Parse", exact: true }).click();
  expect((await parseRes).status()).toBe(200);

  // one card per kind, in payload order
  await expect(panel.locator("li")).toHaveCount(4);
  expect(await panel.locator("li span.w-12").allTextContents()).toEqual(["set", "cardio", "meal", "metric"]);
  await expect(panel.getByRole("button", { name: "Save 4", exact: true })).toBeVisible();
  await expect(panel.getByText("Not mapped: shadowboxing rounds", { exact: true })).toBeVisible();

  const setCard = panel.locator("li").nth(0);
  const cardioCard = panel.locator("li").nth(1);
  const mealCard = panel.locator("li").nth(2);
  const metricCard = panel.locator("li").nth(3);

  // set card: unresolved exercise select + sets/reps/weight inputs
  const select = setCard.locator("select");
  await expect(select).toHaveValue("");
  await expect(select.locator("option").first()).toHaveText("mystery press — pick exercise");
  await expect(setCard.locator("input").nth(0)).toHaveValue("3");
  await expect(setCard.locator("input").nth(1)).toHaveValue("8");
  await expect(setCard.locator("input").nth(2)).toHaveValue("60");
  // cardio card
  await expect(cardioCard.getByText("bike", { exact: true })).toBeVisible();
  await expect(cardioCard.locator("input")).toHaveValue("20");
  // meal card with the estimated badge
  await expect(mealCard.getByText("oats + whey")).toBeVisible();
  await expect(mealCard.getByText("est.", { exact: true })).toBeVisible();
  await expect(mealCard.locator("input").nth(0)).toHaveValue("420");
  await expect(mealCard.locator("input").nth(1)).toHaveValue("35");
  // metric card
  await expect(metricCard.getByText("bodyweight", { exact: true })).toBeVisible();
  await expect(metricCard.locator("input")).toHaveValue("79.6");

  // client-side guard: saving with exerciseId null fires no commit
  await panel.getByRole("button", { name: "Save 4", exact: true }).click();
  await expect(panel.getByText("Pick an exercise for every set before saving.", { exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  expect(commits).toBe(0);

  // remove the cardio card
  await cardioCard.locator("button").click();
  await expect(panel.locator("li")).toHaveCount(3);
  expect(await panel.locator("li span.w-12").allTextContents()).toEqual(["set", "meal", "metric"]);
  await expect(panel.getByRole("button", { name: "Save 3", exact: true })).toBeVisible();

  // resolve the exercise via the select (options come from the live catalogue)
  const exs = (await (await page.request.get("/api/exercises")).json()) as Ex[];
  expect(exs.length).toBeGreaterThan(0);
  await expect(select.locator("option")).toHaveCount(exs.length + 1);
  await select.selectOption(String(exs[0].id));
  await expect(select).toHaveValue(String(exs[0].id));

  // inline numeric editing; clearing snaps to 0 (Number("") -> 0)
  await panel.locator("li").nth(0).locator("input").nth(2).fill("62.5");
  const kcalInput = panel.locator("li").nth(1).locator("input").nth(0);
  await kcalInput.fill("");
  await expect(kcalInput).toHaveValue("0");
  await kcalInput.fill("500");
  await panel.locator("li").nth(2).locator("input").fill("80.5");

  // Save 3 -> POST /api/ai/commit with the edited proposals (no model involved)
  const commitReq = page.waitForRequest((r) => r.url().endsWith("/api/ai/commit") && r.method() === "POST");
  const commitRes = page.waitForResponse((r) => r.url().endsWith("/api/ai/commit") && r.request().method() === "POST");
  await panel.getByRole("button", { name: "Save 3", exact: true }).click();
  expect((await commitReq).postDataJSON()).toEqual({
    date: QL_DATE,
    items: [
      { kind: "set", exerciseId: exs[0].id, exerciseName: "mystery press", sets: 3, reps: 8, weight: 62.5 },
      { kind: "meal", name: "oats + whey", kcal: 500, proteinG: 35, presetId: null, estimated: true },
      { kind: "metric", field: "bodyweight", value: 80.5 },
    ],
  });
  const commit = await commitRes;
  expect(commit.status()).toBe(201);
  expect(await commit.json()).toEqual({ created: { sets: 3, cardio: 0, meals: 1, metrics: 1 } });

  // composer resets after save
  await expect(panel.getByPlaceholder(SAMPLE)).toHaveValue("");
  await expect(panel.locator("li")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^Save \d+$/ })).toHaveCount(0);

  // committed rows are readable via the APIs
  const sessions = (await (await page.request.get(`/api/sessions?date=${QL_DATE}`)).json()) as SessionRow[];
  expect(sessions).toHaveLength(1);
  expect(sessions[0].dayType).toBe("chest_shoulders");
  const sets = (await (await page.request.get(`/api/sessions/${sessions[0].id}`)).json()) as { setNumber: number; weight: number; reps: number; exerciseId: number }[];
  expect(sets.map((s) => s.setNumber).sort()).toEqual([1, 2, 3]);
  for (const s of sets) expect(s).toMatchObject({ exerciseId: exs[0].id, weight: 62.5, reps: 8 });
  const diet = (await (await page.request.get(`/api/diet?date=${QL_DATE}`)).json()) as DietRow[];
  expect(diet).toHaveLength(1);
  expect(diet[0]).toMatchObject({ name: "oats + whey", kcal: 500, proteinG: 35 });
  const metrics = ((await (await page.request.get("/api/metrics")).json()) as MetricRow[]).filter((m) => m.date === QL_DATE);
  expect(metrics).toHaveLength(1);
  expect(metrics[0].bodyweight).toBe(80.5);
});

test("QuickLog: date control backdates parse and commit to the chosen day", async ({ page }) => {
  await pin(page, "2030-05-23");
  await page.route("**/api/ai/parse", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      items: [{ kind: "meal", name: "backdated oats", kcal: 300, proteinG: 20, presetId: null, estimated: true }],
      note: null,
    }) }));
  await loginQuickLogReady(page);
  const panel = quickLog(page);

  const dateInput = panel.getByLabel("Log date");
  await expect(dateInput).toHaveValue("2030-05-23"); // defaults to today
  // max is capped at today; SSR renders it with the server clock and hydration
  // doesn't patch attributes, so under the mocked clock only the format is stable.
  await expect(dateInput).toHaveAttribute("max", /^\d{4}-\d{2}-\d{2}$/);
  await dateInput.fill("2030-05-22");

  await panel.getByPlaceholder(SAMPLE).fill("oats for yesterday");
  const parseReq = page.waitForRequest((r) => r.url().endsWith("/api/ai/parse") && r.method() === "POST");
  await panel.getByRole("button", { name: "Parse", exact: true }).click();
  expect((await parseReq).postDataJSON()).toEqual({ text: "oats for yesterday", date: "2030-05-22" });

  const commitReq = page.waitForRequest((r) => r.url().endsWith("/api/ai/commit") && r.method() === "POST");
  const commitRes = page.waitForResponse((r) => r.url().endsWith("/api/ai/commit") && r.request().method() === "POST");
  await panel.getByRole("button", { name: "Save 1", exact: true }).click();
  expect((await commitReq).postDataJSON()).toEqual({
    date: "2030-05-22",
    items: [{ kind: "meal", name: "backdated oats", kcal: 300, proteinG: 20, presetId: null, estimated: true }],
  });
  expect((await commitRes).status()).toBe(201);

  await expect(panel.getByText("Saved to 2030-05-22", { exact: true })).toBeVisible();

  const diet = (await (await page.request.get("/api/diet?date=2030-05-22")).json()) as DietRow[];
  expect(diet).toHaveLength(1);
  expect(diet[0]).toMatchObject({ name: "backdated oats", kcal: 300, proteinG: 20 });
});

test("QuickLog: parse with zero items shows the empty-items message and no Save button", async ({ page }) => {
  await pin(page, QL_DATE);
  await page.route("**/api/ai/parse", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], note: null }) }));
  await loginQuickLogReady(page);
  const panel = quickLog(page);

  await panel.getByPlaceholder(SAMPLE).fill("good morning diary");
  await panel.getByRole("button", { name: "Parse", exact: true }).click();

  await expect(panel.getByText("Nothing loggable found in that text.", { exact: true })).toBeVisible();
  await expect(panel.locator("li")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^Save \d+$/ })).toHaveCount(0);
  await expect(panel.getByText("Not mapped:")).toHaveCount(0);
});

test("CoachReview: mocked review pins the Markdown renderer (headings, bullets, paragraphs, list flushing)", async ({ page }) => {
  await page.route("**/api/ai/review", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REVIEW) })
      : route.continue());
  await login(page);
  const panel = coach(page);

  await expect(panel.getByRole("button", { name: "Review again", exact: true })).toBeEnabled();
  await expect(panel.getByText("2030-05-06 → 2030-05-19")).toBeVisible();

  const md = panel.locator("div.space-y-2.text-sm");
  await expect(md.locator("h3").first()).toBeVisible();
  // block sequence pins list flushing: on a following paragraph, on a blank line, at EOF
  expect(await md.locator("> *").evaluateAll((els) => els.map((e) => e.tagName))).toEqual([
    "H3", "P", "UL", "P", "H3", "UL", "P",
  ]);
  expect(await md.locator("h3").allTextContents()).toEqual(["Training", "Diet"]);
  expect(await md.locator("p").allTextContents()).toEqual(["Solid week overall.", "Keep pushing.", "Final paragraph."]);
  expect(await md.locator("ul").nth(0).locator("li").allTextContents()).toEqual(["bench up 2.5 kg", "squat steady"]);
  expect(await md.locator("ul").nth(1).locator("li").allTextContents()).toEqual(["protein on target"]);
});

test("/diet: manual add form (blank numbers -> 0), Save preset, and per-entry delete with totals refresh", async ({ page }) => {
  await pin(page, DIET_DATE);
  await login(page);
  await page.goto("/diet");
  await expect(page.getByRole("heading", { name: `Diet · ${DIET_DATE}`, exact: true })).toBeVisible();
  // preset chips rendering means load() resolved and the page is hydrated
  await expect(page.locator("div.flex.flex-wrap button").first()).toBeVisible();
  const settings = (await (await page.request.get("/api/settings")).json()) as Settings;
  const totals = (kcal: number, g: number) => Promise.all([
    expect(page.getByText(`${kcal} / ${settings.calorieTarget} kcal`, { exact: true })).toBeVisible(),
    expect(page.getByText(`${g} / ${settings.proteinTarget} g protein`, { exact: true })).toBeVisible(),
  ]);

  await expect(page.locator("main ul > li")).toHaveCount(0); // owned date starts clean
  await totals(0, 0);

  let presetPosts = 0;
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/presets" && r.method() === "POST") presetPosts++; });

  // manual add leaving kcal/protein blank: Number("") -> 0 goes to the API
  const food = page.getByPlaceholder("Food");
  await food.fill("E2E gap food");
  const blankReq = page.waitForRequest((r) => r.url().endsWith("/api/diet") && r.method() === "POST");
  const blankRes = page.waitForResponse((r) => r.url().endsWith("/api/diet") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  expect((await blankReq).postDataJSON()).toEqual({ date: DIET_DATE, name: "E2E gap food", kcal: 0, proteinG: 0 });
  expect((await blankRes).status()).toBe(201);
  const blankRow = page.locator("main ul > li").filter({ hasText: "E2E gap food" });
  await expect(blankRow).toHaveCount(1);
  await expect(blankRow.getByText("0kcal · 0g", { exact: true })).toBeVisible();
  await totals(0, 0);
  await expect(food).toHaveValue(""); // form resets after Add

  // manual add with numbers updates list and totals
  await food.fill("E2E gap meal");
  await page.getByPlaceholder("kcal").fill("321");
  await page.getByPlaceholder("protein").fill("21");
  const mealRes = page.waitForResponse((r) => r.url().endsWith("/api/diet") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const mealRow = (await (await mealRes).json()) as DietRow;
  expect(mealRow).toMatchObject({ date: DIET_DATE, name: "E2E gap meal", kcal: 321, proteinG: 21 });
  await expect(page.locator("main ul > li")).toHaveCount(2);
  await expect(page.locator("main ul > li").filter({ hasText: "E2E gap meal" }).getByText("321kcal · 21g", { exact: true })).toBeVisible();
  await totals(321, 21);

  // Save preset with an empty name is a no-op (no POST fired)
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await page.waitForTimeout(400);
  expect(presetPosts).toBe(0);

  // Save preset posts /api/presets and the new chip appears
  const presetName = `${PRESET_PREFIX}${Date.now()}`;
  await food.fill(presetName);
  await page.getByPlaceholder("kcal").fill("111");
  await page.getByPlaceholder("protein").fill("9");
  const presetRes = page.waitForResponse((r) => r.url().endsWith("/api/presets") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  const preset = await presetRes;
  expect(preset.status()).toBe(201);
  expect(await preset.json()).toMatchObject({ name: presetName, kcal: 111, proteinG: 9 });
  await expect(page.getByRole("button", { name: `${presetName} · 111kcal`, exact: true })).toBeVisible();
  expect(presetPosts).toBe(1);

  // per-entry ✕ delete refreshes list and totals
  const delRes = page.waitForResponse((r) => r.url().includes(`/api/diet/${mealRow.id}`) && r.request().method() === "DELETE");
  await page.locator("main ul > li").filter({ hasText: "E2E gap meal" }).getByRole("button", { name: "✕" }).click();
  expect((await delRes).status()).toBe(200);
  await expect(page.locator("main ul > li")).toHaveCount(1);
  await totals(0, 0);
  await blankRow.getByRole("button", { name: "✕" }).click();
  await expect(page.locator("main ul > li")).toHaveCount(0);
});

test("/workout on a pinned Saturday renders the rest-day branch", async ({ page }) => {
  await pin(page, REST_DATE);
  await login(page);
  await page.goto("/workout");
  await expect(page.getByRole("heading", { name: "Rest day", exact: true })).toBeVisible();
  await expect(page.getByText("Optional walk / cardio.", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("kg")).toHaveCount(0);
  await expect(page.locator("main span.font-semibold")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "✓" })).toHaveCount(0);
});

test("/workout on a pinned Monday renders the full chest_shoulders training day", async ({ page }) => {
  await pin(page, QL_DATE);
  await login(page);
  await page.goto("/workout");
  await expect(page.getByRole("heading", { name: `Chest + Shoulders · ${QL_DATE}`, exact: true })).toBeVisible();

  const exs = (await (await page.request.get("/api/exercises?dayType=chest_shoulders")).json()) as Ex[];
  expect(exs.length).toBeGreaterThan(0);

  const titles = page.locator("main span.font-semibold");
  await expect(titles).toHaveCount(exs.length);
  expect(await titles.allTextContents()).toEqual(
    exs.map((e) => `${e.supersetGroup ? `[${e.supersetGroup}] ` : ""}${e.name}`));
  for (const ex of exs) {
    await expect(page.getByText(`${ex.targetSets}×${ex.repLow}-${ex.repHigh}`, { exact: true })).toBeVisible();
  }
  const totalSets = exs.reduce((n, e) => n + e.targetSets, 0);
  await expect(page.getByPlaceholder("kg")).toHaveCount(totalSets);
  await expect(page.getByPlaceholder("reps")).toHaveCount(totalSets);
  await expect(page.getByRole("button", { name: "✓" })).toHaveCount(totalSets);
  // every card shows its history line: either a Last: hint or the no-history note
  const firstCard = page.locator("main > div").nth(0);
  await expect(firstCard.getByText(/^(Last: |No history yet)/)).toHaveCount(1);
});
