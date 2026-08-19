import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { exercises } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const dayType = new URL(req.url).searchParams.get("dayType");
  const rows = dayType
    ? await db.select().from(exercises).where(eq(exercises.dayType, dayType)).orderBy(asc(exercises.orderIndex))
    : await db.select().from(exercises).orderBy(asc(exercises.orderIndex));
  return Response.json(rows);
}
