import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dietEntries } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const { id } = await params;
  const entryId = Number(id);
  if (!Number.isInteger(entryId)) return Response.json({ error: "bad request" }, { status: 400 });
  await db.delete(dietEntries).where(eq(dietEntries.id, entryId));
  return Response.json({ ok: true });
}
