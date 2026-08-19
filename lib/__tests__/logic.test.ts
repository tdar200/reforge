import { expect, test } from "vitest";
import { dayTypeForDate, sumDiet, DAY_LABELS } from "../logic";

test("weekday maps to the right session", () => {
  expect(dayTypeForDate("2026-07-20")).toBe("chest_shoulders"); // Monday
  expect(dayTypeForDate("2026-07-21")).toBe("arms1");           // Tuesday
  expect(dayTypeForDate("2026-07-22")).toBe("legs");            // Wednesday
  expect(dayTypeForDate("2026-07-23")).toBe("back");            // Thursday
  expect(dayTypeForDate("2026-07-24")).toBe("arms2");           // Friday
  expect(dayTypeForDate("2026-07-25")).toBe("rest");            // Saturday
  expect(dayTypeForDate("2026-07-26")).toBe("rest");            // Sunday
});

test("sumDiet totals kcal and protein", () => {
  expect(sumDiet([{kcal:500,proteinG:40},{kcal:300,proteinG:25}])).toEqual({kcal:800,proteinG:65});
  expect(sumDiet([])).toEqual({kcal:0,proteinG:0});
});

test("every day type has a label", () => {
  for (const d of ["chest_shoulders","arms1","legs","back","arms2","rest"] as const) {
    expect(DAY_LABELS[d]).toBeTruthy();
  }
});
