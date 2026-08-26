import { randomUUID } from "node:crypto";
import { servicePool } from "./db.js";

const holderId = `${process.pid}-${randomUUID()}`;
const leaseSeconds = 120;

export async function acquireJobLease(jobName: string): Promise<boolean> {
  const result = await servicePool.query(
    `INSERT INTO job_leases (job_name, holder_id, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 second'))
     ON CONFLICT (job_name) DO UPDATE
       SET holder_id = EXCLUDED.holder_id,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()
     WHERE job_leases.expires_at <= now()
     RETURNING job_name`,
    [jobName, holderId, leaseSeconds],
  );
  return result.rows.length > 0;
}

export async function releaseJobLease(jobName: string): Promise<void> {
  await servicePool.query(
    `DELETE FROM job_leases WHERE job_name = $1 AND holder_id = $2`,
    [jobName, holderId],
  );
}