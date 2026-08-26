# Product Requirements Document — AutoCollect AI Platform Rebuild
## Auth, Tenancy, Credits, Super Admin, Role-Based Access

---

## 1. Executive Summary

AutoCollect AI is an invoice-dunning SaaS that automates chasing B2B clients. Today it runs on **dev-mode header auth** (local) and **Clerk JWT** (prod) with **no passwords, no super admin, no credits system**, and a public marketing landing page.

This rebuild replaces that foundation with a **self-hosted, full-featured platform layer** designed to compete with incumbents like Chaser ($259/mo), YayPay (~$500/mo), and Invoiced (quote-only $50-100/mo) — but at a **dramatically lower price point** with **unlimited users** and **credit-based pricing**.

### Target: Local Demo (Fully Functional)

No real email, no real Stripe, no real Clerk. Everything runs locally with a dummy admin account.

---

## 2. Competitor Pricing Analysis

| Competitor | Starting Price | Users | Key Limits |
|---|---|---|---|
| InvoiceSherpa | $49/mo | Limited | Per-invoice volume, basic reminders |
| Paidnice | $69/mo | Unlimited | Per-invoice volume, Xero/QBO only |
| Chaser (Compact) | $259/mo | 4 | Revenue < $5M, 30 templates, 4 workflows |
| Chaser (Core) | $779/mo | Unlimited | Revenue < $13M |
| ezyCollect | $275/mo | Limited | Per-invoice + seat |
| Quadient/YayPay | ~$500/mo | Feature-based | Invoice volume, modules |
| Invoiced (Basic) | ~$50-100/mo | Per-customer | Per-invoice fee |
| Invoiced (Mid) | ~$500/mo | Per-customer | Quote-only |

**Key insight:** Chaser charges $259/mo for just 4 users and 4 workflows. We can undercut dramatically while offering more.

---

## 3. Credit Plan (Competitor-Driven)

Credits are consumed per automated step (email/SMS sent). Free tier included. Scales with plan.

| Plan | Price | Credits/mo | Users | Invoices | Key Differentiator |
|---|---|---|---|---|---|
| **Free** | $0 | 50 | 1 | 50 | No credit card, 50 credits to try |
| **Starter** | $29/mo | 500 | 3 | 200 | Small business, basic dunning |
| **Growth** | $79/mo | 2,000 | 10 | 1,000 | Growing team, advanced workflows |
| **Pro** | $149/mo | 10,000 | Unlimited | Unlimited | Full platform, AI drafts, forecasting |
| **Agency** | $299/mo | 50,000 | Unlimited | Unlimited | Multi-entity, white-label, API |

**Competitor comparison:**
- Chaser Compact ($259/mo) = 4 users, 4 workflows → We offer **unlimited users + 10,000 credits for $149/mo**
- YayPay (~$500/mo) = feature-based → We offer **all features + 50,000 credits for $299/mo**
- InvoiceSherpa ($49/mo) = basic → We offer **500 credits + 3 users for $29/mo**

**Credit consumption rules:**
- 1 email sent = 1 credit
- 1 SMS sent = 2 credits (carrier cost recovery)
- AI draft generation = 0 credits (included)
- Reply triage = 0 credits (included)
- Dashboard/analytics = 0 credits (included)

**Credit top-ups (optional, P2):**
- $10 for 100 credits
- $25 for 300 credits
- $50 for 700 credits

---

## 4. Data Model (new/revised)

### `users` (reworked — identity, no longer holds org)
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  email_verified_at TIMESTAMPTZ,
  is_super_admin BOOLEAN DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### `memberships` (replaces users.tenant_id)
```sql
CREATE TABLE memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active','invited','suspended')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, tenant_id)
);
```

### `sessions`
```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  ip INET,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### `password_reset_tokens`
```sql
CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### `email_verification_tokens`
```sql
CREATE TABLE email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### `invitations`
```sql
CREATE TABLE invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT DEFAULT 'member' CHECK (role IN ('admin','member')),
  token_hash TEXT UNIQUE NOT NULL,
  invited_by UUID REFERENCES users(id),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### `subscriptions`
```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT DEFAULT 'active' CHECK (status IN ('active','trialing','past_due','canceled')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  price_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### `credit_wallets`
```sql
CREATE TABLE credit_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE UNIQUE,
  balance INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### `credit_transactions`
```sql
CREATE TABLE credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  delta INT NOT NULL,
  reason TEXT NOT NULL,
  reference_id TEXT,
  actor TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_credit_txn_tenant ON credit_transactions(tenant_id, created_at DESC);
```

### `tenants` (revised)
```sql
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' CHECK (status IN ('active','suspended','deleted'));
```

---

## 5. Migration Plan

### Migration 010: Auth schema rework
- Create `users`, `memberships`, `sessions`, `password_reset_tokens`, `email_verification_tokens`, `invitations` tables
- RLS policies: `users_self` (own row), `memberships_tenant` (org members), `sessions_self` (own sessions), etc.
- Super admin bypass via `servicePool` (BYPASSRLS)

### Migration 011: Credits + subscriptions
- Create `credit_wallets`, `credit_transactions`, `subscriptions` tables
- Add `status` column to `tenants`

### Migration 012: Data backfill
- Copy existing `users` → `memberships` (preserving roles)
- Create dummy super admin user
- Grant starter credits to all existing tenants
- Drop `users.clerk_user_id` / `tenants.clerk_org_id`

---

## 6. Authentication Design

**Chosen: httpOnly cookie + server-side sessions** (DB-backed, serverless-safe).

- Cookie: `autocollect_session`, `HttpOnly; SameSite=Lax; Path=/`
- Login: argon2id verify → create session → set cookie
- Tokens (verify/reset/invite): random 32B, hashed at rest, single-use, TTL varies
- Logout: delete session + clear cookie
- Password reset: invalidates all sessions

**Auth endpoints:**
- `POST /auth/signup` → create user + send verification email (dev: auto-verify)
- `POST /auth/verify-email` → set email_verified_at
- `POST /auth/login` → verify password + set session cookie
- `POST /auth/logout` → delete session + clear cookie
- `POST /auth/forgot-password` → send reset email
- `POST /auth/reset-password` → verify token + update password
- `POST /auth/change-password` → verify current + update
- `POST /auth/dev-login` → dev-only fast login (non-prod)
- `GET /me` → user + active membership + tenant + plan + credits + role

**Dev mode:** `POST /auth/dev-login` with `{ email }` → creates session for seeded user (no password required). This is the local demo login.

---

## 7. RBAC Model

| Action | member | admin | owner | super_admin |
|---|---|---|---|---|
| View dashboard/invoices/customers/activity | ✓ | ✓ | ✓ | platform-wide |
| Respond to replies | ✓ | ✓ | ✓ | — |
| Manage templates/workflows | ✓ | ✓ | ✓ | — |
| Manage integrations (Stripe/QBO/CSV) | ✗ | ✓ | ✓ | — |
| Invite/remove members, change roles | ✗ | ✓ | ✓ | — |
| Billing / plan / credits view | ✓ | ✓ | ✓ | — |
| Plan change / subscription | ✗ | ✗ | ✓ | can change any org |
| Delete org / transfer ownership | ✗ | ✗ | ✓ | can suspend orgs |
| Super-admin console | ✗ | ✗ | ✗ | ✓ |

---

## 8. Super Admin Console

**Routes:**
- `/admin` — KPIs: total orgs, active users, MRR, credits issued/consumed, messages sent
- `/admin/organizations` — list/search orgs: name, plan, credit balance, seats, status, created; actions: change plan, grant/revoke credits, suspend/unsuspend, view
- `/admin/organizations/:id` — detail: members, plan, wallet, transactions, usage, audit
- `/admin/users` — list/search users: email, status, memberships; actions: suspend, change role
- `/admin/audit` — platform audit feed

**API (super admin, service pool):**
- `GET /admin/stats`
- `GET /admin/tenants?q=&page=`
- `GET /admin/tenants/:id`
- `PATCH /admin/tenants/:id` (plan, suspend)
- `POST /admin/tenants/:id/credits`
- `GET /admin/tenants/:id/transactions`
- `GET /admin/users?q=`
- `PATCH /admin/users/:id`
- `GET /admin/audit`

---

## 9. Credits System

**Grant on plan activation:**
- `checkout.session.completed` webhook → wallet += monthly allowance, ledger `reason='plan_allowance'`
- `invoice.paid` (renewal) → wallet += allowance again

**Consume on send:**
- Engine inserts message → same transaction: `UPDATE credit_wallets SET balance = balance - cost`
- Email = 1 credit, SMS = 2 credits
- If balance < required → skip send, pause invoice, audit event

**Super admin grant:**
- `POST /admin/tenants/:id/credits { amount, reason }` → wallet + ledger

---

## 10. Onboarding Flow

1. **Sign up** → email + password (dev: auto-verify)
2. **Create organization** → name + slug
3. **Choose plan** → Stripe checkout (dev: mock upgrade)
4. **Guided setup** → connect source → approve templates → enable workflow → demo data
5. **Invite members** → email invitations with accept links

---

## 11. Frontend Structure

### Auth Pages
- `/login` — email + password login
- `/signup` — email + password + name signup
- `/forgot-password` — email input → send reset
- `/reset-password` — token + new password
- `/verify-email` — token verification
- `/create-organization` — org creation wizard

### App Pages (existing, modified)
- `/dashboard` — overview with KPIs
- `/invoices` — invoice list
- `/invoices/:id` — invoice detail
- `/customers` — customer list
- `/workflows` — dunning workflows
- `/templates` — email templates
- `/replies` — reply inbox
- `/activity` — activity feed
- `/settings` — workspace settings (integrations, billing, members, branding, credits)

### Super Admin Pages
- `/admin` — platform dashboard
- `/admin/organizations` — org list
- `/admin/organizations/:id` — org detail
- `/admin/users` — user list
- `/admin/audit` — audit log

### Route Guards
- `Shell` → requires auth (session cookie)
- `AdminShell` → requires super admin
- `PublicRoute` → only unauthenticated (login/signup)

---

## 12. Security

- Argon2id password hashing
- Sessions: httpOnly, SameSite=Lax, Secure (prod)
- All tokens hashed at rest, single-use
- Auth brute-force rate limiting (5/min per IP)
- Audit log for all auth + admin + credit events
- No secrets in client

---

## 13. Engineering Backlog (Execution Order)

**M1 — Auth core:**
- Migrations 010-012
- `lib/auth.ts` cookie auth + argon2
- Signup/login/logout/me
- Dev-login endpoint
- Update e2e to use real auth

**M2 — Password recovery:**
- Forgot/reset/change endpoints
- Transactional email (Postmark/mock)

**M3 — Org onboarding:**
- Create org wizard
- Plan selection (mock in dev)
- Invitations + accept flow
- Members page (roles, remove)
- Guided setup integration

**M4 — Credits:**
- Wallets, ledger, plan-allowance grants
- Engine consumption + insufficient-credit handling
- Settings credits card

**M5 — RBAC:**
- `requireOwner`/`requireSuperAdmin`
- Org-route permission audit
- Role-aware frontend nav/guards

**M6 — Super admin console:**
- Admin auth gate
- Stats/orgs/users/audit pages + APIs
- Credit grants, suspend, plan change

**M7 — Frontend cleanup:**
- Remove Landing page
- Auth pages
- `/` redirect
- Logout button
- Cookie request layer

**M8 — Hardening:**
- Auth rate limits
- Audit logging
- Seed scripts
- E2e updates
- Full verification

---

## 14. Open Questions

1. **Credit prices** — Free(50), Starter($29/500), Growth($79/2k), Pro($149/10k), Agency($299/50k) — are these acceptable?
2. **Multi-org switching** — build now or defer?
3. **Old prod auth** — fully remove Clerk code?
