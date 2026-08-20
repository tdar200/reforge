import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { aiUnavailable } from "@/lib/ai/model";
import { loadNutritionContext, saveNutrition } from "@/lib/ai/data";
import { analyzeMeal, NutritionPanel } from "@/lib/ai/nutrition";

const Body = z.object({ entryId: z.number().int().positive() });

/** The jsonb column is only typed at compile time — anything malformed is treated as unanalyzed. */
function storedPanel(value: unknown): NutritionPanel | null {
  if (!value) return null;
  const parsed = NutritionPanel.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function POST(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  const loaded = await loadNutritionContext(parsed.data.entryId);
  if (!loaded) return Response.json({ error: "not_found" }, { status: 404 });
  // Analyzed once, remembered: stored panels are served even without an AI key.
  const stored = storedPanel(loaded.entry.nutrition);
  if (stored) return Response.json({ nutrition: stored });
  const unavailable = aiUnavailable(); if (unavailable) return unavailable;
  try {
    const panel = await analyzeMeal(loaded.ctx);
    if (await saveNutrition(loaded.entry, panel)) return Response.json({ nutrition: panel }, { status: 201 });
    // Lost the race: during the model call the row was deleted, or another request stored a panel.
    const after = await loadNutritionContext(parsed.data.entryId);
    const winner = after && storedPanel(after.entry.nutrition);
    if (winner) return Response.json({ nutrition: winner });
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    console.error("meal nutrition failed", err);
    return Response.json({ error: "nutrition_failed" }, { status: 502 });
  }
}
