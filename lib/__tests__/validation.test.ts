import { expect, test } from "vitest";
import { DietEntryInput, SettingsInput } from "../validation";

test("valid diet entry passes", () => {
  expect(DietEntryInput.safeParse({ date: "2026-07-20", name: "Chicken", kcal: 300, proteinG: 45 }).success).toBe(true);
});
test("negative kcal rejected", () => {
  expect(DietEntryInput.safeParse({ date: "2026-07-20", name: "X", kcal: -5, proteinG: 1 }).success).toBe(false);
});
test("settings require positive targets", () => {
  expect(SettingsInput.safeParse({ calorieTarget: 0, proteinTarget: 100 }).success).toBe(false);
});
