DROP INDEX IF EXISTS idx_customers_tenant_risk;
DROP INDEX IF EXISTS idx_invoices_customer_status;
DROP INDEX IF EXISTS idx_invoices_worklist;

DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS saved_filters;
DROP TABLE IF EXISTS credit_reviews;
DROP TABLE IF EXISTS cash_applications;
DROP TABLE IF EXISTS payments;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_credit_status_check;
ALTER TABLE customers
  DROP COLUMN IF EXISTS credit_limit,
  DROP COLUMN IF EXISTS credit_status,
  DROP COLUMN IF EXISTS credit_hold_reason;

UPDATE memberships SET role = 'member' WHERE role IN ('manager', 'collector', 'viewer');
UPDATE invitations SET role = 'member' WHERE role IN ('manager', 'collector', 'viewer');

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('owner', 'admin', 'member'));

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('admin', 'member'));
