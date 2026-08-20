import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { unauthorized } from "../../lib/errors.js";
import { runDunning } from "../workflows/engine.js";
import { syncAllQuickBooks } from "../integrations/qbo.sync.service.js";

/**
 * Scheduled triggers for platform work in serverless deployments.
 * Vercel cron calls `/cron/dunning` with `x-cron-secret`; the in-process
 * scheduler that runs on a long-lived host is replaced by this on platforms
 * where processes are ephemeral.
 */
export async function cronRoutes(app: FastifyInstance) {
  app.route({
    method: ["GET", "POST"],
    url: "/cron/dunning",
    config: { public: true },
    handler: async (req) => {
      if (!config.cronSecret) throw unauthorized("CRON_SECRET not configured", "CRON_NOT_CONFIGURED");
      const header = (req.headers["x-cron-secret"] as string) ?? "";
      if (header !== config.cronSecret) throw unauthorized("Invalid cron secret", "INVALID_CRON_SECRET");
      const sent = await runDunning();
      const qbo = await syncAllQuickBooks();
      return { ok: true, sent, qbo };
    },
  });
}