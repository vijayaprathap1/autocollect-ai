-- Two-way AI replies (Phase 2): store the AI-suggested reply the owner can
-- approve and send back to the customer.
ALTER TABLE replies ADD COLUMN suggested_body TEXT;