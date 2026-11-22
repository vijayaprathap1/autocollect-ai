import type { Queryable } from "./db.js";
import { servicePool } from "./db.js";
import { disputeReasonFromText, type DisputeReasonCode } from "./dispute-reason.js";
import { riskScore } from "./risk.js";

const OPEN_DISPUTE = `('open', 'investigating', 'pending_customer')`;

/** Open a dispute case for a classified reply, unless one is already open on the invoice. */
export async function openDisputeFromReply(
  client: Queryable,
  input: { tenantId: string; invoiceId: string; replyId: string; text: string },
): Promise<string | null> {
  const ctx = await client.query<{ customer_id: string | null; collector_user_id: string | null; external_id: string | null }>(
    `SELECT i.customer_id, c.collector_user_id, i.external_id
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.id = $1 AND i.tenant_id = $2`,
    [input.invoiceId, input.tenantId],
  );
  const row = ctx.rows[0];
  if (!row) return null;
  const reason: DisputeReasonCode = disputeReasonFromText(input.text);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO disputes (tenant_id, customer_id, invoice_id, reply_id, reason_code, status, owner_user_id, summary)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, $7)
     ON CONFLICT (tenant_id, invoice_id) WHERE invoice_id IS NOT NULL AND status IN ${OPEN_DISPUTE}
     DO NOTHING
     RETURNING id`,
    [
      input.tenantId,
      row.customer_id,
      input.invoiceId,
      input.replyId,
      reason,
      row.collector_user_id,
      input.text.slice(0, 500),
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) return null;
  await client.query(
    `INSERT INTO tasks (tenant_id, customer_id, invoice_id, dispute_id, title, due_on, owner_user_id, priority, source)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE + 2, $6, 20, 'dispute')`,
    [
      input.tenantId,
      row.customer_id,
      input.invoiceId,
      id,
      `Review dispute on ${row.external_id ?? "invoice"}`,
      row.collector_user_id,
    ],
  );
  return id;
}

/** Record a promise-to-pay. A second open promise on the same invoice is ignored. */
export async function recordPromiseFromReply(
  client: Queryable,
  input: { tenantId: string; invoiceId: string; replyId: string; promiseDate: string; amount: number; currency: string },
): Promise<string | null> {
  const ctx = await client.query<{ customer_id: string | null; collector_user_id: string | null }>(
    `SELECT i.customer_id, c.collector_user_id
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.id = $1 AND i.tenant_id = $2`,
    [input.invoiceId, input.tenantId],
  );
  const row = ctx.rows[0];
  if (!row) return null;
  const existing = await client.query(`SELECT id FROM promises WHERE tenant_id = $1 AND invoice_id = $2 AND status = 'open' LIMIT 1`, [
    input.tenantId,
    input.invoiceId,
  ]);
  if (existing.rows[0]) return existing.rows[0].id as string;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO promises (tenant_id, customer_id, invoice_id, reply_id, amount, currency, promise_date, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [input.tenantId, row.customer_id, input.invoiceId, input.replyId, input.amount, input.currency, input.promiseDate, row.collector_user_id],
  );
  return inserted.rows[0]?.id ?? null;
}

export type ReconcileResult = { kept: number; broken: number; tasks: number };

/**
 * Close promises against what was actually paid.
 * Paid on or before the day after the promised date counts as kept.
 * A date that passed with the invoice still open, or a late payment, is broken
 * and gets one follow-up task.
 */
export async function reconcilePromises(): Promise<ReconcileResult> {
  const kept = await servicePool.query(
    `UPDATE promises p
        SET status = 'kept', kept_at = now(), updated_at = now()
       FROM invoices i
      WHERE i.id = p.invoice_id AND i.tenant_id = p.tenant_id
        AND p.status = 'open' AND i.status = 'paid'
        AND i.updated_at::date <= p.promise_date + 1`,
  );
  const brokenPaidLate = await servicePool.query<{ id: string; tenant_id: string; customer_id: string | null; invoice_id: string | null; owner_user_id: string | null }>(
    `UPDATE promises p
        SET status = 'broken', broken_at = now(), updated_at = now()
       FROM invoices i
      WHERE i.id = p.invoice_id AND i.tenant_id = p.tenant_id
        AND p.status = 'open' AND i.status = 'paid'
        AND i.updated_at::date > p.promise_date + 1
      RETURNING p.id, p.tenant_id, p.customer_id, p.invoice_id, p.owner_user_id`,
  );
  const brokenMissed = await servicePool.query<{ id: string; tenant_id: string; customer_id: string | null; invoice_id: string | null; owner_user_id: string | null }>(
    `UPDATE promises p
        SET status = 'broken', broken_at = now(), updated_at = now()
       FROM invoices i
      WHERE i.id = p.invoice_id AND i.tenant_id = p.tenant_id
        AND p.status = 'open' AND p.promise_date < CURRENT_DATE
        AND i.status IN ('open', 'paused')
      RETURNING p.id, p.tenant_id, p.customer_id, p.invoice_id, p.owner_user_id`,
  );
  const broken = [...brokenPaidLate.rows, ...brokenMissed.rows];
  let tasks = 0;
  for (const p of broken) {
    const ins = await servicePool.query(
      `INSERT INTO tasks (tenant_id, customer_id, invoice_id, promise_id, title, due_on, owner_user_id, priority, source)
       VALUES ($1, $2, $3, $4, 'Follow up on a broken promise to pay', CURRENT_DATE, $5, 30, 'broken_promise')
       ON CONFLICT (tenant_id, promise_id) WHERE promise_id IS NOT NULL AND source = 'broken_promise' AND status = 'open'
       DO NOTHING`,
      [p.tenant_id, p.customer_id, p.invoice_id, p.id, p.owner_user_id],
    );
    tasks += ins.rowCount ?? 0;
  }
  return { kept: kept.rowCount ?? 0, broken: broken.length, tasks };
}

/** Recompute customers.risk_score from open AR, broken promises and open disputes. */
export async function refreshRiskScores(): Promise<number> {
  const rows = await servicePool.query<{
    id: string;
    days_overdue: number;
    open_cents: number;
    broken: number;
    disputes: number;
  }>(
    `SELECT c.id,
            COALESCE(MAX(CURRENT_DATE - i.due_date) FILTER (WHERE i.status = 'open' AND i.due_date < CURRENT_DATE), 0)::int AS days_overdue,
            COALESCE(SUM(i.amount_due) FILTER (WHERE i.status = 'open'), 0)::bigint AS open_cents,
            (SELECT count(*) FROM promises p WHERE p.customer_id = c.id AND p.status = 'broken')::int AS broken,
            (SELECT count(*) FROM disputes d WHERE d.customer_id = c.id AND d.status IN ${OPEN_DISPUTE})::int AS disputes
       FROM customers c
       LEFT JOIN invoices i ON i.customer_id = c.id AND i.tenant_id = c.tenant_id
      GROUP BY c.id`,
  );
  let updated = 0;
  for (const row of rows.rows) {
    const score = riskScore({
      daysOverdue: row.days_overdue,
      openCents: Number(row.open_cents),
      brokenPromises: row.broken,
      openDisputes: row.disputes,
    });
    const res = await servicePool.query(`UPDATE customers SET risk_score = $2 WHERE id = $1 AND risk_score IS DISTINCT FROM $2`, [
      row.id,
      score,
    ]);
    updated += res.rowCount ?? 0;
  }
  return updated;
}
