import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { unauthorized, unavailable } from "../../lib/errors.js";
import { runDunningDetailed } from "../workflows/engine.js";
import { syncAllQuickBooks } from "../integrations/qbo.sync.service.js";
import { runHousekeeping } from "../../lib/housekeeping.js";
import { acquireJobLease, releaseJobLease } from "../../lib/job-lock.js";
import { resumeStripeBackfills } from "../integrations/stripe.controller.js";

/**
 * Scheduled triggers for serverless deployments (Vercel Cron, GitHub Actions,
 * any external scheduler). Vercel sends `Authorization: Bearer <CRON_SECRET>`;
 * others may send `x-cron-secret`.
 */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function assertCron(req: FastifyRequest): void {
  if (!config.cronSecret) throw unavailable("CRON_SECRET not configured", "CRON_NOT_CONFIGURED");
  const auth = (req.headers.authorization as string | undefined) ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : ((req.headers["x-cron-secret"] as string | undefined) ?? "");
  if (!presented || !safeEqual(presented, config.cronSecret)) throw unauthorized("Invalid cron secret", "INVALID_CRON_SECRET");
}

async function withLease<T>(name: string, fn: () => Promise<T>): Promise<T | { skipped: true }> {
  if (!(await acquireJobLease(name))) return { skipped: true };
  try {
    return await fn();
  } finally {
    await releaseJobLease(name).catch(() => {});
  }
}

export async function cronRoutes(app: FastifyInstance) {
  const opts = { config: { public: true, rateLimit: false as const } };

  app.route({
    method: ["GET", "POST"],
    url: "/cron/dunning",
    ...opts,
    handler: async (req) => {
      assertCron(req);
      const dunning = await runDunningDetailed();
      // Piggy-back the cheaper periodic jobs; their own leases/intervals keep them from over-running.
      const qbo = await withLease("qbo-sync", () => syncAllQuickBooks());
      const stripeBackfill = await withLease("stripe-backfill", () => resumeStripeBackfills(10_000));
      const minute = new Date().getUTCMinutes();
      const housekeeping = minute < 5 ? await withLease("housekeeping", () => runHousekeeping()) : { skipped: true };
      return { ok: true, dunning, qbo, stripeBackfill, housekeeping };
    },
  });

  app.route({
    method: ["GET", "POST"],
    url: "/cron/housekeeping",
    ...opts,
    handler: async (req) => {
      assertCron(req);
      return { ok: true, housekeeping: await withLease("housekeeping", () => runHousekeeping()) };
    },
  });
}
