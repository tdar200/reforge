import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { aiUnavailable } from "@/lib/ai/model";
import { resolveMacros } from "@/lib/ai/estimate";

// Trimmed: a whitespace-only name carries nothing to estimate from.
const Body = z.object({ name: z.string().trim().min(1).max(120) });

export async function POST(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  const unavailable = aiUnavailable(); if (unavailable) return unavailable;
  try {
    return Response.json(await resolveMacros(parsed.data.name));
  } catch (err) {
    console.error("meal estimate failed", err);
    return Response.json({ error: "estimate_failed" }, { status: 502 });
  }
}
