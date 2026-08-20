import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { runDunning } from "./engine.js";
import { syncAllQuickBooks } from "../integrations/qbo.sync.service.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function startDunningScheduler(app: FastifyInstance) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const sent = await runDunning();
      if (sent > 0) app.log.info({ sent }, "dunning: reminders sent");
      const qbo = await syncAllQuickBooks();
      if (qbo.tenants > 0) app.log.info(qbo, "qbo: sync completed");
    } catch (err) {
      app.log.error({ err }, "dunning: scan failed");
    } finally {
      running = false;
    }
  }, config.dunningScanIntervalMs);
}

export function stopDunningScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}