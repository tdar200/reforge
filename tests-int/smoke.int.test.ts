import { describe, expect, it } from "vitest";
import { api, loginCookie } from "./helpers";

describe("smoke: auth + sessions", () => {
  it("rejects a wrong passcode with 401", async () => {
    const res = await api("/api/login", { method: "POST", body: { passcode: "nope" } });
    expect(res.status).toBe(401);
  });

  it("accepts the right passcode and sets the session cookie", async () => {
    const cookie = await loginCookie();
    expect(cookie).toMatch(/^reforge_session=.+/);
  });

  it("GET /api/sessions?date=2026-08-20 → 401 bare, 200 with cookie", async () => {
    const bare = await api("/api/sessions?date=2026-08-20");
    expect(bare.status).toBe(401);
    const cookie = await loginCookie();
    const authed = await api("/api/sessions?date=2026-08-20", { cookie });
    expect(authed.status).toBe(200);
    expect(Array.isArray(authed.json)).toBe(true);
  });
});
