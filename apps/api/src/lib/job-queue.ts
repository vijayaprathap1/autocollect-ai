import { servicePool } from "./db.js";

/**
 * Enqueue a job.
 * @param jobName - The name of the job (e.g., 'dunning').
 * @param payload - The payload to store with the job.
 * @param scheduledAt - When the job should be run (default: now).
 * @param maxAttempts - Maximum number of attempts (default: 3).
 */
export async function enqueueJob(
  jobName: string,
  payload: Record<string, unknown> = {},
  scheduledAt: Date = new Date(),
  maxAttempts: number = 3
): Promise<void> {
  await servicePool.query(
    `INSERT INTO job_queue (job_name, payload, scheduled_at, max_attempts)
     VALUES ($1, $2, $3, $4)`,
    [jobName, JSON.stringify(payload), scheduledAt, maxAttempts]
  );
}

/**
 * Dequeue a job for processing.
 * This function locks the row, so only one worker can process it at a time.
 * @returns The job or null if no job is available.
 */
export async function dequeueJob(jobName: string): Promise<{
  id: string;
  payload: Record<string, unknown>;
} | null> {
  const client = await servicePool.connect();
  try {
    await client.query("BEGIN");
    // Use FOR UPDATE SKIP LOCKED to lock the row and skip if locked by another transaction.
    const result = await client.query(
      `SELECT id, payload FROM job_queue
       WHERE job_name = $1 AND attempted_at IS NULL AND scheduled_at <= now()
       ORDER BY scheduled_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [jobName]
    );
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const job = result.rows[0];
    // Mark as attempted (we set attempted_at to now, but we don't commit yet)
    await client.query(
      `UPDATE job_queue SET attempted_at = now() WHERE id = $1`,
      [job.id]
    );
    await client.query("COMMIT");
    return {
      id: job.id,
      payload: job.payload as Record<string, unknown>,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Complete a job (remove it from the queue).
 * @param jobId - The ID of the job to complete.
 */
export async function completeJob(jobId: string): Promise<void> {
  await servicePool.query(
    `DELETE FROM job_queue WHERE id = $1`,
    [jobId]
  );
}

/**
 * Fail a job (increment attempts and optionally reschedule).
 * If the job has exceeded max_attempts, it is removed (or we could move to a dead letter queue).
 * For simplicity, we remove it after max_attempts.
 * @param jobId - The ID of the job that failed.
 * @param error - The error message.
 */
export async function failJob(jobId: string, error: string): Promise<void> {
  // Make it runnable again after a short backoff (it was left claimed before,
  // so a failed job was never retried and sat in the table forever).
  await servicePool.query(
    `UPDATE job_queue
     SET attempts = attempts + 1,
         last_error = $2,
         attempted_at = NULL,
         scheduled_at = now() + ((attempts + 1) * interval '1 minute')
     WHERE id = $1`,
    [jobId, error]
  );
  // If the job has exhausted attempts, delete it.
  await servicePool.query(
    `DELETE FROM job_queue WHERE id = $1 AND attempts >= max_attempts`,
    [jobId]
  );
}