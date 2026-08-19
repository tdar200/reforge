CREATE TABLE IF NOT EXISTS "coach_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"markdown" text NOT NULL
);
