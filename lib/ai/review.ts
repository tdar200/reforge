import { generateText } from "ai";
import { getModel } from "./model";
import { dayTypeForDate } from "../logic";

export type ReviewInput = {
  periodStart: string; periodEnd: string;
  targets: { kcal: number; protein: number };
  sessions: { id: number; date: string; dayType: string }[];
  sets: { sessionId: number; exerciseId: number; exerciseName: string; weight: number; reps: number }[];
  diet: { date: string; kcal: number; proteinG: number }[];
  cardio: { date: string; type: string; minutes: number }[];
  metrics: { date: string; bodyweight: number | null; waist: number | null }[];
};

export type CoachContext = {
  periodStart: string; periodEnd: string;
  targets: { kcal: number; protein: number };
  sessions: { date: string; dayType: string; exercises: { name: string; topSet: { weight: number; reps: number }; sets: number }[] }[];
  dailyNutrition: { date: string; kcal: number; proteinG: number }[];
  cardio: { date: string; type: string; minutes: number }[];
  metrics: { date: string; bodyweight: number | null; waist: number | null }[];
  adherence: { planned: number; done: number };
};

export function periodFor(today: string, days = 14): { periodStart: string; periodEnd: string } {
  const end = new Date(today + "T00:00:00Z");
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - (days - 1));
  return { periodStart: start.toISOString().slice(0, 10), periodEnd: today };
}

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  while (d <= e) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

/** Pure: compresses raw rows into the compact JSON the coach prompt receives. */
export function buildCoachContext(input: ReviewInput): CoachContext {
  const setsBySession = new Map<number, ReviewInput["sets"]>();
  for (const s of input.sets) {
    const arr = setsBySession.get(s.sessionId) ?? [];
    arr.push(s); setsBySession.set(s.sessionId, arr);
  }

  const sessions = [...input.sessions]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((sess) => {
      const byEx = new Map<number, ReviewInput["sets"]>();
      for (const s of setsBySession.get(sess.id) ?? []) {
        const arr = byEx.get(s.exerciseId) ?? [];
        arr.push(s); byEx.set(s.exerciseId, arr);
      }
      const exercises = [...byEx.values()].map((rows) => {
        const top = rows.reduce((best, r) => (r.weight > best.weight || (r.weight === best.weight && r.reps > best.reps) ? r : best), rows[0]);
        return { name: rows[0].exerciseName, topSet: { weight: top.weight, reps: top.reps }, sets: rows.length };
      });
      return { date: sess.date, dayType: sess.dayType, exercises };
    });

  const nutrition = new Map<string, { kcal: number; proteinG: number }>();
  for (const d of input.diet) {
    const cur = nutrition.get(d.date) ?? { kcal: 0, proteinG: 0 };
    nutrition.set(d.date, { kcal: cur.kcal + d.kcal, proteinG: cur.proteinG + d.proteinG });
  }
  const dailyNutrition = [...nutrition.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date));

  const planned = datesBetween(input.periodStart, input.periodEnd).filter((d) => dayTypeForDate(d) !== "rest").length;
  const done = new Set(input.sessions.filter((s) => (setsBySession.get(s.id)?.length ?? 0) > 0).map((s) => s.date)).size;

  return {
    periodStart: input.periodStart, periodEnd: input.periodEnd, targets: input.targets,
    sessions, dailyNutrition,
    cardio: [...input.cardio].sort((a, b) => a.date.localeCompare(b.date)),
    metrics: [...input.metrics].sort((a, b) => a.date.localeCompare(b.date)),
    adherence: { planned, done },
  };
}

export const REVIEW_SYSTEM_PROMPT = [
  "You are a concise, evidence-based strength coach reviewing the last two weeks of a client's training log.",
  "Use ONLY the JSON data provided; do not assume anything that is not in it. Quote actual numbers.",
  "Write markdown under 250 words with exactly these sections as ## headings:",
  "## What went well",
  "## What slipped",
  "## Next week — exactly 3 bullets, each with a concrete number (e.g. 'Bench: 62.5 kg x 8, add 2.5 kg if all sets hit 8').",
  "## One caution",
  "No preamble, no sign-off.",
].join("\n");

export async function generateWeeklyReview(ctx: CoachContext): Promise<string> {
  const result = await generateText({
    model: getModel(),
    system: REVIEW_SYSTEM_PROMPT,
    prompt: JSON.stringify(ctx),
    temperature: 0.3,
    maxOutputTokens: 600,
  });
  return result.text.trim();
}
