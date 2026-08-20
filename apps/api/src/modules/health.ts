import type { FastifyInstance } from "fastify";
import { query } from "../lib/db.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get(
    "/health",
    { config: { public: true } },
    async () => {
      let db = "ok";
      try {
        await query("SELECT 1");
      } catch {
        db = "error";
      }
      return { status: db === "ok" ? "ok" : "degraded", db, time: new Date().toISOString() };
    },
  );
}