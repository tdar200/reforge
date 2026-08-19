# Reforge

Personal fitness-tracker PWA (Next.js + Neon Postgres). Tracks workouts, diet, and body metrics
against the MASTER-PLAN program.

## Setup
1. `npm install`
2. Copy `.env.example` → `.env` and fill `DATABASE_URL` (Neon), `APP_PASSCODE`, `SESSION_SECRET`.
3. `npm run db:generate && npm run db:migrate && npm run db:seed`
4. `npm run dev` → open http://localhost:3000, enter passcode.

## Deploy (Vercel)
1. Import repo in Vercel; add the Neon integration (sets `DATABASE_URL`).
2. Add env vars `APP_PASSCODE`, `SESSION_SECRET`.
3. After first deploy, run `npm run db:migrate && npm run db:seed` against the Neon URL.
4. On your phone: open the deployed URL → browser menu → "Add to Home Screen".

## Test
`npm run test`
