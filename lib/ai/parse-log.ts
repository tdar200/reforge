import { generateText, Output } from "ai";
import { getModel } from "./model";
import { ParsedLog } from "./schemas";

export type ParseContext = {
  date: string;
  dayType: string;
  exercises: { id: number; name: string; muscleGroup: string; dayType: string }[];
  presets: { id: number; name: string; kcal: number; proteinG: number }[];
  lastSets: Record<number, { weight: number; reps: number }[]>;
};

export function buildParseSystemPrompt(ctx: ParseContext): string {
  const today = ctx.exercises.filter((e) => e.dayType === ctx.dayType);
  const others = ctx.exercises.filter((e) => e.dayType !== ctx.dayType);
  const exLine = (e: ParseContext["exercises"][number]) => {
    const last = ctx.lastSets[e.id];
    const lastStr = last?.length ? ` (last: ${last.map((s) => `${s.weight}x${s.reps}`).join(", ")})` : "";
    return `- id ${e.id}: ${e.name} [${e.muscleGroup}]${lastStr}`;
  };
  return [
    `You convert a gym-goer's free-text log for ${ctx.date} into structured items.`,
    `Today's planned session: ${ctx.dayType}.`,
    "",
    "Exercise catalogue (today's session first). Use ONLY these ids; if nothing matches, set exerciseId to null and keep the user's name:",
    ...today.map(exLine),
    ...others.map(exLine),
    "",
    "Food presets (use presetId and their kcal/protein when the user clearly means one of these; otherwise presetId null, estimate kcal and protein yourself and set estimated=true):",
    ...ctx.presets.map((p) => `- id ${p.id}: ${p.name} (${p.kcal} kcal, ${p.proteinG} g protein)`),
    "",
    "Rules:",
    "- '3x8 at 60' means sets=3, reps=8, weight=60 kg. 'same as last time' means the last weights listed above.",
    "- Weights are kg. Bodyweight movements have weight 0.",
    "- 'weight 79.6' or 'waist 98' are body metrics (kg / cm).",
    "- Cardio is anything with a duration and a modality (bike, run, walk, rower...).",
    "- Never invent items that are not in the text. If part of the text cannot be mapped, put it in note.",
  ].join("\n");
}

/** Defensive pass over model output: ids must exist in the catalogue. */
export function sanitizeParsed(parsed: ParsedLog, ctx: ParseContext): ParsedLog {
  const exIds = new Set(ctx.exercises.map((e) => e.id));
  const presetIds = new Set(ctx.presets.map((p) => p.id));
  return {
    note: parsed.note,
    items: parsed.items.map((item) => {
      if (item.kind === "set" && item.exerciseId !== null && !exIds.has(item.exerciseId)) return { ...item, exerciseId: null };
      if (item.kind === "meal" && item.presetId !== null && !presetIds.has(item.presetId)) return { ...item, presetId: null, estimated: true };
      return item;
    }),
  };
}

export async function parseQuickLog(text: string, ctx: ParseContext): Promise<ParsedLog> {
  const result = await generateText({
    model: getModel(),
    system: buildParseSystemPrompt(ctx),
    prompt: text,
    output: Output.object({ schema: ParsedLog }),
    temperature: 0,
  });
  return sanitizeParsed(ParsedLog.parse(result.output), ctx);
}
