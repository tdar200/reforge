import { db } from "./index";
import { exercises, foodPresets, workoutSessions, setLogs, dietEntries, cardioLogs, bodyMetrics, coachReviews, settings } from "./schema";
import { SEED_EXERCISES, SEED_SETTINGS } from "./seed-data";
import { generateDemoData } from "./demo-data";
import { todayIso } from "../today";

// Order matters for FKs: sets -> sessions.
await db.delete(setLogs);
await db.delete(workoutSessions);
await db.delete(dietEntries);
await db.delete(cardioLogs);
await db.delete(bodyMetrics);
await db.delete(coachReviews);
await db.delete(foodPresets);
await db.delete(exercises);

const exRows = await db.insert(exercises).values(SEED_EXERCISES).returning();
await db.insert(settings).values(SEED_SETTINGS).onConflictDoUpdate({ target: settings.id, set: { calorieTarget: SEED_SETTINGS.calorieTarget, proteinTarget: SEED_SETTINGS.proteinTarget } });

const demo = generateDemoData(42, todayIso(), exRows);
await db.insert(foodPresets).values(demo.presets);
for (const s of demo.sessions) {
  const [sess] = await db.insert(workoutSessions).values({ date: s.date, dayType: s.dayType }).returning();
  await db.insert(setLogs).values(s.sets.map((x) => ({ ...x, sessionId: sess.id })));
}
await db.insert(dietEntries).values(demo.diet);
await db.insert(cardioLogs).values(demo.cardio);
await db.insert(bodyMetrics).values(demo.metrics);
console.log(`demo seeded: ${demo.sessions.length} sessions, ${demo.diet.length} meals, ${demo.cardio.length} cardio, ${demo.metrics.length} metric days`);
