# AutoCollect AI

Automated B2B invoice collection for freelancers, agencies and small businesses.
Connect Stripe or QuickBooks (or upload a CSV), approve your reminder templates
once, and AutoCollect sends polite, escalating reminders — at your customers'
business hours, with a one-click payment link — until the invoice is paid.
Customer replies are read by AI: disputes pause reminders, promises to pay
snooze them, and your team is notified.

## Stack

| | |
|---|---|
| `apps/api` | Fastify 5 · TypeScript · PostgreSQL (Row-Level Security) · Stripe Connect + Billing · Postmark · Twilio · QuickBooks · Anthropic |
| `apps/web` | React 19 · Vite 6 · TanStack Query · Tailwind |
| `packages/shared` | Shared domain types |
| `e2e/` | Playwright browser tests |
| `docs/` | `PRODUCTION.md` (deploy & operate), `PRODUCTION-READINESS-REVIEW.md` (audit & roadmap) |

## Quick start (local)

Requires Node 20.11+ and Docker (for Postgres on port 5433).

```bash
docker compose up -d                          # 1. Postgres 17
npm install                                   # 2. dependencies
copy apps\api\.env.example apps\api\.env      # 3. config   (macOS/Linux: cp)
npm run db:migrate                            # 4. schema
npm run db:seed                               #    demo workspace
npm run dev                                   # 5. API :4000 + web :5175
```

Open http://localhost:5175 and sign in as `dev-user@autocollect.local` / `dev-password-auto`
(platform admin: http://localhost:5175/admin/login, `admin@autocollect.local` / `admin123`).

Every external service falls back to a local mock when its keys are empty.
Emails (verification links, invites, reminders) are **printed to the API console**
in development, so you can click through every flow offline.

Try the core loop: **Templates** → approve → **Workflows** → Enable →
**Settings → Integrations** → Connect Stripe (demo) → open an invoice → **Send reminder now**.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API (watch) + web (Vite) |
| `npm run typecheck` | TypeScript across all packages |
| `npm test` | API unit + integration tests (needs `DATABASE_URL`) |
| `npm run test:e2e` | Builds the app and runs Playwright browser tests |
| `npm run build` | Production build (shared → API → web) |
| `npm start` | Run the built API (`apps/api/dist/server.js`) |
| `npm run db:migrate` / `db:roles` / `db:seed` | Schema, least-privilege roles, demo data |
| `npm run smoke` | Post-deploy smoke test (`BASE=https://… npm run smoke`) |

### Tests

```bash
# Integration tests exercise Row-Level Security when run with the app role, as CI does:
npm run db:roles
DATABASE_URL=postgres://autocollect_app:autocollect_app_dev@localhost:5433/autocollect \
SERVICE_DATABASE_URL=postgres://autocollect_service:autocollect_service_dev@localhost:5433/autocollect \
MIGRATION_DATABASE_URL=postgres://autocollect:autocollect_dev@localhost:5433/autocollect \
npm test
```

Covered: scheduling (timezones, DST, weekends, catch-up), template rendering and HTML
escaping, CSV parsing, tenant isolation (including a pooled-connection leak regression
test), the full password lifecycle, CSRF, invitations, credit grants, dunning, signed
Stripe webhooks (Connect + billing), and 21 browser flows.

## How it works

- **Invoices in** — Stripe Connect imports open invoices (resumable for large accounts) and
  webhooks keep them in sync; QuickBooks syncs every 15 minutes; CSV import dedupes
  customers and updates on re-upload.
- **Reminders out** — a default 4-step sequence (−2, +1, +7, +14 days around the due date),
  editable per workspace. Nothing sends until templates are approved. Steps fire at the
  workspace's send hour in its timezone, optionally skipping weekends. Invoices imported
  long overdue get only the most relevant reminder, and two reminders are never sent
  less than ~a day apart. Each send costs one credit; failures retry with backoff and
  permanently undeliverable addresses pause the invoice.
- **Payment stops reminders** — `invoice.paid` (Stripe), Payment Link checkout, QuickBooks
  balance → 0, or "Mark paid".
- **Replies** — signed Reply-To routing; AI classification (dispute / promise / question);
  suggested responses in the reply inbox; admins notified by email.
- **Plans & credits** — Starter (free) → Growth → Pro → Agency via Stripe Checkout; plan
  changes and cancellation through the Stripe Customer Portal; credits granted once per
  paid billing period.

## Security model (summary)

- Session cookies: `HttpOnly`, `SameSite=Lax`, `Secure` + `__Host-` prefix in production; server-side sessions (revocable, listed per device).
- Passwords: argon2id; lockout after 5 failures; timing-safe login; reset/verification tokens are single-use and hashed at rest.
- CSRF: Origin allow-list + required `X-Requested-With` on authenticated writes.
- Tenancy: RLS-enforced runtime role + explicit `tenant_id` filters; connections reset before reuse.
- Webhooks: Stripe signatures (multiple endpoint secrets), constant-time Postmark tokens, idempotent processing.
- Production refuses to start with missing or unsafe configuration.

See **`docs/PRODUCTION.md`** to deploy.
