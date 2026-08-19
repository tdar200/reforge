import { expect, test } from "vitest";
import { formatIso } from "../today";

test("formatIso zero-pads month and day", () => {
  expect(formatIso(new Date("2026-03-05T12:00:00"))).toBe("2026-03-05");
});
