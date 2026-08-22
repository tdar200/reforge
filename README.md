# Reforge: AI-assisted personal fitness coach

A small full-stack app that turns a scrappy gym log into structured data and grounded coaching.
Built for the Moonshot Partners technical challenge on top of a personal tracker I already used daily.

**Live demo:** https://reforge-plum-gamma.vercel.app (passcode gated, ask me and I will send it)
**Walkthrough:** https://youtu.be/iBNlmt0hT9Y (6 minutes)

## What it does

- **Tracker.** A 5-day program (chest/shoulders, arms, legs, back, arms), per-set logging with last-session
  overload hints, meals vs calorie/protein targets, cardio, body metrics with trend charts. PWA, dark, mobile-first.
- **Quick log (AI).** Type one line: `bench 3x8 at 60, 20 min bike, oats + whey, weight 79.6`.
  The model maps it onto the exercise catalogue and food presets and returns typed proposals
  (sets / cardio / meals / metrics). You edit the cards, tap Save, and everything is written atomically.
  Nothing is written until you confirm. A date control on the composer backdates the whole line
  (yesterday's forgotten session, for example). It defaults to today and is capped at today.
- **Meal analysis (AI).** Every diet entry has an Analyze action: the model estimates a full per-serving
  panel (macros plus 11 vitamins/minerals), anchored to your logged kcal/protein, and gives a verdict with
  one concrete swap suggestion grounded in your remaining day budget. Analyzed once, stored on the entry
  (`nutrition` jsonb), served from the DB ever after. Clearly labeled as estimates, not label values.
- **Macros you don't know.** Log a meal by name and leave kcal or protein blank. Reforge looks the product
  up in Open Food Facts and uses the real label when it can identify it confidently, otherwise the coach
  estimates a typical UK serving. The row always says which it used, and for which portion. A meal already
  logged without macros is treated as unknown rather than zero: analyzing it fills the numbers in and
  corrects the day's totals.
- **Weekly review (AI).** The server compresses the last 14 days (top set per exercise per session,
  daily kcal/protein vs target, cardio, weight/waist, adherence) into ~3k tokens of JSON; the model writes a
  sub-250-word review with three concrete next-week targets. Reviews are stored and shown on Today.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 15 App Router, React 19, Tailwind | one repo, client pages + route handlers, Vercel-native |
| API | Next.js route handlers under `app/api/**` | thin: auth → Zod → service call → JSON |
| AI | Vercel AI SDK (`ai` v7) + `@ai-sdk/openai`, **GPT-5 mini** | see below |
| DB | Neon Postgres + Drizzle ORM (`neon-http`) | serverless-friendly; migrations in repo |
| Auth | passcode → HS256 JWT cookie (`jose`) | single-user app; enough to gate the API |
| Tests | vitest + Playwright: 349 unit, 217 API integration, 69 e2e | see Testing below |

## How AI is used (and why GPT-5 mini)

- **Structured parsing** (`lib/ai/parse-log.ts`): `generateText` with `Output.object({ schema })`. The system prompt
  carries the exercise catalogue (today's session first, with last weights), the food presets and parsing rules;
  the schema is a discriminated union of proposal kinds with numeric ranges. After the model returns, the server
  re-validates every id against the catalogue (`sanitizeParsed`): the model proposes, the server and the user decide.
- **Grounded review** (`lib/ai/review.ts`): pure `buildCoachContext` turns rows into compact JSON; the prompt forbids
  using anything outside it and fixes the output sections. Context is kept small by sending only top sets.
- **Meal analysis** (`lib/ai/nutrition.ts`): a 22-field panel schema (macros + 11 micronutrients + a verdict/swap
  block) filled from one meal plus the day's remaining budget. Your logged kcal/protein are pinned over whatever
  the model returns and the result is re-validated, so a panel can never contradict the row it belongs to.
  Panels are stored per entry and served from the DB afterwards, so it is one model call per meal, ever.
- **Macro estimate** (`lib/ai/estimate.ts`): a blank number means "work it out" instead of silently logging
  zero. A meal recorded as 0 kcal *and* 0 protein carries no information, so analysis estimates it and writes
  the result back to the row rather than pinning zeros.
- **Label lookup** (`lib/food/openfoodfacts.ts`): before asking the model, search Open Food Facts. Matching is
  deliberately strict: the product must account for every word logged and may only add nutritionally neutral
  ones, so `Coca Cola Zero` never matches *Zero Cherry* and `white loaf` never matches the *gluten free* one.
  Wrong label data is worse than an honest estimate, so anything short of confident falls back to the model.
  The label supplies density (per 100 g) and the portion comes from the product record or the model, and the
  response says which, because the portion is the dominant error term, so the UI shows it.
- **Why GPT-5 mini:** the parse call is interactive, so latency and cost matter more than raw capability;
  the mini tier handles a ~15-field structured schema reliably, and a frontier model would not change the
  quality of a 250-word review. Cost is negligible at this traffic (roughly 2k to 3k input tokens per parse).
- **The provider is a seam, not a dependency:** everything vendor-specific lives in `lib/ai/model.ts`; the
  parse and review code only see the AI SDK interface. I originally built this against Claude Sonnet 5 and
  switched vendors to OpenAI at deploy time by editing that one file. The swap also surfaced a real
  portability lesson: reasoning models reject non-default `temperature` and count reasoning tokens against
  `maxOutputTokens`, so those knobs can't be assumed portable across providers.
- **Failure modes handled:** missing key → 503 + UI hint, invalid model output → 502 and the user's text is kept,
  unresolved exercise → blocked client-side and server-side (400), commit is a single `db.batch` (atomic on Neon).
  Meal analysis claims its row before writing, so a meal deleted during the ~10 s model call returns 404 rather
  than reporting a save that never happened, and two concurrent analyses converge on one stored panel. Stored
  panels are re-validated on read: unreadable JSON is re-analyzed instead of served to the page.
  Resolving a meal runs its lookup and both model calls concurrently rather than chained: serialised, one Add
  waited on up to three round trips (~14 s measured), which was long enough for an ordinary connection blip to
  drop it and surface as a bare network error. Concurrent plus low reasoning effort took it to ~4.5 s, and the
  client retries a dropped request once before reporting it.

## Setup

1. `npm install`
2. `cp .env.example .env` and set `DATABASE_URL` (Neon), `APP_PASSCODE`, `SESSION_SECRET`, `OPENAI_API_KEY`.
3. `npm run db:migrate` then either `npm run db:seed` (empty program) or `npm run db:seed:demo` (3 weeks of
   deterministic synthetic history so the coach has something to review).
4. `npm run dev` → http://localhost:3000 → enter the passcode.
5. `npm test` · `npx tsc --noEmit` (full suite: see Testing)

## Testing

- `npm test`: 349 unit tests, no network or keys (the AI boundary is covered with the AI SDK mock model:
  sanitizer branches, schema rejection, prompt and config assertions).
- `npm run test:int`: 217 HTTP integration tests against a dev server (`PORT=3100 npm run dev`):
  every route × method × auth state (a 401 matrix over all endpoints), every Zod validation contract,
  cookie flags and JWT tampering/expiry, atomicity of the AI commit batch, and the documented
  same-date write race. Suites write only to far-future dates and clean up after themselves.
- `npm run test:e2e`: 69 Playwright tests over all six screens: login, Today (QuickLog proposals via a
  mocked parse, error states that preserve the user's text, CoachReview markdown rendering), workout,
  diet, body, settings, plus the PWA manifest. Live-model happy paths are gated behind `AI_LIVE=1` and
  skip cleanly without it.
- Writing these suites surfaced 8 real bugs: malformed ids/dates and FK violations returning 500 instead
  of 400, a meal analysis reporting success for a row deleted mid-call, an input bound that let a logged meal
  produce a panel violating its own schema, and an output-token cap that intermittently returned no panel at
  all. A ninth came from using the app: a blank macro field logged a real food as 0 kcal. Each is pinned by a
  test and fixed.

## Deploy (Vercel)

Import the repo, add the Neon integration (sets `DATABASE_URL`), add `APP_PASSCODE`, `SESSION_SECRET`,
`OPENAI_API_KEY`, deploy, then run `npm run db:migrate && npm run db:seed:demo` locally against the same
`DATABASE_URL`.

## Project layout

```
app/api/ai/{parse,commit,review,nutrition,estimate}/route.ts   HTTP layer for the AI features
lib/ai/model.ts       provider + model id + "not configured" guard
lib/ai/schemas.ts     Zod contracts (Proposal, ParsedLog, requests)
lib/ai/parse-log.ts   prompt builder, sanitizer, parse call
lib/ai/commit.ts      pure planner: confirmed proposals → row writes
lib/ai/review.ts      pure context builder, review prompt, review call
lib/ai/nutrition.ts   meal panel schema, prompt, pinned-and-revalidated analysis
lib/ai/estimate.ts    label-or-estimate macros for a meal logged by name alone
lib/food/openfoodfacts.ts  Open Food Facts search, strict matching, per-serving scaling
lib/ai/data.ts        the only AI file that reads the DB
lib/db/demo-data.ts   seeded PRNG demo generator (+ seed-demo.ts writer)
components/QuickLog.tsx, components/CoachReview.tsx, app/diet/page.tsx (meal panel UI)
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
- **Micronutrients are still model estimates.** The Open Food Facts lookup corrects calories and protein, but
  UK labels rarely carry vitamins, so the panel's micros remain estimates, good enough to spot "almost no
  vitamin C today", not good enough to trust to the milligram, and the UI says so.
- **Label matching is conservative by design, so it fires less often than it could.** Name search is fuzzy and
  a wrong label silently corrupts the log, so I reject anything ambiguous. Barcode scanning is the real fix:
  it identifies the exact product, and Open Food Facts is built around it.
- **The looked-up label carries carbs, fat, sugar and salt that I currently discard**, then the panel asks the
  model to re-invent them. Plumbing those through would make four more numbers label-true for matched foods.
- **Evaluation.** I'd add a small golden set of log lines → expected proposals and run it against the model in CI
  (AI SDK's mock provider for the route tests, real model nightly).
- **Voice input** via the Web Speech API is a natural fit for the gym floor.
- **Why not an agent with DB tools?** I considered tool-calling that writes rows directly. A "propose → confirm →
  commit" pipeline is safer for data the user cares about and far easier to test deterministically.
