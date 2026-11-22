import { config, validateProductionConfig } from "./config.js";
import { closeDb } from "./lib/db.js";
import { ensurePlatformSchedules, registerPlatformJobs } from "./lib/job-handlers.js";
import { startWorker, stopWorker } from "./lib/job-queue.js";
import { captureException } from "./lib/observability.js";
import { isMainModule } from "./lib/main-module.js";

/**
 * Dedicated worker process.
 *
 *   npm run worker            # development (tsx)
 *   node dist/worker.js       # production image
 *
 * The API process also runs this loop when RUN_SCHEDULER=true, so a single
 * container does not need a second process. Run this entrypoint (and set
 * RUN_SCHEDULER=false on the web replicas) when you want jobs isolated from
 * request traffic. Postgres leases make overlapping processes safe.
 */
export async function runWorker(): Promise<void> {
  validateProductionConfig();
  registerPlatformJobs();
  const log = {
    info: (obj: unknown, msg?: string) => console.log(JSON.stringify({ level: "info", msg, ...(obj as object) })),
    warn: (obj: unknown, msg?: string) => console.warn(JSON.stringify({ level: "warn", msg, ...(obj as object) })),
    error: (obj: unknown, msg?: string) => console.error(JSON.stringify({ level: "error", msg, ...(obj as object) })),
  };

  await ensurePlatformSchedules();
  startWorker(log);
  log.info({ pollMs: config.workerPollMs }, "autocollect worker running");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "worker shutting down");
    stopWorker();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "unhandledRejection");
    void captureException(reason, { component: "worker" });
  });
}

if (isMainModule(import.meta.url)) {
  runWorker().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
