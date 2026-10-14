import { buildApp } from "./app.js";
import { startScheduler, stopScheduler } from "./modules/workflows/scheduler.js";
import { closeDb } from "./lib/db.js";
import { config, isDevLike, validateProductionConfig } from "./config.js";
import { ensureSuperAdmin } from "./lib/super-admin.js";

validateProductionConfig();
const app = buildApp();

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down: draining requests");
  const force = setTimeout(() => {
    app.log.error("Forced exit after 25s shutdown timeout");
    process.exit(1);
  }, 25_000);
  force.unref();
  try {
    stopScheduler();
    await app.close(); // stop accepting + finish in-flight requests first…
    await closeDb(); // …then release DB connections.
  } catch (err) {
    app.log.error({ err }, "Error during shutdown");
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
  app.log.fatal({ err }, "uncaughtException — exiting");
  void shutdown("uncaughtException", 1);
});

app
  .listen({ port: config.port, host: config.host })
  .then(async () => {
    try {
      app.log.info(`Super admin ensured: ${await ensureSuperAdmin()}`);
    } catch (err) {
      app.log.warn({ err }, "Could not ensure super admin (run migrations first)");
    }
    if (config.runScheduler && config.nodeEnv !== "test") {
      startScheduler(app.log);
    } else {
      app.log.info("Scheduler disabled for this process (RUN_SCHEDULER=false)");
    }
    if (isDevLike) app.log.info("Development mode: mocks and dev routes are enabled");
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
