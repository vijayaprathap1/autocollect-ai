# AutoCollect AI — Production Runbook

How to deploy, configure, operate and recover AutoCollect AI. Pair this with
`docs/PRODUCTION-READINESS-REVIEW.md` (what was fixed and why).

---

## 1. Architecture at a glance

```
Browser ──HTTPS──▶  One container (Fastify, Node 22)
                     ├─ /            React SPA (static, immutable hashed assets)
                     ├─ /api/*       JSON API  ── pool (RLS role) ──▶ Postgres 17
                     │                         └─ servicePool (BYPASSRLS role)
                     └─ scheduler    dunning · Stripe import · QBO sync · housekeeping
                                     (DB leases → safe with N replicas)
Stripe ──webhooks──▶ /api/integrations/stripe/webhook   (Connect + billing secrets)
Postmark ─webhooks─▶ /api/email/webhook/postmark  ·  /api/inbound/postmark
```

**Tenant isolation is enforced twice:** every query filters by `tenant_id`, and
Postgres Row-Level Security scopes the runtime role to the current workspace.
The request connection is always reset before it returns to the pool (covered by
an automated regression test).

---

## 2. Recommended hosting

| Option | Fit | Notes |
|---|---|---|
| **Docker on Render / Railway / Fly.io / ECS / a VM** | **Recommended** | One image (`Dockerfile`). Scheduler runs in-process; `/api/health` + `/api/ready` for probes. Scale to 2+ replicas freely. |
| Vercel | Works, with caveats | See **§3.5**. Static SPA + one Node function (`api/index.mjs`). No in-process scheduler: a cron trigger must call `/api/cron/dunning` every 5 min. 60s function limit — dunning runs are time-budgeted (`DUNNING_TIME_BUDGET_MS`). |

Database: any managed Postgres **15+** (17 recommended) with daily backups and
point-in-time recovery (Neon, Supabase, RDS, Cloud SQL, Render Postgres).

---

## 3. First deployment (step by step)

### 3.1 Database and roles
1. Create the database; keep the **owner** credentials for migrations only.
2. Run migrations as the owner:
   ```bash
   MIGRATION_DATABASE_URL=postgres://owner:…@host/db npm run db:migrate
   # or in the image:  node dist/scripts/migrate.js
   ```
3. Create least-privilege runtime roles (DML only, no DDL):
   ```bash
   MIGRATION_DATABASE_URL=postgres://owner:…@host/db \
   APP_DB_PASSWORD='<32+ random>' SERVICE_DB_PASSWORD='<32+ random>' \
   NODE_ENV=production npm run db:roles
   ```
4. Point the app at them:
   - `DATABASE_URL` → `autocollect_app` (RLS enforced)
   - `SERVICE_DATABASE_URL` → `autocollect_service` (BYPASSRLS, used by webhooks/jobs)
   - `MIGRATION_DATABASE_URL` → owner (only for migrate/roles jobs)

Run `db:migrate` on **every deploy, before** the new version starts (a pre-deploy
job on Render/Railway, an ECS task, or `docker run … node dist/scripts/migrate.js`).
Migrations take an advisory lock and are checksummed — never edit an applied
migration; add a new one.

### 3.2 Required environment (production refuses to boot without these)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL`, `SERVICE_DATABASE_URL` | see 3.1 |
| `WEB_ORIGIN` | `https://app.yourdomain.com` |
| `APP_URL` | `https://app.yourdomain.com/api` |
| `CREDENTIALS_ENCRYPTION_KEY` | exactly 32 random characters |
| `OAUTH_STATE_SECRET` | 32+ random characters |
| `CRON_SECRET` | 32+ random characters |
| `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_EMAIL` | from Postmark — **or** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM_ADDRESS` for any SMTP server (no bounce webhooks or inbound reply handling) |
| `POSTMARK_WEBHOOK_TOKEN` | 24+ random characters |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | 12+ characters, not the default |

Generate secrets with `openssl rand -base64 48 | tr -d '/+=' | cut -c1-40`
(and `cut -c1-32` for the encryption key).

Optional groups are all-or-nothing (the app tells you what's missing): Stripe,
Twilio, QuickBooks, Google sign-in. See `apps/api/.env.example` for every setting.

### 3.3 Run it
```bash
docker build -t autocollect-ai --build-arg APP_VERSION=$(git rev-parse --short HEAD) .
docker run --env-file .env.production -p 4000:4000 autocollect-ai
```
Health checks: liveness `GET /api/health`, readiness `GET /api/ready` (checks both DB pools).
Behind a load balancer the app trusts **1** proxy hop by default (`TRUST_PROXY`), so
rate limits and audit IPs use the real client IP.

### 3.5 Deploying to Vercel

How it is wired (`vercel.json`):

- `npm run build:vercel` builds shared → API → web, then runs migrations for **production** deployments
  (preview builds never migrate). The build fails if `MIGRATION_DATABASE_URL` is missing, so a version
  that cannot reach its schema never goes live.
- `apps/web/dist` is served as static files with the security headers (CSP, HSTS, nosniff) and an SPA fallback.
- `/api/*` is rewritten to `api/index.mjs`, which loads the compiled Fastify app (`apps/api/dist/serverless.js`).

Steps:

1. **Database** — create a Postgres 15+ database (e.g. Neon from the Vercel dashboard → Storage). Use the
   **direct (non-pooled)** connection string everywhere: the app scopes each request with a session-level
   setting, which is not safe behind a transaction-mode pooler (PgBouncer / Neon `-pooler` hosts).
   Append `?sslmode=require`.
2. **Schema and roles** — from your machine, against the new database (owner URL):
   ```bash
   export MIGRATION_DATABASE_URL="postgres://owner:…@host/db?sslmode=require"
   npm run db:migrate
   APP_DB_PASSWORD="<32+ random>" SERVICE_DB_PASSWORD="<32+ random>" NODE_ENV=production npm run db:roles
   ```
3. **Environment** (Vercel → Project → Settings → Environment Variables, Production): everything in §3.2,
   with `DATABASE_URL` → `autocollect_app`, `SERVICE_DATABASE_URL` → `autocollect_service`,
   `MIGRATION_DATABASE_URL` → owner, `WEB_ORIGIN=https://<domain>` and `APP_URL=https://<domain>/api`.
   Vercel sets `NODE_ENV=production` itself. Each function instance keeps a small pool
   (`DB_POOL_MAX` 3 + `DB_SERVICE_POOL_MAX` 2 by default on Vercel).
4. **Deploy** — `vercel deploy --prod`, then `BASE=https://<domain> npm run smoke`.
5. **Scheduler** — reminders only go out when something calls `/api/cron/dunning`:
   - **Pro plan:** change the `crons` schedule in `vercel.json` to `*/5 * * * *`.
   - **Hobby plan** (cron jobs limited to once a day): keep the daily crons as a safety net and let
     `.github/workflows/cron.yml` trigger every 5 minutes. Set the repository secrets
     `CRON_URL=https://<domain>/api/cron/dunning` and `CRON_SECRET`. Vercel Hobby is for
     non-commercial use; a product that bills customers needs Pro.

Limits to know: 60 s per invocation (dunning is time-budgeted and resumes on the next trigger), and rate
limits are counted per function instance — add a shared store (Redis) before relying on them at scale.

### 3.4 Verify
```bash
BASE=https://app.yourdomain.com npm run smoke
```
14 checks: health, readiness, CSRF, dev routes disabled, webhooks reject unsigned
calls, security headers, HSTS. Non-zero exit on any failure — use it to gate deploys.

---

## 4. Stripe setup

### 4.1 Connect (reading customers' invoices)
1. Dashboard → **Connect** → Settings → **OAuth**: enable, add redirect URI
   `https://app.yourdomain.com/api/integrations/stripe/callback`.
2. Copy the client id (`ca_…`) → `STRIPE_CONNECT_CLIENT_ID`; secret key → `STRIPE_SECRET_KEY`.
3. **Webhook endpoint #1 — Connected accounts** (“Listen to events on Connected accounts”):
   URL `https://app.yourdomain.com/api/integrations/stripe/webhook`, events:
   `invoice.finalized`, `invoice.updated`, `invoice.paid`, `invoice.payment_failed`,
   `invoice.voided`, `invoice.marked_uncollectible`, `checkout.session.completed`,
   `account.application.deauthorized`.
   Its signing secret → `STRIPE_WEBHOOK_SECRET`.

### 4.2 Billing (customers paying you)
1. Create three recurring monthly Prices → `BILLING_GROWTH_PRICE_ID`, `BILLING_PRO_PRICE_ID`, `BILLING_AGENCY_PRICE_ID`.
2. **Webhook endpoint #2 — Your account** (same URL), events:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid`, `invoice.payment_failed`.
   Its signing secret → `STRIPE_BILLING_WEBHOOK_SECRET`.
3. Configure the **Customer Portal** (Settings → Billing → Customer portal): allow
   payment-method updates, invoice history, plan switching between the three prices,
   and cancellation at period end.

How it behaves: every paid subscription invoice (`invoice.paid`) grants that plan's
monthly credits **once** (idempotent per Stripe invoice). A workspace with an active
subscription is sent to the Portal instead of a second Checkout, so it can't be
double-billed. Cancelled/unpaid subscriptions fall back to Starter.

Local testing: `stripe listen --forward-to localhost:4000/integrations/stripe/webhook`
(put the printed `whsec_…` in `STRIPE_WEBHOOK_SECRET`).

---

## 5. Email (Postmark)

1. Add and verify your sending **domain** (DKIM + Return-Path). Publish SPF and a DMARC
   record (`p=quarantine` once reports look clean). Reminders go out as
   `"<Customer's company name>" <POSTMARK_FROM_EMAIL>`.
2. Server API token → `POSTMARK_SERVER_TOKEN`. Use the transactional `outbound` stream.
3. **Delivery webhook**: `https://app.yourdomain.com/api/email/webhook/postmark?token=<POSTMARK_WEBHOOK_TOKEN>`
   with Delivery, Bounce, Spam complaint, Open, Link click, Subscription change.
   Hard bounces, complaints and unsubscribes pause the invoice automatically.
4. **Inbound (customer replies)**: set the server's inbound webhook to
   `https://app.yourdomain.com/api/inbound/postmark?token=<POSTMARK_WEBHOOK_TOKEN>` and put the
   inbound address in `INBOUND_REPLY_ADDRESS` (e.g. `abc123@inbound.postmarkapp.com`, or a
   custom inbound domain). Reminders then carry a signed `Reply-To` so every reply lands
   on the right invoice; disputes pause reminders, promises to pay snooze them.

---

## 6. Google sign-in (optional)
Create an OAuth client (Web). Authorized redirect URI:
`https://app.yourdomain.com/api/auth/google/callback`. Set `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET`. The button appears automatically once configured.

---

## 7. Operating the system

### Logs
One JSON line per request (`reqId`, `tenantId`, `userId`, status, duration, IP). Every
error response carries a `requestId` that users can quote to support. Unhandled 5xx are
POSTed to `ERROR_WEBHOOK_URL` (Slack/Discord/incident tool).

### Useful queries (run as the owner or service role)
```sql
-- Webhooks that failed and will be retried by the provider
SELECT id, source, attempts, error, processed_at FROM webhook_events WHERE status = 'failed' ORDER BY processed_at DESC LIMIT 50;

-- Reminder failures in the last day
SELECT tenant_id, detail FROM audit_log
 WHERE action IN ('dunning_send_failed','dunning_send_gave_up_invoice_paused','dunning_error')
   AND created_at > now() - interval '1 day' ORDER BY created_at DESC;

-- Is the scheduler alive? (leases are refreshed each run)
SELECT job_name, holder_id, expires_at FROM job_leases;

-- Tenants out of credits with open invoices
SELECT t.name, w.balance, count(i.*) AS open_invoices
  FROM tenants t JOIN credit_wallets w ON w.tenant_id = t.id
  JOIN invoices i ON i.tenant_id = t.id AND i.status = 'open'
 WHERE w.balance = 0 GROUP BY 1,2 ORDER BY 3 DESC;
```

### Admin console (`/admin/login`)
Create workspaces (owner gets a set-password email), suspend/reactivate (signs members
out and pauses reminders), set plans manually, grant/adjust credits, unlock users. Every
action is written to `audit_log` as `admin:<email>`.

### Scaling
- Replicas: safe. Dunning, Stripe import, QBO sync and housekeeping each take a DB lease.
- Connections: each replica uses up to `DB_POOL_MAX` (10) + `DB_SERVICE_POOL_MAX` (5).
  Size Postgres `max_connections` (or use PgBouncer in transaction mode for the app role).
- Rate limits are per replica (in-memory). For strict global limits add a Redis store
  to `@fastify/rate-limit`.
- To isolate background work: run one replica with `RUN_SCHEDULER=true` and the rest with `false`.

### Backups & recovery
Enable daily snapshots + PITR (7–30 days). Test a restore quarterly. After a restore,
run `db:migrate` (idempotent) and the smoke test.

### Secret rotation
- `CREDENTIALS_ENCRYPTION_KEY`: stored QBO tokens are encrypted with it — rotate by
  reconnecting QuickBooks after the change.
- `OAUTH_STATE_SECRET`: rotating invalidates in-flight OAuth attempts and existing
  reply-routing addresses (older replies then match by email threading instead).
- `POSTMARK_WEBHOOK_TOKEN` / `CRON_SECRET`: update the provider/cron first, then the app.

---

## 8. Security checklist (pre-launch)
- [ ] `NODE_ENV=production` (dev-login, simulators and mocks are then impossible)
- [ ] Runtime uses `autocollect_app` / `autocollect_service`, not the owner
- [ ] HTTPS only; HSTS header present (smoke test checks it)
- [ ] Postmark domain has SPF, DKIM and DMARC
- [ ] Both Stripe webhook endpoints created with their own secrets
- [ ] Super-admin password is unique and stored in a password manager
- [ ] Backups + PITR enabled and a restore tested
- [ ] `ERROR_WEBHOOK_URL` wired to an alert channel
- [ ] `npm audit --omit=dev` clean (CI enforces `high`)
