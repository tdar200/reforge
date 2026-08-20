import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dietEntries } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { DietEntryInput } from "@/lib/validation";

export async function GET(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const date = new URL(req.url).searchParams.get("date");
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "bad request" }, { status: 400 });
  const rows = date
    ? await db.select().from(dietEntries).where(eq(dietEntries.date, date))
    : await db.select().from(dietEntries);
  return Response.json(rows);
}
export async function POST(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const parsed = DietEntryInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  const [row] = await db.insert(dietEntries).values(parsed.data).returning();
  return Response.json(row, { status: 201 });
}
