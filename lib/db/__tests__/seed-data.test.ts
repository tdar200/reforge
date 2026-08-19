import { expect, test } from "vitest";
import { SEED_EXERCISES, DAY_TYPES } from "../seed-data";

test("every seeded exercise uses a known day_type", () => {
  for (const ex of SEED_EXERCISES) expect(DAY_TYPES).toContain(ex.dayType);
});
test("arm days include forearm work", () => {
  const tue = SEED_EXERCISES.filter(e => e.dayType === "arms1").map(e => e.name.toLowerCase());
  expect(tue.some(n => n.includes("wrist"))).toBe(true);
});
test("leg day includes glute-med wobble work", () => {
  const wed = SEED_EXERCISES.filter(e => e.dayType === "legs").map(e => e.name.toLowerCase());
  expect(wed.some(n => n.includes("hip abduction"))).toBe(true);
});
