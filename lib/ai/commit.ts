import type { Proposal } from "./schemas";

export type CommitState = {
  date: string;
  dayType: string;
  sessionId: number | null;
  maxSetByExercise: Record<number, number>;
  existingMetric: { id: number } | null;
};

export type CommitPlan = {
  setRows: { sessionId: number; exerciseId: number; setNumber: number; weight: number; reps: number }[];
  cardioRows: { date: string; type: string; minutes: number; notes: null }[];
  mealRows: { date: string; name: string; kcal: number; proteinG: number }[];
  metric:
    | null
    | { op: "insert"; values: Record<string, number | string> }
    | { op: "update"; id: number; values: Record<string, number> };
  counts: { sets: number; cardio: number; meals: number; metrics: number };
};

export class CommitError extends Error {
  constructor(public code: "unresolved_exercise" | "missing_session") {
    super(code);
    this.name = "CommitError";
  }
}

/** Pure: turns confirmed proposals into concrete row writes. Throws CommitError on unusable input. */
export function planCommit(items: Proposal[], state: CommitState): CommitPlan {
  const plan: CommitPlan = { setRows: [], cardioRows: [], mealRows: [], metric: null, counts: { sets: 0, cardio: 0, meals: 0, metrics: 0 } };
  const nextSet: Record<number, number> = { ...state.maxSetByExercise };
  const metricValues: Record<string, number> = {};

  for (const item of items) {
    switch (item.kind) {
      case "set": {
        if (item.exerciseId === null) throw new CommitError("unresolved_exercise");
        if (state.sessionId === null) throw new CommitError("missing_session");
        for (let i = 0; i < item.sets; i++) {
          const setNumber = (nextSet[item.exerciseId] ?? 0) + 1;
          nextSet[item.exerciseId] = setNumber;
          plan.setRows.push({ sessionId: state.sessionId, exerciseId: item.exerciseId, setNumber, weight: item.weight, reps: item.reps });
          plan.counts.sets++;
        }
        break;
      }
      case "cardio":
        plan.cardioRows.push({ date: state.date, type: item.type, minutes: item.minutes, notes: null });
        plan.counts.cardio++;
        break;
      case "meal":
        plan.mealRows.push({ date: state.date, name: item.name, kcal: item.kcal, proteinG: item.proteinG });
        plan.counts.meals++;
        break;
      case "metric":
        metricValues[item.field] = item.value;
        plan.counts.metrics++;
        break;
    }
  }

  if (Object.keys(metricValues).length > 0) {
    plan.metric = state.existingMetric
      ? { op: "update", id: state.existingMetric.id, values: metricValues }
      : { op: "insert", values: { date: state.date, ...metricValues } };
  }
  return plan;
}
