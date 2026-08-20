-- Make the tenant policy cover inserts too (needed for member invites under
-- forced RLS in production; dev superuser bypasses RLS today).
DROP POLICY IF EXISTS users_tenant ON users;
CREATE POLICY users_tenant ON users FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);