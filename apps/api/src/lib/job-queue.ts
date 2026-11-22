import { randomBytes } from "node:crypto";
import { servicePool } from "./db.js";
import { config } from "../config.js";
import { captureException, increment } from "./observability.js";

export type JobPayload = Record<string, unknown>;

export type JobContext = { id: string; name: string; attempt: number };

export type JobHandler = (payload: JobPayload, ctx: JobContext) => Promise<void>;

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const handlers = new Map<string, JobHandler>();

const LEASE_SECONDS = 120;

let timer: NodeJS.Timeout | null = null;
let tickRunning = false;
let stopped = false;
const workerId = `worker-${process.pid}-${randomBytes(3).toString("hex")}`;

export function registerJob(name: string, handler: JobHandler): void {
  handlers.set(name, handler);
}

export function registeredJobs(): string[] {
  return [...handlers.keys()];
}

/**
 * Insert a job. A singleton key collapses duplicates: while a pending or
 * running row with the same (name, key) exists, the insert is a no-op.
 * That is what keeps a 5-second poll from stacking dunning runs.
 */
export async function enqueueJob(
  jobName: string,
  payload: JobPayload = {},
  opts: { scheduledAt?: Date; maxAttempts?: number; singletonKey?: string | null } = {},
): Promise<boolean> {
  const result = await servicePool.query(
    `INSERT INTO job_queue (job_name, payload, scheduled_at, max_attempts, singleton_key, status)
     VALUES ($1, $2::jsonb, $3, $4, $5, 'pending')
     ON CONFLICT (job_name, singleton_key) WHERE singleton_key IS NOT NULL AND status IN ('pending', 'running')
     DO NOTHING
     RETURNING id`,
    [
      jobName,
      JSON.stringify(payload),
      (opts.scheduledAt ?? new Date()).toISOString(),
      opts.maxAttempts ?? 5,
      opts.singletonKey ?? null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Upsert a recurring schedule. The worker enqueues one singleton job each time it comes due. */
export async function ensureSchedule(jobName: string, intervalSeconds: number): Promise<void> {
  const seconds = Math.max(5, Math.floor(intervalSeconds));
  await servicePool.query(
    `INSERT INTO job_schedules (job_name, interval_seconds, next_run_at)
     VALUES ($1, $2, now())
     ON CONFLICT (job_name) DO UPDATE
       SET interval_seconds = EXCLUDED.interval_seconds, updated_at = now()`,
    [jobName, seconds],
  );
}

export async function tickSchedules(): Promise<string[]> {
  const due = await servicePool.query<{ job_name: string }>(
    `UPDATE job_schedules
        SET next_run_at = now() + make_interval(secs => interval_seconds),
            updated_at = now()
      WHERE enabled AND next_run_at <= now()
      RETURNING job_name`,
  );
  const queued: string[] = [];
  for (const row of due.rows) {
    const inserted = await enqueueJob(row.job_name, {}, { singletonKey: row.job_name, maxAttempts: 3 });
    if (inserted) queued.push(row.job_name);
  }
  return queued;
}

type ClaimedJob = { id: string; job_name: string; payload: JobPayload; attempts: number };

async function reclaimExpired(): Promise<number> {
  const res = await servicePool.query(
    `UPDATE job_queue
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
            locked_by = NULL,
            locked_until = NULL,
            last_error = COALESCE(last_error, 'lease expired before the job finished'),
            finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
            scheduled_at = CASE WHEN attempts >= max_attempts THEN scheduled_at ELSE now() END
      WHERE status = 'running' AND locked_until IS NOT NULL AND locked_until < now()`,
  );
  return res.rowCount ?? 0;
}

async function claimJobs(limit: number, onlyName: string | null): Promise<ClaimedJob[]> {
  const res = await servicePool.query<ClaimedJob>(
    `WITH next AS (
       SELECT id FROM job_queue
        WHERE status = 'pending' AND scheduled_at <= now() AND attempts < max_attempts
          AND ($2::text IS NULL OR job_name = $2)
        ORDER BY scheduled_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE job_queue q
        SET status = 'running',
            locked_by = $3,
            locked_until = now() + ($4::int * interval '1 second'),
            started_at = now(),
            attempted_at = now(),
            attempts = q.attempts + 1
       FROM next
      WHERE q.id = next.id
      RETURNING q.id, q.job_name, q.payload, q.attempts`,
    [limit, onlyName, workerId, LEASE_SECONDS],
  );
  return res.rows.map((row) => ({
    ...row,
    payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as JobPayload,
  }));
}

async function completeJob(id: string): Promise<void> {
  await servicePool.query(`DELETE FROM job_queue WHERE id = $1`, [id]);
}

async function failJob(id: string, error: string, dead = false): Promise<void> {
  await servicePool.query(
    `UPDATE job_queue
        SET status = CASE WHEN $3::boolean OR attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
            scheduled_at = now() + (LEAST(attempts, 8) * interval '30 seconds'),
            locked_by = NULL,
            locked_until = NULL,
            last_error = $2,
            finished_at = CASE WHEN $3::boolean OR attempts >= max_attempts THEN now() ELSE NULL END
      WHERE id = $1`,
    [id, error.slice(0, 1000), dead],
  );
}

export async function processJobs(opts: { limit?: number; jobName?: string } = {}): Promise<{ processed: number; failed: number; reclaimed: number }> {
  const reclaimed = await reclaimExpired();
  const jobs = await claimJobs(opts.limit ?? 10, opts.jobName ?? null);
  let processed = 0;
  let failed = 0;
  for (const job of jobs) {
    const handler = handlers.get(job.job_name);
    if (!handler) {
      await failJob(job.id, `No handler registered for ${job.job_name}`, true);
      failed += 1;
      continue;
    }
    try {
      await handler(job.payload ?? {}, { id: job.id, name: job.job_name, attempt: job.attempts });
      await completeJob(job.id);
      processed += 1;
      increment("autocollect_jobs_total", 1, { job: job.job_name, result: "ok" });
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await failJob(job.id, message).catch(() => {});
      increment("autocollect_jobs_total", 1, { job: job.job_name, result: "error" });
      await captureException(err, { job: job.job_name, jobId: job.id, attempt: job.attempts });
    }
  }
  return { processed, failed, reclaimed };
}

async function beat(processed: number): Promise<void> {
  await servicePool.query(
    `INSERT INTO worker_heartbeats (worker_id, seen_at, processed)
     VALUES ($1, now(), $2)
     ON CONFLICT (worker_id) DO UPDATE
       SET seen_at = now(), processed = worker_heartbeats.processed + EXCLUDED.processed`,
    [workerId, processed],
  );
}

/**
 * Postgres-backed worker loop. Safe to run inside the API process and as a
 * separate `node dist/worker.js` process: SKIP LOCKED plus singleton keys
 * keep two workers from double-running a schedule, and the dunning engine
 * still takes its own lease so a manual cron poke cannot double-charge.
 */
export function startWorker(log: Logger): void {
  if (timer) return;
  stopped = false;
  const tick = async () => {
    if (tickRunning || stopped) return;
    tickRunning = true;
    try {
      const queued = await tickSchedules();
      const result = await processJobs({ limit: 8 });
      await beat(result.processed);
      if (queued.length || result.processed || result.failed || result.reclaimed) {
        log.info({ queued, ...result }, "worker tick");
      }
    } catch (err) {
      log.error({ err }, "worker tick failed");
      await captureException(err, { component: "worker" }).catch(() => {});
    } finally {
      tickRunning = false;
    }
  };
  timer = setInterval(() => void tick(), config.workerPollMs);
  timer.unref?.();
  setTimeout(() => void tick(), 1_000).unref?.();
  log.info({ workerId, pollMs: config.workerPollMs, jobs: registeredJobs() }, "worker started");
}

export function stopWorker(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

export function currentWorkerId(): string {
  return workerId;
}
