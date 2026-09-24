# AutoCollect AI

Automated B2B invoice chasing for freelancers, agencies, and small businesses.
Connect Stripe (or upload a CSV), approve the reminder templates once, and
AutoCollect sends polite, escalating email reminders with a one-click payment
link until the invoice is paid.

## Layout

```
apps/web         React SPA (Vite, port 5175)
apps/api         Fastify API + SQL migrations + seed (port 4000)
packages/shared  shared domain types
e2e/             Playwright UI tests
scripts/         end-to-end API flow tests
```

## Local development

Prereqs: Node 20+, Docker (for Postgres on port 5433).

```bash
docker compose up -d                          # 1. Postgres
npm install                                   # 2. deps
copy apps\api\.env.example apps\api\.env      # 3. config (cp on macOS/Linux)
npm run db:migrate                            # 4. schema
npm run db:seed                               #    demo workspace
npm run dev                                   # 5. API :4000 + web :5175
```

Open http://localhost:5175 and sign in with `dev-user@autocollect.local` /
`dev-password-auto`. Every external service (Stripe, Postmark, Anthropic, QBO,
Twilio) falls back to a local mock when its keys are empty, so the whole flow
works offline.

To see a reminder go out: Templates → approve all → Workflows → enable →
Settings → Connect Stripe (mock) → open an invoice → **Send now**.

### Testing

```bash
npm run typecheck && npm run build
npm run test:e2e                                  # Playwright UI tests
bash scripts/e2e-flow.sh                          # API flows (mock mode, API on :4000)
npx tsx scripts/e2e-production-paths.ts           # signed Stripe webhooks, scheduler
```

`e2e-production-paths.ts` needs an API started with
`STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_e2e POSTMARK_WEBHOOK_TOKEN=pm_e2e DUNNING_SCAN_INTERVAL_MS=2000 PORT=4001`
(see the header of the script).

## How the core flows work

- **Invoices in:** Stripe Connect OAuth imports the account's *open* invoices,
  then webhooks (`invoice.finalized/updated/voided/marked_uncollectible/paid`)
  keep them in sync. CSV import is on the Settings page.
- **Reminders out:** every workspace starts with a 4-step sequence
  (−2, +1, +7, +14 days from due date). Templates must be approved once; the
  scheduler (or Vercel cron) then sends due steps. Each send costs 1 credit.
  Failed sends are retried with backoff (5 automatic attempts); "Send now"
  retries immediately.
- **Payment stops reminders:** `invoice.paid` for Stripe invoices, or
  `checkout.session.completed` for Payment Links created for CSV invoices.
- **Delivery tracking:** Postmark delivery/open/click/bounce webhooks update each
  message. A hard bounce or spam complaint pauses the invoice.

## Stripe setup

1. Dashboard → **Connect** → Settings → OAuth: enable OAuth, add the redirect
   URI `APP_URL/integrations/stripe/callback`
   (local: `http://localhost:4000/integrations/stripe/callback`). Copy the
   **Client ID** (`ca_...`) → `STRIPE_CONNECT_CLIENT_ID`.
2. Developers → API keys → **Secret key** (`sk_test_...`) → `STRIPE_SECRET_KEY`.
3. Webhooks:
   - **Local:** `stripe listen --forward-to localhost:4000/integrations/stripe/webhook`
     and put the printed `whsec_...` in `STRIPE_WEBHOOK_SECRET` (restart the API).
   - **Production:** add an endpoint `APP_URL/integrations/stripe/webhook` with
     **"Listen to events on Connected accounts"** enabled, events
     `invoice.finalized`, `invoice.updated`, `invoice.paid`,
     `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`,
     `checkout.session.completed`. Copy its signing secret (`whsec_...`).
     If you sell plans, add a second **platform** endpoint (same URL) for
     `checkout.session.completed` and `customer.subscription.deleted`.

`STRIPE_WEBHOOK_SECRET` is the endpoint's signing secret (`whsec_...`), not an
account id (`acct_...`).

## Postmark setup

- Server → API Tokens → `POSTMARK_SERVER_TOKEN`; a verified sender →
  `POSTMARK_FROM_EMAIL`.
- Generate a random `POSTMARK_WEBHOOK_TOKEN`, then in Postmark add webhooks:
  - delivery events → `APP_URL/email/webhook/postmark?token=<POSTMARK_WEBHOOK_TOKEN>`
    (Delivery, Bounce, Spam complaint, Open, Link click)
  - inbound replies → `APP_URL/inbound/postmark?token=<POSTMARK_WEBHOOK_TOKEN>`

## Production (Vercel)

`vercel.json` serves the SPA and runs the API as a function under `/api`.
Set these environment variables in Vercel:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | RLS-enforced app role (`npm run db:roles` creates `autocollect_app`) |
| `SERVICE_DATABASE_URL` | BYPASSRLS service role (`autocollect_service`) — webhooks/cron need it |
| `APP_URL` | `https://<your-domain>/api` |
| `WEB_ORIGIN` | `https://<your-domain>` |
| `CREDENTIALS_ENCRYPTION_KEY` | exactly 32 random characters |
| `OAUTH_STATE_SECRET` | long random string |
| `CRON_SECRET` | long random string (Vercel Cron sends it as `Authorization: Bearer`) |
| `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_EMAIL`, `POSTMARK_WEBHOOK_TOKEN` | see above |
| `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_WEBHOOK_SECRET` | live-mode values |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | redirect URI `APP_URL/auth/google/callback` |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | not the defaults |
| `ANTHROPIC_API_KEY` | optional (AI template drafts) |

Run `npm run db:migrate` against the production database on every deploy. The
API refuses to start in production if required settings are missing or unsafe.

Vercel Cron triggers `/api/cron/dunning` every 5 minutes. Vercel's Hobby plan
limits how often crons run; on Hobby, use Pro or an external scheduler that
calls the route with the `x-cron-secret` header.
On a long-lived host (`npm start` in `apps/api`) the in-process scheduler runs
instead.
