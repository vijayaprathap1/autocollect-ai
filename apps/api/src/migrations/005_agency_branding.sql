-- White-label / agency (Phase 2): per-seat limits and tenant branding.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS seat_limit INT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branding JSONB DEFAULT '{}'::jsonb;

-- Backfill seat limits consistent with plan defaults.
UPDATE tenants SET seat_limit = 1 WHERE seat_limit IS NULL AND plan = 'starter';
UPDATE tenants SET seat_limit = 3 WHERE seat_limit IS NULL AND plan = 'growth';
UPDATE tenants SET seat_limit = NULL WHERE plan IN ('pro', 'agency');