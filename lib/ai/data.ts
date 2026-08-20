import { and, asc, eq, gte, lte, inArray } from "drizzle-orm";
import { db } from "../db";
import { exercises, foodPresets, workoutSessions, setLogs, dietEntries, cardioLogs, bodyMetrics, settings } from "../db/schema";
import { lastSetsByExercise } from "../overload";
import { dayTypeForDate } from "../logic";
import type { ParseContext } from "./parse-log";
import type { CommitState } from "./commit";
import type { ReviewInput } from "./review";

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
