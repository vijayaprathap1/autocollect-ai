import { config } from "../config.js";
import { closeDb } from "../lib/db.js";
import { ensureSuperAdmin } from "../lib/super-admin.js";

/**
 * Creates or updates the platform super admin from SUPER_ADMIN_EMAIL /
 * SUPER_ADMIN_PASSWORD. Run after migrations on hosts without a startup phase
 * (the Vercel build does this for production deployments).
 */
async function main(): Promise<void> {
  if (config.superAdminPassword === "admin123" || config.superAdminPassword.length < 12) {
    throw new Error("SUPER_ADMIN_PASSWORD must be set to 12+ characters (not the default)");
  }
  const email = await ensureSuperAdmin();
  console.log(`Super admin ensured: ${email}`);
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("ensure-admin failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
