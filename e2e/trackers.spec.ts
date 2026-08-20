import { neonConfig } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DAY_LABELS, dayTypeForDate, sumDiet } from "../lib/logic";
import { todayIso } from "../lib/today";

const PASSCODE = process.env.APP_PASSCODE || "reforge-1b3543";
const BASE = process.env.REFORGE_URL || "http://localhost:3100";

type Ex = { id: number; name: string; targetSets: number; repLow: number; repHigh: number; supersetGroup: string | null };
type OverloadSet = { weight: number; reps: number; setNumber: number };
type Preset = { id: number; name: string; kcal: number; proteinG: number };
type DietEntry = { id: number; date: string; name: string; kcal: number; proteinG: number };
type Metric = { id: number; date: string; bodyweight: number | null };
type Settings = { calorieTarget: number; proteinTarget: number };

const date = todayIso();
const dayType = dayTypeForDate(date);

// Rows this suite created; removed in afterAll (API delete where one exists, drizzle otherwise).
const created = {
  setIds: [] as number[],
  sessionId: null as number | null,
  sessionCreated: false,
  dietIds: [] as number[],
  metricIds: [] as number[],
  originalSettings: null as Settings | null,
};

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Passcode").fill(PASSCODE);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page).toHaveURL(/\/$/);
}

// Shared Neon DB blips transiently 5xx; retry before asserting the real status.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  throw last;
}

async function getJson<T>(page: Page, apiPath: string): Promise<T> {
  const res = await withRetry(async () => {
    const r = await page.request.get(apiPath);
    if (r.status() >= 500) throw new Error(`${apiPath} -> ${r.status()}`);
    return r;
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as T;
}


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

test.afterAll(async () => {
  const cookie = await withRetry(async () => {
    const res = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode: PASSCODE }),
    });
    const m = /reforge_session=[^;]+/.exec(res.headers.get("set-cookie") ?? "");
    if (!m) throw new Error(`cleanup login failed: ${res.status}`);
    return m[0];
  });
  for (const id of created.dietIds) {
    await withRetry(() => fetch(`${BASE}/api/diet/${id}`, { method: "DELETE", headers: { Cookie: cookie } }));
  }
  if (created.originalSettings) {
    const body = JSON.stringify({
      calorieTarget: created.originalSettings.calorieTarget,
      proteinTarget: created.originalSettings.proteinTarget,
    });
    await withRetry(() => fetch(`${BASE}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body,
    }));
  }
  // No delete endpoints for sets/sessions/metrics: direct drizzle deletes by captured id, today only.
  if (created.setIds.length || created.metricIds.length || (created.sessionCreated && created.sessionId)) {
    loadDatabaseUrl();
    const { db } = await import("../lib/db");
    const { setLogs, workoutSessions, bodyMetrics } = await import("../lib/db/schema");
    const { and, eq, inArray } = await import("drizzle-orm");
    if (created.setIds.length) await withRetry(() => db.delete(setLogs).where(inArray(setLogs.id, created.setIds)));
    if (created.sessionCreated && created.sessionId) {
      const sid = created.sessionId;
      await withRetry(() => db.delete(workoutSessions).where(and(eq(workoutSessions.id, sid), eq(workoutSessions.date, date))));
    }
    if (created.metricIds.length) await withRetry(() => db.delete(bodyMetrics).where(inArray(bodyMetrics.id, created.metricIds)));
  }
});

test("/workout shows the overload hint for a seeded exercise and logs a set for today", async ({ page }) => {
  test.skip(dayType === "rest", "today is a rest day: no set-logging UI");
  await login(page);
  await page.goto("/workout");
  await expect(page.getByRole("heading", { name: `${DAY_LABELS[dayType]} · ${date}`, exact: true })).toBeVisible();

  const exs = await getJson<Ex[]>(page, `/api/exercises?dayType=${dayType}`);
  const overload = await getJson<Record<string, OverloadSet[]>>(page, `/api/overload?dayType=${dayType}&date=${date}`);
  const seeded = exs.find((e) => (overload[String(e.id)] ?? []).length > 0);
  expect(seeded, "a seeded exercise with prior-session history").toBeDefined();
  const ex = seeded!;

  const card = page.locator("main > div").filter({ hasText: ex.name });
  await expect(card).toHaveCount(1);
  await expect(card.getByText(`${ex.targetSets}×${ex.repLow}-${ex.repHigh}`, { exact: true })).toBeVisible();
  const hint = "Last: " + overload[String(ex.id)].map((s) => `${s.weight}×${s.reps}`).join(", ");
  await expect(card.getByText(hint, { exact: true })).toBeVisible();

  const kg = card.getByPlaceholder("kg").first();
  const reps = card.getByPlaceholder("reps").first();
  await kg.fill("52.5");
  await reps.fill("8");
  const sessionRes = page.waitForResponse((r) => r.url().endsWith("/api/sessions") && r.request().method() === "POST");
  const setRes = page.waitForResponse((r) => r.url().endsWith("/api/sets") && r.request().method() === "POST");
  await card.getByRole("button", { name: "✓" }).first().click();

  const sess = await sessionRes;
  expect([200, 201]).toContain(sess.status());
  const sessJson = (await sess.json()) as { id: number; date: string; dayType: string };
  expect(sessJson.date).toBe(date);
  expect(sessJson.dayType).toBe(dayType);
  created.sessionId = sessJson.id;
  created.sessionCreated = sess.status() === 201;

  const set = await setRes;
  expect(set.status()).toBe(201);
  const setJson = (await set.json()) as { id: number; sessionId: number; exerciseId: number; setNumber: number; weight: number; reps: number };
  created.setIds.push(setJson.id);
  expect(setJson).toMatchObject({ sessionId: sessJson.id, exerciseId: ex.id, setNumber: 1, weight: 52.5, reps: 8 });

  // UI acknowledges the log by clearing the inputs; the row is in today's session.
  await expect(kg).toHaveValue("");
  await expect(reps).toHaveValue("");
  const sessionSets = await getJson<{ id: number; exerciseId: number; setNumber: number; weight: number; reps: number }[]>(page, `/api/sessions/${sessJson.id}`);
  const mine = sessionSets.find((s) => s.id === setJson.id);
  expect(mine).toMatchObject({ exerciseId: ex.id, setNumber: 1, weight: 52.5, reps: 8 });
});

test("/diet adds a meal from a preset and updates the list and totals", async ({ page }) => {
  await login(page);
  await page.goto("/diet");
  await expect(page.getByRole("heading", { name: `Diet · ${date}`, exact: true })).toBeVisible();

  const presets = await getJson<Preset[]>(page, "/api/presets");
  expect(presets.length, "seeded food presets").toBeGreaterThan(0);
  const preset = presets[0];
  const entriesBefore = await getJson<DietEntry[]>(page, `/api/diet?date=${date}`);
  const settings = await getJson<Settings>(page, "/api/settings");
  const before = sumDiet(entriesBefore);
  await expect(page.getByText(`${before.kcal} / ${settings.calorieTarget} kcal`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${Math.round(before.proteinG)} / ${settings.proteinTarget} g protein`, { exact: true })).toBeVisible();

  const rowsForPreset = page.locator("main ul > li").filter({ hasText: preset.name });
  const countBefore = await rowsForPreset.count();

  const postRes = page.waitForResponse((r) => r.url().endsWith("/api/diet") && r.request().method() === "POST");
  await page.getByRole("button", { name: `${preset.name} · ${preset.kcal}kcal`, exact: true }).click();
  const post = await postRes;
  expect(post.status()).toBe(201);
  const entry = (await post.json()) as DietEntry;
  created.dietIds.push(entry.id);
  expect(entry).toMatchObject({ date, name: preset.name, kcal: preset.kcal, proteinG: preset.proteinG });

  await expect(rowsForPreset).toHaveCount(countBefore + 1);
  await expect(rowsForPreset.filter({ hasText: `${preset.kcal}kcal · ${Math.round(preset.proteinG)}g` }).first()).toBeVisible();
  await expect(page.getByText(`${before.kcal + preset.kcal} / ${settings.calorieTarget} kcal`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${Math.round(before.proteinG + preset.proteinG)} / ${settings.proteinTarget} g protein`, { exact: true })).toBeVisible();
});

test("/body logs a weight entry and re-renders the bodyweight trend chart", async ({ page }) => {
  await login(page);
  await page.goto("/body");
  await expect(page.getByRole("heading", { name: "Body metrics", exact: true })).toBeVisible();

  const section = page.locator("main > div").filter({ has: page.locator("h2", { hasText: /^bodyweight$/i }) });
  await expect(section).toHaveCount(1);
  const curve = section.locator("path.recharts-line-curve");
  await expect(curve).toBeVisible();
  const dBefore = await curve.getAttribute("d");
  expect(dBefore).toBeTruthy();

  const weightInput = page.getByPlaceholder("bodyweight");
  await weightInput.fill("80.5");
  const postRes = page.waitForResponse((r) => r.url().endsWith("/api/metrics") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Log today", exact: true }).click();
  const post = await postRes;
  expect(post.status()).toBe(201);
  const metric = (await post.json()) as Metric;
  created.metricIds.push(metric.id);
  expect(metric).toMatchObject({ date, bodyweight: 80.5 });

  await expect(weightInput).toHaveValue("");
  const all = await getJson<Metric[]>(page, "/api/metrics");
  const mine = all.find((m) => m.id === metric.id);
  expect(mine).toMatchObject({ date, bodyweight: 80.5 });
  // The series re-renders with the new point: the line path changes and stays non-empty.
  await expect.poll(async () => (await curve.getAttribute("d")) ?? "").not.toBe(dBefore);
  expect(((await curve.getAttribute("d")) ?? "").length).toBeGreaterThan(0);
});

test("/settings persists a calorie-target change across reload, then restores it", async ({ page }) => {
  await login(page);
  const original = await getJson<Settings>(page, "/api/settings");
  created.originalSettings = { calorieTarget: original.calorieTarget, proteinTarget: original.proteinTarget };
  const changed = original.calorieTarget + 37;

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  const input = page.getByLabel("Calorie target", { exact: true });
  await expect(input).toHaveValue(String(original.calorieTarget));

  async function saveTarget(value: number) {
    await input.fill(String(value));
    const putRes = page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const put = await putRes;
    expect(put.status()).toBe(200);
    expect(await put.json()).toEqual({ ok: true });
    await expect(page.getByRole("button", { name: "Saved ✓", exact: true })).toBeVisible();
  }

  await saveTarget(changed);
  await page.reload();
  await expect(input).toHaveValue(String(changed));
  expect((await getJson<Settings>(page, "/api/settings")).calorieTarget).toBe(changed);
  expect((await getJson<Settings>(page, "/api/settings")).proteinTarget).toBe(original.proteinTarget);

  await saveTarget(original.calorieTarget);
  await page.reload();
  await expect(input).toHaveValue(String(original.calorieTarget));
  expect((await getJson<Settings>(page, "/api/settings")).calorieTarget).toBe(original.calorieTarget);
});
