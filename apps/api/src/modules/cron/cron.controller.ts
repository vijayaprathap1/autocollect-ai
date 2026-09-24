import type { FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { unauthorized } from "../../lib/errors.js";
import { pool } from "../../lib/db.js";
import { runDunning } from "../workflows/engine.js";
import { syncAllQuickBooks } from "../integrations/qbo.sync.service.js";

/**
 * Scheduled triggers for platform work in serverless deployments.
 * Vercel cron calls `/cron/dunning` with `x-cron-secret`; the in-process
 * scheduler that runs on a long-lived host is replaced by this on platforms
 * where processes are ephemeral.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function cronRoutes(app: FastifyInstance) {
  app.route({
    method: ["GET", "POST"],
    url: "/cron/dunning",
    config: { public: true },
    handler: async (req) => {
      if (!config.cronSecret) throw unauthorized("CRON_SECRET not configured", "CRON_NOT_CONFIGURED");
      // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; other
      // schedulers can send `x-cron-secret: <CRON_SECRET>`.
      const auth = (req.headers.authorization as string | undefined) ?? "";
      const presented = auth.startsWith("Bearer ")
        ? auth.slice(7)
        : ((req.headers["x-cron-secret"] as string | undefined) ?? "");
      if (!safeEqual(presented, config.cronSecret)) {
        throw unauthorized("Invalid cron secret", "INVALID_CRON_SECRET");
      }
      const sent = await runDunning();
      const qbo = await syncAllQuickBooks();
      // Cleanup expired sessions
      const cleaned = await pool.query(
        `DELETE FROM sessions WHERE expires_at < now()`,
      );
      return { ok: true, sent, qbo, sessionsCleaned: cleaned.rowCount ?? 0 };
    },
  });
}