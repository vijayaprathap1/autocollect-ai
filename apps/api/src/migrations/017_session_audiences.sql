-- Keep platform-admin sessions separate from tenant sessions.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_type TEXT NOT NULL DEFAULT 'tenant'
  CHECK (session_type IN ('tenant', 'admin'));