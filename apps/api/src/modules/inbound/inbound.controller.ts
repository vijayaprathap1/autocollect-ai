import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requireRole } from "../../plugins/tenant.js";
import { badRequest, notFound, unauthorized, unavailable, assertUuid } from "../../lib/errors.js";
import { config, isDevLike, isProduction } from "../../config.js";
import { processInboundEmail, type PostmarkInboundPayload } from "./inbound.service.js";
import { replyAddressFor } from "../../lib/reply-address.js";

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Token via ?token=, Basic auth password, or header (Postmark supports all three). */
export function presentedWebhookToken(req: FastifyRequest): string {
  const q = (req.query as { token?: string }).token;
  if (q) return q;
  const auth = (req.headers.authorization as string | undefined) ?? "";
  if (auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    return decoded.slice(decoded.indexOf(":") + 1);
  }
  return ((req.headers["x-postmark-webhook-token"] ?? req.headers["x-postmark-server-token"]) as string | undefined) ?? "";
}

export function assertPostmarkWebhook(req: FastifyRequest): void {
  if (!config.inboundWebhookToken) {
    if (isProduction) throw unavailable("POSTMARK_WEBHOOK_TOKEN must be configured in production", "WEBHOOK_NOT_CONFIGURED");
    return;
  }
  const presented = presentedWebhookToken(req);
  if (!presented || !sameSecret(presented, config.inboundWebhookToken)) {
    throw unauthorized("Invalid webhook token", "INVALID_WEBHOOK_TOKEN");
  }
}

export async function inboundRoutes(app: FastifyInstance) {
  /** Postmark inbound webhook. Idempotent on MessageID; unmatched replies are acknowledged and dropped. */
  app.post("/inbound/postmark", { config: { public: true, rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    assertPostmarkWebhook(req);
    const result = await processInboundEmail((req.body ?? {}) as PostmarkInboundPayload);
    return { ok: true, ...result };
  });

  /**
   * Development simulator: pretend a customer replied to an invoice. Runs the
   * same pipeline as the real webhook (signed reply address routing).
   */
  app.post("/integrations/postmark/dev-inbound", { preHandler: requireRole("admin") }, async (req) => {
    if (!isDevLike) throw notFound("Route not found");
    const body = z
      .object({
        invoiceId: z.string().optional(),
        from: z.string().email().optional(),
        text: z.string().trim().min(1, "Missing reply text").max(5000),
        subject: z.string().max(200).optional(),
      })
      .parse(req.body ?? {});

    let invoiceId = body.invoiceId ? assertUuid(body.invoiceId, "Invoice") : undefined;
    if (invoiceId) {
      const ok = await req.db.query(`SELECT 1 FROM invoices WHERE id = $1 AND tenant_id = $2`, [invoiceId, req.user.tenantId]);
      if (!ok.rows.length) throw notFound("Invoice not found");
    } else {
      const m = await req.db.query<{ invoice_id: string | null }>(
        `SELECT m.invoice_id FROM messages m WHERE m.tenant_id = $1 AND m.invoice_id IS NOT NULL ORDER BY m.created_at DESC LIMIT 1`,
        [req.user.tenantId],
      );
      invoiceId = m.rows[0]?.invoice_id ?? undefined;
    }
    if (!invoiceId) throw badRequest("No invoice to attach the reply to");

    // Build the same MailboxHash a real reply to our Reply-To address would carry.
    const address = replyAddressFor(invoiceId) ?? `dev+${invoiceId}.unsigned@example.com`;
    const hash = address.slice(address.indexOf("+") + 1, address.lastIndexOf("@"));
    const payload: PostmarkInboundPayload = {
      MessageID: `dev-inbound-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      FromFull: { Email: body.from ?? "client@example.com", Name: "Client" },
      Subject: body.subject ?? "Re: your invoice",
      TextBody: body.text,
      MailboxHash: config.inboundReplyAddress ? hash : undefined,
      Headers: [],
    };
    if (!config.inboundReplyAddress) {
      // Without an inbound address configured, route via the last message id instead.
      const m = await req.db.query<{ provider_msg_id: string | null }>(
        `SELECT provider_msg_id FROM messages WHERE invoice_id = $1 AND tenant_id = $2 AND provider_msg_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        [invoiceId, req.user.tenantId],
      );
      if (!m.rows[0]?.provider_msg_id) throw badRequest("Send a reminder for this invoice first (or set INBOUND_REPLY_ADDRESS)");
      payload.Headers = [{ Name: "In-Reply-To", Value: `<${m.rows[0].provider_msg_id}@mtasv.net>` }];
    }
    const result = await processInboundEmail(payload);
    return { ok: true, ...result };
  });
}
