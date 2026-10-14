-- Migration 024: Create job queue for durable background jobs
CREATE TABLE IF NOT EXISTS job_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name        TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  scheduled_at    TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  attempted_at    TIMESTAMPTZ NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  last_error      TEXT NULL
);

-- Index to find due jobs
CREATE INDEX IF NOT EXISTS idx_job_queue_scheduled ON job_queue(scheduled_at) WHERE attempted_at IS NULL;

-- Index for retrying failed jobs
CREATE INDEX IF NOT EXISTS idx_job_queue_attempts ON job_queue(attempts) WHERE attempted_at IS NULL;