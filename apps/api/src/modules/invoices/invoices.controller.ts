import type { FastifyInstance } from "fastify";
import { requireRole } from "../../plugins/tenant.js";
import { notFound, badRequest } from "../../lib/errors.js";
import { stripe, stripeEnabled } from "../../lib/stripe.js";
import { sendNowForInvoice } from "../workflows/engine.js";

type InvoiceRow = {
  id: string;
  customer_id: string | null;
  external_id: string | null;
  source: string;
  amount_due: number;
  currency: string;
  issue_date: string | null;
  due_date: string | null;
  status: string;
  payment_link: string | null;
  line_items: unknown;
  next_step_index: number;
  next_step_due_at: string | null;
  created_at: string;
  updated_at: string;
  customer_name: string | null;
  customer_email: string | null;
};

function toInvoice(row: InvoiceRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    externalId: row.external_id,
    source: row.source,
    amountDue: Number(row.amount_due),
    currency: row.currency,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    status: row.status,
    paymentLink: row.payment_link,
    lineItems: row.line_items,
    nextStepIndex: row.next_step_index,
    nextStepDueAt: row.next_step_due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function invoicesRoutes(app: FastifyInstance) {
  app.get("/invoices", async (req) => {
    const q = req.query as { status?: string; source?: string; q?: string; limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? "100") || 100, 1), 500);
    const offset = Math.max(Number(q.offset ?? "0") || 0, 0);

    const rows = await req.db.query<InvoiceRow>(
      `SELECT i.*, i.issue_date::text AS issue_date, i.due_date::text AS due_date,
              c.name AS customer_name, c.email AS customer_email
         FROM invoices i
         LEFT JOIN customers c ON c.id = i.customer_id
        WHERE i.tenant_id = $6
          AND ($1::text IS NULL OR ($1 = 'overdue' AND i.status = 'open' AND i.due_date < CURRENT_DATE) OR i.status = $1)
          AND ($2::text IS NULL OR i.source = $2)
          AND ($3::text IS NULL OR c.name ILIKE '%' || $3 || '%' OR c.email ILIKE '%' || $3 || '%' OR i.external_id ILIKE '%' || $3 || '%')
        ORDER BY i.due_date NULLS LAST, i.created_at DESC, i.id
        LIMIT ($4 + 1) OFFSET $5`,
      [q.status ?? null, q.source ?? null, q.q ?? null, limit, offset, req.user.tenantId],
    );

    return { invoices: rows.rows.slice(0, limit).map(toInvoice), limit, offset, hasMore: rows.rows.length > limit };
  });

  app.get("/invoices/:id", async (req) => {
    const { id } = req.params as { id: string };
    const row = await req.db.query<InvoiceRow>(
      `SELECT i.*, i.issue_date::text AS issue_date, i.due_date::text AS due_date,
              c.name AS customer_name, c.email AS customer_email
         FROM invoices i
         LEFT JOIN customers c ON c.id = i.customer_id
        WHERE i.id = $1 AND i.tenant_id = $2`,
      [id, req.user.tenantId],
    );
    const invoice = row.rows[0];
    if (!invoice) throw notFound("Invoice not found");

    const timeline = await req.db.query(
      `SELECT m.id, m.step_index AS "stepIndex", m.channel, m.status, m.sent_at AS "sentAt",
              NULL::text AS "content", NULL::text AS "classification", NULL::date AS "promiseDate"
         FROM messages m
        WHERE m.invoice_id = $1
       UNION ALL
      SELECT r.id, NULL::int AS "stepIndex", r.channel, 'reply' AS status, r.created_at AS "sentAt",
              r.content, r.classification, r.promise_date AS "promiseDate"
         FROM replies r
        WHERE r.invoice_id = $1
        ORDER BY "sentAt" ASC`,
      [id],
    );

    return {
      invoice: toInvoice(invoice),
      timeline: timeline.rows.map((t) => ({
        ...t,
        kind: t.classification ? "reply" : "send",
      })),
    };
  });

  app.post("/invoices/:id/actions", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { action?: string };
    const action = body.action;
    if (!action) throw badRequest("Missing action");

    const allowed = new Set(["pause", "resume", "mark_paid", "send_now"]);
    if (!allowed.has(action)) throw badRequest("Unknown action");

    const set = {
      pause: "paused",
      resume: "open",
      mark_paid: "paid",
    } as const;

    const row = await req.db.query<{ id: string }>(
      `SELECT id FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tenantId],
    );
    if (row.rows.length === 0) throw notFound("Invoice not found");

    if (action === "send_now") {
      const result = await sendNowForInvoice(req.user.tenantId, id);
      return { ok: true, sent: result.sent, status: "sent" };
    }

    await req.db.query(
      `UPDATE invoices
          SET status = $3,
              next_step_index = CASE WHEN $3 = 'paid' THEN 9999 ELSE next_step_index END,
              next_step_due_at = CASE WHEN $3 = 'paid' THEN NULL ELSE next_step_due_at END,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tenantId, set[action as keyof typeof set]],
    );

    return { ok: true, status: set[action as keyof typeof set] };
  });

  app.post("/invoices/:id/pay-link", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await req.db.query<{
      amount_due: number;
      currency: string;
      external_id: string | null;
      payment_link: string | null;
    }>(`SELECT amount_due, currency, external_id, payment_link FROM invoices WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
    const inv = row.rows[0];
    if (!inv) throw notFound("Invoice not found");

    if (inv.payment_link) return { paymentLink: inv.payment_link };

    let link: string;
    if (stripeEnabled) {
      const integration = await req.db.query<{ credentials: { stripe_account_id?: string } }>(
        `SELECT credentials FROM integrations WHERE tenant_id = $1 AND source = 'stripe' LIMIT 1`,
        [req.user.tenantId],
      );
      const account = integration.rows[0]?.credentials?.stripe_account_id;
      if (!account) throw badRequest("Connect Stripe first", "STRIPE_NOT_CONNECTED");

      const pl = await stripe!.paymentLinks.create(
        {
          line_items: [
            {
              price_data: {
                currency: inv.currency,
                product_data: { name: inv.external_id ? `Invoice ${inv.external_id}` : "Invoice" },
                unit_amount: inv.amount_due,
              },
              quantity: 1,
            },
          ],
          // Lets the connected-account `checkout.session.completed` webhook
          // find and close this invoice, and stops a second payment.
          metadata: { autocollect_invoice_id: id, autocollect_tenant_id: req.user.tenantId },
          payment_intent_data: { metadata: { autocollect_invoice_id: id } },
          restrictions: { completed_sessions: { limit: 1 } },
        },
        { stripeAccount: account },
      );
      link = pl.url;
    } else {
      link = `https://pay.stripe.com/dev-pay-${Math.random().toString(36).slice(2, 10)}`;
    }

    await req.db.query(`UPDATE invoices SET payment_link = $2, updated_at = now() WHERE id = $1`, [id, link]);
    return { paymentLink: link };
  });
}