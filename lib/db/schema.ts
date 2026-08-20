import { pgTable, serial, integer, text, date, real, timestamp, jsonb } from "drizzle-orm/pg-core";
import type { NutritionPanel } from "../ai/nutrition";

export const exercises = pgTable("exercises", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  muscleGroup: text("muscle_group").notNull(),
  dayType: text("day_type").notNull(),
  targetSets: integer("target_sets").notNull(),
  repLow: integer("rep_low").notNull(),
  repHigh: integer("rep_high").notNull(),
  supersetGroup: text("superset_group"),
  orderIndex: integer("order_index").notNull(),
});

export const workoutSessions = pgTable("workout_sessions", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  dayType: text("day_type").notNull(),
  notes: text("notes"),
});

export const setLogs = pgTable("set_logs", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => workoutSessions.id, { onDelete: "cascade" }),
  exerciseId: integer("exercise_id").notNull().references(() => exercises.id),
  setNumber: integer("set_number").notNull(),
  weight: real("weight").notNull(),
  reps: integer("reps").notNull(),
  completedAt: timestamp("completed_at").defaultNow().notNull(),
});

export const dietEntries = pgTable("diet_entries", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  name: text("name").notNull(),
  kcal: integer("kcal").notNull(),
  proteinG: real("protein_g").notNull(),
  carbsG: real("carbs_g"),
  fatG: real("fat_g"),
  nutrition: jsonb("nutrition").$type<NutritionPanel>(),
});

export const foodPresets = pgTable("food_presets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kcal: integer("kcal").notNull(),
  proteinG: real("protein_g").notNull(),
  carbsG: real("carbs_g"),
  fatG: real("fat_g"),
});

export const bodyMetrics = pgTable("body_metrics", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  bodyweight: real("bodyweight"),
  waist: real("waist"),
  chest: real("chest"),
  thigh: real("thigh"),
  arm: real("arm"),
});

export const cardioLogs = pgTable("cardio_logs", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  type: text("type").notNull(),
  minutes: integer("minutes").notNull(),
  notes: text("notes"),
});

export const settings = pgTable("settings", {
  id: integer("id").primaryKey(),
  calorieTarget: integer("calorie_target").notNull(),
  proteinTarget: integer("protein_target").notNull(),
});

export const coachReviews = pgTable("coach_reviews", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  markdown: text("markdown").notNull(),
});
