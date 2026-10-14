-- Migration 020: Track payment failure reasons on invoices
-- Supports invoice.payment_failed webhook handling

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS last_payment_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_payment_failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_payment_failure_code TEXT;

-- Index for querying failed invoices
CREATE INDEX IF NOT EXISTS idx_invoices_payment_failed
  ON invoices(tenant_id, last_payment_failed_at DESC)
  WHERE last_payment_failed_at IS NOT NULL;