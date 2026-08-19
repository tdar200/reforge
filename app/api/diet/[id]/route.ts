import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dietEntries } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const { id } = await params;
  await db.delete(dietEntries).where(eq(dietEntries.id, Number(id)));
  return Response.json({ ok: true });
}
