import { expect, test, afterEach } from "vitest";
import { aiConfigured, aiUnavailable, MODEL_ID } from "../model";

const original = process.env.OPENAI_API_KEY;
afterEach(() => { if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original; });

test("model id is gpt-5-mini", () => { expect(MODEL_ID).toBe("gpt-5-mini"); });

test("aiUnavailable returns 503 when key missing", async () => {
  delete process.env.OPENAI_API_KEY;
  expect(aiConfigured()).toBe(false);
  const res = aiUnavailable();
  expect(res?.status).toBe(503);
  expect(await res!.json()).toEqual({ error: "ai_not_configured" });
});

test("aiUnavailable returns null when key present", () => {
  process.env.OPENAI_API_KEY = "sk-test";
  expect(aiConfigured()).toBe(true);
  expect(aiUnavailable()).toBeNull();
});
