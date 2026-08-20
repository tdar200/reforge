import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { setLogs } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const { id } = await params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) return Response.json({ error: "bad request" }, { status: 400 });
  const rows = await db.select().from(setLogs).where(eq(setLogs.sessionId, sessionId));
  return Response.json(rows);
}
