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

Requires Node.js 20+ and PostgreSQL.

```bash
git clone https://github.com/vijayaprathap1/autocollect-ai.git
cd autocollect-ai
npm install

# create a .env with DATABASE_URL and the other values read in apps/api/src/config.ts

npm run db:migrate      # apply SQL migrations
npm run db:roles        # create the Postgres roles used for RLS
npm run db:seed         # seed a demo org and user

npm run dev             # starts API and web together
```

Other scripts: `npm run typecheck`, `npm run build`, `npm run test:e2e`.

## Roadmap

- Transactional email provider in production (currently mocked locally)
- AI-drafted reminder emails and reply classification
- Cash-flow forecasting from payment history
- Multi-org switching

## Author

**Vijayaprathap P**, Senior Full-Stack Engineer
[LinkedIn](https://linkedin.com/in/vjprathap) · [GitHub](https://github.com/vijayaprathap1) · [Email](mailto:pvijayaprathap1@gmail.com)
