import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { setLogs, workoutSessions } from "@/lib/db/schema";
import { api, loginCookie } from "./helpers";

// Assigned date range: 2030-01-01 .. 2030-01-31 only.
const RANGE_FROM = "2030-01-01";
const RANGE_TO = "2030-01-31";
const DATE_A = "2030-01-05";
const DATE_B = "2030-01-10";
const DATE_CURRENT = "2030-01-15";
const DAY_TYPE = "wint-suite";

type Session = { id: number; date: string; dayType: string; notes: string | null };
type SetRow = {
  id: number; sessionId: number; exerciseId: number;
  setNumber: number; weight: number; reps: number; completedAt: string;
};

let cookie: string;
let exA: number;
let exB: number;
let sessionA: Session;
let sessionB: Session;

async function cleanRange() {
  const rows = await db
    .select({ id: workoutSessions.id })
    .from(workoutSessions)
    .where(and(gte(workoutSessions.date, RANGE_FROM), lte(workoutSessions.date, RANGE_TO)));
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await db.delete(setLogs).where(inArray(setLogs.sessionId, ids));
    await db.delete(workoutSessions).where(inArray(workoutSessions.id, ids));
  }
}

beforeAll(async () => {
  cookie = await loginCookie();
  await cleanRange(); // idempotent: clear leftovers in our range from prior runs
  const ex = await api("/api/exercises", { cookie });
  expect(ex.status).toBe(200);
  const list = ex.json as { id: number }[];
  expect(list.length).toBeGreaterThanOrEqual(2);
  exA = list[0].id;
  exB = list[1].id;
});

afterAll(async () => {
  await cleanRange();
});

describe("auth", () => {
  it("POST /api/sessions without cookie → 401", async () => {
    const res = await api("/api/sessions", { method: "POST", body: { date: DATE_A, dayType: DAY_TYPE } });
    expect(res.status).toBe(401);
  });

  it("POST /api/sets without cookie → 401", async () => {
    const res = await api("/api/sets", {
      method: "POST",
      body: { sessionId: 1, exerciseId: 1, setNumber: 1, weight: 50, reps: 8 },
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/overload without cookie → 401", async () => {
    const res = await api(`/api/overload?dayType=${DAY_TYPE}&date=${DATE_CURRENT}`);
    expect(res.status).toBe(401);
  });
});

describe("sessions", () => {
  it("POST /api/sessions creates a session → 201 with the row", async () => {
    const res = await api("/api/sessions", {
      method: "POST", cookie,
      body: { date: DATE_A, dayType: DAY_TYPE },
    });
    expect(res.status).toBe(201);
    sessionA = res.json as Session;
    expect(sessionA).toMatchObject({ date: DATE_A, dayType: DAY_TYPE, notes: null });
    expect(typeof sessionA.id).toBe("number");
  });

  it("GET /api/sessions?date= returns exactly the created session", async () => {
    const res = await api(`/api/sessions?date=${DATE_A}`, { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as Session[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: sessionA.id, date: DATE_A, dayType: DAY_TYPE, notes: null });
  });

  it("POST for an existing date → 200 with the existing row (dayType NOT overwritten)", async () => {
    const res = await api("/api/sessions", {
      method: "POST", cookie,
      body: { date: DATE_A, dayType: "some-other-day-type" },
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: sessionA.id, date: DATE_A, dayType: DAY_TYPE, notes: null });
  });

  it("POST accepts notes and second date → 201", async () => {
    const res = await api("/api/sessions", {
      method: "POST", cookie,
      body: { date: DATE_B, dayType: DAY_TYPE, notes: "heavier day" },
    });
    expect(res.status).toBe(201);
    sessionB = res.json as Session;
    expect(sessionB).toMatchObject({ date: DATE_B, dayType: DAY_TYPE, notes: "heavier day" });
  });

  it.each([
    ["empty body", {}],
    ["missing dayType", { date: DATE_A }],
    ["empty dayType", { date: DATE_A, dayType: "" }],
    ["non-ISO date", { date: "2030-1-5", dayType: DAY_TYPE }],
    ["date as number", { date: 20300105, dayType: DAY_TYPE }],
    ["notes wrong type", { date: DATE_A, dayType: DAY_TYPE, notes: 123 }],
    ["non-object body", "just a string"],
  ])("POST invalid payload (%s) → 400", async (_label, body) => {
    const res = await api("/api/sessions", { method: "POST", cookie, body });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });
});

describe("sets", () => {
  const planA = () => [
    { exerciseId: exA, setNumber: 1, weight: 60, reps: 8 },
    { exerciseId: exA, setNumber: 2, weight: 60, reps: 8 },
    { exerciseId: exB, setNumber: 1, weight: 40, reps: 10 },
  ];
  const planB = () => [
    { exerciseId: exA, setNumber: 1, weight: 62.5, reps: 8 },
    { exerciseId: exA, setNumber: 2, weight: 62.5, reps: 7 },
    { exerciseId: exB, setNumber: 1, weight: 42.5, reps: 10 },
  ];

  it("POST /api/sets logs sets on both sessions → 201 each with full row", async () => {
    for (const [sessionId, plan] of [[sessionA.id, planA()], [sessionB.id, planB()]] as const) {
      for (const s of plan) {
        const res = await api("/api/sets", { method: "POST", cookie, body: { sessionId, ...s } });
        expect(res.status).toBe(201);
        const row = res.json as SetRow;
        expect(row).toMatchObject({ sessionId, ...s });
        expect(typeof row.id).toBe("number");
        expect(typeof row.completedAt).toBe("string");
      }
    }
  });

  it("GET /api/sessions/<id> returns that session's sets", async () => {
    const res = await api(`/api/sessions/${sessionA.id}`, { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as SetRow[];
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.sessionId).toBe(sessionA.id);
    const key = (r: { exerciseId: number; setNumber: number }) => `${r.exerciseId}:${r.setNumber}`;
    const got = rows
      .map((r) => ({ exerciseId: r.exerciseId, setNumber: r.setNumber, weight: r.weight, reps: r.reps }))
      .sort((a, b) => key(a).localeCompare(key(b)));
    const want = planA()
      .map((s) => ({ ...s }))
      .sort((a, b) => key(a).localeCompare(key(b)));
    expect(got).toEqual(want);
  });

  it("GET /api/sessions/<nonexistent numeric id> → 200 []", async () => {
    const res = await api("/api/sessions/9999999", { cookie });
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
  });

  it("GET /api/sessions/<non-numeric id> → 400 (BUG: currently 500, NaN reaches the DB)", async () => {
    const res = await api("/api/sessions/not-a-number", { cookie });
    expect(res.status).toBe(400);
  });

  it.each([
    ["empty body", {}],
    ["setNumber 0", () => ({ sessionId: sessionA.id, exerciseId: exA, setNumber: 0, weight: 50, reps: 8 })],
    ["negative weight", () => ({ sessionId: sessionA.id, exerciseId: exA, setNumber: 1, weight: -1, reps: 8 })],
    ["non-int reps", () => ({ sessionId: sessionA.id, exerciseId: exA, setNumber: 1, weight: 50, reps: 8.5 })],
    ["negative reps", () => ({ sessionId: sessionA.id, exerciseId: exA, setNumber: 1, weight: 50, reps: -1 })],
    ["sessionId as string", () => ({ sessionId: "1", exerciseId: exA, setNumber: 1, weight: 50, reps: 8 })],
    ["missing exerciseId", () => ({ sessionId: sessionA.id, setNumber: 1, weight: 50, reps: 8 })],
    ["non-int exerciseId", () => ({ sessionId: sessionA.id, exerciseId: 1.5, setNumber: 1, weight: 50, reps: 8 })],
  ])("POST invalid set payload (%s) → 400", async (_label, body) => {
    const res = await api("/api/sets", {
      method: "POST", cookie,
      body: typeof body === "function" ? body() : body,
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });

  it("POST with unknown exerciseId → 400 (BUG: currently 500, FK violation unhandled)", async () => {
    const res = await api("/api/sets", {
      method: "POST", cookie,
      body: { sessionId: sessionA.id, exerciseId: 9999999, setNumber: 1, weight: 50, reps: 8 },
    });
    expect(res.status).toBe(400);
  });
});

describe("overload", () => {
  it("returns last-session sets per exercise for a later date", async () => {
    const res = await api(`/api/overload?dayType=${DAY_TYPE}&date=${DATE_CURRENT}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      [exA]: [
        { weight: 62.5, reps: 8, setNumber: 1 },
        { weight: 62.5, reps: 7, setNumber: 2 },
      ],
      [exB]: [{ weight: 42.5, reps: 10, setNumber: 1 }],
    });
  });

  it("excludes the current date itself (strictly prior sessions only)", async () => {
    const res = await api(`/api/overload?dayType=${DAY_TYPE}&date=${DATE_B}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      [exA]: [
        { weight: 60, reps: 8, setNumber: 1 },
        { weight: 60, reps: 8, setNumber: 2 },
      ],
      [exB]: [{ weight: 40, reps: 10, setNumber: 1 }],
    });
  });

  it("no prior sessions → {}", async () => {
    const res = await api(`/api/overload?dayType=${DAY_TYPE}&date=${DATE_A}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({});
  });

  it("unknown dayType → {}", async () => {
    const res = await api(`/api/overload?dayType=zz-no-such-day&date=${DATE_CURRENT}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({});
  });

  it("missing params degrade to 200 {}", async () => {
    const res = await api("/api/overload", { cookie });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({});
  });
});

describe("date param validation", () => {
  it("GET /api/sessions with malformed date → 400 (BUG: currently 500, raw param hits Postgres date cast)", async () => {
    const res = await api("/api/sessions?date=not-a-date", { cookie });
    expect(res.status).toBe(400);
  });

  it("GET /api/sessions with valid unused date → 200 []", async () => {
    const res = await api(`/api/sessions?date=${RANGE_TO}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
  });
});
