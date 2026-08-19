import { expect, test } from "vitest";
import { lastSetsByExercise } from "../overload";

test("returns sets from the most recent prior session only", () => {
  const rows = [
    { exerciseId: 1, sessionDate: "2026-07-07", weight: 20, reps: 10, setNumber: 1 },
    { exerciseId: 1, sessionDate: "2026-07-14", weight: 22, reps: 9, setNumber: 1 }, // most recent prior
    { exerciseId: 1, sessionDate: "2026-07-21", weight: 99, reps: 1, setNumber: 1 }, // == current, excluded
  ];
  const out = lastSetsByExercise(rows, "2026-07-21");
  expect(out[1]).toEqual([{ weight: 22, reps: 9, setNumber: 1 }]);
});

test("no prior sessions yields empty map", () => {
  expect(lastSetsByExercise([], "2026-07-21")).toEqual({});
});
