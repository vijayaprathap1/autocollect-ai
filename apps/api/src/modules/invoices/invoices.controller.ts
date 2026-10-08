import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../../plugins/tenant.js";
import { notFound, badRequest, conflict, assertUuid } from "../../lib/errors.js";
import { stripe, stripeEnabled } from "../../lib/stripe.js";
import { isDevLike } from "../../config.js";
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
  snoozed_until: string | null;
  last_payment_failure_reason: string | null;
  last_payment_failed_at: string | null;
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
    snoozedUntil: row.snoozed_until,
    lastPaymentFailure: row.last_payment_failed_at
      ? { at: row.last_payment_failed_at, reason: row.last_payment_failure_reason }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const listSchema = z.object({
  status: z.enum(["open", "paid", "void", "uncollectible", "paused", "overdue"]).optional(),
  source: z.enum(["stripe", "csv", "qbo"]).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** Allowed manual transitions: action -> [from statuses, to status]. */
const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  pause: { from: ["open"], to: "paused" },
  resume: { from: ["paused"], to: "open" },
  mark_paid: { from: ["open", "paused", "uncollectible"], to: "paid" },
  mark_uncollectible: { from: ["open", "paused"], to: "uncollectible" },
  reopen: { from: ["uncollectible", "void"], to: "open" },
};

export async function invoicesRoutes(app: FastifyInstance) {
  app.get("/invoices", async (req) => {
    const q = listSchema.parse(req.query ?? {});
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
      [q.status ?? null, q.source ?? null, q.q ? q.q.replace(/[%_\\]/g, "\\$&") : null, q.limit, q.offset, req.user.tenantId],
    );
    return { invoices: rows.rows.slice(0, q.limit).map(toInvoice), limit: q.limit, offset: q.offset, hasMore: rows.rows.length > q.limit };
  });

  app.get("/invoices/:id", async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Invoice");
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
      `SELECT m.id, m.step_index AS "stepIndex", m.channel, m.status, COALESCE(m.sent_at, m.created_at) AS "sentAt",
              m.last_error AS "error", NULL::text AS "content", NULL::text AS "classification", NULL::date AS "promiseDate"
         FROM messages m
        WHERE m.invoice_id = $1 AND m.tenant_id = $2
       UNION ALL
      SELECT r.id, NULL::int AS "stepIndex", r.channel, 'reply' AS status, r.created_at AS "sentAt",
             NULL::text AS "error", r.content, r.classification, r.promise_date AS "promiseDate"
         FROM replies r
        WHERE r.invoice_id = $1 AND r.tenant_id = $2
        ORDER BY "sentAt" ASC`,
      [id, req.user.tenantId],
    );

    return {
      invoice: toInvoice(invoice),
      timeline: timeline.rows.map((t) => ({ ...t, kind: t.status === "reply" ? "reply" : "send" })),
    };
  });

  app.post("/invoices/:id/actions", { preHandler: requireRole("admin"), config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Invoice");
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "mark_paid", "mark_uncollectible", "reopen", "send_now"]) })
      .parse(req.body ?? {});

    const row = await req.db.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
    const current = row.rows[0];
    if (!current) throw notFound("Invoice not found");

    if (action === "send_now") {
      if (current.status !== "open") throw conflict(`Only open invoices can be reminded (this one is ${current.status})`, "INVALID_STATUS");
      const result = await sendNowForInvoice(req.user.tenantId, id);
      return { ok: true, sent: result.sent, status: "open" };
    }

    const t = TRANSITIONS[action];
    if (!t.from.includes(current.status)) {
      throw conflict(`Can't ${action.replace("_", " ")} an invoice that is ${current.status}`, "INVALID_STATUS");
    }
    await req.db.query(
      `UPDATE invoices
          SET status = $3,
              next_step_index = CASE WHEN $3 IN ('paid','uncollectible') THEN 9999
                                     WHEN $4 = 'reopen' THEN 0 ELSE next_step_index END,
              next_step_due_at = CASE WHEN $3 = 'open' THEN NULL ELSE next_step_due_at END,
              snoozed_until = CASE WHEN $3 = 'open' THEN NULL ELSE snoozed_until END,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tenantId, t.to, action],
    );
    await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, $3, $4::jsonb)`, [
      req.user.tenantId,
      req.user.email,
      `invoice_${action}`,
      JSON.stringify({ invoice_id: id, from: current.status, to: t.to }),
    ]);
    return { ok: true, status: t.to };
  });

  /** Create (or return) a one-click Stripe Payment Link on the connected account. */
  app.post("/invoices/:id/pay-link", { preHandler: requireRole("admin"), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Invoice");
    const row = await req.db.query<{ amount_due: number; currency: string; external_id: string | null; payment_link: string | null; status: string }>(
      `SELECT amount_due, currency, external_id, payment_link, status FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tenantId],
    );
    const inv = row.rows[0];
    if (!inv) throw notFound("Invoice not found");
    if (inv.payment_link) return { paymentLink: inv.payment_link };
    if (!["open", "paused"].includes(inv.status)) throw conflict("This invoice is not payable", "INVALID_STATUS");
    if (Number(inv.amount_due) < 50) throw badRequest("Amount is too small for an online payment", "AMOUNT_TOO_SMALL");

    let link: string;
    if (stripeEnabled) {
      const integration = await req.db.query<{ account: string | null }>(
        `SELECT credentials->>'stripe_account_id' AS account FROM integrations WHERE tenant_id = $1 AND source = 'stripe' AND status = 'active'`,
        [req.user.tenantId],
      );
      const account = integration.rows[0]?.account;
      if (!account) throw badRequest("Connect Stripe first to create payment links", "STRIPE_NOT_CONNECTED");
      const pl = await stripe!.paymentLinks.create(
        {
          line_items: [
            {
              price_data: {
                currency: inv.currency,
                product_data: { name: inv.external_id ? `Invoice ${inv.external_id}` : "Invoice payment" },
                unit_amount: Number(inv.amount_due),
              },
              quantity: 1,
            },
          ],
          // Lets the connected-account checkout.session.completed webhook close this invoice.
          metadata: { autocollect_invoice_id: id, autocollect_tenant_id: req.user.tenantId },
          payment_intent_data: { metadata: { autocollect_invoice_id: id } },
          restrictions: { completed_sessions: { limit: 1 } },
        },
        { stripeAccount: account, idempotencyKey: `paylink:${id}` },
      );
      link = pl.url;
    } else {
      if (!isDevLike) throw badRequest("Payments are not configured on this server", "STRIPE_NOT_CONFIGURED");
      link = `https://pay.stripe.com/dev-pay-${id.slice(0, 8)}`;
    }

    await req.db.query(`UPDATE invoices SET payment_link = $2, updated_at = now() WHERE id = $1 AND tenant_id = $3`, [id, link, req.user.tenantId]);
    return { paymentLink: link };
  });
}
