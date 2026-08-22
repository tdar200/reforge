import { createOpenAI } from "@ai-sdk/openai";

export const MODEL_ID = "gpt-5-mini";

export function aiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** 503 response when the AI key is missing; null when configured. Call first in every AI route. */
export function aiUnavailable(): Response | null {
  if (aiConfigured()) return null;
  return Response.json({ error: "ai_not_configured" }, { status: 503 });
}

/** Built lazily so importing this module never requires the key. */
export function getModel() {
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai(MODEL_ID);
}

/**
 * Knobs for short recall-style calls that sit in front of an interactive action.
 * Provider-specific by nature, so it lives behind the seam with everything else
 * vendor-shaped: callers ask for "fast", not for an OpenAI setting.
 */
export const FAST_CALL_OPTIONS = { openai: { reasoningEffort: "low" } } as const;
