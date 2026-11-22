import type { FastifyBaseLogger } from "fastify";
import { ensurePlatformSchedules, registerPlatformJobs } from "../../lib/job-handlers.js";
import { startWorker, stopWorker } from "../../lib/job-queue.js";

/**
 * In-process scheduler for long-lived hosts (Docker, Render, Fly, a VM).
 *
 * Work is durable: schedules enqueue singleton rows in `job_queue`, and a
 * worker loop claims them with FOR UPDATE SKIP LOCKED and a lease. A crash
 * mid-job returns the row to the queue when the lease expires. The dunning
 * engine still uses its own claim/send/record path, so a retried job cannot
 * charge a credit twice.
 *
 * Serverless hosts that cannot run a process should call `/cron/dunning`,
 * which enqueues the same jobs. GitHub's 5-minute Actions cron is not required.
 */

export function startScheduler(log: FastifyBaseLogger): void {
  registerPlatformJobs();
  ensurePlatformSchedules()
    .then(() => startWorker(log))
    .catch((err) => log.error({ err }, "failed to start worker"));
}

export function stopScheduler(): void {
  stopWorker();
}

/** @deprecated kept for older imports */
export const startDunningScheduler = (app: { log: FastifyBaseLogger }) => startScheduler(app.log);
/** @deprecated kept for older imports */
export const stopDunningScheduler = stopScheduler;
