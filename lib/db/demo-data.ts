import { dayTypeForDate } from "../logic";

export type DemoExercise = { id: number; name: string; muscleGroup: string; dayType: string; targetSets: number; repLow: number; repHigh: number };
export type DemoData = {
  presets: { name: string; kcal: number; proteinG: number }[];
  sessions: { date: string; dayType: string; sets: { exerciseId: number; setNumber: number; weight: number; reps: number }[] }[];
  diet: { date: string; name: string; kcal: number; proteinG: number }[];
  cardio: { date: string; type: string; minutes: number }[];
  metrics: { date: string; bodyweight: number | null; waist: number | null }[];
};

/** mulberry32 — tiny seeded PRNG so the demo is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_KG: Record<string, number> = { chest: 50, shoulders: 25, biceps: 17.5, triceps: 25, forearms: 12.5, legs: 50, glutes: 0, back: 45 };

const PRESETS = [
  { name: "Oats + whey", kcal: 420, proteinG: 35 },
  { name: "3 eggs + toast", kcal: 380, proteinG: 24 },
  { name: "Chicken rice bowl", kcal: 650, proteinG: 48 },
  { name: "Greek yogurt + berries", kcal: 220, proteinG: 18 },
  { name: "Salmon + potatoes", kcal: 600, proteinG: 42 },
  { name: "Protein shake", kcal: 160, proteinG: 30 },
  { name: "Beef mince + pasta", kcal: 720, proteinG: 45 },
  { name: "Takeaway pizza", kcal: 1100, proteinG: 38 },
];

function isoDaysAgo(today: string, n: number): string {
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const round = (x: number, step: number) => Math.round(x / step) * step;

export function generateDemoData(seed: number, today: string, exercises: DemoExercise[], days = 21): DemoData {
  const rand = rng(seed);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const data: DemoData = { presets: PRESETS, sessions: [], diet: [], cardio: [], metrics: [] };
  const skipIdx = new Set([Math.floor(rand() * days), Math.floor(rand() * days)]); // two missed sessions

  for (let i = days - 1; i >= 0; i--) {
    const date = isoDaysAgo(today, i);
    const week = Math.floor((days - 1 - i) / 7); // 0,1,2
    const dayType = dayTypeForDate(date);

    if (dayType !== "rest" && !skipIdx.has(i)) {
      const sets: DemoData["sessions"][number]["sets"] = [];
      for (const ex of exercises.filter((e) => e.dayType === dayType)) {
        const base = BASE_KG[ex.muscleGroup] ?? 20;
        const w = base === 0 ? 0 : round(base + week * 2.5 + (rand() - 0.5) * 2, 2.5);
        for (let s = 1; s <= ex.targetSets; s++) {
          const reps = ex.repHigh - Math.floor(rand() * 3) - (s === ex.targetSets ? 1 : 0);
          sets.push({ exerciseId: ex.id, setNumber: s, weight: w, reps: Math.max(ex.repLow, reps) });
        }
      }
      data.sessions.push({ date, dayType, sets });
    }

    const lowProteinDay = i % 9 === 4; // a few deliberately weak days for the coach to spot
    const meals = lowProteinDay ? [PRESETS[1], PRESETS[7]] : [PRESETS[0], pick([PRESETS[2], PRESETS[4], PRESETS[6]]), PRESETS[3], PRESETS[5]];
    if (!lowProteinDay && rand() < 0.3) meals.pop();
    for (const m of meals) data.diet.push({ date, ...m });

    if (dayType === "rest" || (dayType === "legs" && rand() < 0.5)) {
      data.cardio.push({ date, type: pick(["walk", "bike", "run"]), minutes: 20 + Math.floor(rand() * 3) * 10 });
    }

    const bodyweight = Math.round((81.2 - week * 0.4 - (days - 1 - i) * 0.02 + (rand() - 0.5) * 0.4) * 10) / 10;
    const waist = i % 3 === 0 ? Math.round((101.5 - week * 0.5 + (rand() - 0.5) * 0.4) * 10) / 10 : null;
    data.metrics.push({ date, bodyweight, waist });
  }
  return data;
}
