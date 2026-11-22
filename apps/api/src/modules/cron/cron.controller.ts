import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { unauthorized, unavailable } from "../../lib/errors.js";
import { enqueuePlatformJob, registerPlatformJobs } from "../../lib/job-handlers.js";
import { processJobs } from "../../lib/job-queue.js";

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

export async function cronRoutes(app: FastifyInstance) {
  const opts = { config: { public: true, rateLimit: false as const } };

  // External poke (Vercel Cron, a manual backup). Jobs are the same rows the
  // in-app worker drains, then this request runs whatever it just queued so a
  // host with no resident worker still sends reminders before the function ends.
  app.route({
    method: ["GET", "POST"],
    url: "/cron/dunning",
    ...opts,
    handler: async (req) => {
      assertCron(req);
      registerPlatformJobs();
      const minute = new Date().getUTCMinutes();
      await enqueuePlatformJob("dunning");
      await enqueuePlatformJob("qbo-sync");
      await enqueuePlatformJob("stripe-backfill");
      if (minute < 5) await enqueuePlatformJob("housekeeping");
      const jobs = await processJobs({ limit: 6 });
      return { ok: true, jobs };
    },
  });

  app.route({
    method: ["GET", "POST"],
    url: "/cron/housekeeping",
    ...opts,
    handler: async (req) => {
      assertCron(req);
      registerPlatformJobs();
      await enqueuePlatformJob("housekeeping");
      return { ok: true, jobs: await processJobs({ limit: 2, jobName: "housekeeping" }) };
    },
  });
}
