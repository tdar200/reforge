import { afterAll, beforeAll, describe, expect, it, test } from "vitest";
import { and, gte, lte } from "drizzle-orm";
import { SignJWT } from "jose";
import { db } from "@/lib/db";
import { bodyMetrics, workoutSessions } from "@/lib/db/schema";
import { api, loginCookie } from "./helpers";

// Assigned date range for this suite: 2030-05-06 .. 2030-05-10 only
// (the e2e gaps suite owns other days of 2030-05; keep the ranges disjoint).
const RANGE_LO = "2030-05-06";
const RANGE_HI = "2030-05-10";
const D_RACE = "2030-05-07";
const D_METRIC = "2030-05-08";
const D_EMPTY = "2030-05-09";
const DAY_TYPE = "gaps-race-suite";

type SessionRow = { id: number; date: string; dayType: string; notes: string | null };
type MetricRow = { id: number; date: string; bodyweight: number | null };

let cookie: string;

async function cleanupRange() {
  // No delete endpoints for sessions/metrics: direct scoped deletes, owned range only.
  await db.delete(bodyMetrics).where(and(gte(bodyMetrics.date, RANGE_LO), lte(bodyMetrics.date, RANGE_HI)));
  // cascades set_logs via FK onDelete (none created here)
  await db.delete(workoutSessions).where(and(gte(workoutSessions.date, RANGE_LO), lte(workoutSessions.date, RANGE_HI)));
}

beforeAll(async () => {
  cookie = await loginCookie();
  await cleanupRange(); // idempotent reruns
});

afterAll(async () => {
  await cleanupRange();
});

describe("GET /api/diet date param validation", () => {
  it("malformed date → 400 (BUG: currently 500, raw param hits the Postgres date cast; /api/sessions validates, /api/diet does not)", async () => {
    const res = await api("/api/diet?date=not-a-date", { cookie });
    expect(res.status).toBe(400);
  });

  it("valid unused date → 200 []", async () => {
    const res = await api(`/api/diet?date=${D_EMPTY}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
  });
});

describe("DELETE /api/diet/:id id validation", () => {
  it("non-numeric id → 400 (BUG: currently 500, Number('not-a-number') = NaN reaches drizzle/Postgres)", async () => {
    const res = await api("/api/diet/not-a-number", { method: "DELETE", cookie });
    expect(res.status).toBe(400);
  });
});

describe("auth: expired session JWT", () => {
  const sign = (expSecondsFromNow: number) =>
    new SignJWT({ ok: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) + expSecondsFromNow)
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET!));

  test("expired token signed with the real SESSION_SECRET → 401", async () => {
    const expired = await sign(-60);
    const res = await api("/api/exercises", { cookie: `reforge_session=${expired}` });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "unauthorized" });
  });

  test("control: same signer, exp in the future → 200 (the 401 above is the exp check)", async () => {
    const valid = await sign(3600);
    const res = await api("/api/exercises", { cookie: `reforge_session=${valid}` });
    expect(res.status).toBe(200);
  });
});

describe("concurrent same-date writes (README select-then-insert race, no unique index on date)", () => {
  test("two concurrent POST /api/sessions for one date: both 2xx; 1 or 2 rows persist", async () => {
    const post = () => api("/api/sessions", { method: "POST", cookie, body: { date: D_RACE, dayType: DAY_TYPE } });
    const [a, b] = await Promise.all([post(), post()]);

    expect([200, 201]).toContain(a.status);
    expect([200, 201]).toContain(b.status);
    expect([a.status, b.status]).toContain(201); // at least one insert
    for (const r of [a.json as SessionRow, b.json as SessionRow]) {
      expect(r).toMatchObject({ date: D_RACE, dayType: DAY_TYPE });
      expect(typeof r.id).toBe("number");
    }

    const list = await api(`/api/sessions?date=${D_RACE}`, { cookie });
    expect(list.status).toBe(200);
    const rows = list.json as SessionRow[];
    // Documented race: both selects can miss, then both insert. 1 row = one request
    // saw the other's insert; 2 rows = the duplicate-session outcome the README accepts.
    expect([1, 2]).toContain(rows.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) expect(r).toMatchObject({ date: D_RACE, dayType: DAY_TYPE });
    const returnedIds = new Set([(a.json as SessionRow).id, (b.json as SessionRow).id]);
    for (const id of returnedIds) expect(rows.map((r) => r.id)).toContain(id);
  });

  test("two concurrent metric-bearing POST /api/ai/commit for one date: both 201; 1 or 2 metric rows persist", async () => {
    const commit = (value: number) =>
      api("/api/ai/commit", {
        method: "POST", cookie,
        body: { date: D_METRIC, items: [{ kind: "metric", field: "bodyweight", value }] },
      });
    const [a, b] = await Promise.all([commit(80.1), commit(80.2)]);

    for (const r of [a, b]) {
      expect(r.status).toBe(201);
      expect(r.json).toEqual({ created: { sets: 0, cardio: 0, meals: 0, metrics: 1 } });
    }

    const res = await api("/api/metrics", { cookie });
    expect(res.status).toBe(200);
    const rows = (res.json as MetricRow[]).filter((r) => r.date === D_METRIC);
    // Same race on body_metrics: 1 row = second commit updated in place,
    // 2 rows = both inserted. Every surviving value came from these two writes.
    expect([1, 2]).toContain(rows.length);
    for (const r of rows) expect([80.1, 80.2]).toContain(r.bodyweight);
    if (rows.length === 1) expect([80.1, 80.2]).toContain(rows[0].bodyweight);
  });
});
