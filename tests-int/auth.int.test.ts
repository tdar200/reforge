import { describe, expect, test } from "vitest";
import { SignJWT } from "jose";
import { api, loginCookie } from "./helpers";

const BASE = () => process.env.REFORGE_URL || "http://localhost:3100";

const rawLogin = (body?: string) =>
  fetch(`${BASE()}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

describe("POST /api/login", () => {
  test("wrong passcode → 401", async () => {
    const r = await api("/api/login", { method: "POST", body: { passcode: "not-the-passcode" } });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: "wrong passcode" });
  });

  test("missing body → 400", async () => {
    const res = await rawLogin();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad request" });
  });

  test("malformed JSON → 400", async () => {
    const res = await rawLogin("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad request" });
  });

  test("missing passcode key → 400", async () => {
    const r = await api("/api/login", { method: "POST", body: {} });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "bad request" });
  });

  test("non-string passcode → 400", async () => {
    for (const passcode of [123, true, null, ["reforge"]]) {
      const r = await api("/api/login", { method: "POST", body: { passcode } });
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: "bad request" });
    }
  });

  test("correct passcode → 200 ok:true", async () => {
    const r = await api("/api/login", { method: "POST", body: { passcode: process.env.APP_PASSCODE } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
  });

  test("Set-Cookie flags: HttpOnly, SameSite=Lax, Path=/, Max-Age", async () => {
    const res = await rawLogin(JSON.stringify({ passcode: process.env.APP_PASSCODE }));
    expect(res.status).toBe(200);
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/reforge_session=[^;]+/);
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).toContain("Path=/");
    expect(sc).toMatch(/Max-Age=\d+/);
  });
});

describe("session cookie verification (GET /api/exercises)", () => {
  test("valid cookie → 200 (sanity)", async () => {
    const r = await api("/api/exercises", { cookie: await loginCookie() });
    expect(r.status).toBe(200);
  });

  test("absent cookie → 401", async () => {
    const r = await api("/api/exercises");
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: "unauthorized" });
  });

  test("garbage cookie value → 401", async () => {
    const r = await api("/api/exercises", { cookie: "reforge_session=garbage.not.a-jwt" });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: "unauthorized" });
  });

  test("tampered payload on a real token → 401", async () => {
    const cookie = await loginCookie();
    const jwt = cookie.slice("reforge_session=".length);
    const [h, p, s] = jwt.split(".");
    const flipped = (p[0] === "a" ? "b" : "a") + p.slice(1);
    const r = await api("/api/exercises", { cookie: `reforge_session=${h}.${flipped}.${s}` });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: "unauthorized" });
  });

  test("JWT signed with the wrong secret → 401", async () => {
    const wrongSecret = crypto.getRandomValues(new Uint8Array(32));
    const forged = await new SignJWT({ ok: true })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("365d")
      .sign(wrongSecret);
    const r = await api("/api/exercises", { cookie: `reforge_session=${forged}` });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: "unauthorized" });
  });
});

// Every exported method of every protected route file. Single source of truth
// that no endpoint is accidentally public.
const MATRIX: [string, string][] = [
  ["GET", "/api/sessions"],
  ["POST", "/api/sessions"],
  ["GET", "/api/sessions/1"],
  ["POST", "/api/sets"],
  ["GET", "/api/overload"],
  ["GET", "/api/diet"],
  ["POST", "/api/diet"],
  ["DELETE", "/api/diet/1"],
  ["GET", "/api/cardio"],
  ["POST", "/api/cardio"],
  ["GET", "/api/metrics"],
  ["POST", "/api/metrics"],
  ["GET", "/api/exercises"],
  ["GET", "/api/presets"],
  ["POST", "/api/presets"],
  ["GET", "/api/settings"],
  ["PUT", "/api/settings"],
  ["POST", "/api/ai/parse"],
  ["POST", "/api/ai/commit"],
  ["GET", "/api/ai/review"],
  ["POST", "/api/ai/review"],
  ["POST", "/api/ai/nutrition"],
];

describe("unauth matrix: every protected method → 401 without cookie", () => {
  test.each(MATRIX)("%s %s → 401", async (method, path) => {
    const r = await api(path, { method });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: "unauthorized" });
  });
});
