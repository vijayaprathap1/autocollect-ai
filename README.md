<<<<<<< HEAD
# AutoCollect AI

Automated B2B invoice chasing for freelancers, agencies, and small businesses.
Connect Stripe (or upload a CSV), approve AI-drafted reminder templates, and get
polite escalating email reminders with 1-click payment links sent automatically.

MVP scope (locked): **Stripe + CSV** sources · **email-only** · **approve-once, then auto-send**.

## Stack


## Layout

```
apps/web       React SPA
apps/api       Fastify API + migrations + seed
packages/shared  shared domain types
infra/         deployment notes
```

## Local development

Prereqs: Node 20+, Docker (for Postgres).

```bash
# 1. Start the database
docker compose up -d

# 2. Install workspace deps
npm install

# 3. Configure the API (dev defaults work out of the box)
copy apps/api/.env.example apps/api/.env

# 4. Migrate + seed
npm run db:migrate
npm run db:seed

# 5. Run API + web concurrently
npm run dev
```


### Dev auth

With no `CLERK_SECRET_KEY` set, the API runs in **dev auth mode**: the SPA's
login screen lets you enter any email, which is sent as `x-dev-user` and
auto-provisions a workspace. Production uses Clerk session JWTs.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run API + web |
| `npm run build` | Build all workspaces |
| `npm run typecheck` | Type-check all workspaces |
| `npm run db:migrate` | Apply pending SQL migrations |
| `npm run db:seed` | Seed dev tenant + default workflow + templates |

## Environment

See `apps/api/.env.example`. External integrations (Stripe, Postmark, Anthropic,
Clerk) are optional locally and degrade to dev fallbacks when keys are absent.

## Stripe Connect OAuth setup

AutoCollect uses Stripe Connect OAuth for **Standard connected accounts**. The
flow is:

1. The tenant admin clicks **Connect Stripe** in Settings.
2. The API creates a signed, single-use OAuth `state` value and redirects to
	Stripe with `scope=read_write`.
3. Stripe redirects to `APP_URL/integrations/stripe/callback`.
4. The API verifies the state and exchanges the one-time code at Stripe's OAuth
	token endpoint.
5. The connected account ID and encrypted OAuth tokens are stored in the
	tenant's Stripe integration, then historical invoices are synced.

### Get the Stripe client ID

1. Sign in to the [Stripe Dashboard](https://dashboard.stripe.com/).
2. Select the correct mode: **Test** while developing, **Live** for production.
3. Open **Connect** and go to **Settings** or **Platform settings**.
4. Open the **OAuth settings** section and enable OAuth for your platform.
5. Add this exact redirect URI under allowed redirect URIs:
	`http://localhost:4000/integrations/stripe/callback`
6. Copy the **Client ID**, which starts with `ca_`. Test and live mode values
	are different; do not substitute the platform account ID (`acct_...`).

Stripe requires production redirect URIs to use HTTPS. Add the production URI
as a separate allowed URI, for example
`https://api.example.com/integrations/stripe/callback`, and set `APP_URL` to
that API origin. The URI sent by AutoCollect must match the Stripe Dashboard
entry exactly, including scheme, hostname, port, and path.

### Configure the API

Put the following values in `apps/api/.env`:

```dotenv
STRIPE_SECRET_KEY=sk_test_...
STRIPE_CONNECT_CLIENT_ID=ca_...
STRIPE_WEBHOOK_SECRET=whsec_...
APP_URL=http://localhost:4000
WEB_ORIGIN=http://localhost:5175
CREDENTIALS_ENCRYPTION_KEY=32-character-secret-for-local-development
OAUTH_STATE_SECRET=another-long-random-secret
```

Use a real 32-character encryption key and a separately generated state secret
in deployed environments. Never commit `.env` or print Stripe keys in logs.

### Test the connection locally

1. Start Postgres and apply migrations with `npm run db:migrate`.
2. Start the API and web app with `npm run dev`.
3. Sign in as a tenant admin and open Settings.
4. Click **Connect Stripe**, then authorize the platform in Stripe's test mode.
5. Confirm the browser returns to `/settings?stripe=connected` and invoices
	appear after the historical sync.

For webhook delivery, run `stripe listen --forward-to
localhost:4000/integrations/stripe/webhook` and put the displayed `whsec_...`
value in `STRIPE_WEBHOOK_SECRET`. Configure the same endpoint and secret in the
Stripe Dashboard for deployed environments.
=======
# autocollect-ai
AI-powered auto-collect project
>>>>>>> origin/main
