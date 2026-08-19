import type { DayType } from "./db/seed-data";

export const DAY_LABELS: Record<DayType, string> = {
  chest_shoulders: "Chest + Shoulders",
  arms1: "Arms #1 + Forearms",
  legs: "Legs + Glute-Med",
  back: "Back",
  arms2: "Arms #2 + Forearms",
  rest: "Rest",
};

// getUTCDay avoids timezone drift when parsing a YYYY-MM-DD string.
const WEEKDAY_TO_DAYTYPE: DayType[] = [
  "rest",           // 0 Sun
  "chest_shoulders",// 1 Mon
  "arms1",          // 2 Tue
  "legs",           // 3 Wed
  "back",           // 4 Thu
  "arms2",          // 5 Fri
  "rest",           // 6 Sat
];

export function dayTypeForDate(iso: string): DayType {
  const d = new Date(iso + "T00:00:00Z");
  return WEEKDAY_TO_DAYTYPE[d.getUTCDay()];
}

export function sumDiet(entries: { kcal: number; proteinG: number }[]) {
  return entries.reduce(
    (acc, e) => ({ kcal: acc.kcal + e.kcal, proteinG: acc.proteinG + e.proteinG }),
    { kcal: 0, proteinG: 0 },
  );
}
