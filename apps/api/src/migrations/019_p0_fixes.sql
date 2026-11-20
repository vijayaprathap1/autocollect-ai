-- Migration 019: P0 production fixes
-- Retryable send claims, opt-outs, pay-link tracking, session org selection,
-- and one Stripe subscription per tenant.

-- ─── messages: retryable send claims ───────────────────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_messages_provider_msg_id ON messages(provider_msg_id);

-- ─── customers: email opt-out (unsubscribe) ────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_opt_out BOOLEAN NOT NULL DEFAULT FALSE;

-- ─── invoices: Stripe Payment Link id (closes invoice when the link is paid) ─
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_link_id TEXT;
CREATE INDEX IF NOT EXISTS idx_invoices_payment_link ON invoices(tenant_id, payment_link_id);

-- ─── sessions: active organization for the session ─────────────────────────
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

-- ─── tenants: Stripe customer for platform billing ─────────────────────────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_stripe_customer
  ON tenants(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- ─── subscriptions: exactly one row per tenant ─────────────────────────────
DELETE FROM subscriptions a
USING subscriptions b
WHERE a.tenant_id = b.tenant_id
  AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id));

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_per_tenant ON subscriptions(tenant_id);

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('active','trialing','past_due','canceled','incomplete','incomplete_expired','unpaid','paused'));

-- ─── users: existing accounts that already have a password count as verified,
-- so enforcing verification at login does not lock them out.
UPDATE users
   SET email_verified_at = now()
 WHERE email_verified_at IS NULL
   AND password_hash <> 'needs_password_reset';
