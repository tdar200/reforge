export const DAY_TYPES = ["chest_shoulders","arms1","legs","back","arms2","rest"] as const;
export type DayType = (typeof DAY_TYPES)[number];

type SeedEx = {
  name: string; muscleGroup: string; dayType: DayType;
  targetSets: number; repLow: number; repHigh: number;
  supersetGroup: string | null; orderIndex: number;
};

export const SEED_EXERCISES: SeedEx[] = [
  // Mon — Chest + Shoulders (maintenance)
  { name: "Barbell Bench Press", muscleGroup: "chest", dayType: "chest_shoulders", targetSets: 4, repLow: 6, repHigh: 10, supersetGroup: null, orderIndex: 1 },
  { name: "Incline DB Press", muscleGroup: "chest", dayType: "chest_shoulders", targetSets: 3, repLow: 8, repHigh: 12, supersetGroup: null, orderIndex: 2 },
  { name: "Overhead Press", muscleGroup: "shoulders", dayType: "chest_shoulders", targetSets: 3, repLow: 6, repHigh: 10, supersetGroup: null, orderIndex: 3 },
  { name: "Lateral Raises", muscleGroup: "shoulders", dayType: "chest_shoulders", targetSets: 3, repLow: 12, repHigh: 20, supersetGroup: null, orderIndex: 4 },
  { name: "Cable Fly", muscleGroup: "chest", dayType: "chest_shoulders", targetSets: 2, repLow: 12, repHigh: 15, supersetGroup: null, orderIndex: 5 },
  // Tue — Arms #1 + Forearms (biceps-led supersets)
  { name: "Barbell Curl", muscleGroup: "biceps", dayType: "arms1", targetSets: 4, repLow: 6, repHigh: 10, supersetGroup: "A", orderIndex: 1 },
  { name: "Close-Grip Bench", muscleGroup: "triceps", dayType: "arms1", targetSets: 4, repLow: 6, repHigh: 10, supersetGroup: "A", orderIndex: 2 },
  { name: "Incline DB Curl", muscleGroup: "biceps", dayType: "arms1", targetSets: 3, repLow: 8, repHigh: 12, supersetGroup: "B", orderIndex: 3 },
  { name: "Overhead DB Extension", muscleGroup: "triceps", dayType: "arms1", targetSets: 3, repLow: 8, repHigh: 12, supersetGroup: "B", orderIndex: 4 },
  { name: "Hammer Curl", muscleGroup: "biceps", dayType: "arms1", targetSets: 3, repLow: 10, repHigh: 12, supersetGroup: "C", orderIndex: 5 },
  { name: "Dips", muscleGroup: "triceps", dayType: "arms1", targetSets: 3, repLow: 8, repHigh: 12, supersetGroup: "C", orderIndex: 6 },
  { name: "Wrist Curls", muscleGroup: "forearms", dayType: "arms1", targetSets: 3, repLow: 12, repHigh: 20, supersetGroup: null, orderIndex: 7 },
  { name: "Reverse Wrist Curls", muscleGroup: "forearms", dayType: "arms1", targetSets: 3, repLow: 12, repHigh: 20, supersetGroup: null, orderIndex: 8 },
  // Wed — Legs (light) + Glute-Med (wobble)
  { name: "Goblet Squat", muscleGroup: "legs", dayType: "legs", targetSets: 2, repLow: 8, repHigh: 12, supersetGroup: null, orderIndex: 1 },
  { name: "Romanian Deadlift", muscleGroup: "legs", dayType: "legs", targetSets: 2, repLow: 8, repHigh: 10, supersetGroup: null, orderIndex: 2 },
  { name: "Side-Lying Hip Abduction", muscleGroup: "glutes", dayType: "legs", targetSets: 3, repLow: 12, repHigh: 15, supersetGroup: null, orderIndex: 3 },
  { name: "Single-Leg Squat / Step-Down", muscleGroup: "glutes", dayType: "legs", targetSets: 3, repLow: 8, repHigh: 12, supersetGroup: null, orderIndex: 4 },
  { name: "Single-Leg Bridge", muscleGroup: "glutes", dayType: "legs", targetSets: 3, repLow: 10, repHigh: 15, supersetGroup: null, orderIndex: 5 },
  // Thu — Back (maintenance)
  { name: "Pull-ups / Lat Pulldown", muscleGroup: "back", dayType: "back", targetSets: 4, repLow: 6, repHigh: 12, supersetGroup: null, orderIndex: 1 },
  { name: "Barbell Row", muscleGroup: "back", dayType: "back", targetSets: 4, repLow: 6, repHigh: 10, supersetGroup: null, orderIndex: 2 },
  { name: "Chest-Supported Row", muscleGroup: "back", dayType: "back", targetSets: 3, repLow: 10, repHigh: 12, supersetGroup: null, orderIndex: 3 },
  { name: "Face Pulls", muscleGroup: "back", dayType: "back", targetSets: 3, repLow: 15, repHigh: 20, supersetGroup: null, orderIndex: 4 },
  // Fri — Arms #2 + Forearms (triceps-led supersets) + Glute-Med
  { name: "Rope Pushdown", muscleGroup: "triceps", dayType: "arms2", targetSets: 4, repLow: 10, repHigh: 15, supersetGroup: "A", orderIndex: 1 },
  { name: "Cable Curl", muscleGroup: "biceps", dayType: "arms2", targetSets: 4, repLow: 10, repHigh: 15, supersetGroup: "A", orderIndex: 2 },
  { name: "Overhead Rope Extension", muscleGroup: "triceps", dayType: "arms2", targetSets: 3, repLow: 12, repHigh: 15, supersetGroup: "B", orderIndex: 3 },
  { name: "Preacher Curl", muscleGroup: "biceps", dayType: "arms2", targetSets: 3, repLow: 10, repHigh: 12, supersetGroup: "B", orderIndex: 4 },
  { name: "Single-Arm Pushdown", muscleGroup: "triceps", dayType: "arms2", targetSets: 3, repLow: 15, repHigh: 20, supersetGroup: "C", orderIndex: 5 },
  { name: "Spider Curl", muscleGroup: "biceps", dayType: "arms2", targetSets: 3, repLow: 12, repHigh: 15, supersetGroup: "C", orderIndex: 6 },
  { name: "Wrist Curls", muscleGroup: "forearms", dayType: "arms2", targetSets: 3, repLow: 12, repHigh: 20, supersetGroup: null, orderIndex: 7 },
  { name: "Reverse Wrist Curls", muscleGroup: "forearms", dayType: "arms2", targetSets: 3, repLow: 12, repHigh: 20, supersetGroup: null, orderIndex: 8 },
  { name: "Side-Lying Hip Abduction", muscleGroup: "glutes", dayType: "arms2", targetSets: 3, repLow: 12, repHigh: 15, supersetGroup: null, orderIndex: 9 },
];

export const SEED_SETTINGS = { id: 1, calorieTarget: 2000, proteinTarget: 170 };
