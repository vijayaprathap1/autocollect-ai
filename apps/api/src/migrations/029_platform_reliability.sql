-- Durable worker queue, heartbeats, and TOTP two-factor auth.
-- Forward-only. The matching rollback is migrations/down/029_platform_reliability.sql
-- (npm run db:migrate:down).

ALTER TABLE job_queue
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by TEXT,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS singleton_key TEXT;

UPDATE job_queue
   SET status = CASE WHEN attempted_at IS NULL THEN 'pending' ELSE 'running' END
 WHERE status = 'pending';

ALTER TABLE job_queue DROP CONSTRAINT IF EXISTS job_queue_status_check;
ALTER TABLE job_queue ADD CONSTRAINT job_queue_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'dead'));

-- One in-flight copy of a recurring job. Ad-hoc jobs leave singleton_key NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_singleton_active
  ON job_queue (job_name, singleton_key)
  WHERE singleton_key IS NOT NULL AND status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_job_queue_due
  ON job_queue (scheduled_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS job_schedules (
  job_name TEXT PRIMARY KEY,
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 5),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ NOT NULL,
  processed BIGINT NOT NULL DEFAULT 0
);

-- Authenticator secrets and one-time recovery-code hashes. Service role only
-- (BYPASSRLS). The app role cannot read these rows.
CREATE TABLE IF NOT EXISTS user_totp (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  enabled_at TIMESTAMPTZ,
  recovery_hashes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS two_factor_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  session_type TEXT NOT NULL DEFAULT 'tenant' CHECK (session_type IN ('tenant', 'admin')),
  tenant_id UUID,
  remember_me BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_two_factor_challenges_expires ON two_factor_challenges(expires_at);

ALTER TABLE user_totp ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_totp FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_totp_self ON user_totp;
CREATE POLICY user_totp_self ON user_totp FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE two_factor_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE two_factor_challenges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS two_factor_challenges_self ON two_factor_challenges;
CREATE POLICY two_factor_challenges_self ON two_factor_challenges FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
