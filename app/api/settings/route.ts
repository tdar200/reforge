import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { SettingsInput } from "@/lib/validation";

export async function GET(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const rows = await db.select().from(settings).where(eq(settings.id, 1));
  return Response.json(rows[0] ?? { id: 1, calorieTarget: 2000, proteinTarget: 170 });
}
export async function PUT(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const parsed = SettingsInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  await db.insert(settings).values({ id: 1, ...parsed.data })
    .onConflictDoUpdate({ target: settings.id, set: parsed.data });
  return Response.json({ ok: true });
}
