import { pool, servicePool } from "../../lib/db.js";
import { assertInvoiceCapacity } from "../../lib/billing.js";

/** Minimal shape of a Stripe Invoice object (see Stripe API docs). */
export type StripeInvoiceLike = {
  id: string;
  customer: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
  amount_due: number;
  currency: string;
  created: number;
  status: string;
  hosted_invoice_url?: string | null;
  due_date?: number | null;
  period_start?: number | null;
  line_items?: { description?: string | null; quantity?: number; amount?: number }[];
};

const STRIPE_STATUS: Record<string, "open" | "paid" | "void" | "uncollectible"> = {
  open: "open",
  paid: "paid",
  void: "void",
  uncollectible: "uncollectible",
};

/**
 * Upsert a Stripe invoice (and its customer) into the normalized store.
 * Uses its own connection with `app.tenant_id` set so RLS applies.
 * Returns "skipped" for draft/unknown statuses (nothing to chase).
 */
export async function ingestStripeInvoice(
  tenantId: string,
  inv: StripeInvoiceLike,
): Promise<"skipped" | "upserted"> {
  const status = STRIPE_STATUS[inv.status];
  if (!status) return "skipped";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);

    // Enforce plan capacity (blocked on new invoices only; updates pass).
    await assertInvoiceCapacity(client, tenantId, "stripe", inv.id);

    let customerId: string | null = null;
    if (inv.customer) {
      const cu = await client.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, source, external_id, name, email)
         VALUES ($1, 'stripe', $2, $3, $4)
         ON CONFLICT (tenant_id, source, external_id)
         DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name),
                       email = COALESCE(EXCLUDED.email, customers.email)
         RETURNING id`,
        [tenantId, inv.customer, inv.customer_name ?? null, inv.customer_email ?? null],
      );
      customerId = cu.rows[0].id;
    }

    const integration = await client.query<{ id: string }>(
      `SELECT id FROM integrations WHERE tenant_id = $1 AND source = 'stripe' LIMIT 1`,
      [tenantId],
    );
    const integrationId = integration.rows[0]?.id ?? null;

    const issueDate = inv.period_start
      ? new Date(inv.period_start * 1000).toISOString().slice(0, 10)
      : null;
    const dueDate = inv.due_date
      ? new Date(inv.due_date * 1000).toISOString().slice(0, 10)
      : null;
    const lineItems = (inv.line_items ?? []).map((l) => ({
      description: l.description ?? null,
      quantity: l.quantity ?? 1,
      amount: l.amount ?? 0,
    }));

    await client.query(
      `INSERT INTO invoices (tenant_id, integration_id, customer_id, external_id, source,
                             amount_due, currency, issue_date, due_date, status, payment_link, line_items, workflow_id)
       VALUES ($1, $2, $3, $4, 'stripe', $5, $6, $7, $8, $9, $10, $11::jsonb,
               (SELECT id FROM workflows WHERE tenant_id = $1 AND is_default = TRUE LIMIT 1))
       ON CONFLICT (tenant_id, source, external_id)
       DO UPDATE SET amount_due = EXCLUDED.amount_due,
                     currency = EXCLUDED.currency,
                     issue_date = EXCLUDED.issue_date,
                     due_date = EXCLUDED.due_date,
                     -- Stripe webhooks can arrive out of order: a late "open"
                     -- must not reopen a paid invoice or un-pause one an admin
                     -- (or a bounce) paused.
                     status = CASE
                       WHEN EXCLUDED.status = 'open' AND invoices.status IN ('paid', 'paused')
                         THEN invoices.status
                       ELSE EXCLUDED.status
                     END,
                     payment_link = EXCLUDED.payment_link,
                     line_items = EXCLUDED.line_items,
                     updated_at = now()`,
      [
        tenantId,
        integrationId,
        customerId,
        inv.id,
        inv.amount_due,
        inv.currency,
        issueDate,
        dueDate,
        status,
        inv.hosted_invoice_url ?? null,
        JSON.stringify(lineItems),
      ],
    );

    await client.query("COMMIT");
    return "upserted";
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** On `invoice.paid`, stop the dunning sequence and mark the invoice paid. */
export async function markInvoicePaid(tenantId: string, invoiceExternalId: string): Promise<void> {
  await servicePool.query(
    `UPDATE invoices
        SET status = 'paid', next_step_index = 9999, next_step_due_at = NULL, updated_at = now()
      WHERE tenant_id = $1 AND source = 'stripe' AND external_id = $2`,
    [tenantId, invoiceExternalId],
  );
}

/** Mark one of our invoices paid by its internal id (Payment Link payments). */
export async function markInvoicePaidById(tenantId: string, invoiceId: string): Promise<void> {
  await servicePool.query(
    `UPDATE invoices
        SET status = 'paid', next_step_index = 9999, next_step_due_at = NULL, updated_at = now()
      WHERE tenant_id = $1 AND id::text = $2`,
    [tenantId, invoiceId],
  );
  await servicePool.query(
    `INSERT INTO audit_log (tenant_id, actor, action, detail)
     VALUES ($1, 'stripe', 'invoice_paid_via_payment_link', $2::jsonb)`,
    [tenantId, JSON.stringify({ invoice_id: invoiceId })],
  );
}

/**
 * `invoice.payment_failed`: record why on that one invoice. The invoice stays
 * open so reminders continue (the customer still owes and Stripe keeps
 * retrying the charge); admins see the reason on the invoice.
 */
export async function recordPaymentFailure(
  tenantId: string,
  invoiceExternalId: string,
  reason: string,
  code: string,
): Promise<void> {
  await servicePool.query(
    `UPDATE invoices
        SET last_payment_failed_at = now(),
            last_payment_failure_reason = $3,
            last_payment_failure_code = $4,
            updated_at = now()
      WHERE tenant_id = $1 AND source = 'stripe' AND external_id = $2`,
    [tenantId, invoiceExternalId, reason, code],
  );
  await servicePool.query(
    `INSERT INTO audit_log (tenant_id, actor, action, detail)
     VALUES ($1, 'stripe', 'invoice_payment_failed', $2::jsonb)`,
    [tenantId, JSON.stringify({ invoice_external_id: invoiceExternalId, failure_reason: reason, failure_code: code })],
  );
}

/** Resolve the tenant that owns a Stripe connected account (webhook routing). */
export async function tenantByStripeAccount(stripeAccountId: string): Promise<{
  tenantId: string;
  integrationId: string;
} | null> {
  const result = await servicePool.query<{ tenant_id: string; id: string }>(
    `SELECT tenant_id, id
       FROM integrations
      WHERE source = 'stripe'
        AND credentials->>'stripe_account_id' = $1
      LIMIT 1`,
    [stripeAccountId],
  );
  const row = result.rows[0];
  return row ? { tenantId: row.tenant_id, integrationId: row.id } : null;
}