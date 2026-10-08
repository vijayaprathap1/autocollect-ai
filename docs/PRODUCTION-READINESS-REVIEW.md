# AutoCollect AI — Production Readiness Review

Scope: the whole monorepo (API, web, database, integrations, build and deploy).
Method: read every flow end-to-end, fix the defect at its root, then prove the fix with an
automated test, a scripted API flow or a browser run. Deploy steps: `docs/PRODUCTION.md`.

---

## 1. Verdict

| Area | Before | After |
|---|---|---|
| Tenant isolation | RLS present but a pooled connection could keep the previous tenant's id; policies failed on empty GUC | Connections reset on release (regression-tested, mutation-verified); NULL-safe policies; RLS on `tenants` |
| Authentication | Several gaps (no lockout, enumeration, weak reset/verify flows, no session management) | Complete lifecycle: signup → verify → login → forgot/reset → change password → sessions → logout |
| Billing | Checkout could double-subscribe; credits could be granted twice; one webhook secret only | Portal for existing subscribers, idempotent credit grants per Stripe invoice, multi-secret webhooks |
| Dunning engine | Transaction held across network sends; overdue imports blasted every step; no timezone | Claim → send → record; catch-up picks one step; ≥20h gap; tenant timezone/send hour/weekends |
| Operability | No health/readiness, no scheduler for long-lived hosts, no deploy docs | `/health` + `/ready`, in-process scheduler with DB leases, Docker image, CI, runbook, smoke test |
| Tests | None meaningful | 27 unit + 16 integration + 21 browser tests |

**Status: ready for a controlled production launch** once the environment is configured
(`docs/PRODUCTION.md` §3) and the items in §5 "Before launch" are done.

---

## 2. Findings and fixes (by severity)

### Critical
| # | Finding | Fix | Verified by |
|---|---|---|---|
| C1 | **Cross-tenant data leak**: `app.tenant_id` was set per session and not reset when the connection returned to the pool; the next request on that connection could read another tenant's rows. | `ROLLBACK; RESET app.tenant_id; RESET app.user_id` on every release (abort-safe, idempotent); request client released on response *and* on abort. | Integration test with `DB_POOL_MAX=1`; removing the reset makes it fail (mutation test). |
| C2 | RLS policies cast `current_setting()` directly — an empty GUC raised errors or (with superuser) bypassed scoping. | Migration 027: `NULLIF(current_setting(...),'')::uuid` in all policies; RLS enabled on `tenants`. | RLS integration tests run as the non-owner `autocollect_app` role. |
| C3 | Dunning held a DB transaction open during email/SMS sends → pool exhaustion and duplicate sends on retry. | Claim (short txn) → send (no txn) → record; provider message ids stored; permanent failures pause the invoice. | Dunning integration tests; `runDunningDetailed` counters. |
| C4 | Invoices imported long overdue received **every** reminder step at once. | `stepToSend` catch-up (only the most relevant step) + minimum 20h gap derived from `messages.sent_at`. | Unit tests (`schedule.test.ts`). |
| C5 | Double billing: a subscribed workspace could start a second Checkout; credits granted on every webhook retry. | Redirect to Customer Portal when a live subscription exists; unique partial index `idx_credit_txn_plan_grant_once`; one subscription row per tenant. | `stripe-webhooks.test.ts` (replayed events grant once). |
| C6 | Nested pool acquisition inside webhook/ingest paths deadlocked under load. | `withServiceTenant` reuses one service connection; CSV import uses the request client. | Reproduced with `DB_POOL_MAX=1`, then passing. |

### High
| # | Finding | Fix |
|---|---|---|
| H1 | No brute-force protection; user enumeration on login/forgot/signup. | Lockout after 5 failures (15 min), dummy-hash timing equalisation, generic responses; "account exists" email instead of a signup error. |
| H2 | Sessions not bound to a tenant; suspended tenants and removed members kept access. | `sessions.tenant_id`; `authenticate` rejects suspended tenants and revoked memberships; suspension signs everyone out. |
| H3 | Password reset did not revoke other sessions; no change-password or device list. | Reset/change revoke all other sessions, send a "password changed" email; Account tab lists and revokes sessions. |
| H4 | CSRF relied on a plugin not wired to routes. | Origin allow-list + mandatory `X-Requested-With` on authenticated writes (smoke-tested). |
| H5 | Stripe Connect: same Stripe account connectable to multiple workspaces; `account.application.deauthorized` ignored; only one webhook secret. | Unique active-account index, deauthorization handling, multiple secrets (Connect + billing endpoints). |
| H6 | Google OAuth: state not bound to the browser; account pre-hijack possible. | Nonce cookie bound to signed state; unverified local account is not silently merged. |
| H7 | Production could boot with mock email, default admin password or missing secrets. | `validateProductionConfig` refuses to start and lists what is missing. |
| H8 | Reply routing trusted the `To` address; any sender could attach mail to any invoice. | Signed Reply-To `local+<invoiceId>.<hmac>@domain`, verified on inbound; constant-time Postmark token checks. |
| H9 | **Prompt injection**: customer reply text was interpolated raw into AI prompts; model output parsed without validation. | Untrusted text fenced in `<customer_reply>` tags with an explicit instruction, length-capped; JSON extraction tolerant of code fences; `promise_date` must be `YYYY-MM-DD`; confidence clamped; 20s timeout; deterministic fallback on any failure. AI output is only ever a *suggestion* shown to a human. |

### Medium
- Invoice-limit counted paid/void invoices → now only open/paused.
- Seat limits ignored pending invitations → counted (except when re-inviting the same email).
- DATE columns shifted by timezone in the browser → parsed as strings, formatted as local calendar dates.
- DSO computed over unpaid invoices → paid invoices only.
- Workflow edits did not reschedule → `next_step_due_at` reset on change.
- QuickBooks sync read only the first page → paginated; auth failures flag the integration.
- CSV import aborted on one bad row → per-row savepoints, dedupe customers by email/name, robust date and money parsing.
- Web: infinite `/me` refetch loop on 401; hooks-order crash on invoice detail; render-blocking Google Fonts (now self-hosted); no error boundary or 404.

### Low
- Migration runner not Windows-safe and without checksums → fixed.
- `.gitignore` missing build/env files; CRLF churn → `.gitattributes`.
- Role bootstrap granted DDL → DML only; passwords required outside dev.

---

## 3. Test evidence

| Suite | Count | Notes |
|---|---|---|
| Unit (`vitest`) | 27 | Timezones, DST, weekends, catch-up, rendering/escaping, CSV parsing, reply address signing |
| Integration (real Postgres, app role with RLS) | 16 | Tenant isolation + leak regression, password lifecycle, CSRF, invitations, credits, dunning, signed Stripe webhooks (Connect + billing, replay) |
| Browser (Playwright) | 21 | Signup → verify → login, forgot/reset, invites, settings, templates → workflows → send, 404, admin |
| Post-deploy smoke | 14 checks | Health, readiness, CSRF, dev routes off, unsigned webhooks rejected, security headers, HSTS |

Production-mode boot was verified both ways: refuses with missing config, starts and passes the
smoke test with a complete one.

---

## 4. Competitor landscape (qualitative)

| | Chaser | Upflow | Paidnice | Stripe built-in reminders | **AutoCollect AI** |
|---|---|---|---|---|---|
| Target | SMB → mid-market finance teams | Mid-market AR teams | SMBs on Xero/QuickBooks | Stripe Invoicing users | Freelancers, agencies, small B2B |
| Setup | Accounting sync, schedules | Heavier onboarding, AR workflows | Accounting sync, policies | Toggle in Stripe | Connect Stripe/QBO/CSV, approve AI templates |
| Reminder logic | Rich schedules, multi-channel | Workflows, portal | Reminders + late fees/incentives | Fixed emails, limited customisation | Escalating sequence, tenant timezone/send hour, catch-up |
| Reply handling | Shared inbox | Collaboration | Basic | None | AI classification: dispute pauses, promise snoozes, suggested reply |
| Pricing posture | Paid tiers | Sales-led | Paid tiers | Included in Stripe fees | Free Starter + credit-based tiers |

**Positioning:** the gap is *reply intelligence for small teams* — Stripe's reminders are free but
blind to replies, and the full AR suites are priced and scoped for finance departments. AutoCollect
AI should win on "connect in two minutes, never chase a reply by hand".

**Gaps vs. competitors (roadmap below):** customer payment portal, late fees/early-pay incentives,
Xero integration, SMS/WhatsApp escalation UX, cash-forecast reporting.

---

## 5. Remaining risks and roadmap

### Before launch (must)
1. Configure production env, both Stripe webhook endpoints and Postmark (SPF/DKIM/DMARC).
2. Run `npm run db:migrate` then `npm run db:roles`; run the app as `autocollect_app` / `autocollect_service`.
3. Build and run the Docker image once (`docker build .`) — the Dockerfile was written but not built in this environment (no Docker daemon); CI builds it on every push.
4. Enable backups + PITR; wire `ERROR_WEBHOOK_URL` to an alert channel.
5. Legal: Terms, Privacy Policy, DPA, and an unsubscribe/contact line in reminder footers (CAN-SPAM/GDPR).

### Next 30 days (should)
- Redis-backed rate limiting when running >1 replica.
- OpenTelemetry traces + metrics (sends, failures, webhook lag); uptime monitor on `/api/ready`.
- Email change flow with re-verification; optional TOTP 2FA for owners.
- Data export and account deletion (GDPR).
- Remove the unused `plugins/csrf.ts` and its dependencies.

### Next quarter (could)
- Customer-facing payment portal; late fees / early-payment discounts; Xero integration.
- Per-tenant sending domains (DKIM) for better deliverability.
- Cash-flow forecast from promise dates.
