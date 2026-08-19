import { expect, test } from "vitest";
import * as schema from "../schema";

test("schema exports all tables", () => {
  for (const t of ["exercises","workoutSessions","setLogs","dietEntries","foodPresets","bodyMetrics","cardioLogs","settings"]) {
    expect(schema).toHaveProperty(t);
  }
});
