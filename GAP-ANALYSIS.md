# AutoCollect AI — Gap Analysis & Improvement Plan

Generated: 2026-08-27

---

## User Flow: Login → Stripe Integration

```
/signup → verify email → login → dashboard → onboarding → connect Stripe → approve templates → enable workflow → dunning starts
```

---

## CRITICAL GAPS

### 1. Stripe Integration

| # | Issue | Severity | File(s) | Fix |
|---|-------|----------|---------|-----|
| S1 | No `invoice.payment_failed` webhook handling | Critical | `stripe.controller.ts` | Add case in webhook switch |
| S2 | No historical invoice sync on Connect | High | `ingest.service.ts` | Add pull-based sync |
| S3 | No Stripe Customer Portal | High | `billing.controller.ts` | Add portal session endpoint |
| S4 | No `connect.account.updated/deauthorized` | High | `stripe.controller.ts` | Add webhook cases |
| S5 | No `customer.subscription.updated` handling | Medium | `stripe.controller.ts` | Add webhook case |
| S6 | Production config doesn't validate Stripe keys | Medium | `config.ts` | Add to `validateProductionConfig` |
| S7 | Dev webhook endpoint public when Stripe disabled | Medium | `stripe.controller.ts` | Add auth guard |

### 2. Email/SMS Delivery

| # | Issue | Severity | File(s) | Fix |
|---|-------|----------|---------|-----|
| E1 | No Postmark delivery/bounce tracking | High | New file needed | Add webhook handler |
| E2 | No retry logic for transient send failures | High | `engine.ts` | Add retry queue |
| E3 | No Twilio delivery status tracking | Medium | New file needed | Add webhook handler |
| E4 | No HTML email templates | Medium | `render.ts` | Add HTML template support |

### 3. Onboarding Flow

| # | Issue | Severity | File(s) | Fix |
|---|-------|----------|---------|-----|
| O1 | No customer detail page | High | New route needed | Create `/customers/:id` |
| O2 | No invoice creation from UI | High | New route needed | Add invoice create form |
| O3 | No workflow step editing | High | `workflows.controller.ts` + UI | Add step CRUD |
| O4 | `createPayLink()` not wired in UI | High | `InvoiceDetail.tsx` | Add button |
| O5 | `addMember()` not used | Medium | `Settings.tsx` | Wire up or remove |

### 4. Auth Flow

| # | Issue | Severity | File(s) | Fix |
|---|-------|----------|---------|-----|
| A1 | AcceptInvite dead end for ACCOUNT_REQUIRED | Medium | `AcceptInvite.tsx` | Link to `/signup` |
| A2 | Dead code in SignUp.tsx (`if res.userId`) | Low | `SignUp.tsx` | Remove branch |
| A3 | Dead import `devLogin` in auth.controller | Low | `auth.controller.ts` | Remove import |
| A4 | No CSRF token protection | Medium | `auth.ts` + `api.ts` | Add CSRF tokens |
| A5 | No account lockout on failed logins | Medium | `auth.controller.ts` | Add lockout logic |
| A6 | No "remember me" option | Low | `Login.tsx` | Add checkbox + extended TTL |
| A7 | No re-send verification on login | Low | `Login.tsx` | Add re-send button |
| A8 | Signup doesn't auto-login after verify | Low | `VerifyEmail.tsx` | Auto-login on success |

### 5. UI/UX

| # | Issue | Severity | File(s) | Fix |
|---|-------|----------|---------|-----|
| U1 | No confirmation dialogs for destructive actions | Medium | Multiple pages | Add confirm modal |
| U2 | `window.location.reload()` used 4 places | Medium | Multiple pages | Use React Router state |
| U3 | Invoice action errors silently logged | Medium | `Invoices.tsx` | Use toast |
| U4 | No debounce on search inputs | Low | `Invoices.tsx`, `Customers.tsx` | Add debounce hook |
| U5 | No loading skeletons for non-dashboard pages | Low | Multiple pages | Add skeleton components |
| U6 | No user profile/account settings page | Medium | New route needed | Create `/settings/profile` |
| U7 | No notification preferences | Low | New route needed | Create preferences page |

### 6. Webhook Processing

| # | Issue | Severity | File(s) | Fix |
|---|-------|----------|---------|-----|
| W1 | No webhook event replay/retry | Medium | `webhook-events.ts` | Add retry endpoint |
| W2 | No Stripe event types whitelist | Low | `stripe.controller.ts` | Add filter config |
| W3 | QBO sync + dunning share timer | Low | `scheduler.ts` | Separate timers |

---

## IMPLEMENTATION PRIORITY

### Phase 1 — Quick Wins (1-2 days)
- [ ] Wire `createPayLink()` in InvoiceDetail UI
- [ ] Fix AcceptInvite dead end (link to `/signup`)
- [ ] Remove dead code (SignUp.tsx, auth.controller.ts)
- [ ] Add toast for invoice action errors
- [ ] Add confirmation dialogs for destructive actions
- [ ] Validate Stripe keys in production config

### Phase 2 — Critical Features (3-5 days)
- [ ] Add `invoice.payment_failed` webhook handling
- [ ] Add historical invoice sync on Stripe Connect
- [ ] Add Postmark delivery/bounce webhook handler
- [ ] Add send retry logic in dunning engine
- [ ] Add `connect.account.updated/deauthorized` handling
- [ ] Add `customer.subscription.updated` handling

### Phase 3 — Enhanced UX (3-5 days)
- [ ] Create customer detail page
- [ ] Create invoice create form
- [ ] Add workflow step editing
- [ ] Add Stripe Customer Portal
- [ ] Add user profile/settings page
- [ ] Add debounce on search inputs

### Phase 4 — Polish (2-3 days)
- [ ] Add CSRF token protection
- [ ] Add account lockout on failed logins
- [ ] Add "remember me" option
- [ ] Add HTML email templates
- [ ] Add loading skeletons to all pages
- [ ] Remove `window.location.reload()` usage

### Phase 5 — Advanced (3-5 days)
- [ ] Add webhook event replay/retry
- [ ] Add Stripe event types whitelist
- [ ] Separate QBO sync and dunning timers
- [ ] Add Postmark/Twilio delivery tracking
- [ ] Add notification preferences

---

## ARCHITECTURE NOTES

### Current Stack
- **API:** Fastify 5 + TypeScript + PostgreSQL 17
- **Web:** React 19 + Vite 6 + Tailwind 3 + TanStack Query 5
- **Auth:** Custom session cookies (dev mode) / Clerk (production)
- **Payments:** Stripe Connect + Stripe Billing
- **Email:** Postmark
- **SMS:** Twilio (Phase 2)
- **AI:** Anthropic Claude
- **Accounting:** QuickBooks Online (mock mode available)

### Dual-Mode Design
Every external integration has a mock/dev fallback:
- Stripe → mock mode with fake payment links
- Postmark → console.log fallback
- QBO → fake realm + generated invoices
- Anthropic → hardcoded classification rules

This allows full local development without API keys.

---

## DATABASE MIGRATIONS

Current: 19 migrations (`001_init.sql` through `019_trial_fields.sql`)

Upcoming migrations needed:
- `020_invoice_payment_failed_fields.sql` — track payment failure reasons
- `021_delivery_status_tracking.sql` — outbound message delivery status
- `022_webhook_retry_queue.sql` — failed webhook event retry
- `023_user_profile_fields.sql` — display_name, avatar, preferences
- `024_workflow_step_customization.sql` — editable workflow steps
