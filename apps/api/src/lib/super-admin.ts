import { config } from "../config.js";
import { hashPassword } from "./auth.js";
import { servicePool } from "./db.js";

const SEEDED_DEV_ADMIN = "admin@autocollect.local";

/**
 * Ensure the platform super admin exists with the password from the
 * environment (the environment is the source of truth, so a database first
 * seeded with a dev password can't keep it once a production secret is set).
 * Long-lived servers call this at startup; serverless deployments run
 * `scripts/ensure-admin` after migrations because they have no startup phase.
 */
export async function ensureSuperAdmin(): Promise<string> {
  const hash = await hashPassword(config.superAdminPassword);
  await servicePool.query(
    `INSERT INTO users (email, password_hash, display_name, status, email_verified_at, is_super_admin)
     VALUES ($1, $2, 'Super Admin', 'active', now(), TRUE)
     ON CONFLICT (email) DO UPDATE
       SET is_super_admin = TRUE,
           status = 'active',
           email_verified_at = COALESCE(users.email_verified_at, now()),
           failed_login_count = 0,
           locked_until = NULL,
           password_hash = EXCLUDED.password_hash`,
    [config.superAdminEmail, hash],
  );
  // Migration 012 seeds a placeholder admin for local development. Once a real
  // admin is configured, that account must not keep platform privileges.
  if (config.superAdminEmail !== SEEDED_DEV_ADMIN) {
    await servicePool.query(`UPDATE users SET is_super_admin = FALSE, status = 'suspended' WHERE email = $1 AND is_super_admin`, [SEEDED_DEV_ADMIN]);
  }
  return config.superAdminEmail;
}
