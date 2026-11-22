-- Collector workbench: disputes, promises, tasks, contacts, strategies.
-- Rollback: migrations/down/030_ar_workbench.sql

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS segment TEXT,
  ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS collector_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_segment_check;
ALTER TABLE customers ADD CONSTRAINT customers_segment_check
  CHECK (segment IS NULL OR segment IN ('strategic', 'standard', 'high_risk', 'smb'));
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_risk_score_check;
ALTER TABLE customers ADD CONSTRAINT customers_risk_score_check
  CHECK (risk_score BETWEEN 0 AND 100);

ALTER TABLE workflows
  ADD COLUMN IF NOT EXISTS segment TEXT,
  ADD COLUMN IF NOT EXISTS min_risk INTEGER,
  ADD COLUMN IF NOT EXISTS max_risk INTEGER,
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_segment_check;
ALTER TABLE workflows ADD CONSTRAINT workflows_segment_check
  CHECK (segment IS NULL OR segment IN ('strategic', 'standard', 'high_risk', 'smb'));
ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_risk_band_check;
ALTER TABLE workflows ADD CONSTRAINT workflows_risk_band_check
  CHECK (
    (min_risk IS NULL OR min_risk BETWEEN 0 AND 100)
    AND (max_risk IS NULL OR max_risk BETWEEN 0 AND 100)
    AND (min_risk IS NULL OR max_risk IS NULL OR min_risk <= max_risk)
  );

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS strategy_locked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_link_status TEXT,
  ADD COLUMN IF NOT EXISTS stripe_payment_link_id TEXT;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payment_link_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_payment_link_status_check
  CHECK (payment_link_status IS NULL OR payment_link_status IN ('active', 'paid'));

CREATE TABLE IF NOT EXISTS customer_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT,
  email TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'ap',
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer ON customer_contacts(tenant_id, customer_id);

INSERT INTO customer_contacts (tenant_id, customer_id, name, email, phone, role, is_primary)
SELECT c.tenant_id, c.id, c.name, c.email, c.phone, 'ap', TRUE
  FROM customers c
 WHERE (c.email IS NOT NULL OR c.phone IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM customer_contacts cc WHERE cc.customer_id = c.id);

CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  reply_id UUID,
  reason_code TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'open',
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  summary TEXT,
  resolution TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_disputes_tenant_status ON disputes(tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_one_open_per_invoice
  ON disputes(tenant_id, invoice_id)
  WHERE invoice_id IS NOT NULL AND status IN ('open', 'investigating', 'pending_customer');

ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_reason_check;
ALTER TABLE disputes ADD CONSTRAINT disputes_reason_check
  CHECK (reason_code IN ('pricing', 'quantity', 'quality', 'duplicate', 'delivery', 'tax', 'other'));
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_status_check;
ALTER TABLE disputes ADD CONSTRAINT disputes_status_check
  CHECK (status IN ('open', 'investigating', 'pending_customer', 'resolved', 'rejected'));

CREATE TABLE IF NOT EXISTS dispute_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dispute_id UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dispute_notes_dispute ON dispute_notes(tenant_id, dispute_id);

CREATE TABLE IF NOT EXISTS promises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  reply_id UUID,
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  promise_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  kept_at TIMESTAMPTZ,
  broken_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_promises_tenant_status ON promises(tenant_id, status, promise_date);

ALTER TABLE promises DROP CONSTRAINT IF EXISTS promises_status_check;
ALTER TABLE promises ADD CONSTRAINT promises_status_check
  CHECK (status IN ('open', 'kept', 'broken', 'cancelled'));

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  dispute_id UUID REFERENCES disputes(id) ON DELETE SET NULL,
  promise_id UUID REFERENCES promises(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  notes TEXT,
  due_on DATE,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks(tenant_id, status, due_on);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_one_broken_promise_followup
  ON tasks(tenant_id, promise_id)
  WHERE promise_id IS NOT NULL AND source = 'broken_promise' AND status = 'open';

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('open', 'done', 'cancelled'));

-- RLS. Service role bypasses; request connections are scoped by app.tenant_id.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['customer_contacts', 'disputes', 'dispute_notes', 'promises', 'tasks']
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
