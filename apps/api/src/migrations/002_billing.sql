-- AutoCollect AI - M7: billing plan columns
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'starter'
  CHECK (plan IN ('starter', 'growth'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS invoice_limit INT DEFAULT 50;