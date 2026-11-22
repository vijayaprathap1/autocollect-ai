-- Rollback for 030_ar_workbench.sql.

DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS promises;
DROP TABLE IF EXISTS dispute_notes;
DROP TABLE IF EXISTS disputes;
DROP TABLE IF EXISTS customer_contacts;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payment_link_status_check;
ALTER TABLE invoices
  DROP COLUMN IF EXISTS strategy_locked,
  DROP COLUMN IF EXISTS payment_link_status,
  DROP COLUMN IF EXISTS stripe_payment_link_id;

ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_segment_check;
ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_risk_band_check;
ALTER TABLE workflows
  DROP COLUMN IF EXISTS segment,
  DROP COLUMN IF EXISTS min_risk,
  DROP COLUMN IF EXISTS max_risk,
  DROP COLUMN IF EXISTS priority;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_segment_check;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_risk_score_check;
ALTER TABLE customers
  DROP COLUMN IF EXISTS segment,
  DROP COLUMN IF EXISTS risk_score,
  DROP COLUMN IF EXISTS collector_user_id;
