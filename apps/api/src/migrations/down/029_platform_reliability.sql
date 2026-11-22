-- Rollback for 029_platform_reliability.sql. Applied only by `npm run db:migrate:down`.

DROP TABLE IF EXISTS two_factor_challenges;
DROP TABLE IF EXISTS user_totp;
DROP TABLE IF EXISTS worker_heartbeats;
DROP TABLE IF EXISTS job_schedules;
DROP INDEX IF EXISTS idx_job_queue_due;
DROP INDEX IF EXISTS idx_job_queue_singleton_active;
ALTER TABLE job_queue DROP CONSTRAINT IF EXISTS job_queue_status_check;
ALTER TABLE job_queue
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS locked_until,
  DROP COLUMN IF EXISTS locked_by,
  DROP COLUMN IF EXISTS started_at,
  DROP COLUMN IF EXISTS finished_at,
  DROP COLUMN IF EXISTS singleton_key;
