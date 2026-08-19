import { db } from "./index";
import { exercises, settings } from "./schema";
import { SEED_EXERCISES, SEED_SETTINGS } from "./seed-data";

await db.delete(exercises);
await db.insert(exercises).values(SEED_EXERCISES);
await db.insert(settings).values(SEED_SETTINGS).onConflictDoNothing();
console.log(`seeded ${SEED_EXERCISES.length} exercises`);
