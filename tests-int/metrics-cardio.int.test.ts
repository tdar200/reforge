import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, gte, lte } from "drizzle-orm";
import { api, loginCookie } from "./helpers";

// Date range owned by this suite: 2030-03-01 .. 2030-03-31.
const D = (day: number) => `2030-03-${String(day).padStart(2, "0")}`;
const LO = D(1);
const HI = D(31);

let cookie: string;

async function wipeRange() {
  const { db } = await import("@/lib/db");
  const { bodyMetrics, cardioLogs } = await import("@/lib/db/schema");
  await db.delete(bodyMetrics).where(and(gte(bodyMetrics.date, LO), lte(bodyMetrics.date, HI)));
  await db.delete(cardioLogs).where(and(gte(cardioLogs.date, LO), lte(cardioLogs.date, HI)));
}

type MetricRow = {
  id: number; date: string;
  bodyweight: number | null; waist: number | null; chest: number | null; thigh: number | null; arm: number | null;
};
type CardioRow = { id: number; date: string; type: string; minutes: number; notes: string | null };

const inRange = (r: { date: string }) => r.date >= LO && r.date <= HI;
const sortedAsc = (rows: { date: string }[]) =>
  rows.every((r, i) => i === 0 || rows[i - 1].date <= r.date);

beforeAll(async () => {
  cookie = await loginCookie();
  await wipeRange(); // deterministic counts even after a crashed prior run
});

afterAll(async () => {
  await wipeRange(); // no DELETE endpoint exists for metrics/cardio
});

describe("/api/metrics", () => {
  it("GET and POST are 401 without the session cookie", async () => {
    const get = await api("/api/metrics");
    expect(get.status).toBe(401);
    expect(get.json).toEqual({ error: "unauthorized" });
    const post = await api("/api/metrics", { method: "POST", body: { date: D(2), bodyweight: 80 } });
    expect(post.status).toBe(401);
    expect(post.json).toEqual({ error: "unauthorized" });
  });

  it("POST creates a weight+waist metric and echoes the row (201)", async () => {
    const res = await api("/api/metrics", {
      method: "POST", cookie,
      body: { date: D(2), bodyweight: 80.5, waist: 101.6 },
    });
    expect(res.status).toBe(201);
    const row = res.json as MetricRow;
    expect(row.id).toBeTypeOf("number");
    expect(row.date).toBe(D(2));
    expect(row.bodyweight).toBeCloseTo(80.5, 3);
    expect(row.waist).toBeCloseTo(101.6, 3);
    expect(row.chest).toBeNull();
    expect(row.thigh).toBeNull();
    expect(row.arm).toBeNull();
  });

  it("POST with only a date is valid: all measurements nullish (201)", async () => {
    const res = await api("/api/metrics", { method: "POST", cookie, body: { date: D(3) } });
    expect(res.status).toBe(201);
    const row = res.json as MetricRow;
    expect(row.date).toBe(D(3));
    expect(row.bodyweight).toBeNull();
    expect(row.waist).toBeNull();
  });

  it("same-date POSTs duplicate (plain insert, no upsert): two rows, distinct ids", async () => {
    const a = await api("/api/metrics", { method: "POST", cookie, body: { date: D(10), bodyweight: 80 } });
    const b = await api("/api/metrics", { method: "POST", cookie, body: { date: D(10), bodyweight: 81 } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((a.json as MetricRow).id).not.toBe((b.json as MetricRow).id);
    const list = await api("/api/metrics", { cookie });
    expect(list.status).toBe(200);
    const dupes = (list.json as MetricRow[]).filter((r) => r.date === D(10));
    expect(dupes).toHaveLength(2);
    expect(dupes.map((r) => r.bodyweight).sort()).toEqual([80, 81]);
  });

  it("GET lists all rows ascending by date; query params are ignored", async () => {
    const res = await api("/api/metrics?date=garbage&from=not-a-date", { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as MetricRow[];
    const mine = rows.filter(inRange);
    expect(mine.length).toBeGreaterThanOrEqual(4); // D(2), D(3), D(10) x2
    expect(mine.some((r) => r.date === D(2) && r.waist !== null)).toBe(true);
    expect(sortedAsc(rows)).toBe(true);
  });

  it("POST 400 on missing or garbage date", async () => {
    for (const body of [
      { bodyweight: 80 },
      { date: "2030-3-1", bodyweight: 80 },
      { date: "03/01/2030", bodyweight: 80 },
      { date: "not-a-date", bodyweight: 80 },
      { date: 20300301, bodyweight: 80 },
    ]) {
      const res = await api("/api/metrics", { method: "POST", cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json).toEqual({ error: "bad request" });
    }
  });

  it("POST 400 on non-positive or non-numeric measurements", async () => {
    for (const body of [
      { date: D(4), bodyweight: 0 },
      { date: D(4), bodyweight: -80 },
      { date: D(4), waist: 0 },
      { date: D(4), waist: -1 },
      { date: D(4), bodyweight: "80" },
    ]) {
      const res = await api("/api/metrics", { method: "POST", cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json).toEqual({ error: "bad request" });
    }
  });

  it("POST 400 on an empty (non-JSON) body", async () => {
    const res = await api("/api/metrics", { method: "POST", cookie });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad request" });
  });

  it("POST accepts an absurdly large bodyweight (contract has no upper bound) on the range edge", async () => {
    const res = await api("/api/metrics", { method: "POST", cookie, body: { date: HI, bodyweight: 1e12 } });
    expect(res.status).toBe(201);
    expect((res.json as MetricRow).date).toBe(HI);
  });
});

describe("/api/cardio", () => {
  it("GET and POST are 401 without the session cookie", async () => {
    const get = await api("/api/cardio");
    expect(get.status).toBe(401);
    expect(get.json).toEqual({ error: "unauthorized" });
    const post = await api("/api/cardio", { method: "POST", body: { date: D(5), type: "run", minutes: 30 } });
    expect(post.status).toBe(401);
    expect(post.json).toEqual({ error: "unauthorized" });
  });

  it("POST creates a cardio log and echoes it exactly (201)", async () => {
    const res = await api("/api/cardio", {
      method: "POST", cookie,
      body: { date: D(5), type: "run", minutes: 30, notes: "zone 2" },
    });
    expect(res.status).toBe(201);
    const row = res.json as CardioRow;
    expect(row.id).toBeTypeOf("number");
    expect(row.date).toBe(D(5));
    expect(row.type).toBe("run");
    expect(row.minutes).toBe(30);
    expect(row.notes).toBe("zone 2");
  });

  it("POST without notes stores null notes; minutes=1 is the valid minimum (201)", async () => {
    const res = await api("/api/cardio", { method: "POST", cookie, body: { date: D(6), type: "walk", minutes: 1 } });
    expect(res.status).toBe(201);
    const row = res.json as CardioRow;
    expect(row.minutes).toBe(1);
    expect(row.notes).toBeNull();
  });

  it("same-date POSTs duplicate (plain insert, no upsert)", async () => {
    const a = await api("/api/cardio", { method: "POST", cookie, body: { date: D(12), type: "bike", minutes: 20 } });
    const b = await api("/api/cardio", { method: "POST", cookie, body: { date: D(12), type: "bike", minutes: 25 } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((a.json as CardioRow).id).not.toBe((b.json as CardioRow).id);
    const list = await api("/api/cardio", { cookie });
    const dupes = (list.json as CardioRow[]).filter((r) => r.date === D(12));
    expect(dupes.map((r) => r.minutes).sort()).toEqual([20, 25]);
  });

  it("GET lists all rows ascending by date; query params are ignored", async () => {
    const res = await api("/api/cardio?date=nonsense", { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as CardioRow[];
    const mine = rows.filter(inRange);
    expect(mine.length).toBeGreaterThanOrEqual(4); // D(5), D(6), D(12) x2
    expect(mine.some((r) => r.date === D(5) && r.type === "run" && r.minutes === 30)).toBe(true);
    expect(sortedAsc(rows)).toBe(true);
  });

  it("POST 400 on invalid minutes: zero, negative, non-integer, missing", async () => {
    for (const minutes of [0, -5, 1.5, undefined]) {
      const res = await api("/api/cardio", { method: "POST", cookie, body: { date: D(7), type: "run", minutes } });
      expect(res.status, `minutes=${minutes}`).toBe(400);
      expect(res.json).toEqual({ error: "bad request" });
    }
  });

  it("POST 400 on missing or empty type", async () => {
    for (const body of [{ date: D(7), minutes: 10 }, { date: D(7), type: "", minutes: 10 }]) {
      const res = await api("/api/cardio", { method: "POST", cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json).toEqual({ error: "bad request" });
    }
  });

  it("POST 400 on missing/garbage date or empty body", async () => {
    for (const body of [
      { type: "run", minutes: 10 },
      { date: "2030/03/07", type: "run", minutes: 10 },
      { date: "garbage", type: "run", minutes: 10 },
      undefined,
    ]) {
      const res = await api("/api/cardio", { method: "POST", cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json).toEqual({ error: "bad request" });
    }
  });

  it("POST accepts the int4 max for minutes (contract has no upper bound)", async () => {
    const res = await api("/api/cardio", { method: "POST", cookie, body: { date: HI, type: "ultra", minutes: 2147483647 } });
    expect(res.status).toBe(201);
    expect((res.json as CardioRow).minutes).toBe(2147483647);
  });
});
