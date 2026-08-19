import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { cardioLogs } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { CardioInput } from "@/lib/validation";

export async function GET(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  return Response.json(await db.select().from(cardioLogs).orderBy(asc(cardioLogs.date)));
}
export async function POST(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const parsed = CardioInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  const [row] = await db.insert(cardioLogs).values(parsed.data).returning();
  return Response.json(row, { status: 201 });
}
