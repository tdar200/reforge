import { createAnthropic } from "@ai-sdk/anthropic";

export const MODEL_ID = "claude-sonnet-5";

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** 503 response when the AI key is missing; null when configured. Call first in every AI route. */
export function aiUnavailable(): Response | null {
  if (aiConfigured()) return null;
  return Response.json({ error: "ai_not_configured" }, { status: 503 });
}

/** Built lazily so importing this module never requires the key. */
export function getModel() {
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic(MODEL_ID);
}
