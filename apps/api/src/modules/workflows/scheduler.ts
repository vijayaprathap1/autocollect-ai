import type { FastifyBaseLogger } from "fastify";
import { config } from "../../config.js";
import { runDunningDetailed } from "./engine.js";
import { syncAllQuickBooks } from "../integrations/qbo.sync.service.js";
import { runHousekeeping } from "../../lib/housekeeping.js";
import { acquireJobLease, releaseJobLease } from "../../lib/job-lock.js";
import { resumeStripeBackfills } from "../integrations/stripe.controller.js";

/**
 * In-process scheduler for long-lived hosts (Docker, Render, Fly, VMs).
 * Serverless deployments use /cron/dunning instead.
 *
 * Every loop is crash-proof: errors are logged, never thrown into a timer
 * (an unhandled rejection would kill the process). Cross-instance safety comes
 * from database leases, so running N replicas is fine.
 */

type Loop = { name: string; timer: NodeJS.Timeout | null; running: boolean };
const loops: Loop[] = [];

function every(log: FastifyBaseLogger, name: string, intervalMs: number, task: () => Promise<unknown>, runNow = true): void {
  const loop: Loop = { name, timer: null, running: false };
  const tick = async () => {
    if (loop.running) return; // never overlap with ourselves
    loop.running = true;
    try {
      const result = await task();
      if (result && typeof result === "object" && Object.values(result).some((v) => typeof v === "number" && v > 0)) {
        log.info({ job: name, result }, "scheduled job completed");
      }
    } catch (err) {
      log.error({ err, job: name }, "scheduled job failed");
    } finally {
      loop.running = false;
    }
  };
  loop.timer = setInterval(() => void tick(), intervalMs);
  loop.timer.unref?.();
  if (runNow) setTimeout(() => void tick(), 2_000).unref?.();
  loops.push(loop);
}

export function startScheduler(log: FastifyBaseLogger): void {
  stopScheduler();
  every(log, "dunning", config.dunningScanIntervalMs, async () => {
    const r = await runDunningDetailed();
    return r.skippedLease ? {} : { sent: r.sent, processed: r.processed, failed: r.failed };
  });
  every(log, "qbo-sync", config.qboSyncIntervalMs, async () => {
    if (!(await acquireJobLease("qbo-sync"))) return {};
    try {
      return await syncAllQuickBooks();
    } finally {
      await releaseJobLease("qbo-sync").catch(() => {});
    }
  }, false);
  every(log, "stripe-backfill", 2 * 60_000, async () => {
    if (!(await acquireJobLease("stripe-backfill"))) return {};
    try {
      return await resumeStripeBackfills(60_000);
    } finally {
      await releaseJobLease("stripe-backfill").catch(() => {});
    }
  });
  every(log, "housekeeping", 6 * 3_600_000, async () => {
    if (!(await acquireJobLease("housekeeping"))) return {};
    try {
      return await runHousekeeping();
    } finally {
      await releaseJobLease("housekeeping").catch(() => {});
    }
  });
  log.info({ dunningIntervalMs: config.dunningScanIntervalMs }, "Scheduler started");
}

export function stopScheduler(): void {
  for (const l of loops) if (l.timer) clearInterval(l.timer);
  loops.length = 0;
}

/** @deprecated kept for older imports */
export const startDunningScheduler = (app: { log: FastifyBaseLogger }) => startScheduler(app.log);
/** @deprecated kept for older imports */
export const stopDunningScheduler = stopScheduler;
