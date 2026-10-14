# AutoCollect AI

**Automated B2B invoice chasing (dunning) for small businesses.** AutoCollect pulls in unpaid invoices, runs multi-step reminder workflows by email and SMS, triages customer replies, and shows what's overdue on one dashboard, so finance teams stop chasing payments by hand.

> Status: working MVP, built solo end-to-end. Runs fully locally with seeded demo data.

---

## Why I built it

Tools in this space (Chaser, YayPay, Invoiced) start at roughly $259–$500/month and cap users or workflows. AutoCollect is designed around **unlimited users and credit-based pricing** (1 credit per email, 2 per SMS), so a small team pays for what it sends, not for seats.

## What it does

- **Invoice ingestion:** Stripe, QuickBooks Online sync, and CSV import feed one shared ingest pipeline
- **Dunning workflows:** configurable multi-step reminder sequences with templates, run on a scheduler (cron module)
- **Reply inbox:** inbound customer replies are captured and triaged alongside each invoice
- **Dashboard:** overdue totals, invoice and customer views, and an activity feed
- **Teams and roles:** organizations with owner / admin / member roles and email invitations
- **Credits and billing:** per-tenant credit wallet with an append-only transaction ledger; plan allowances granted from Stripe webhooks; sends pause automatically when credits run out
- **Super-admin console:** platform KPIs, org and user management, credit grants, suspensions, and an audit feed

## Architecture

npm-workspaces monorepo:

```
apps/
  api/        Fastify 5 + TypeScript REST API (also exported as a serverless handler)
    src/modules/   auth, invoices, customers, workflows, replies, integrations,
                   billing, cron, dashboard, members, admin, activity, settings
    src/migrations SQL migrations
  web/        React 19 + Vite SPA
packages/
  shared/     Types and Zod schemas shared by API and web
e2e/          Playwright end-to-end tests
docs/         Product requirements and product analysis
```

### Engineering decisions worth noting

- **Multi-tenancy with PostgreSQL row-level security (RLS).** Tenant isolation is enforced in the database, not only in application code. Admin operations use a separate pool with `BYPASSRLS`.
- **Self-hosted auth.** argon2id password hashing and DB-backed sessions in `HttpOnly`/`SameSite=Lax` cookies. Verification, reset, and invite tokens are random, hashed at rest, and single-use.
- **Credits in the same transaction as the send.** The wallet debit happens in the same DB transaction as the message insert, so a send can never happen without being paid for.
- **Hardening:** rate limiting on auth routes, Helmet security headers, CORS, Zod validation on every input, and an audit log for auth, admin, and credit events.
- **Stripe webhooks** verified against the raw request body.

## Tech stack

| Layer | Tools |
|---|---|
| Frontend | React 19, TypeScript, Vite, TanStack Query, React Router, Tailwind CSS |
| Backend | Node.js 20, Fastify 5, TypeScript, Zod, `pg` (raw SQL, no ORM) |
| Data | PostgreSQL with row-level security |
| Auth | argon2id, DB sessions, `jose` |
| Integrations | Stripe, QuickBooks Online, CSV |
| Testing | Playwright (e2e), `tsc` type checks across all workspaces |

## Running locally

Requires Node.js 20.11+ and Docker (for Postgres on port 5433).

```bash
git clone https://github.com/vijayaprathap1/autocollect-ai.git
cd autocollect-ai
docker compose up -d                          # Postgres 17
npm install
cp apps/api/.env.example apps/api/.env        # Windows: copy apps\api\.env.example apps\api\.env
npm run db:migrate                            # apply SQL migrations
npm run db:seed                               # seed a demo org and user
npm run dev                                   # API :4000 + web :5175
```

Open http://localhost:5175 and sign in as `dev-user@autocollect.local` / `dev-password-auto`
(platform admin: http://localhost:5175/admin/login, `admin@autocollect.local` / `admin123`).
Every external service falls back to a local mock when its keys are empty, and emails are
printed to the API console, so every flow works offline.

| Command | What it does |
|---|---|
| `npm run dev` | API (watch) + web (Vite) |
| `npm run typecheck` | TypeScript across all packages |
| `npm test` | API unit + integration tests (needs the database) |
| `npm run test:e2e` | Builds the app and runs the Playwright browser tests |
| `npm run build` | Production build (shared → API → web) |
| `npm run db:migrate` / `db:roles` / `db:seed` | Schema, least-privilege roles, demo data |
| `npm run smoke` | Post-deploy smoke test (`BASE=https://… npm run smoke`) |

To run the integration tests with Row-Level Security enforced (as CI does), run
`npm run db:roles` and point the test run at the restricted roles:

```bash
DATABASE_URL=postgres://autocollect_app:autocollect_app_dev@localhost:5433/autocollect \
SERVICE_DATABASE_URL=postgres://autocollect_service:autocollect_service_dev@localhost:5433/autocollect \
MIGRATION_DATABASE_URL=postgres://autocollect:autocollect_dev@localhost:5433/autocollect \
npm test
```

## Deploying

- `docs/GO-LIVE.md`: step-by-step launch checklist (accounts, secrets, DNS, verification)
- `docs/PRODUCTION.md`: deploy and operate (Vercel or Docker), runbook, security checklist
- `docs/PRODUCTION-READINESS-REVIEW.md`: audit findings, fixes and roadmap

## Roadmap

- Cash-flow forecasting from payment history and promise-to-pay dates
- Customer-facing payment portal
- Late fees and early-payment discounts
- Xero integration
- Per-workspace sending domains (DKIM) for better deliverability
- Optional TOTP two-factor sign-in for workspace owners

## Author

**Vijayaprathap P**, Senior Full-Stack Engineer
[LinkedIn](https://linkedin.com/in/vjprathap) · [GitHub](https://github.com/vijayaprathap1) · [Email](mailto:pvijayaprathap1@gmail.com)
