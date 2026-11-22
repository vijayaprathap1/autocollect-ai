-- Enterprise AR: cash application, credit, forecasts support, saved filters, notifications.
-- Rollback: migrations/down/032_enterprise_ar.sql

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('owner', 'admin', 'manager', 'collector', 'viewer', 'member'));

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('admin', 'manager', 'collector', 'viewer', 'member'));

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS credit_limit BIGINT,
  ADD COLUMN IF NOT EXISTS credit_status TEXT NOT NULL DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS credit_hold_reason TEXT;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_credit_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_credit_status_check
  CHECK (credit_status IN ('ok', 'review', 'hold'));

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('stripe', 'qbo', 'csv', 'manual')),
  external_id TEXT,
  amount BIGINT NOT NULL CHECK (amount > 0),
  unapplied BIGINT NOT NULL CHECK (unapplied >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_unapplied ON payments(tenant_id, unapplied) WHERE unapplied > 0;
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(tenant_id, customer_id);

CREATE TABLE IF NOT EXISTS cash_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('exact', 'partial', 'multi', 'manual', 'suggested')),
  applied_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cash_app_payment ON cash_applications(tenant_id, payment_id);
CREATE INDEX IF NOT EXISTS idx_cash_app_invoice ON cash_applications(tenant_id, invoice_id);

CREATE TABLE IF NOT EXISTS credit_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'held', 'rejected')),
  notes TEXT,
  reviewer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_credit_reviews_open ON credit_reviews(tenant_id, status);

CREATE TABLE IF NOT EXISTS saved_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('invoices', 'worklist', 'cash', 'disputes')),
  query JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, scope, name)
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  href TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(tenant_id, user_id, read_at);

CREATE INDEX IF NOT EXISTS idx_invoices_worklist ON invoices(tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_customer_status ON invoices(tenant_id, customer_id, status);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_risk ON customers(tenant_id, risk_score DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autocollect_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON payments, cash_applications, credit_reviews, saved_filters, notifications TO autocollect_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autocollect_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON payments, cash_applications, credit_reviews, saved_filters, notifications TO autocollect_service;
  END IF;
END $$;

DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['payments', 'cash_applications', 'credit_reviews', 'saved_filters', 'notifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl || '_tenant', tbl
    );
  END LOOP;
END $$;
