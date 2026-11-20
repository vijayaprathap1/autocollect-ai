-- Migration 028: external sign-in identities ("Continue with Stripe").
--
-- A Stripe Connect grant identifies a Stripe *account* (acct_...), not a
-- verified person, so Stripe sign-in is keyed on that account id — never on
-- the account's email (which Stripe does not guarantee is verified).

CREATE TABLE IF NOT EXISTS user_identities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('stripe')),
  subject       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);

-- Only the service role (BYPASSRLS) touches identities: during sign-in, before
-- a tenant exists. The RLS-restricted app role gets no rows.
ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identities FORCE ROW LEVEL SECURITY;

-- OAuth state for the sign-in flow (no tenant yet, browser-bound nonce).
ALTER TABLE oauth_states DROP CONSTRAINT IF EXISTS oauth_states_provider_check;
ALTER TABLE oauth_states
  ADD CONSTRAINT oauth_states_provider_check
  CHECK (provider IN ('stripe', 'qbo', 'google', 'stripe_login'));

-- Workspaces that already connected Stripe from Settings: let their owner use
-- "Continue with Stripe" with that same account.
INSERT INTO user_identities (user_id, provider, subject)
SELECT DISTINCT ON (ig.credentials->>'stripe_account_id')
       m.user_id, 'stripe', ig.credentials->>'stripe_account_id'
  FROM integrations ig
  JOIN memberships m ON m.tenant_id = ig.tenant_id AND m.role = 'owner' AND m.status = 'active'
 WHERE ig.source = 'stripe' AND ig.status = 'active'
   AND ig.credentials->>'stripe_account_id' IS NOT NULL
   AND ig.credentials->>'stripe_account_id' <> 'acct_dev_mock'
 ORDER BY ig.credentials->>'stripe_account_id', m.created_at
ON CONFLICT (provider, subject) DO NOTHING;
