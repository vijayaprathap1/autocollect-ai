-- Cross-process lease for scheduled platform jobs.
CREATE TABLE IF NOT EXISTS job_leases (
  job_name TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_leases_expiry ON job_leases(expires_at);