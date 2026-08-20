-- AutoCollect AI - initial schema (M1)
-- Mirrors LLD doc `04-low-level-design.md` section 1.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tenant / org
CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  clerk_org_id  TEXT UNIQUE,
  email_domain  TEXT,
  tone          TEXT DEFAULT 'friendly' CHECK (tone IN ('friendly','professional','firm')),
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Users (Clerk is source of truth; mirror for FK convenience)
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES tenants(id),
  clerk_user_id TEXT UNIQUE NOT NULL,
  email         TEXT,
  role          TEXT DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- External integrations
CREATE TABLE integrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('stripe','qbo','csv')),
  status        TEXT DEFAULT 'active' CHECK (status IN ('active','error','disconnected')),
  credentials   JSONB NOT NULL DEFAULT '{}',
  settings      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_integrations_tenant ON integrations(tenant_id, source);

-- Customers (normalized across sources)
CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id   TEXT,
  source        TEXT NOT NULL CHECK (source IN ('stripe','csv','qbo')),
  name          TEXT,
  email         TEXT,
  phone         TEXT,
  company       TEXT,
  sms_opt_out   BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, source, external_id)
);
CREATE INDEX idx_customers_tenant ON customers(tenant_id);

-- Invoices (core entity)
CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id  UUID REFERENCES integrations(id) ON DELETE SET NULL,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  external_id     TEXT,
  source          TEXT NOT NULL CHECK (source IN ('stripe','csv','qbo')),
  amount_due      BIGINT NOT NULL,
  currency        TEXT DEFAULT 'usd',
  issue_date      DATE,
  due_date        DATE,
  status          TEXT DEFAULT 'open' CHECK (status IN ('open','paid','void','uncollectible','paused')),
  payment_link    TEXT,
  line_items      JSONB DEFAULT '[]',
  next_step_index INT  DEFAULT 0,
  next_step_due_at TIMESTAMPTZ,
  workflow_id     UUID,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, source, external_id)
);
CREATE INDEX idx_invoices_engine ON invoices(tenant_id, status, next_step_due_at);
CREATE INDEX idx_invoices_customer ON invoices(tenant_id, customer_id);

-- Dunning workflow (rule list, not AI)
CREATE TABLE workflows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT,
  is_default    BOOLEAN DEFAULT TRUE,
  enabled       BOOLEAN DEFAULT FALSE,
  steps         JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Templates (AI-drafted, human-approved)
CREATE TABLE templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  step_key      TEXT,
  subject       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  approved      BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, step_key)
);

-- Messages / send log
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id      UUID REFERENCES invoices(id) ON DELETE CASCADE,
  step_index      INT,
  channel         TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms')),
  provider_msg_id TEXT,
  status          TEXT DEFAULT 'sent' CHECK (status IN ('sent','delivered','opened','clicked','bounced','failed')),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_messages_invoice ON messages(tenant_id, invoice_id);

-- Inbound replies (Phase 2)
CREATE TABLE replies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id    UUID REFERENCES invoices(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms')),
  content       TEXT,
  classification TEXT CHECK (classification IN ('dispute','promise','question','junk')),
  resolved      BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Idempotency for webhooks
CREATE TABLE webhook_events (
  id            TEXT PRIMARY KEY,
  tenant_id     UUID,
  source        TEXT,
  processed_at  TIMESTAMPTZ DEFAULT now()
);

-- Audit log
CREATE TABLE audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID,
  actor         TEXT,
  action        TEXT,
  detail        JSONB,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Row-Level Security: tenant isolation
-- API sets `app.tenant_id` before each query; RLS scopes every row.
-- ---------------------------------------------------------------------------

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'invoices','customers','workflows','templates','messages','replies',
    'integrations','audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::UUID)',
      t
    );
  END LOOP;
END $$;

-- users table: allow selecting own row + any row for the current tenant
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users
  USING (clerk_user_id = current_setting('app.user_id', true))
  WITH CHECK (clerk_user_id = current_setting('app.user_id', true));
CREATE POLICY users_tenant ON users
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);