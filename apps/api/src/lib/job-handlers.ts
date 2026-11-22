import { config } from "../config.js";
import { runHousekeeping } from "./housekeeping.js";
import { enqueueJob, ensureSchedule, registerJob } from "./job-queue.js";
import { increment } from "./observability.js";
import { runDunningDetailed } from "../modules/workflows/engine.js";
import { syncAllQuickBooks } from "../modules/integrations/qbo.sync.service.js";
import { resumeStripeBackfills } from "../modules/integrations/stripe.controller.js";

let registered = false;

/**
 * Platform jobs. Each one is also safe to invoke from `/cron/*` — the dunning
 * engine and the other tasks take database leases, so a worker and an external
 * poke cannot double-send or double-charge.
 */
export function registerPlatformJobs(): void {
  if (registered) return;
  registered = true;

  registerJob("dunning", async () => {
    const result = await runDunningDetailed();
    if (!result.skippedLease) {
      increment("autocollect_dunning_sent_total", result.sent);
      increment("autocollect_dunning_failed_total", result.failed);
    }
  });

  registerJob("qbo-sync", async () => {
    await syncAllQuickBooks();
  });

  registerJob("stripe-backfill", async () => {
    await resumeStripeBackfills(60_000);
  });

  registerJob("housekeeping", async () => {
    await runHousekeeping();
  });
}

/** Install the recurring schedules the worker drains. Idempotent. */
export async function ensurePlatformSchedules(): Promise<void> {
  registerPlatformJobs();
  await ensureSchedule("dunning", Math.max(30, Math.round(config.dunningScanIntervalMs / 1000)));
  await ensureSchedule("qbo-sync", Math.max(60, Math.round(config.qboSyncIntervalMs / 1000)));
  await ensureSchedule("stripe-backfill", 120);
  await ensureSchedule("housekeeping", 6 * 3600);
}

/** Used by the HTTP cron endpoint so an external poke goes through the same queue. */
export async function enqueuePlatformJob(name: "dunning" | "qbo-sync" | "stripe-backfill" | "housekeeping"): Promise<boolean> {
  registerPlatformJobs();
  return enqueueJob(name, {}, { singletonKey: name, maxAttempts: 3 });
}
