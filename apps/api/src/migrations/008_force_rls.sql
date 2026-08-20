-- FORCE Row-Level Security so that even the table owner is constrained when a
-- non-superuser runtime role connects. Superusers (migrations, local dev) are
-- still exempt, so dev behaviour is unchanged.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'invoices','customers','workflows','templates','messages','replies',
    'integrations','audit_log','users','webhook_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- webhook_events had no RLS policy; scope it by tenant (background inserters
-- use the BYPASSRLS service role and are unaffected).
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webhook_events;
CREATE POLICY tenant_isolation ON webhook_events
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);