import { db } from "@/lib/db";
import { setLogs } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { SetLogInput } from "@/lib/validation";

export async function POST(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const parsed = SetLogInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  const [row] = await db.insert(setLogs).values(parsed.data).returning();
  return Response.json(row, { status: 201 });
}
