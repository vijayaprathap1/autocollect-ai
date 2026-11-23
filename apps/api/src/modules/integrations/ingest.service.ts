import { servicePool, withServiceTenant, withServiceTransaction } from "../../lib/db.js";
import { assertInvoiceCapacity } from "../../lib/billing.js";
import { reconcilePromises } from "../../lib/collections.js";
import { bookSettledReceipt, recordPayment } from "../../lib/cash-ledger.js";

/** Minimal shape of a Stripe Invoice object (see Stripe API docs). */
export type StripeInvoiceLike = {
  id: string;
  number?: string | null;
  customer: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  amount_due: number;
  /** Outstanding balance (handles partial payments); preferred over amount_due. */
  amount_remaining?: number | null;
  currency: string;
  created: number;
  status: string;
  hosted_invoice_url?: string | null;
  due_date?: number | null;
  period_start?: number | null;
  line_items?: { description?: string | null; quantity?: number | null; amount?: number | null }[];
};

const STRIPE_STATUS: Record<string, "open" | "paid" | "void" | "uncollectible"> = {
  open: "open",
  paid: "paid",
  void: "void",
  uncollectible: "uncollectible",
};

const toDate = (unix?: number | null) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : null);

/**
 * Upsert a Stripe invoice (and its customer). Runs in a transaction with a
 * transaction-local tenant scope, so RLS applies and nothing leaks to the
 * next user of the pooled connection. Drafts are skipped (nothing to chase).
 */
export async function ingestStripeInvoice(tenantId: string, inv: StripeInvoiceLike): Promise<"skipped" | "upserted"> {
  const status = STRIPE_STATUS[inv.status];
  if (!status) return "skipped";

  return withServiceTenant(tenantId, async (client) => {
    if (status === "open") await assertInvoiceCapacity(client, tenantId, "stripe", inv.id);

    let customerId: string | null = null;
    if (inv.customer) {
      const cu = await client.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, source, external_id, name, email, phone)
         VALUES ($1, 'stripe', $2, $3, $4, $5)
         ON CONFLICT (tenant_id, source, external_id)
         DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name),
                       email = COALESCE(EXCLUDED.email, customers.email),
                       phone = COALESCE(EXCLUDED.phone, customers.phone)
         RETURNING id`,
        [tenantId, inv.customer, inv.customer_name ?? null, inv.customer_email?.toLowerCase() ?? null, inv.customer_phone ?? null],
      );
      customerId = cu.rows[0].id;
    }

    const lineItems = (inv.line_items ?? []).map((l) => ({
      description: l.description ?? null,
      quantity: l.quantity ?? 1,
      amount: l.amount ?? 0,
    }));
    const outstanding = inv.amount_remaining ?? inv.amount_due;

    await client.query(
      `INSERT INTO invoices (tenant_id, integration_id, customer_id, external_id, source,
                             amount_due, currency, issue_date, due_date, status, payment_link, line_items, workflow_id)
       VALUES ($1, (SELECT id FROM integrations WHERE tenant_id = $1 AND source = 'stripe' LIMIT 1), $2, $3, 'stripe',
               $4, $5, $6, $7, $8, $9, $10::jsonb,
               (SELECT id FROM workflows WHERE tenant_id = $1 AND is_default = TRUE ORDER BY created_at LIMIT 1))
       ON CONFLICT (tenant_id, source, external_id)
       DO UPDATE SET amount_due = EXCLUDED.amount_due,
                     payment_link = CASE
                       WHEN invoices.stripe_payment_link_id IS NOT NULL AND invoices.amount_due IS DISTINCT FROM EXCLUDED.amount_due THEN NULL
                       ELSE COALESCE(EXCLUDED.payment_link, invoices.payment_link)
                     END,
                     stripe_payment_link_id = CASE WHEN invoices.amount_due IS DISTINCT FROM EXCLUDED.amount_due THEN NULL ELSE invoices.stripe_payment_link_id END,
                     payment_link_status = CASE WHEN invoices.stripe_payment_link_id IS NOT NULL AND invoices.amount_due IS DISTINCT FROM EXCLUDED.amount_due THEN NULL ELSE invoices.payment_link_status END,
                     currency = EXCLUDED.currency,
                     issue_date = EXCLUDED.issue_date,
                     due_date = EXCLUDED.due_date,
                     customer_id = COALESCE(EXCLUDED.customer_id, invoices.customer_id),
                     -- Webhooks can arrive out of order: a late "open" must not reopen a
                     -- paid invoice or un-pause one an admin (or a bounce) paused.
                     status = CASE
                       WHEN EXCLUDED.status = 'open' AND invoices.status IN ('paid', 'paused') THEN invoices.status
                       ELSE EXCLUDED.status
                     END,
                     next_step_index = CASE WHEN EXCLUDED.status IN ('paid','void','uncollectible') THEN 9999 ELSE invoices.next_step_index END,
                     next_step_due_at = CASE WHEN EXCLUDED.status IN ('paid','void','uncollectible') THEN NULL ELSE invoices.next_step_due_at END,
                     line_items = EXCLUDED.line_items,
                     updated_at = now()`,
      [
        tenantId,
        customerId,
        inv.id,
        outstanding,
        (inv.currency || "usd").toLowerCase(),
        toDate(inv.period_start ?? inv.created),
        toDate(inv.due_date),
        status,
        inv.hosted_invoice_url ?? null,
        JSON.stringify(lineItems),
      ],
    );
    return "upserted" as const;
  });
}

async function settleStripeInvoice(
  tenantId: string,
  whereSql: string,
  whereParam: string,
  externalId: string,
  reference: string,
): Promise<boolean> {
  const changed = await withServiceTransaction(async (client) => {
    const existing = await client.query<{ id: string; customer_id: string | null; amount_due: number; currency: string; status: string }>(
      `SELECT id, customer_id, amount_due, currency, status FROM invoices
        WHERE tenant_id = $1 AND ${whereSql} FOR UPDATE`,
      [tenantId, whereParam],
    );
    const row = existing.rows[0];
    if (!row || row.status === "paid") return false;
    const amount = Number(row.amount_due);
    if (amount > 0) {
      await bookSettledReceipt(client, {
        tenantId,
        customerId: row.customer_id,
        source: "stripe",
        externalId,
        amount,
        currency: (row.currency || "usd").toLowerCase(),
        invoiceId: row.id,
        reference,
      });
    }
    await client.query(
      `UPDATE invoices
          SET status = 'paid', next_step_index = 9999, next_step_due_at = NULL,
              payment_link_status = CASE WHEN payment_link IS NULL THEN payment_link_status ELSE 'paid' END,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status <> 'paid'`,
      [row.id, tenantId],
    );
    return true;
  });
  if (changed) await reconcilePromises().catch(() => {});
  return changed;
}

/** On `invoice.paid`, stop the dunning sequence, book the receipt, and mark the invoice paid. */
export async function markInvoicePaid(tenantId: string, invoiceExternalId: string): Promise<void> {
  await settleStripeInvoice(
    tenantId,
    "source = 'stripe' AND external_id = $2",
    invoiceExternalId,
    `invoice:${invoiceExternalId}`,
    "Stripe invoice",
  );
}

/** Mark one of our invoices paid by its internal id (Payment Link payments). */
export async function markInvoicePaidById(tenantId: string, invoiceId: string): Promise<void> {
  const changed = await settleStripeInvoice(tenantId, "id::text = $2", invoiceId, `paylink:${invoiceId}`, "Stripe Payment Link");
  if (changed) {
    await servicePool.query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'stripe', 'invoice_paid_via_payment_link', $2::jsonb)`,
      [tenantId, JSON.stringify({ invoice_id: invoiceId })],
    );
  }
}

/**
 * `invoice.payment_failed`: record why. The invoice stays open so reminders
 * continue (the customer still owes and Stripe keeps retrying the charge).
 */
export async function recordPaymentFailure(tenantId: string, invoiceExternalId: string, reason: string, code: string): Promise<void> {
  await servicePool.query(
    `UPDATE invoices
        SET last_payment_failed_at = now(), last_payment_failure_reason = $3, last_payment_failure_code = $4, updated_at = now()
      WHERE tenant_id = $1 AND source = 'stripe' AND external_id = $2`,
    [tenantId, invoiceExternalId, reason.slice(0, 500), code.slice(0, 100)],
  );
  await servicePool.query(
    `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'stripe', 'invoice_payment_failed', $2::jsonb)`,
    [tenantId, JSON.stringify({ invoice_external_id: invoiceExternalId, failure_reason: reason, failure_code: code })],
  );
}

/** A Stripe charge or payout that does not name an invoice waits in the unapplied queue. */
export async function recordUnappliedStripeCash(
  tenantId: string,
  input: { externalId: string; amount: number; currency: string; reference: string },
): Promise<void> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) return;
  await withServiceTransaction(async (client) => {
    const payment = await recordPayment(client, {
      tenantId,
      customerId: null,
      source: "stripe",
      externalId: input.externalId,
      amount: input.amount,
      currency: input.currency.toLowerCase(),
      reference: input.reference,
    });
    if (!payment.created) return;
    await client.query(
      `INSERT INTO notifications (tenant_id, kind, title, body, href) VALUES ($1, 'cash', $2, $3, '/cash')`,
      [tenantId, "Unapplied Stripe cash", input.reference],
    );
    await client.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'stripe', 'payment_recorded', $2::jsonb)`, [
      tenantId,
      JSON.stringify({ payment_id: payment.id, amount: input.amount, reference: input.reference }),
    ]);
  });
}

/** Resolve the tenant that owns an ACTIVE Stripe connected account (webhook routing). */
export async function tenantByStripeAccount(stripeAccountId: string): Promise<{ tenantId: string; integrationId: string } | null> {
  const result = await servicePool.query<{ tenant_id: string; id: string }>(
    `SELECT tenant_id, id FROM integrations
      WHERE source = 'stripe' AND status = 'active' AND credentials->>'stripe_account_id' = $1
      LIMIT 1`,
    [stripeAccountId],
  );
  const row = result.rows[0];
  return row ? { tenantId: row.tenant_id, integrationId: row.id } : null;
}
