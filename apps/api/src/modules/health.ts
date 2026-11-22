import type { FastifyInstance } from "fastify";
import { pool, servicePool } from "../lib/db.js";
import { config } from "../config.js";
import { metricsText, secretsEqual } from "../lib/observability.js";

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
    const [db, serviceDb, worker] = await Promise.all([
      ping(pool),
      ping(servicePool),
      servicePool
        .query<{ seen_at: Date | string | null; pending: number }>(
          `SELECT (SELECT max(seen_at) FROM worker_heartbeats) AS seen_at,
                  (SELECT count(*)::int FROM job_queue WHERE status IN ('pending', 'running')) AS pending`,
        )
        .then((r) => r.rows[0])
        .catch(() => null),
    ]);
    const ok = db === "ok" && serviceDb === "ok";
    const seen = worker?.seen_at ? new Date(worker.seen_at).getTime() : 0;
    const workerStatus = !seen ? "absent" : Date.now() - seen < 3 * 60_000 ? "ok" : "stale";
    return reply.status(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      checks: { db, serviceDb, worker: workerStatus },
      queue: { pending: worker?.pending ?? null },
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      version: config.version,
      time: new Date().toISOString(),
    });
  });

  /** Prometheus text. Set METRICS_TOKEN to require a bearer token. */
  app.get("/metrics", { config: { public: true, rateLimit: false } }, async (req, reply) => {
    if (config.metricsToken) {
      const auth = (req.headers.authorization as string | undefined) ?? "";
      const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!presented || !secretsEqual(presented, config.metricsToken)) {
        return reply.status(401).send("unauthorized\n");
      }
    }
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(metricsText());
  });
}
