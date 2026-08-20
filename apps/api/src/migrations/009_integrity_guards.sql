-- Dunning reliability + data integrity guards.
-- 1) One send per (invoice, step): prevents double-sends when scans overlap or a
--    crash happens between sending and advancing. Dedupe pre-existing duplicates
--    (keep the earliest) so the unique index can be created safely.
DELETE FROM messages a
USING messages b
WHERE a.tenant_id = b.tenant_id
  AND a.invoice_id = b.invoice_id
  AND a.step_index = b.step_index
  AND a.step_index IS NOT NULL
  AND a.created_at > b.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_one_send_per_step
  ON messages(tenant_id, invoice_id, step_index)
  WHERE step_index IS NOT NULL;

-- 2) One integration per (tenant, source). Existing code used ON CONFLICT DO
--    NOTHING without a target, which only works if a unique constraint exists.
DELETE FROM integrations a
USING integrations b
WHERE a.tenant_id = b.tenant_id
  AND a.source = b.source
  AND a.created_at > b.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_tenant_source
  ON integrations(tenant_id, source);
