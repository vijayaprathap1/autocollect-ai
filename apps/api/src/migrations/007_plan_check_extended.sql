-- Allow the Pro and Agency plans (the original billing check predated them).
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_plan_check
  CHECK (plan IN ('starter', 'growth', 'pro', 'agency'));