import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workoutSessions } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { SessionInput } from "@/lib/validation";

export async function GET(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const date = new URL(req.url).searchParams.get("date");
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "bad request" }, { status: 400 });
  const rows = date
    ? await db.select().from(workoutSessions).where(eq(workoutSessions.date, date))
    : await db.select().from(workoutSessions);
  return Response.json(rows);
}
export async function POST(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const parsed = SessionInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  const existing = await db.select().from(workoutSessions).where(eq(workoutSessions.date, parsed.data.date));
  if (existing[0]) return Response.json(existing[0]);
  const [row] = await db.insert(workoutSessions).values(parsed.data).returning();
  return Response.json(row, { status: 201 });
}
