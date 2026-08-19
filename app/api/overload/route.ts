import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workoutSessions, setLogs } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { lastSetsByExercise } from "@/lib/overload";

export async function GET(req: Request) {
  const unauth = await requireAuth(req); if (unauth) return unauth;
  const url = new URL(req.url);
  const dayType = url.searchParams.get("dayType")!;
  const date = url.searchParams.get("date")!;
  const rows = await db
    .select({
      exerciseId: setLogs.exerciseId, sessionDate: workoutSessions.date,
      weight: setLogs.weight, reps: setLogs.reps, setNumber: setLogs.setNumber,
    })
    .from(setLogs)
    .innerJoin(workoutSessions, eq(setLogs.sessionId, workoutSessions.id))
    .where(eq(workoutSessions.dayType, dayType));
  return Response.json(lastSetsByExercise(rows, date));
}
