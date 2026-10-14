-- Fix the live OAuth state table so Google login can begin without a tenant yet.
ALTER TABLE oauth_states ALTER COLUMN tenant_id DROP NOT NULL;

ALTER TABLE oauth_states DROP CONSTRAINT IF EXISTS oauth_states_provider_check;
ALTER TABLE oauth_states
  ADD CONSTRAINT oauth_states_provider_check
  CHECK (provider IN ('stripe', 'qbo', 'google'));
