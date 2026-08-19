import { beforeAll, expect, test } from "vitest";
beforeAll(() => { process.env.SESSION_SECRET = "test-secret-please-change-1234567890"; });
import { createSessionToken, verifySessionToken } from "../auth";

test("valid token verifies", async () => {
  const t = await createSessionToken();
  expect(await verifySessionToken(t)).toBe(true);
});
test("garbage token fails", async () => {
  expect(await verifySessionToken("nope")).toBe(false);
  expect(await verifySessionToken(undefined)).toBe(false);
});
