import type { FastifyInstance } from "fastify";
import { pool, servicePool } from "../lib/db.js";
import { config } from "../config.js";

async function ping(p: typeof pool, timeoutMs = 2000): Promise<"ok" | "error"> {
  try {
    await Promise.race([
      p.query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return "ok";
  } catch {
    return "error";
  }
}

export async function healthRoutes(app: FastifyInstance) {
  /** Liveness: the process is up. Never touches dependencies (safe for restarts). */
  app.get("/health", { config: { public: true, rateLimit: false } }, async () => ({
    status: "ok",
    version: config.version,
    time: new Date().toISOString(),
  }));

  /** Readiness: dependencies reachable. Load balancers should route on this. */
  app.get("/ready", { config: { public: true, rateLimit: false } }, async (_req, reply) => {
    const [db, serviceDb] = await Promise.all([ping(pool), ping(servicePool)]);
    const ok = db === "ok" && serviceDb === "ok";
    return reply.status(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      checks: { db, serviceDb },
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      version: config.version,
      time: new Date().toISOString(),
    });
  });
}
