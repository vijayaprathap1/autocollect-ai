import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { runDunning } from "./engine.js";
import { syncAllQuickBooks } from "../integrations/qbo.sync.service.js";
import { enqueueJob, dequeueJob, completeJob, failJob } from "../../lib/job-queue.js";

let enqueueTimer: NodeJS.Timeout | null = null;
let workerTimer: NodeJS.Timeout | null = null;
let enqueuing = false;
let processing = false;

/**
 * Enqueues a recurring dunning job at the specified interval.
 */
async function enqueueDunningJob() {
  if (enqueuing) return;
  enqueuing = true;
  try {
    // Enqueue a job to run dunning. We'll let the worker pick it up.
    // We don't need to check for duplicates because we rely on the job queue's processing
    // to avoid concurrent execution (via the locking in dequeueJob).
    // However, we might want to avoid enqueuing too many jobs if the worker is behind.
    // For simplicity, we enqueue every interval and let the worker process them sequentially.
    await enqueueJob("dunning", {}, new Date(Date.now() + config.dunningScanIntervalMs));
  } finally {
    enqueuing = false;
  }
}

/**
 * Worker that processes the job queue for dunning jobs.
 */
async function processDunningQueue() {
  if (processing) return;
  processing = true;
  try {
    const job = await dequeueJob("dunning");
    if (job) {
      try {
        const sent = await runDunning();
        if (sent > 0) {
          // Also sync QuickBooks if dunning sent something? Keep original behavior.
          const qbo = await syncAllQuickBooks();
          if (qbo.tenants > 0) {
            // We don't have the app instance here to log, but we can use a logger.
            // For now, we'll just complete the job.
          }
        }
        await completeJob(job.id);
      } catch (err) {
        await failJob(job.id, err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    processing = false;
  }
}

/**
 * Start the dunning scheduler: sets up an enqueuer timer and a worker timer.
 */
export async function startDunningScheduler(app: FastifyInstance) {
  // Clear any existing timers
  if (enqueueTimer) clearInterval(enqueueTimer);
  if (workerTimer) clearInterval(workerTimer);

  // Enqueue timer: runs every dunningScanIntervalMs to enqueue a job.
  enqueueTimer = setInterval(async () => {
    await enqueueDunningJob();
  }, config.dunningScanIntervalMs);

  // Worker timer: runs every second to process the job queue.
  workerTimer = setInterval(async () => {
    await processDunningQueue();
  }, 1000); // Check every second for due jobs

  // Also run once right away so we don't wait a full interval after boot.
  await enqueueJob("dunning", {}, new Date());
}

/**
 * Stop the dunning scheduler.
 */
export function stopDunningScheduler(): void {
  if (enqueueTimer) {
    clearInterval(enqueueTimer);
    enqueueTimer = null;
  }
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}