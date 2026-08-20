import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const METRIC_FIELDS = ["bodyweight", "waist", "chest", "thigh", "arm"] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];

export const SetProposal = z.object({
  kind: z.literal("set"),
  exerciseId: z.number().int().nullable().describe("id from the exercise catalogue, or null if no match"),
  exerciseName: z.string().min(1).describe("exercise name as the user said it"),
  sets: z.number().int().min(1).max(10).describe("number of sets, e.g. 3 for '3x8'"),
  reps: z.number().int().min(1).max(50),
  weight: z.number().min(0).max(500).describe("kg; 0 for bodyweight"),
});
export const CardioProposal = z.object({
  kind: z.literal("cardio"),
  type: z.string().min(1).describe("e.g. bike, run, walk, rower"),
  minutes: z.number().int().min(1).max(600),
});
export const MealProposal = z.object({
  kind: z.literal("meal"),
  name: z.string().min(1),
  kcal: z.number().int().min(0).max(5000),
  proteinG: z.number().min(0).max(500),
  presetId: z.number().int().nullable().describe("id from the food presets, or null"),
  estimated: z.boolean().describe("true when kcal/protein were estimated rather than taken from a preset"),
});
export const MetricProposal = z.object({
  kind: z.literal("metric"),
  field: z.enum(METRIC_FIELDS),
  value: z.number().positive().describe("kg for bodyweight, cm for the rest"),
});

export const Proposal = z.discriminatedUnion("kind", [SetProposal, CardioProposal, MealProposal, MetricProposal]);
export type Proposal = z.infer<typeof Proposal>;

export const ParsedLog = z.object({
  items: z.array(Proposal).max(40),
  note: z.string().nullable().describe("anything in the text you could not map to an item, else null"),
});
export type ParsedLog = z.infer<typeof ParsedLog>;

export const ParseRequest = z.object({ text: z.string().min(1).max(1000), date: isoDate });
export type ParseRequest = z.infer<typeof ParseRequest>;

export const CommitRequest = z.object({ date: isoDate, items: z.array(Proposal).min(1).max(40) });
export type CommitRequest = z.infer<typeof CommitRequest>;
