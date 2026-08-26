import { buildApp } from "./app.js";
import { startDunningScheduler, stopDunningScheduler } from "./modules/workflows/scheduler.js";
import { closeDb, pool } from "./lib/db.js";
import { config, validateProductionConfig } from "./config.js";
import { hashPassword } from "./lib/auth.js";

validateProductionConfig();
const app = buildApp();
const shutdown = async () => {
  app.log.info("Shutting down");
  stopDunningScheduler();
  await closeDb();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function seedSuperAdmin() {
  try {
    const hash = await hashPassword(config.superAdminPassword);
    await pool.query(
      `INSERT INTO users (email, password_hash, display_name, status, email_verified_at, is_super_admin)
       VALUES ($1, $2, 'Super Admin', 'active', now(), TRUE)
       ON CONFLICT (email) DO UPDATE
       SET password_hash = $2, is_super_admin = TRUE, status = 'active', email_verified_at = now()`,
      [config.superAdminEmail, hash],
    );
    app.log.info(`Super admin seeded: ${config.superAdminEmail}`);
  } catch (err) {
    app.log.warn({ err }, "Failed to seed super admin (may not exist yet — run migrations first)");
  }
}

app.listen({ port: config.port, host: "0.0.0.0" }).then(async () => {
  await seedSuperAdmin();
  if (config.nodeEnv !== "test") {
    await startDunningScheduler(app);
    app.log.info("Dunning scheduler started");
  }
}).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
