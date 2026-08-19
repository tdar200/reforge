import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { setLogs, cardioLogs, dietEntries, bodyMetrics } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { aiUnavailable } from "@/lib/ai/model";
import { CommitRequest } from "@/lib/ai/schemas";
import { ensureSession, loadCommitState } from "@/lib/ai/data";
import { planCommit, CommitError } from "@/lib/ai/commit";
import { dayTypeForDate } from "@/lib/logic";

export async function POST(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const unavailable = aiUnavailable(); if (unavailable) return unavailable;
  const parsed = CommitRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  const { date, items } = parsed.data;

  const hasSets = items.some((i) => i.kind === "set");
  if (items.some((i) => i.kind === "set" && i.exerciseId === null)) {
    return Response.json({ error: "unresolved_exercise" }, { status: 400 });
  }
  const sessionId = hasSets ? await ensureSession(date, dayTypeForDate(date)) : null;
  const state = await loadCommitState(date, sessionId);

  let plan;
  try { plan = planCommit(items, state); }
  catch (e) {
    if (e instanceof CommitError) return Response.json({ error: e.code }, { status: 400 });
    throw e;
  }

  // neon-http has no interactive transactions; db.batch runs these atomically.
  const queries = [];
  if (plan.setRows.length) queries.push(db.insert(setLogs).values(plan.setRows));
  if (plan.cardioRows.length) queries.push(db.insert(cardioLogs).values(plan.cardioRows));
  if (plan.mealRows.length) queries.push(db.insert(dietEntries).values(plan.mealRows));
  if (plan.metric?.op === "insert") queries.push(db.insert(bodyMetrics).values(plan.metric.values as typeof bodyMetrics.$inferInsert));
  if (plan.metric?.op === "update") queries.push(db.update(bodyMetrics).set(plan.metric.values).where(eq(bodyMetrics.id, plan.metric.id)));
  if (queries.length) await db.batch(queries as [typeof queries[number], ...typeof queries]);

  return Response.json({ created: plan.counts }, { status: 201 });
}
