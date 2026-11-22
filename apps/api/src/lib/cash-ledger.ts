import type { Queryable } from "./db.js";
import { suggestApplications, type MatchInvoice, type SuggestedLine } from "./cash-match.js";

export type PaymentInput = {
  tenantId: string;
  customerId: string | null;
  source: "stripe" | "qbo" | "csv" | "manual";
  externalId: string;
  amount: number;
  currency: string;
  paidAt?: string;
  reference?: string | null;
};

/** Insert a receipt once. Returns the existing row when the external id was already stored. */
export async function recordPayment(db: Queryable, input: PaymentInput): Promise<{ id: string; unapplied: number; created: boolean }> {
  const inserted = await db.query<{ id: string; unapplied: number }>(
    `INSERT INTO payments (tenant_id, customer_id, source, external_id, amount, unapplied, currency, paid_at, reference)
     VALUES ($1, $2, $3, $4, $5, $5, $6, COALESCE($7::timestamptz, now()), $8)
     ON CONFLICT (tenant_id, source, external_id) DO NOTHING
     RETURNING id, unapplied`,
    [input.tenantId, input.customerId, input.source, input.externalId, input.amount, input.currency, input.paidAt ?? null, input.reference ?? null],
  );
  if (inserted.rows[0]) return { ...inserted.rows[0], created: true };
  const existing = await db.query<{ id: string; unapplied: number }>(
    `SELECT id, unapplied FROM payments WHERE tenant_id = $1 AND source = $2 AND external_id = $3`,
    [input.tenantId, input.source, input.externalId],
  );
  return { ...existing.rows[0], created: false };
}

export async function openInvoicesFor(db: Queryable, tenantId: string, customerId: string | null): Promise<MatchInvoice[]> {
  const rows = await db.query<{ id: string; customer_id: string | null; amount_due: number; due_date: string | null; external_id: string | null }>(
    `SELECT id, customer_id, amount_due, due_date::text AS due_date, external_id
       FROM invoices
      WHERE tenant_id = $1 AND status IN ('open', 'paused') AND amount_due > 0
        AND ($2::uuid IS NULL OR customer_id = $2)
      ORDER BY due_date NULLS LAST
      LIMIT 200`,
    [tenantId, customerId],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    amountDue: Number(r.amount_due),
    dueDate: r.due_date,
    externalId: r.external_id,
  }));
}

export async function suggestionsForPayment(db: Queryable, tenantId: string, paymentId: string): Promise<SuggestedLine[]> {
  const payment = await db.query<{ amount: number; unapplied: number; customer_id: string | null }>(
    `SELECT amount, unapplied, customer_id FROM payments WHERE id = $1 AND tenant_id = $2`,
    [paymentId, tenantId],
  );
  const row = payment.rows[0];
  if (!row || row.unapplied <= 0) return [];
  const invoices = await openInvoicesFor(db, tenantId, row.customer_id);
  return suggestApplications(Number(row.unapplied), row.customer_id, invoices);
}

export async function applyCash(
  db: Queryable,
  input: { tenantId: string; paymentId: string; lines: { invoiceId: string; amount: number }[]; userId: string | null; method: string },
  options: { transaction?: boolean } = {},
): Promise<{ applied: number }> {
  const total = input.lines.reduce((sum, line) => sum + line.amount, 0);
  if (total <= 0) throw new Error("Nothing to apply");
  const ownTransaction = options.transaction !== false;
  if (ownTransaction) await db.query("BEGIN");
  try {
    const locked = await db.query<{ unapplied: number }>(
      `SELECT unapplied FROM payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [input.paymentId, input.tenantId],
    );
    if (!locked.rows[0]) throw new Error("Payment not found");
    if (Number(locked.rows[0].unapplied) < total) throw new Error("That receipt does not have enough unapplied cash");
    for (const line of input.lines) {
      const updated = await db.query(
        `UPDATE invoices
            SET amount_due = amount_due - $3,
                status = CASE WHEN amount_due - $3 <= 0 THEN 'paid' ELSE status END,
                next_step_index = CASE WHEN amount_due - $3 <= 0 THEN 9999 ELSE next_step_index END,
                next_step_due_at = CASE WHEN amount_due - $3 <= 0 THEN NULL ELSE next_step_due_at END,
                updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status IN ('open', 'paused') AND amount_due >= $3`,
        [line.invoiceId, input.tenantId, line.amount],
      );
      if (!updated.rowCount) throw new Error("An invoice could not take that amount");
      await db.query(
        `INSERT INTO cash_applications (tenant_id, payment_id, invoice_id, amount, method, applied_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.tenantId, input.paymentId, line.invoiceId, line.amount, input.method, input.userId],
      );
    }
    await db.query(`UPDATE payments SET unapplied = unapplied - $3 WHERE id = $1 AND tenant_id = $2`, [
      input.paymentId,
      input.tenantId,
      total,
    ]);
    await db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'cash_applied', $3::jsonb)`, [
      input.tenantId,
      input.userId ?? "system",
      JSON.stringify({ payment_id: input.paymentId, amount: total, lines: input.lines.length }),
    ]);
    if (ownTransaction) await db.query("COMMIT");
    return { applied: total };
  } catch (err) {
    if (ownTransaction) await db.query("ROLLBACK");
    throw err;
  }
}

/**
 * Record a receipt and, when the invoice is known, apply it.
 * Does not open its own transaction — callers that need atomicity wrap this.
 * An invoice that is already paid gets a ledger line without changing its balance again.
 */
export async function bookSettledReceipt(
  db: Queryable,
  input: PaymentInput & { invoiceId: string | null },
): Promise<{ id: string; unapplied: number }> {
  const payment = await recordPayment(db, input);
  if (!input.invoiceId || Number(payment.unapplied) <= 0) return payment;
  const inv = await db.query<{ status: string; amount_due: number }>(
    `SELECT status, amount_due FROM invoices WHERE id = $1 AND tenant_id = $2`,
    [input.invoiceId, input.tenantId],
  );
  const row = inv.rows[0];
  if (!row) return payment;
  const unapplied = Number(payment.unapplied);
  if ((row.status === "open" || row.status === "paused") && Number(row.amount_due) >= unapplied) {
    await applyCash(
      db,
      {
        tenantId: input.tenantId,
        paymentId: payment.id,
        lines: [{ invoiceId: input.invoiceId, amount: unapplied }],
        userId: null,
        method: "exact",
      },
      { transaction: false },
    );
    return { id: payment.id, unapplied: 0 };
  }
  if (row.status !== "paid") return payment;
  await db.query(
    `INSERT INTO cash_applications (tenant_id, payment_id, invoice_id, amount, method)
     VALUES ($1, $2, $3, $4, 'exact')`,
    [input.tenantId, payment.id, input.invoiceId, unapplied],
  );
  await db.query(`UPDATE payments SET unapplied = 0 WHERE id = $1 AND tenant_id = $2`, [payment.id, input.tenantId]);
  await db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'cash_applied', $3::jsonb)`, [
    input.tenantId,
    "system",
    JSON.stringify({ payment_id: payment.id, invoice_id: input.invoiceId, amount: unapplied, source: input.source }),
  ]);
  return { id: payment.id, unapplied: 0 };
}
