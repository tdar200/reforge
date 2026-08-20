import { expect, test, type Page } from "@playwright/test";
import { DAY_LABELS, dayTypeForDate, sumDiet } from "../lib/logic";
import { todayIso } from "../lib/today";

const PASSCODE = process.env.APP_PASSCODE || "reforge-1b3543";
const QUICKLOG_PLACEHOLDER = "bench 3x8 at 60, lateral raises 3x15 at 8, 20 min bike, oats + whey, weight 79.6";

type Settings = { calorieTarget: number; proteinTarget: number };
type DietRow = { kcal: number; proteinG: number };
type Review = { periodStart: string; periodEnd: string; markdown: string } | null;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Passcode").fill(PASSCODE);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("/login renders the passcode form without app nav", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Reforge" })).toBeVisible();
  const input = page.getByPlaceholder("Passcode");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
  await expect(page.locator("nav")).toHaveCount(0);
});

test("wrong passcode gets 401, shows error, stays on /login", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("Passcode").fill("definitely-wrong");
  const resPromise = page.waitForResponse((r) => r.url().endsWith("/api/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Unlock" }).click();
  expect((await resPromise).status()).toBe(401);
  await expect(page.getByText("Wrong passcode")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test("correct passcode sets session cookie and lands on Today", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("Passcode").fill(PASSCODE);
  const resPromise = page.waitForResponse((r) => r.url().endsWith("/api/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Unlock" }).click();
  expect((await resPromise).status()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name === "reforge_session" && c.value.length > 0)).toBe(true);
});

test("visiting / logged out redirects to /login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByPlaceholder("Passcode")).toBeVisible();
});

test("Today shows the seeded day label and diet totals vs targets", async ({ page }) => {
  await login(page);
  const date = todayIso();
  const dayType = dayTypeForDate(date);
  const settings = (await (await page.request.get("/api/settings")).json()) as Settings;
  const rows = (await (await page.request.get(`/api/diet?date=${date}`)).json()) as DietRow[];
  const total = sumDiet(rows);

  await expect(page.getByText("Session", { exact: true })).toBeVisible();
  await expect(page.getByText(DAY_LABELS[dayType], { exact: true })).toBeVisible();

  const ringValues = page.locator("div.text-2xl.font-bold");
  await expect(ringValues).toHaveCount(2);
  await expect(ringValues.nth(0)).toHaveText(String(Math.round(total.kcal)));
  await expect(ringValues.nth(1)).toHaveText(String(Math.round(total.proteinG)));
  await expect(page.getByText(`/ ${settings.calorieTarget} kcal`, { exact: true })).toBeVisible();
  await expect(page.getByText(`/ ${settings.proteinTarget} g`, { exact: true })).toBeVisible();
  await expect(page.getByText("Calories", { exact: true })).toBeVisible();
  await expect(page.getByText("Protein", { exact: true })).toBeVisible();

  const main = page.locator("main");
  await expect(main.getByRole("link", { name: "Workout", exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: "Add meal", exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: "Log body", exact: true })).toBeVisible();
});

test("QuickLog composer renders with example placeholder and disabled Parse", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Quick log", exact: true })).toBeVisible();
  await expect(page.getByText("AI · GPT-5 mini")).toBeVisible();
  await expect(page.getByPlaceholder(QUICKLOG_PLACEHOLDER)).toBeVisible();
  const parse = page.getByRole("button", { name: "Parse", exact: true });
  await expect(parse).toBeVisible();
  await expect(parse).toBeDisabled();
});

test("CoachReview panel reflects the stored review state", async ({ page }) => {
  await login(page);
  const review = (await (await page.request.get("/api/ai/review")).json()) as Review;
  const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Coach review", exact: true }) });
  await expect(panel).toBeVisible();
  if (review) {
    await expect(panel.getByRole("button", { name: "Review again" })).toBeVisible();
    await expect(panel.getByText(`${review.periodStart} → ${review.periodEnd}`)).toBeVisible();
  } else {
    await expect(panel.getByRole("button", { name: "Review my week" })).toBeVisible();
    await expect(panel.getByText("No review yet. The coach reads your last 14 days of sets, meals, cardio and weight.")).toBeVisible();
  }
});

test("bottom nav reaches every tab and returns to Today", async ({ page }) => {
  await login(page);
  const date = todayIso();
  const dayType = dayTypeForDate(date);
  const workoutHeading = dayType === "rest" ? "Rest day" : `${DAY_LABELS[dayType]} · ${date}`;
  const nav = page.locator("nav");
  await expect(nav.getByRole("link")).toHaveCount(5);

  await nav.getByRole("link", { name: "Workout", exact: true }).click();
  await expect(page).toHaveURL(/\/workout$/);
  await expect(page.getByRole("heading", { name: workoutHeading, exact: true })).toBeVisible();

  await nav.getByRole("link", { name: "Diet", exact: true }).click();
  await expect(page).toHaveURL(/\/diet$/);
  await expect(page.getByRole("heading", { name: `Diet · ${date}`, exact: true })).toBeVisible();

  await nav.getByRole("link", { name: "Body", exact: true }).click();
  await expect(page).toHaveURL(/\/body$/);
  await expect(page.getByRole("heading", { name: "Body metrics", exact: true })).toBeVisible();

  await nav.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  await nav.getByRole("link", { name: "Today", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
});

test("PWA manifest is linked and serves valid JSON", async ({ page }) => {
  await page.goto("/login");
  const link = page.locator('link[rel="manifest"]');
  await expect(link).toHaveCount(1);
  const href = await link.getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  const manifest = JSON.parse(await res.text());
  expect(manifest.name).toBe("Reforge");
  expect(manifest.short_name).toBe("Reforge");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  expect(manifest.icons).toHaveLength(2);
});
