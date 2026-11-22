import { servicePool } from "./db.js";
import { isDevLike } from "../config.js";
import { stripe, stripeEnabled } from "./stripe.js";
import { badRequest, conflict, notFound } from "./errors.js";

/**
 * Create a Stripe Payment Link for an invoice and store it.
 * `strict` is the HTTP path (surface a reason). The dunning engine passes
 * strict=false and sends the reminder anyway when Stripe is not connected.
 */
export async function ensureInvoicePaymentLink(
  tenantId: string,
  invoiceId: string,
  opts: { strict?: boolean } = {},
): Promise<string | null> {
  const row = await servicePool.query<{
    amount_due: number;
    currency: string;
    external_id: string | null;
    payment_link: string | null;
    status: string;
  }>(
    `SELECT amount_due, currency, external_id, payment_link, status
       FROM invoices WHERE id = $1 AND tenant_id = $2`,
    [invoiceId, tenantId],
  );
  const inv = row.rows[0];
  if (!inv) {
    if (opts.strict) throw notFound("Invoice not found");
    return null;
  }
  if (inv.payment_link) return inv.payment_link;
  if (!["open", "paused"].includes(inv.status)) {
    if (opts.strict) throw conflict("This invoice is not payable", "INVALID_STATUS");
    return null;
  }
  if (Number(inv.amount_due) < 50) {
    if (opts.strict) throw badRequest("Amount is too small for an online payment", "AMOUNT_TOO_SMALL");
    return null;
  }

  let link: string;
  let stripeId: string | null = null;
  if (!stripeEnabled || !stripe) {
    // Automatic sends must not invent a URL. The invoice screen can still
    // mint a local placeholder while developing without Stripe keys.
    if (!opts.strict) return null;
    if (!isDevLike) throw badRequest("Payments are not configured on this server", "STRIPE_NOT_CONFIGURED");
    link = `https://pay.stripe.com/dev-pay-${invoiceId.slice(0, 8)}`;
  } else {
    const integration = await servicePool.query<{ account: string | null }>(
      `SELECT credentials->>'stripe_account_id' AS account
         FROM integrations WHERE tenant_id = $1 AND source = 'stripe' AND status = 'active'`,
      [tenantId],
    );
    const account = integration.rows[0]?.account;
    if (!account) {
      if (opts.strict) throw badRequest("Connect Stripe first to create payment links", "STRIPE_NOT_CONNECTED");
      return null;
    }
    const pl = await stripe.paymentLinks.create(
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
        metadata: { autocollect_invoice_id: invoiceId, autocollect_tenant_id: tenantId },
        payment_intent_data: { metadata: { autocollect_invoice_id: invoiceId } },
        restrictions: { completed_sessions: { limit: 1 } },
      },
      { stripeAccount: account, idempotencyKey: `paylink:${invoiceId}` },
    );
    link = pl.url;
    stripeId = pl.id;
  }

  await servicePool.query(
    `UPDATE invoices
        SET payment_link = $2, stripe_payment_link_id = COALESCE($3, stripe_payment_link_id),
            payment_link_status = 'active', updated_at = now()
      WHERE id = $1 AND tenant_id = $4 AND payment_link IS NULL`,
    [invoiceId, link, stripeId, tenantId],
  );
  return link;
}
