import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { coachReviews } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { aiUnavailable } from "@/lib/ai/model";
import { loadReviewInput } from "@/lib/ai/data";
import { buildCoachContext, generateWeeklyReview, periodFor } from "@/lib/ai/review";
import { todayIso } from "@/lib/today";

export async function GET(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const rows = await db.select().from(coachReviews).orderBy(desc(coachReviews.createdAt)).limit(1);
  return Response.json(rows[0] ?? null);
}

export async function POST(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const unavailable = aiUnavailable(); if (unavailable) return unavailable;
  const { periodStart, periodEnd } = periodFor(todayIso());
  try {
    const input = await loadReviewInput(periodStart, periodEnd);
    const markdown = await generateWeeklyReview(buildCoachContext(input));
    const [row] = await db.insert(coachReviews).values({ periodStart, periodEnd, markdown }).returning();
    return Response.json(row, { status: 201 });
  } catch (err) {
    console.error("weekly review failed", err);
    return Response.json({ error: "review_failed" }, { status: 502 });
  }
}
