import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/scripts/migrate.js";
import { closeDb, servicePool } from "../../src/lib/db.js";
import { enqueueJob, processJobs, registerJob } from "../../src/lib/job-queue.js";

const d = describe;

d("job queue", () => {
  beforeAll(async () => {
    await migrate();
  });
  afterAll(async () => {
    await servicePool.query(`DELETE FROM job_queue WHERE job_name LIKE 'test-%'`);
    await closeDb();
  });

  it("runs one singleton job and retries a failure until it succeeds", async () => {
    let calls = 0;
    registerJob("test-echo", async (payload) => {
      calls += 1;
      if (payload.fail && calls === 1) throw new Error("transient");
    });
    const first = await enqueueJob("test-echo", { n: 1 }, { singletonKey: "echo", maxAttempts: 3 });
    const second = await enqueueJob("test-echo", { n: 2 }, { singletonKey: "echo", maxAttempts: 3 });
    expect(first).toBe(true);
    expect(second).toBe(false);

    await servicePool.query(`UPDATE job_queue SET payload = '{"fail":true}'::jsonb WHERE job_name = 'test-echo'`);
    const failed = await processJobs({ jobName: "test-echo", limit: 5 });
    expect(failed.failed).toBe(1);
    expect(calls).toBe(1);

    await servicePool.query(
      `UPDATE job_queue SET scheduled_at = now(), payload = '{}'::jsonb WHERE job_name = 'test-echo' AND status = 'pending'`,
    );
    const ok = await processJobs({ jobName: "test-echo", limit: 5 });
    expect(ok.processed).toBe(1);
    expect(calls).toBe(2);
    const left = await servicePool.query(`SELECT count(*)::int AS n FROM job_queue WHERE job_name = 'test-echo'`);
    expect(left.rows[0].n).toBe(0);
  });

  it("reclaims a job whose lease expired", async () => {
    let ran = 0;
    registerJob("test-reclaim", async () => {
      ran += 1;
    });
    await servicePool.query(
      `INSERT INTO job_queue (job_name, payload, scheduled_at, status, attempts, max_attempts, locked_until, locked_by)
       VALUES ('test-reclaim', '{}', now(), 'running', 1, 3, now() - interval '1 minute', 'dead-worker')`,
    );
    const result = await processJobs({ jobName: "test-reclaim", limit: 5 });
    expect(result.reclaimed).toBeGreaterThanOrEqual(1);
    expect(result.processed).toBe(1);
    expect(ran).toBe(1);
  });
});
