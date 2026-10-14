-- Migration 023: Add Stripe customer ID to integrations for billing portal
ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT NULL;

-- Index for looking up by customer ID (optional)
CREATE INDEX IF NOT EXISTS idx_integrations_stripe_customer ON integrations(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;