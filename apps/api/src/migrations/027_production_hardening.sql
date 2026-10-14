-- Migration 027: production hardening.
--
-- 1) NULL-safe RLS policies. Once a custom setting such as app.tenant_id has
--    been used on a connection, RESET leaves it as '' (not NULL) and
--    ''::uuid raises "invalid input syntax for type uuid". NULLIF makes an
--    unscoped connection see zero rows instead of erroring.
-- 2) RLS on tenants (was readable across tenants by the runtime role).
-- 3) Columns for login lockout, tenant-bound sessions, subscription sync,
--    idempotent plan credit grants, tenant scheduling preferences, promise
--    snoozes, and the indexes the hot paths need.

-- ─── 1. NULL-safe tenant policies ────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'invoices','customers','workflows','templates','messages','replies',
    'integrations','audit_log','webhook_events'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

DROP POLICY IF EXISTS memberships_tenant ON memberships;
CREATE POLICY memberships_tenant ON memberships FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS invitations_tenant ON invitations;
CREATE POLICY invitations_tenant ON invitations FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS subscriptions_tenant ON subscriptions;
CREATE POLICY subscriptions_tenant ON subscriptions FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS credit_wallets_tenant ON credit_wallets;
CREATE POLICY credit_wallets_tenant ON credit_wallets FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS credit_txn_tenant ON credit_transactions;
CREATE POLICY credit_txn_tenant ON credit_transactions FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS users_self ON users;
CREATE POLICY users_self ON users FOR ALL
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS users_tenant ON users;
CREATE POLICY users_tenant ON users FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
       WHERE m.user_id = users.id
         AND m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS sessions_own ON sessions;
CREATE POLICY sessions_own ON sessions FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS prt_own ON password_reset_tokens;
CREATE POLICY prt_own ON password_reset_tokens FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS evt_own ON email_verification_tokens;
CREATE POLICY evt_own ON email_verification_tokens FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- ─── 2. tenants: RLS + missing columns ───────────────────────────────────────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS send_hour INT NOT NULL DEFAULT 9;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS skip_weekends BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reply_notifications BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_send_hour_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_send_hour_check CHECK (send_hour BETWEEN 0 AND 23);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_self ON tenants;
CREATE POLICY tenants_self ON tenants FOR ALL
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ─── 3. users: brute-force lockout ───────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
-- Lookups lowercase the input; normalise stored emails where that can't collide.
UPDATE users u SET email = lower(u.email)
 WHERE u.email <> lower(u.email)
   AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id <> u.id AND lower(o.email) = lower(u.email));

-- ─── 4. sessions: bind to a tenant (multi-org users) + cleanup index ─────────
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

-- ─── 5. subscriptions: one row per tenant, synced from Stripe ────────────────
UPDATE subscriptions SET plan = 'starter' WHERE plan = 'free';
ALTER TABLE subscriptions ALTER COLUMN plan SET DEFAULT 'starter';

DELETE FROM subscriptions a
 USING subscriptions b
 WHERE a.tenant_id = b.tenant_id
   AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id));
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_per_tenant ON subscriptions(tenant_id);

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused'));

-- Every tenant needs a subscription row (older admin/dev paths skipped it).
INSERT INTO subscriptions (tenant_id, plan, status, credits_per_month)
SELECT t.id, COALESCE(t.plan, 'starter'), 'active', 50
  FROM tenants t
 WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id);

-- Idempotent plan credit grants: one grant per Stripe invoice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_txn_plan_grant_once
  ON credit_transactions(tenant_id, reason, reference_id)
  WHERE reference_id IS NOT NULL AND reason = 'plan_grant';

-- ─── 6. integrations: a Stripe account can belong to one active tenant ───────
WITH ranked AS (
  SELECT id, row_number() OVER (
           PARTITION BY credentials->>'stripe_account_id'
           ORDER BY created_at DESC, id DESC) AS rn
    FROM integrations
   WHERE source = 'stripe' AND status = 'active'
     AND credentials->>'stripe_account_id' IS NOT NULL
)
UPDATE integrations i SET status = 'disconnected'
  FROM ranked r WHERE r.id = i.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_active_stripe_account
  ON integrations ((credentials->>'stripe_account_id'))
  WHERE source = 'stripe' AND status = 'active';
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- ─── 7. invoices: explicit promise-to-pay snooze + engine index ──────────────
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_invoices_dunning_due
  ON invoices (next_step_due_at NULLS FIRST)
  WHERE status = 'open' AND next_step_index < 9999;

-- ─── 8. hot-path indexes ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_messages_provider_msg ON messages(provider_msg_id)
  WHERE provider_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created ON audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_replies_tenant ON replies(tenant_id, resolved, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed ON webhook_events(processed_at);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_email ON customers(tenant_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens(user_id);
