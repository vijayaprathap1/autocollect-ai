-- Inbound reply classification (Phase 2): track a promised payment date
-- so the engine can pause until then and resume if still unpaid.
ALTER TABLE replies ADD COLUMN promise_date DATE;