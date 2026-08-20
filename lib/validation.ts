import { z } from "zod";
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const DietEntryInput = z.object({
  // Bounds match MealProposal in lib/ai/schemas.ts so the manual and AI paths agree.
  date: isoDate, name: z.string().min(1).max(120),
  kcal: z.number().int().min(0).max(5000),
  proteinG: z.number().min(0).max(500),
  carbsG: z.number().nonnegative().nullish(),
  fatG: z.number().nonnegative().nullish(),
});
export const PresetInput = DietEntryInput.omit({ date: true });
export const SettingsInput = z.object({
  calorieTarget: z.number().int().positive(),
  proteinTarget: z.number().int().positive(),
});
export const BodyMetricInput = z.object({
  date: isoDate,
  bodyweight: z.number().positive().nullish(),
  waist: z.number().positive().nullish(),
  chest: z.number().positive().nullish(),
  thigh: z.number().positive().nullish(),
  arm: z.number().positive().nullish(),
});
export const CardioInput = z.object({
  date: isoDate, type: z.string().min(1), minutes: z.number().int().positive(), notes: z.string().nullish(),
});
export const SessionInput = z.object({ date: isoDate, dayType: z.string().min(1), notes: z.string().nullish() });
export const SetLogInput = z.object({
  sessionId: z.number().int(), exerciseId: z.number().int(),
  setNumber: z.number().int().positive(), weight: z.number().nonnegative(), reps: z.number().int().nonnegative(),
});
