import { and, asc, eq, gte, isNull, lte, inArray } from "drizzle-orm";
import { db } from "../db";
import { exercises, foodPresets, workoutSessions, setLogs, dietEntries, cardioLogs, bodyMetrics, settings } from "../db/schema";
import { lastSetsByExercise } from "../overload";
import { dayTypeForDate } from "../logic";
import type { ParseContext } from "./parse-log";
import type { CommitState } from "./commit";
import type { ReviewInput } from "./review";
import { macrosUnknown, type NutritionContext, type NutritionPanel } from "./nutrition";

export async function loadParseContext(date: string): Promise<ParseContext> {
  const dayType = dayTypeForDate(date);
  const [exs, presets, setRows] = await Promise.all([
    db.select({ id: exercises.id, name: exercises.name, muscleGroup: exercises.muscleGroup, dayType: exercises.dayType })
      .from(exercises).orderBy(asc(exercises.dayType), asc(exercises.orderIndex)),
    db.select({ id: foodPresets.id, name: foodPresets.name, kcal: foodPresets.kcal, proteinG: foodPresets.proteinG }).from(foodPresets),
    db.select({ exerciseId: setLogs.exerciseId, sessionDate: workoutSessions.date, weight: setLogs.weight, reps: setLogs.reps, setNumber: setLogs.setNumber })
      .from(setLogs).innerJoin(workoutSessions, eq(setLogs.sessionId, workoutSessions.id)),
  ]);
  const last = lastSetsByExercise(setRows, date);
  const lastSets: ParseContext["lastSets"] = {};
  for (const [id, sets] of Object.entries(last)) lastSets[Number(id)] = sets.map((s) => ({ weight: s.weight, reps: s.reps }));
  return { date, dayType, exercises: exs, presets, lastSets };
}

export async function ensureSession(date: string, dayType: string): Promise<number> {
  const existing = await db.select({ id: workoutSessions.id }).from(workoutSessions).where(eq(workoutSessions.date, date));
  if (existing[0]) return existing[0].id;
  const [row] = await db.insert(workoutSessions).values({ date, dayType }).returning({ id: workoutSessions.id });
  return row.id;
}

export async function loadCommitState(date: string, sessionId: number | null): Promise<CommitState> {
  const maxSetByExercise: Record<number, number> = {};
  if (sessionId !== null) {
    const rows = await db.select({ exerciseId: setLogs.exerciseId, setNumber: setLogs.setNumber }).from(setLogs).where(eq(setLogs.sessionId, sessionId));
    for (const r of rows) maxSetByExercise[r.exerciseId] = Math.max(maxSetByExercise[r.exerciseId] ?? 0, r.setNumber);
  }
  const metric = await db.select({ id: bodyMetrics.id }).from(bodyMetrics).where(eq(bodyMetrics.date, date));
  return { date, dayType: dayTypeForDate(date), sessionId, maxSetByExercise, existingMetric: metric[0] ?? null };
}

export async function loadReviewInput(periodStart: string, periodEnd: string): Promise<ReviewInput> {
  const sessions = await db.select({ id: workoutSessions.id, date: workoutSessions.date, dayType: workoutSessions.dayType })
    .from(workoutSessions).where(and(gte(workoutSessions.date, periodStart), lte(workoutSessions.date, periodEnd)));
  const sessionIds = sessions.map((s) => s.id);
  const [sets, diet, cardio, metrics, settingRows] = await Promise.all([
    sessionIds.length
      ? db.select({ sessionId: setLogs.sessionId, exerciseId: setLogs.exerciseId, exerciseName: exercises.name, weight: setLogs.weight, reps: setLogs.reps })
          .from(setLogs).innerJoin(exercises, eq(setLogs.exerciseId, exercises.id)).where(inArray(setLogs.sessionId, sessionIds))
      : Promise.resolve([]),
    db.select({ date: dietEntries.date, kcal: dietEntries.kcal, proteinG: dietEntries.proteinG })
      .from(dietEntries).where(and(gte(dietEntries.date, periodStart), lte(dietEntries.date, periodEnd))),
    db.select({ date: cardioLogs.date, type: cardioLogs.type, minutes: cardioLogs.minutes })
      .from(cardioLogs).where(and(gte(cardioLogs.date, periodStart), lte(cardioLogs.date, periodEnd))),
    db.select({ date: bodyMetrics.date, bodyweight: bodyMetrics.bodyweight, waist: bodyMetrics.waist })
      .from(bodyMetrics).where(and(gte(bodyMetrics.date, periodStart), lte(bodyMetrics.date, periodEnd))),
    db.select().from(settings).where(eq(settings.id, 1)),
  ]);
  const s = settingRows[0];
  return {
    periodStart, periodEnd,
    targets: { kcal: s?.calorieTarget ?? 2000, protein: s?.proteinTarget ?? 170 },
    sessions, sets, diet, cardio, metrics,
  };
}

export type DietEntryRow = typeof dietEntries.$inferSelect;

export async function loadNutritionContext(entryId: number): Promise<{ entry: DietEntryRow; ctx: NutritionContext } | null> {
  const rows = await db.select().from(dietEntries).where(eq(dietEntries.id, entryId));
  const entry = rows[0];
  if (!entry) return null;
  const [dayRows, settingRows] = await Promise.all([
    db.select({ kcal: dietEntries.kcal, proteinG: dietEntries.proteinG }).from(dietEntries).where(eq(dietEntries.date, entry.date)),
    db.select().from(settings).where(eq(settings.id, 1)),
  ]);
  const s = settingRows[0];
  const dayTotals = dayRows.reduce((a, r) => ({ kcal: a.kcal + r.kcal, proteinG: a.proteinG + r.proteinG }), { kcal: 0, proteinG: 0 });
  return {
    entry,
    ctx: {
      // Cap the name: it is user text going into the prompt, and older rows predate the input limit.
      meal: { name: entry.name.slice(0, 120), kcal: entry.kcal, proteinG: entry.proteinG },
      date: entry.date, dayTotals,
      targets: { kcal: s?.calorieTarget ?? 2000, protein: s?.proteinTarget ?? 170 },
    },
  };
}

/**
 * Persists the panel; backfills the row's carbs/fat only where the user left them empty.
 * Guarded on the row still existing and still being unanalyzed, so a delete or a second
 * concurrent analysis during the model call cannot be reported as a successful write.
 * Returns false when nothing matched.
 */
export async function saveNutrition(entry: DietEntryRow, panel: NutritionPanel): Promise<boolean> {
  // Claim the row. Fresh analysis only wins while nutrition is still null, so a concurrent
  // writer cannot be overwritten; re-analysis of an unreadable stored panel heals it in place.
  const claim = entry.nutrition === null
    ? and(eq(dietEntries.id, entry.id), isNull(dietEntries.nutrition))
    : eq(dietEntries.id, entry.id);
  const rows = await db.update(dietEntries)
    .set({
      nutrition: panel,
      carbsG: entry.carbsG ?? panel.macros.carbsG,
      fatG: entry.fatG ?? panel.macros.fatG,
      // A row logged without macros gets the analysis's estimate, so the day's totals stop reading 0.
      ...(macrosUnknown(entry) ? { kcal: panel.macros.kcal, proteinG: panel.macros.proteinG } : {}),
    })
    .where(claim)
    .returning({ id: dietEntries.id });
  return rows.length > 0;
}
