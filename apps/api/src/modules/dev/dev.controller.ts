import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { requireRole } from "../../plugins/tenant.js";
import { notFound } from "../../lib/errors.js";
import { runDunning } from "../workflows/engine.js";
import { syncAllQuickBooks } from "../integrations/qbo.sync.service.js";

/**
 * Dev-only manual triggers (mirror of the stripe dev-event simulator).
 * Disabled in production.
 */
export async function devRoutes(app: FastifyInstance) {
  app.post(
    "/dev/dunning-run",
    { preHandler: requireRole("admin") },
    async (req) => {
      if (config.nodeEnv === "production") throw notFound("Disabled in production");
      const sent = await runDunning();
      const qbo = await syncAllQuickBooks();
      return { sent, qbo };
    },
  );
}