import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { and, gte, lte, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { workoutSessions, dietEntries, cardioLogs, bodyMetrics, coachReviews } from "@/lib/db/schema";
import { dayTypeForDate } from "@/lib/logic";
import { ParsedLog } from "@/lib/ai/schemas";
import { api, loginCookie } from "./helpers";

// Assigned date range for this suite: 2030-04-01 .. 2030-04-30 only.
const RANGE_START = "2030-04-01";
const RANGE_END = "2030-04-30";
const D_COMMIT = "2030-04-15"; // Mon -> chest_shoulders
const D_MEAL = "2030-04-03";
const D_ATOMIC = "2030-04-04";
const D_REJECT = "2030-04-02";
const D_PARSE = "2030-04-10";

const AI_LIVE = !!process.env.AI_LIVE;

type SessionRow = { id: number; date: string; dayType: string };
type SetRow = { exerciseId: number; setNumber: number; weight: number; reps: number };
type DietRow = { id: number; date: string; name: string; kcal: number; proteinG: number };
type CardioRow = { date: string; type: string; minutes: number };
type MetricRow = { date: string; bodyweight: number | null; waist: number | null; chest: number | null };
type ReviewRow = { id: number; periodStart: string; periodEnd: string; markdown: string };

let cookie: string;
let exerciseId: number;
let unknownExerciseId: number;
const createdReviewIds: number[] = [];

const cardioAt = async (date: string): Promise<CardioRow[]> => {
  const res = await api("/api/cardio", { cookie });
  return (res.json as CardioRow[]).filter((r) => r.date === date);
};
const metricsAt = async (date: string): Promise<MetricRow[]> => {
  const res = await api("/api/metrics", { cookie });
  return (res.json as MetricRow[]).filter((r) => r.date === date);
};
const sessionsAt = async (date: string): Promise<SessionRow[]> => {
  const res = await api(`/api/sessions?date=${date}`, { cookie });
  return res.json as SessionRow[];
};

async function cleanupRange(): Promise<void> {
  // API delete where one exists (diet), direct scoped deletes for the rest.
  for (const d of [D_COMMIT, D_MEAL]) {
    const res = await api(`/api/diet?date=${d}`, { cookie });
    for (const row of (res.json as DietRow[] | null) ?? []) {
      await api(`/api/diet/${row.id}`, { method: "DELETE", cookie });
    }
  }
  await db.delete(dietEntries).where(and(gte(dietEntries.date, RANGE_START), lte(dietEntries.date, RANGE_END)));
  await db.delete(cardioLogs).where(and(gte(cardioLogs.date, RANGE_START), lte(cardioLogs.date, RANGE_END)));
  await db.delete(bodyMetrics).where(and(gte(bodyMetrics.date, RANGE_START), lte(bodyMetrics.date, RANGE_END)));
  // cascades set_logs via FK onDelete
  await db.delete(workoutSessions).where(and(gte(workoutSessions.date, RANGE_START), lte(workoutSessions.date, RANGE_END)));
  if (createdReviewIds.length) await db.delete(coachReviews).where(inArray(coachReviews.id, createdReviewIds));
}

beforeAll(async () => {
  cookie = await loginCookie();
  await cleanupRange(); // idempotent reruns
  const res = await api("/api/exercises", { cookie });
  expect(res.status).toBe(200);
  const exs = res.json as { id: number }[];
  expect(exs.length).toBeGreaterThan(0);
  exerciseId = exs[0].id;
  unknownExerciseId = Math.max(...exs.map((e) => e.id)) + 999;
});

afterAll(async () => {
  await cleanupRange();
});

describe("POST /api/ai/commit", () => {
  test("401 without the session cookie", async () => {
    const res = await api("/api/ai/commit", {
      method: "POST",
      body: { date: D_COMMIT, items: [{ kind: "cardio", type: "bike", minutes: 10 }] },
    });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "unauthorized" });
  });

  test("400 on malformed bodies", async () => {
    for (const body of [
      {},
      { date: D_COMMIT },
      { items: [{ kind: "cardio", type: "bike", minutes: 10 }] },
      { date: "2030-4-15", items: [{ kind: "cardio", type: "bike", minutes: 10 }] },
      { date: D_COMMIT, items: [{ kind: "nap", minutes: 60 }] },
      { date: D_COMMIT, items: [{ kind: "set", exerciseId: 1, exerciseName: "Bench", sets: 3, reps: 8, weight: 501 }] },
      { date: D_COMMIT, items: "bench 3x8" },
      null,
    ]) {
      const res = await api("/api/ai/commit", { method: "POST", body, cookie });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "bad request" });
    }
  });

  test("400 on empty items", async () => {
    const res = await api("/api/ai/commit", { method: "POST", body: { date: D_COMMIT, items: [] }, cookie });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });

  test("400 on more than 40 items", async () => {
    const items = Array.from({ length: 41 }, () => ({ kind: "cardio", type: "bike", minutes: 5 }));
    const res = await api("/api/ai/commit", { method: "POST", body: { date: D_COMMIT, items }, cookie });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });

  test("400 unresolved_exercise for a set with exerciseId null, and writes nothing", async () => {
    const res = await api("/api/ai/commit", {
      method: "POST",
      body: {
        date: D_REJECT,
        items: [
          { kind: "set", exerciseId: null, exerciseName: "Mystery Press", sets: 3, reps: 8, weight: 60 },
          { kind: "cardio", type: "bike", minutes: 15 },
        ],
      },
      cookie,
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "unresolved_exercise" });
    expect(await sessionsAt(D_REJECT)).toEqual([]);
    expect(await cardioAt(D_REJECT)).toEqual([]);
  });

  test("201 happy path commits sets/cardio/meal/metric in one call, verifiable via the read APIs", async () => {
    const res = await api("/api/ai/commit", {
      method: "POST",
      body: {
        date: D_COMMIT,
        items: [
          { kind: "set", exerciseId, exerciseName: "Bench", sets: 3, reps: 8, weight: 60 },
          { kind: "cardio", type: "bike", minutes: 20 },
          { kind: "meal", name: "Test meal", kcal: 500, proteinG: 40, presetId: null, estimated: true },
          { kind: "metric", field: "bodyweight", value: 79.6 },
        ],
      },
      cookie,
    });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ created: { sets: 3, cardio: 1, meals: 1, metrics: 1 } });

    const sessions = await sessionsAt(D_COMMIT);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].dayType).toBe(dayTypeForDate(D_COMMIT));

    const setsRes = await api(`/api/sessions/${sessions[0].id}`, { cookie });
    expect(setsRes.status).toBe(200);
    const sets = (setsRes.json as SetRow[]).sort((a, b) => a.setNumber - b.setNumber);
    expect(sets).toHaveLength(3);
    expect(sets.map((s) => s.setNumber)).toEqual([1, 2, 3]);
    for (const s of sets) expect(s).toMatchObject({ exerciseId, weight: 60, reps: 8 });

    const dietRes = await api(`/api/diet?date=${D_COMMIT}`, { cookie });
    const diet = dietRes.json as DietRow[];
    expect(diet).toHaveLength(1);
    expect(diet[0]).toMatchObject({ date: D_COMMIT, name: "Test meal", kcal: 500, proteinG: 40 });

    const cardio = await cardioAt(D_COMMIT);
    expect(cardio).toHaveLength(1);
    expect(cardio[0]).toMatchObject({ type: "bike", minutes: 20 });

    const metrics = await metricsAt(D_COMMIT);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ bodyweight: 79.6, waist: null });
  });

  test("second commit on the same date reuses the session, continues set numbers, updates the metric row", async () => {
    const res = await api("/api/ai/commit", {
      method: "POST",
      body: {
        date: D_COMMIT,
        items: [
          { kind: "set", exerciseId, exerciseName: "Bench", sets: 2, reps: 6, weight: 62.5 },
          { kind: "metric", field: "waist", value: 98 },
        ],
      },
      cookie,
    });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ created: { sets: 2, cardio: 0, meals: 0, metrics: 1 } });

    const sessions = await sessionsAt(D_COMMIT);
    expect(sessions).toHaveLength(1); // reused, not duplicated

    const setsRes = await api(`/api/sessions/${sessions[0].id}`, { cookie });
    const sets = (setsRes.json as SetRow[]).sort((a, b) => a.setNumber - b.setNumber);
    expect(sets.map((s) => s.setNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(sets[3]).toMatchObject({ weight: 62.5, reps: 6 });
    expect(sets[4]).toMatchObject({ weight: 62.5, reps: 6 });

    const metrics = await metricsAt(D_COMMIT);
    expect(metrics).toHaveLength(1); // updated in place, no second row
    expect(metrics[0]).toMatchObject({ bodyweight: 79.6, waist: 98 });
  });

  test("meal with a presetId not in the catalogue commits with its inline macros (commit never reads presetId)", async () => {
    const res = await api("/api/ai/commit", {
      method: "POST",
      body: { date: D_MEAL, items: [{ kind: "meal", name: "Ghost preset meal", kcal: 321, proteinG: 21, presetId: 99999999, estimated: false }] },
      cookie,
    });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ created: { sets: 0, cardio: 0, meals: 1, metrics: 0 } });
    const dietRes = await api(`/api/diet?date=${D_MEAL}`, { cookie });
    const diet = dietRes.json as DietRow[];
    expect(diet).toHaveLength(1);
    expect(diet[0]).toMatchObject({ name: "Ghost preset meal", kcal: 321, proteinG: 21 });
  });

  test("a batch that fails mid-write rolls back atomically (set with unknown numeric exerciseId)", async () => {
    const res = await api("/api/ai/commit", {
      method: "POST",
      body: {
        date: D_ATOMIC,
        items: [
          { kind: "cardio", type: "row", minutes: 12 },
          { kind: "set", exerciseId: unknownExerciseId, exerciseName: "Bench", sets: 1, reps: 8, weight: 60 },
        ],
      },
      cookie,
    });
    // Out-of-contract id: not the 400 unresolved_exercise path; FK violation surfaces as a server error.
    expect(res.status).toBeGreaterThanOrEqual(500);
    // Atomicity: the cardio row from the same batch must not persist.
    expect(await cardioAt(D_ATOMIC)).toEqual([]);
    const sessions = await sessionsAt(D_ATOMIC);
    if (sessions[0]) {
      const setsRes = await api(`/api/sessions/${sessions[0].id}`, { cookie });
      expect(setsRes.json).toEqual([]);
    }
  });
});

describe("POST /api/ai/parse", () => {
  test("401 without the session cookie", async () => {
    const res = await api("/api/ai/parse", { method: "POST", body: { text: "bench 3x8 at 60", date: D_PARSE } });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "unauthorized" });
  });

  test("400 on malformed bodies", async () => {
    for (const body of [
      {},
      { text: "bench 3x8", date: "2030/04/10" },
      { text: "", date: D_PARSE },
      { text: "x".repeat(1001), date: D_PARSE },
      { date: D_PARSE },
      null,
    ]) {
      const res = await api("/api/ai/parse", { method: "POST", body, cookie });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "bad request" });
    }
  });

  test.runIf(AI_LIVE)("live: returns typed proposals for 'bench 3x8 at 60, weight 79.6'", async () => {
    const res = await api("/api/ai/parse", { method: "POST", body: { text: "bench 3x8 at 60, weight 79.6", date: D_PARSE }, cookie });
    expect(res.status).toBe(200);
    const parsed = ParsedLog.parse(res.json); // typed against the app schema
    const set = parsed.items.find((i) => i.kind === "set");
    expect(set).toMatchObject({ kind: "set", sets: 3, reps: 8, weight: 60 });
    const metric = parsed.items.find((i) => i.kind === "metric");
    expect(metric).toEqual({ kind: "metric", field: "bodyweight", value: 79.6 });
  }, 120_000);
});

describe("/api/ai/review", () => {
  test("401 without the session cookie (GET and POST)", async () => {
    // Note: POST /api/ai/review reads no request body, so there is no malformed-body 400 in its contract.
    const get = await api("/api/ai/review");
    expect(get.status).toBe(401);
    expect(get.json).toEqual({ error: "unauthorized" });
    const post = await api("/api/ai/review", { method: "POST" });
    expect(post.status).toBe(401);
    expect(post.json).toEqual({ error: "unauthorized" });
  });

  test.runIf(AI_LIVE)("live: POST stores a review and GET returns it", async () => {
    const post = await api("/api/ai/review", { method: "POST", cookie });
    expect(post.status).toBe(201);
    const row = post.json as ReviewRow;
    createdReviewIds.push(row.id);
    expect(row.markdown.length).toBeGreaterThan(0);
    expect(row.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const days = (Date.parse(row.periodEnd) - Date.parse(row.periodStart)) / 86_400_000;
    expect(days).toBe(13); // 14-day window

    const get = await api("/api/ai/review", { cookie });
    expect(get.status).toBe(200);
    expect((get.json as ReviewRow).id).toBe(row.id);
    expect((get.json as ReviewRow).markdown).toBe(row.markdown);
  }, 180_000);
});
