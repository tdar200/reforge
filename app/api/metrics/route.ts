import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { bodyMetrics } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { BodyMetricInput } from "@/lib/validation";

export async function GET(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  return Response.json(await db.select().from(bodyMetrics).orderBy(asc(bodyMetrics.date)));
}
export async function POST(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const parsed = BodyMetricInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  const [row] = await db.insert(bodyMetrics).values(parsed.data).returning();
  return Response.json(row, { status: 201 });
}
