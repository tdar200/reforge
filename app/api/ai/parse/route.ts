import { requireAuth } from "@/lib/auth";
import { aiUnavailable } from "@/lib/ai/model";
import { ParseRequest } from "@/lib/ai/schemas";
import { loadParseContext } from "@/lib/ai/data";
import { parseQuickLog } from "@/lib/ai/parse-log";

export async function POST(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const unavailable = aiUnavailable(); if (unavailable) return unavailable;
  const parsed = ParseRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const ctx = await loadParseContext(parsed.data.date);
    const result = await parseQuickLog(parsed.data.text, ctx);
    return Response.json(result);
  } catch (err) {
    console.error("quick-log parse failed", err);
    return Response.json({ error: "parse_failed" }, { status: 502 });
  }
}
