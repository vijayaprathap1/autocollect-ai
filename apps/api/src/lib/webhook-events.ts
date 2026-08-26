import { servicePool } from "./db.js";

export async function claimWebhookEvent(
  id: string,
  source: string,
  tenantId?: string,
): Promise<boolean> {
  const result = await servicePool.query(
    `INSERT INTO webhook_events (id, tenant_id, source, status, attempts, locked_until)
     VALUES ($1, $2, $3, 'processing', 1, now() + interval '5 minutes')
     ON CONFLICT (id) DO UPDATE
       SET status = 'processing',
           attempts = webhook_events.attempts + 1,
           locked_until = now() + interval '5 minutes',
           error = NULL
     WHERE webhook_events.status = 'failed'
        OR (webhook_events.status = 'processing' AND webhook_events.locked_until < now())
     RETURNING id`,
    [id, tenantId ?? null, source],
  );
  return result.rows.length > 0;
}

export async function completeWebhookEvent(id: string): Promise<void> {
  await servicePool.query(
    `UPDATE webhook_events SET status = 'processed', processed_at = now(), locked_until = NULL, error = NULL WHERE id = $1`,
    [id],
  );
}

export async function failWebhookEvent(id: string, error: unknown): Promise<void> {
  await servicePool.query(
    `UPDATE webhook_events SET status = 'failed', locked_until = NULL, error = $2 WHERE id = $1`,
    [id, error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000)],
  );
}