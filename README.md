# Reforge — AI-assisted personal fitness coach

A small full-stack app that turns a scrappy gym log into structured data and grounded coaching.
Built for the Moonshot Partners technical challenge on top of a personal tracker I already used daily.

**Live demo:** <url after deploy> · passcode in the submission email · **Demo video:** <Loom url>

## What it does

- **Tracker** — 5-day program (chest/shoulders, arms, legs, back, arms), per-set logging with last-session
  overload hints, meals vs calorie/protein targets, cardio, body metrics with trend charts. PWA, dark, mobile-first.
- **Quick log (AI)** — type one line: `bench 3x8 at 60, 20 min bike, oats + whey, weight 79.6`.
  Claude maps it onto the exercise catalogue and food presets and returns typed proposals
  (sets / cardio / meals / metrics). You edit the cards, tap Save, and everything is written atomically.
  Nothing is written until you confirm.
- **Weekly review (AI)** — the server compresses the last 14 days (top set per exercise per session,
  daily kcal/protein vs target, cardio, weight/waist, adherence) into ~3k tokens of JSON; Claude writes a
  sub-250-word review with three concrete next-week targets. Reviews are stored and shown on Today.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 15 App Router, React 19, Tailwind | one repo, client pages + route handlers, Vercel-native |
| API | Next.js route handlers under `app/api/**` | thin: auth → Zod → service call → JSON |
| AI | Vercel AI SDK (`ai` v7) + `@ai-sdk/anthropic`, **Claude Sonnet 5** | see below |
| DB | Neon Postgres + Drizzle ORM (`neon-http`) | serverless-friendly; migrations in repo |
| Auth | passcode → HS256 JWT cookie (`jose`) | single-user app; enough to gate the API |
| Tests | vitest, 41 unit tests, no network | every AI boundary is a Zod contract so the logic is testable without a key |

## How AI is used (and why Claude Sonnet 5)

- **Structured parsing** (`lib/ai/parse-log.ts`): `generateText` with `Output.object({ schema })`. The system prompt
  carries the exercise catalogue (today's session first, with last weights), the food presets and parsing rules;
  the schema is a discriminated union of proposal kinds with numeric ranges. After the model returns, the server
  re-validates every id against the catalogue (`sanitizeParsed`) — the model proposes, the server and the user decide.
- **Grounded review** (`lib/ai/review.ts`): pure `buildCoachContext` turns rows into compact JSON; the prompt forbids
  using anything outside it and fixes the output sections. Context is kept small by sending only top sets.
- **Why Sonnet 5:** the parse call is interactive, so latency matters; Sonnet's structured-output reliability is
  excellent for a ~15-field schema; cost is negligible at this traffic (~2–3k input tokens per parse); Opus would
  not change the quality of a 250-word review. The provider is isolated in `lib/ai/model.ts`, so swapping models
  or vendors is a one-line change thanks to the AI SDK.
- **Failure modes handled:** missing key → 503 + UI hint, invalid model output → 502 and the user's text is kept,
  unresolved exercise → blocked client-side and server-side (400), commit is a single `db.batch` (atomic on Neon).

## Setup

1. `npm install`
2. `cp .env.example .env` and set `DATABASE_URL` (Neon), `APP_PASSCODE`, `SESSION_SECRET`, `ANTHROPIC_API_KEY`.
3. `npm run db:migrate` then either `npm run db:seed` (empty program) or `npm run db:seed:demo` (3 weeks of
   deterministic synthetic history so the coach has something to review).
4. `npm run dev` → http://localhost:3000 → enter the passcode.
5. `npm test` · `npx tsc --noEmit`

## Deploy (Vercel)

Import the repo, add the Neon integration (sets `DATABASE_URL`), add `APP_PASSCODE`, `SESSION_SECRET`,
`ANTHROPIC_API_KEY`, deploy, then run `npm run db:migrate && npm run db:seed:demo` locally against the same
`DATABASE_URL`.

## Project layout

```
app/api/ai/{parse,commit,review}/route.ts   HTTP layer for the AI features
lib/ai/model.ts       provider + model id + "not configured" guard
lib/ai/schemas.ts     Zod contracts (Proposal, ParsedLog, requests)
lib/ai/parse-log.ts   prompt builder, sanitizer, parse call
lib/ai/commit.ts      pure planner: confirmed proposals → row writes
lib/ai/review.ts      pure context builder, review prompt, review call
lib/ai/data.ts        the only AI file that reads the DB
lib/db/demo-data.ts   seeded PRNG demo generator (+ seed-demo.ts writer)
components/QuickLog.tsx, components/CoachReview.tsx
```

## Trade-offs and what I'd do with more time

- **Single user, shared passcode.** Right for a personal tool and for a reviewable demo; real accounts
  (user_id on every table, magic-link auth) are the first thing I'd add for more than one person.
- **Select-then-insert races.** Session and body-metric rows are created with a read-then-write (no unique index on date), matching the original app's pattern. Fine for one user; a unique constraint + upsert is the fix if this ever grows a second writer.
- **No streaming.** The review takes a few seconds; streaming tokens would feel better. Kept the simple
  request/response to keep the commit + persist path obviously correct.
- **Review history.** Every review is stored but only the latest is shown; a list + diff between weeks is cheap to add.
- **Confidence / ambiguity UI.** The schema could carry a per-item confidence and the cards could highlight
  low-confidence ones. Skipped to keep the parse contract small.
- **Evaluation.** I'd add a small golden set of log lines → expected proposals and run it against the model in CI
  (AI SDK's mock provider for the route tests, real model nightly).
- **Voice input** via the Web Speech API is a natural fit for the gym floor.
- **Why not an agent with DB tools?** I considered tool-calling that writes rows directly. A "propose → confirm →
  commit" pipeline is safer for data the user cares about and far easier to test deterministically.
