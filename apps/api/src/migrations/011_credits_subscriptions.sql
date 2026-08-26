-- Migration 011: Credits, subscriptions, tenant status

-- ─── tenants: add status column ────────────────────────────────────────────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' CHECK (status IN ('active','suspended','deleted'));

-- ─── subscriptions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT DEFAULT 'active' CHECK (status IN ('active','trialing','past_due','canceled')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  price_id TEXT,
  credits_per_month INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id);

-- ─── credit_wallets ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE UNIQUE,
  balance INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── credit_transactions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delta INT NOT NULL,
  reason TEXT NOT NULL,
  reference_id TEXT,
  actor TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_txn_tenant ON credit_transactions(tenant_id, created_at DESC);

-- ─── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscriptions_tenant ON subscriptions;
CREATE POLICY subscriptions_tenant ON subscriptions FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

ALTER TABLE credit_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_wallets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_wallets_tenant ON credit_wallets;
CREATE POLICY credit_wallets_tenant ON credit_wallets FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_txn_tenant ON credit_transactions;
CREATE POLICY credit_txn_tenant ON credit_transactions FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);
