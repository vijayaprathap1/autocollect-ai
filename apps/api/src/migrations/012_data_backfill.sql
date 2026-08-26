-- Migration 012: Data backfill
-- Migrates old users (1-user-per-tenant) to new users + memberships model.

-- ─── Backfill: existing users → new users + memberships ────────────────────

DO $$
DECLARE
  r RECORD;
  new_user_id UUID;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (u.email)
      u.id AS old_user_id, u.email, u.role, u.tenant_id, u.created_at
    FROM users u
    WHERE u.email IS NOT NULL
    ORDER BY u.email, u.created_at ASC
  LOOP
    -- Check if user already exists
    SELECT id INTO new_user_id FROM users WHERE email = LOWER(TRIM(r.email));

    -- Insert if not exists
    IF new_user_id IS NULL THEN
      new_user_id := gen_random_uuid();
      INSERT INTO users (id, email, password_hash, display_name, status, email_verified_at, created_at)
      VALUES (
        new_user_id,
        LOWER(TRIM(r.email)),
        'needs_password_reset',
        SPLIT_PART(r.email, '@', 1),
        'active',
        now(),
        r.created_at
      );
    END IF;

    -- Insert membership (skip if exists)
    INSERT INTO memberships (user_id, tenant_id, role, status, created_at)
    VALUES (new_user_id, r.tenant_id, r.role, 'active', r.created_at)
    ON CONFLICT (user_id, tenant_id) DO NOTHING;
  END LOOP;
END $$;

-- ─── Seed super admin ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE email = 'admin@autocollect.local') THEN
    INSERT INTO users (email, password_hash, display_name, status, email_verified_at, is_super_admin, created_at)
    VALUES (
      'admin@autocollect.local',
      '$argon2id$v=19$m=65536,t=3,p=1$dGVzdA$placeholder',
      'Super Admin',
      'active',
      now(),
      TRUE,
      now()
    );
  END IF;
END $$;

-- ─── Grant starter credits to all tenants ──────────────────────────────────
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM tenants
  LOOP
    INSERT INTO credit_wallets (tenant_id, balance, updated_at)
    VALUES (t.id, 50, now())
    ON CONFLICT (tenant_id) DO NOTHING;

    INSERT INTO credit_transactions (tenant_id, delta, reason, actor, created_at)
    SELECT t.id, 50, 'plan_allowance', 'system', now()
    WHERE NOT EXISTS (
      SELECT 1 FROM credit_transactions ct
      WHERE ct.tenant_id = t.id AND ct.reason = 'plan_allowance'
    );
  END LOOP;
END $$;
