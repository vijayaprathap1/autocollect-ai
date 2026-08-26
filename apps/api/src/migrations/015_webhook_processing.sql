-- Make webhook delivery claims retryable and observable.
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processed';
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 1;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_status_check
  CHECK (status IN ('processing','processed','failed'));

UPDATE webhook_events SET status = 'processed' WHERE status IS NULL;