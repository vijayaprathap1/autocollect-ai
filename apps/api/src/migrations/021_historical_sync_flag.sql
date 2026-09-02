-- Migration 021: Add historical sync tracking for integrations
ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS historical_sync_completed_at TIMESTAMPTZ NULL;

-- Index for checking which integrations need historical sync
CREATE INDEX IF NOT EXISTS idx_integrations_needs_historical_sync
  ON integrations(tenant_id, source)
  WHERE historical_sync_completed_at IS NULL;