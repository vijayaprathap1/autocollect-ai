# AutoCollect AI — Go-Live Guide (step by step)

Everything in the code is ready. This guide covers the accounts, settings and secrets
that only you can set up. Work through the phases in order, ticking each box. Each step
says **where** to click, **what** to copy, and **which environment variable** it goes in.

> Deployment target: **Vercel** (the repo is already linked to the Vercel project
> `autocollect-ai`). Throughout this guide, replace `app.yourdomain.com` with your real
> domain and `yourdomain.com` with the domain you send email from.

**Time needed:** about 3–4 hours, plus up to 48 hours for DNS records and Stripe/Postmark
account approval.

---

## Progress at a glance

| Phase | What | Required? | Done |
|---|---|---|---|
| 0 | Merge the code to `main` | Yes | ☐ |
| 1 | Domain + Vercel Pro | Yes | ☐ |
| 2 | Generate secrets | Yes | ☐ |
| 3 | Production database (Neon) | Yes | ☐ |
| 4 | Redis for rate limits (Upstash) | Yes on Vercel | ☐ |
| 5 | Email (Postmark) | Yes | ☐ |
| 6 | Stripe (Connect + Billing) | Yes, to take payments | ☐ |
| 7 | Vercel environment variables + deploy | Yes | ☐ |
| 8 | Scheduler (reminders every 5 min) | Yes | ☐ |
| 9 | Monitoring + alerts | Yes | ☐ |
| 10 | Optional: Google sign-in, QuickBooks, SMS, AI replies | Optional | ☐ |
| 11 | Legal review | Yes | ☐ |
| 12 | Verify end to end | Yes | ☐ |

Keep a password manager (1Password, Bitwarden…) open: every secret you create below
goes in there **and** in Vercel. Never commit secrets to Git or paste them in chat.

---

## Phase 0 — Merge the code to `main`

The production fixes are on the `dev` branch in a pull request.

- [ ] 0.1 Open the pull request on GitHub (`dev` → `main`) and wait for the **CI** check to go green.
- [ ] 0.2 If CI fails, open the failed run → copy the error → send it to Claude to fix.
- [ ] 0.3 Click **Merge pull request**.

---

## Phase 1 — Domain and Vercel plan

- [ ] 1.1 **Upgrade Vercel to Pro** — Vercel dashboard → your team → **Settings → Billing**.
  Hobby is for non-commercial use only and runs cron jobs only once a day; this product
  charges customers, so Pro is required.
- [ ] 1.2 **Add your domain** — Vercel → project `autocollect-ai` → **Settings → Domains** →
  add `app.yourdomain.com`. Vercel shows a DNS record (usually a `CNAME` to
  `cname.vercel-dns.com`). Add it at your domain registrar (GoDaddy, Namecheap, Cloudflare…).
- [ ] 1.3 Wait until Vercel shows **Valid Configuration** with a green tick (minutes to a few hours).

From here on, your two key URLs are:

| Name | Value |
|---|---|
| `WEB_ORIGIN` | `https://app.yourdomain.com` |
| `APP_URL` | `https://app.yourdomain.com/api` |

---

## Phase 2 — Generate secrets

Run these in a terminal in the project folder (PowerShell or Git Bash both work). Each
command prints a new random value; run it once per secret.

```bash
# exactly 32 characters (for CREDENTIALS_ENCRYPTION_KEY)
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

# 43 characters (for everything else)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

- [ ] 2.1 `CREDENTIALS_ENCRYPTION_KEY` — the **32-character** one. ⚠️ Never change it after
  launch without reconnecting QuickBooks (it encrypts stored tokens).
- [ ] 2.2 `OAUTH_STATE_SECRET` — 43 characters.
- [ ] 2.3 `CRON_SECRET` — 43 characters.
- [ ] 2.4 `POSTMARK_WEBHOOK_TOKEN` — 43 characters.
- [ ] 2.5 `APP_DB_PASSWORD` — 43 characters (database password, used in Phase 3).
- [ ] 2.6 `SERVICE_DB_PASSWORD` — 43 characters (database password, used in Phase 3).
- [ ] 2.7 `SUPER_ADMIN_EMAIL` — your own email address (platform admin login at `/admin/login`).
- [ ] 2.8 `SUPER_ADMIN_PASSWORD` — a strong password, 12+ characters, not reused anywhere.

---

## Phase 3 — Production database (Neon Postgres)

- [ ] 3.1 Vercel → project → **Storage → Create Database → Neon** (or sign up at neon.tech).
  Region: the same as your Vercel functions (default `iad1` / US East).
- [ ] 3.2 In Neon → your project → **Settings → Backup & restore**: turn on point-in-time
  restore and keep at least **7 days** (paid plan recommended for 30 days).
- [ ] 3.3 In Neon → **Connection Details**: turn **Connection pooling OFF** and copy the
  **direct** connection string. It looks like
  `postgresql://neondb_owner:XXXX@ep-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require`.
  ⚠️ The host must **not** contain `-pooler` — the app's tenant isolation is not safe
  behind a transaction pooler.
  This is your **owner URL** → it becomes `MIGRATION_DATABASE_URL`.
- [ ] 3.4 Create the tables and the two restricted roles. In PowerShell, from the project folder:

  ```powershell
  $env:NODE_ENV = "production"
  $env:MIGRATION_DATABASE_URL = "postgresql://neondb_owner:XXXX@ep-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require"
  $env:APP_DB_PASSWORD = "<value from 2.5>"
  $env:SERVICE_DB_PASSWORD = "<value from 2.6>"
  npm run db:migrate
  npm run db:roles
  ```

  Expected output ends with `role ready: autocollect_app`, `role ready: autocollect_service`.
  Close the terminal afterwards so the passwords don't linger in the session.
- [ ] 3.5 Build the two runtime URLs by swapping the user and password in the owner URL:

  | Variable | Value |
  |---|---|
  | `DATABASE_URL` | `postgresql://autocollect_app:<APP_DB_PASSWORD>@ep-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require` |
  | `SERVICE_DATABASE_URL` | `postgresql://autocollect_service:<SERVICE_DB_PASSWORD>@ep-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require` |
  | `MIGRATION_DATABASE_URL` | the owner URL from 3.3 |

  > If your Neon integration added `DATABASE_URL`/`POSTGRES_*` variables to Vercel
  > automatically, **overwrite** `DATABASE_URL` with the `autocollect_app` URL above —
  > the app must not run as the owner.

---

## Phase 4 — Redis for rate limits (Upstash)

Without this, every Vercel instance counts requests separately and the brute-force/abuse
limits are close to meaningless.

- [ ] 4.1 Vercel → project → **Storage → Create Database → Upstash for Redis** (free tier is
  enough). Same region as the database.
- [ ] 4.2 Open it → copy the **TLS** URL that starts with `rediss://` (two s's).
- [ ] 4.3 This value is `REDIS_URL`. (If Vercel auto-adds `KV_URL`/`REDIS_URL`, make sure
  `REDIS_URL` is the `rediss://` one.)

---

## Phase 5 — Email (Postmark)

### 5A. Account and sending domain
- [ ] 5.1 Sign up at postmarkapp.com. New accounts start in **test mode** (can only email
  your own domain) — click **Request approval** early; it can take a day.
- [ ] 5.2 **Sender Signatures → Add Domain** → `yourdomain.com`. Postmark shows DNS records.
  Add them at your registrar:
  - [ ] **DKIM** — a `TXT` record (name like `20261015._domainkey`).
  - [ ] **Return-Path** — a `CNAME` (`pm-bounces` → `pm.mtasv.net`).
  - [ ] **SPF** — if you already have an SPF `TXT` record, add `include:spf.mtasv.net` to it;
    don't create a second SPF record.
  - [ ] **DMARC** — a `TXT` record named `_dmarc` with value
    `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` (change `p=none` to
    `p=quarantine` after two clean weeks).
- [ ] 5.3 Wait until Postmark shows DKIM and Return-Path as **Verified**.

### 5B. Server token and sender
- [ ] 5.4 **Servers → Create server** (e.g. "AutoCollect Production") → **API Tokens** →
  copy the **Server API token** → `POSTMARK_SERVER_TOKEN`.
- [ ] 5.5 Pick the from address, e.g. `reminders@yourdomain.com` → `POSTMARK_FROM_EMAIL`.
  (Reminders show as `"<Customer's company>" <reminders@yourdomain.com>`.)
- [ ] 5.6 `EMAIL_PROVIDER` = `postmark`.

### 5C. Webhooks (use the token from step 2.4)
- [ ] 5.7 Server → **Default Transactional Stream → Webhooks → Add webhook**:
  - URL: `https://app.yourdomain.com/api/email/webhook/postmark?token=<POSTMARK_WEBHOOK_TOKEN>`
  - Tick: **Delivery, Bounce, Spam Complaint, Open, Link Click, Subscription Change**.
  - Click **Send test** → expect a 200 response.
  (Hard bounces, complaints and unsubscribes then pause that invoice automatically.)
- [ ] 5.8 Server → **Default Inbound Stream → Settings**:
  - **Webhook URL**: `https://app.yourdomain.com/api/inbound/postmark?token=<POSTMARK_WEBHOOK_TOKEN>`
  - Copy the **inbound email address** shown there (like `abc123def@inbound.postmarkapp.com`)
    → `INBOUND_REPLY_ADDRESS`. Customer replies to reminders now land on the right invoice
    and are classified (dispute → pause, promise to pay → snooze).

---

## Phase 6 — Stripe (live mode)

Do this in the Stripe dashboard with **Test mode switched OFF** (top right). Your Stripe
account must be **activated** (business details + bank account) first.

### 6A. API key
- [ ] 6.1 **Developers → API keys** → reveal the **Secret key** (`sk_live_…`) → `STRIPE_SECRET_KEY`.

### 6B. Connect (reading your customers' invoices)
- [ ] 6.2 **Connect → Get started** (choose platform type "Standard accounts" / OAuth) and
  complete the platform profile.
- [ ] 6.3 **Connect → Settings → OAuth**: turn on **OAuth for Standard accounts**; under
  **Redirects** add `https://app.yourdomain.com/api/integrations/stripe/callback`.
- [ ] 6.4 Copy the **Live mode client ID** (`ca_…`) → `STRIPE_CONNECT_CLIENT_ID`.
- [ ] 6.5 **Developers → Webhooks → Add endpoint** — endpoint **#1, Connected accounts**:
  - URL: `https://app.yourdomain.com/api/integrations/stripe/webhook`
  - **Listen to: Events on Connected accounts**
  - Events: `invoice.finalized`, `invoice.updated`, `invoice.paid`, `invoice.payment_failed`,
    `invoice.voided`, `invoice.marked_uncollectible`, `checkout.session.completed`,
    `account.application.deauthorized`
  - After saving, reveal the **Signing secret** (`whsec_…`) → `STRIPE_WEBHOOK_SECRET`.

### 6C. Billing (your customers paying you)
- [ ] 6.6 **Product catalog → Add product** three times, each with a **recurring monthly** price:
  - "Growth" → copy its price ID (`price_…`) → `BILLING_GROWTH_PRICE_ID`
  - "Pro" → `BILLING_PRO_PRICE_ID`
  - "Agency" → `BILLING_AGENCY_PRICE_ID`
- [ ] 6.7 **Developers → Webhooks → Add endpoint** — endpoint **#2, Your account**:
  - URL: the **same** `https://app.yourdomain.com/api/integrations/stripe/webhook`
  - **Listen to: Events on Your account**
  - Events: `checkout.session.completed`, `customer.subscription.created`,
    `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
    `invoice.payment_failed`
  - Signing secret (`whsec_…`) → `STRIPE_BILLING_WEBHOOK_SECRET`.
- [ ] 6.8 **Settings → Billing → Customer portal**: activate it and allow
  - updating payment methods, viewing invoice history,
  - switching plans between Growth / Pro / Agency,
  - cancelling **at end of billing period**.
- [ ] 6.9 **Settings → Business → Public details**: set business name, support email and
  statement descriptor (what appears on card statements).

---

## Phase 7 — Vercel environment variables and first deploy

- [ ] 7.1 Vercel → project → **Settings → Environment Variables**. Add each variable below
  for the **Production** environment (tick only *Production*; previews must not touch the
  production database). Mark every secret as **Sensitive**.

  | Variable | Value from |
  |---|---|
  | `WEB_ORIGIN` | Phase 1 — `https://app.yourdomain.com` |
  | `APP_URL` | Phase 1 — `https://app.yourdomain.com/api` |
  | `DATABASE_URL` | 3.5 (`autocollect_app`) |
  | `SERVICE_DATABASE_URL` | 3.5 (`autocollect_service`) |
  | `MIGRATION_DATABASE_URL` | 3.3 (owner URL) |
  | `REDIS_URL` | 4.2 |
  | `CREDENTIALS_ENCRYPTION_KEY` | 2.1 |
  | `OAUTH_STATE_SECRET` | 2.2 |
  | `CRON_SECRET` | 2.3 |
  | `POSTMARK_WEBHOOK_TOKEN` | 2.4 |
  | `SUPER_ADMIN_EMAIL` | 2.7 |
  | `SUPER_ADMIN_PASSWORD` | 2.8 |
  | `EMAIL_PROVIDER` | `postmark` |
  | `POSTMARK_SERVER_TOKEN` | 5.4 |
  | `POSTMARK_FROM_EMAIL` | 5.5 |
  | `EMAIL_FROM_NAME` | `AutoCollect AI` (or your brand) |
  | `INBOUND_REPLY_ADDRESS` | 5.8 |
  | `STRIPE_SECRET_KEY` | 6.1 |
  | `STRIPE_CONNECT_CLIENT_ID` | 6.4 |
  | `STRIPE_WEBHOOK_SECRET` | 6.5 |
  | `STRIPE_BILLING_WEBHOOK_SECRET` | 6.7 |
  | `BILLING_GROWTH_PRICE_ID` | 6.6 |
  | `BILLING_PRO_PRICE_ID` | 6.6 |
  | `BILLING_AGENCY_PRICE_ID` | 6.6 |
  | `ERROR_WEBHOOK_URL` | 9.1 (add now if you have it, or later) |

  Do **not** set `NODE_ENV` (Vercel sets `production` itself). Optional variables from
  Phase 10 can be added later.

- [ ] 7.2 Vercel → **Deployments** → latest `main` deployment → **⋯ → Redeploy** (or push to
  `main`). The build runs migrations and creates your admin user automatically.
- [ ] 7.3 If the build or first request fails with
  `Missing or unsafe production configuration: - …`, the message lists exactly which
  variable is missing or too short. Fix it in 7.1 and redeploy.
- [ ] 7.4 Open `https://app.yourdomain.com/api/ready` → must show a JSON response with
  status 200 (both database connections OK).

---

## Phase 8 — Scheduler (sends reminders)

Reminders are only sent when something calls `/api/cron/dunning`. Pick **one**:

**Option A — Vercel Cron (Pro plan, simplest)**
- [ ] 8.1 Ask Claude to change the `crons` schedule for `/api/cron/dunning` in `vercel.json`
  from `0 6 * * *` to `*/5 * * * *`, merge, and deploy. Vercel automatically sends
  `CRON_SECRET` with each call.

**Option B — GitHub Actions (already in the repo)**
- [ ] 8.1 GitHub → repo → **Settings → Secrets and variables → Actions → New repository secret**:
  - `CRON_URL` = `https://app.yourdomain.com/api/cron/dunning`
  - `CRON_SECRET` = value from 2.3
- [ ] 8.2 **Actions → Scheduled jobs → Run workflow** once; it should finish green.
  (GitHub can delay scheduled runs under load and pauses them after 60 days without commits.)

- [ ] 8.3 Check it's alive: after 10 minutes, Vercel → project → **Logs**, filter
  `/api/cron/dunning` → entries with status 200.

---

## Phase 9 — Monitoring and alerts

- [ ] 9.1 **Error alerts** — create an incoming webhook in Slack (*Apps → Incoming Webhooks*)
  or Discord (*Channel settings → Integrations → Webhooks*) → copy the URL →
  `ERROR_WEBHOOK_URL` in Vercel → redeploy. Every server error is then posted there.
- [ ] 9.2 **Uptime monitor** — free account at UptimeRobot or Better Stack → HTTP monitor on
  `https://app.yourdomain.com/api/ready`, every 5 minutes, alert to your email/phone.
- [ ] 9.3 **Backups** — confirm Neon point-in-time restore is on (3.2). Put a calendar
  reminder every 3 months to test a restore into a branch database.
- [ ] 9.4 **Postmark** — Server → **Settings → Notifications**: enable bounce-rate and
  spam-complaint alerts.

---

## Phase 10 — Optional integrations

Each group is all-or-nothing: set **all** of its variables or none. Redeploy after adding.

### Google sign-in
- [ ] Google Cloud Console → **APIs & Services → OAuth consent screen**: External, app name,
  support email, your domain; publish the app.
- [ ] **Credentials → Create credentials → OAuth client ID → Web application**:
  - Authorized JavaScript origin: `https://app.yourdomain.com`
  - Authorized redirect URI: `https://app.yourdomain.com/api/auth/google/callback`
- [ ] `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. The "Continue with Google" button appears automatically.

### QuickBooks Online
- [ ] developer.intuit.com → **Create an app** (QuickBooks Online and Payments, scope *Accounting*).
- [ ] **Production keys** → redirect URI `https://app.yourdomain.com/api/integrations/qbo/callback`.
  Intuit requires a short app assessment questionnaire before production keys work.
- [ ] `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENV=production`.

### SMS reminders (Twilio)
- [ ] twilio.com → buy a phone number; for US numbers complete **A2P 10DLC** registration.
- [ ] `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (e.g. `+15551234567`).

### AI reply classification (Anthropic)
Without a key, replies are classified by simple keyword rules.
- [ ] console.anthropic.com → **API Keys → Create key**; add billing credit.
- [ ] `ANTHROPIC_API_KEY`. Optionally set `ANTHROPIC_MODEL` (ask Claude for the current recommended model).

---

## Phase 11 — Legal (before taking real customers)

- [ ] 11.1 Have a lawyer review the **Terms** (`/terms`) and **Privacy Policy** (`/privacy`).
  The text lives in `apps/web/src/pages/Legal.tsx`; send Claude any changes.
- [ ] 11.2 Prepare a **Data Processing Agreement (DPA)** for business customers — you
  process their customers' personal data on their behalf. Your lawyer can provide a template.
- [ ] 11.3 Confirm the contact email on the site. It is currently **`support@botly.in`**
  (`CONTACT_EMAIL` in `apps/web/src/components/marketing.tsx`). Tell Claude if it should change,
  and make sure that mailbox is monitored.
- [ ] 11.4 Check the subprocessor list on the Privacy page matches what you actually enabled
  (e.g. remove Twilio/QuickBooks/Anthropic if you didn't turn them on).
- [ ] 11.5 Tell every workspace (or add to onboarding) to fill in **Settings → Branding →
  Business address** — it appears in the footer of every reminder email.

---

## Phase 12 — Verify end to end

### 12A. Automated smoke test (2 minutes)
- [ ] From Git Bash in the project folder:
  ```bash
  BASE=https://app.yourdomain.com npm run smoke
  ```
  All checks must say **PASS** (health, readiness, CSRF, dev routes disabled, webhooks
  reject unsigned calls, security headers, HSTS).

### 12B. Manual walkthrough (30 minutes, with real money — refund afterwards)
- [ ] Sign up at `https://app.yourdomain.com/signup` with a real email → verification email
  arrives (check spam) → link signs you in.
- [ ] **Settings → Branding**: enter a business address.
- [ ] **Settings → Billing → Choose Growth** → pay with a real card → plan shows **Growth** and
  credits increase. Then **Manage billing** opens the Stripe portal. Refund the payment in Stripe.
- [ ] **Settings → Integrations → Connect Stripe** → authorise with a Stripe account that has
  an open invoice → the invoice appears under **Invoices** within a minute.
- [ ] **Templates** → approve all → **Workflows** → enable.
- [ ] Open an invoice whose customer email is **your own** address → **Send reminder now** →
  the email arrives, shows the company name, the pay button and the footer with the business address.
- [ ] **Reply** to that email with "I will pay next Friday" → within a minute it appears under
  **Replies**, classified as a promise to pay, and the invoice is snoozed.
- [ ] Pay the invoice via the pay link (or mark it paid in Stripe) → the invoice shows **Paid**
  and no more reminders are scheduled.
- [ ] Log in at `https://app.yourdomain.com/admin/login` with the super-admin credentials →
  the admin console loads.
- [ ] **Settings → Workspace → Export workspace data** downloads a JSON file.
- [ ] Your Slack/Discord alert channel and uptime monitor show no errors.

### 12C. Hand-off back to Claude
Send Claude: your domain, the smoke-test output, and any step that failed (copy the exact
error text or a screenshot). **Do not send secrets** — variable names are enough.

---

## After launch — routine operations

| When | What |
|---|---|
| Every deploy | CI must be green; run `BASE=https://app.yourdomain.com npm run smoke` afterwards |
| Weekly | Glance at error alerts, Postmark bounce rate, and Vercel logs for `/api/cron/dunning` |
| Monthly | `npm audit --omit=dev` (CI also enforces this) |
| Quarterly | Test a Neon restore into a branch; rotate `SUPER_ADMIN_PASSWORD` |
| Customer asks for their data / deletion | They can do it themselves: **Settings → Workspace** (export, delete workspace) and **Settings → Your account** (delete account) |

Useful database queries for troubleshooting are in `docs/PRODUCTION.md` §7.
