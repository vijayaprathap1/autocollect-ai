-- Migration 022: Add reservation timeout for outbound messages to prevent duplicate sends
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ NULL;

-- Index to find stale reservations (optional, for cleanup)
CREATE INDEX IF NOT EXISTS idx_messages_reserved_until ON messages(reserved_until) WHERE reserved_until IS NOT NULL;