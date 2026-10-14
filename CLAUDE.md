# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

AutoCollect AI: automated B2B invoice collection. Invoices come in from Stripe Connect / QuickBooks / CSV; the app sends escalating reminders ("dunning") until paid, and AI-classifies customer replies (dispute pauses, promise-to-pay snoozes).

## Layout

npm workspaces monorepo (Node >= 20.11):
- `apps/api` — Fastify 5 + TypeScript (ESM, `.js` import suffixes), raw SQL via `pg` (no ORM), zod validation.
- `apps/web` — React 19 + Vite 6 + TanStack Query + Tailwind. `@/` aliases `apps/web/src`.
- `packages/shared` — shared domain types (`@autocollect/shared`). **Must be built before API/web typecheck or tests**; the root scripts do this for you.
- `e2e/` — Playwright specs. `api/index.mjs` — Vercel function entry that re-exports `apps/api/dist/serverless.js`.

## Commands

```bash
docker compose up -d                 # Postgres 17 on localhost:5433
cp apps/api/.env.example apps/api/.env
npm run db:migrate && npm run db:seed
npm run dev                          # API :4000 (tsx watch) + web :5175 (Vite proxies /api -> :4000, stripping /api)

npm run typecheck                    # all packages
npm test                             # API vitest (unit + integration; needs DATABASE_URL / a running DB)
npm run test:unit -w @autocollect/api            # only src/**/*.test.ts (pure tests)
npx vitest run test/integration/api.test.ts -t "name"   # single file / test (run from apps/api)
npm run test:e2e                     # builds web, serves it from the API on :4000, runs Playwright
npx playwright test e2e/auth.spec.ts # single e2e spec
npm run build                        # shared -> api -> web
```

Dev logins after seeding: `dev-user@autocollect.local` / `dev-password-auto`; platform admin at `/admin/login` with `admin@autocollect.local` / `admin123`.

To run integration tests the way CI does (so RLS is actually enforced), run `npm run db:roles` and set `DATABASE_URL` to the `autocollect_app` role, `SERVICE_DATABASE_URL` to `autocollect_service`, `MIGRATION_DATABASE_URL` to the owner `autocollect` (see README "Tests"). Integration test files run sequentially against one shared DB. `vitest.config.ts` and `playwright.config.ts` blank out all provider keys, so tests always use the local mocks.

## Architecture

### Tenancy and database access (most important invariant)
Postgres Row-Level Security keyed on the session variable `app.tenant_id`, plus explicit `WHERE tenant_id = $1` filters in queries (do both). Three DB roles/URLs:
- `DATABASE_URL` → `pool`: RLS-restricted runtime role for request work.
- `SERVICE_DATABASE_URL` → `servicePool`: BYPASSRLS, for cross-tenant/pre-auth work (auth lookups, webhooks, scheduler, syncs).
- `MIGRATION_DATABASE_URL`: table owner, used only by migrations.

The default local `.env` connects as the `autocollect` superuser, which **bypasses RLS**, so missing policies or tenant filters won't show up in plain local dev. Use the least-privilege roles (above) to exercise isolation.

`apps/api/src/plugins/tenant.ts` gives every non-public request a dedicated connection as `req.db`, authenticates, and scopes it to the tenant at session level; it is always reset via `releaseRequestClient()` on response/abort so scope never leaks to the next borrower. In handlers, query through `req.db` and `req.user.tenantId`. Background/webhook code uses `withServiceTenant()` / `withServiceTransaction()` from `lib/db.ts`. **Never acquire from `pool` while a request already holds `req.db`** (pool-exhaustion deadlock).

Routes are authenticated by default. Opt out via route `config`: `public: true` (webhooks, health, auth, cron), `allowNoTenant: true` (signed-in users without a workspace), `rawBody: true` (signature verification). Role guards: `requireRole("admin")`, `requireTenant()`, `requireSuperAdmin()` as `preHandler`s. Admin sessions are a separate audience and only reach `/admin/` routes.

### HTTP conventions
- Modules live in `apps/api/src/modules/<area>/*.controller.ts`, each exporting a `xxxRoutes(app)` registered in `app.ts`.
- Throw helpers from `lib/errors.ts` (`badRequest`, `notFound`, `forbidden`, `ApiError`). `app.ts` maps ZodError and common Postgres codes (23505 → 409, etc.) to `{ error: { code, message } }`.
- CSRF: non-GET requests with an Origin must match `WEB_ORIGIN`/`APP_URL`; authenticated writes without an Origin must send `X-Requested-With` (the web client in `apps/web/src/lib/api.ts` always does).
- Route prefix: routes are mounted at root in dev/tests, but under `/api` when the API serves the SPA (`SERVE_WEB_DIR` set — Docker, e2e) and on Vercel.

### Dunning engine and jobs
`modules/workflows/engine.ts` is the core reminder sender, using a crash-safe CLAIM → SEND → RECORD model: a short transaction deducts a credit and reserves `(tenant, invoice, step)` in `messages` with a lease (unique index makes workers mutually exclusive); the provider call happens with no transaction held; a second transaction marks sent/advances or refunds and schedules a retry. Send-time math (timezone, send hour, weekends, DST, catch-up for long-overdue imports) is in `lib/schedule.ts` (pure, unit-tested).

Periodic jobs (dunning, QBO sync, Stripe backfill resume, housekeeping) run two ways:
- Long-lived hosts: in-process `modules/workflows/scheduler.ts` (disable with `RUN_SCHEDULER=false`).
- Serverless (Vercel): `GET/POST /cron/dunning` and `/cron/housekeeping`, authenticated by `CRON_SECRET`, triggered by Vercel Cron and `.github/workflows/cron.yml` every 5 min.
Both paths take database leases (`lib/job-lock.ts`), so duplicate/overlapping triggers and multiple replicas are safe.

### External services and dev mocks
Stripe (Connect + Billing), Postmark/SMTP email, Twilio SMS, QuickBooks, Anthropic (reply classification, `lib/ai.ts`), Google OAuth. Every one falls back to a local mock when its keys are empty; in dev, emails (verification, invites, reminders) are printed to the API console. `config.ts` distinguishes dev-like (`development`/`test`: mocks, simulators allowed) from production, and `validateProductionConfig()` refuses to start with missing/unsafe config.

Webhooks (Stripe, Postmark inbound) are verified and processed idempotently (`lib/webhook-events.ts`). Reply-To addresses are signed per invoice (`lib/reply-address.ts`) to route inbound replies.

### Migrations
Forward-only numbered SQL files in `apps/api/src/migrations/` (copied into `dist` at build). Each runs in its own transaction with a recorded checksum; **never edit an applied migration — add a new numbered file.** New tenant tables need RLS policies (see `008_force_rls.sql` for the pattern) and grants for the app/service roles (`scripts/bootstrap-roles.ts`).

### Money and dates
Amounts are stored in minor units as BIGINT (parsed to JS numbers when safe). `DATE` columns are returned as `"YYYY-MM-DD"` strings, not `Date` objects — keep it that way to avoid timezone shifts.

## Deployment
Vercel (`vercel.json`, `scripts/vercel-build.mjs`) or Docker (single container serving SPA + API under `/api`). See `docs/PRODUCTION.md`. `npm run smoke` (`BASE=https://… npm run smoke`) is a post-deploy smoke test. CI (`.github/workflows/ci.yml`) runs migrate + roles, `npm audit --omit=dev`, typecheck, tests as least-privilege roles, build, and Playwright.
