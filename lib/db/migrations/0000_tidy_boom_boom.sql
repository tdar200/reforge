CREATE TABLE IF NOT EXISTS "body_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"bodyweight" real,
	"waist" real,
	"chest" real,
	"thigh" real,
	"arm" real
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cardio_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"type" text NOT NULL,
	"minutes" integer NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "diet_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"kcal" integer NOT NULL,
	"protein_g" real NOT NULL,
	"carbs_g" real,
	"fat_g" real
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exercises" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"muscle_group" text NOT NULL,
	"day_type" text NOT NULL,
	"target_sets" integer NOT NULL,
	"rep_low" integer NOT NULL,
	"rep_high" integer NOT NULL,
	"superset_group" text,
	"order_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "food_presets" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kcal" integer NOT NULL,
	"protein_g" real NOT NULL,
	"carbs_g" real,
	"fat_g" real
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "set_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"exercise_id" integer NOT NULL,
	"set_number" integer NOT NULL,
	"weight" real NOT NULL,
	"reps" integer NOT NULL,
	"completed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"calorie_target" integer NOT NULL,
	"protein_target" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workout_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"day_type" text NOT NULL,
	"notes" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "set_logs" ADD CONSTRAINT "set_logs_session_id_workout_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "set_logs" ADD CONSTRAINT "set_logs_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
