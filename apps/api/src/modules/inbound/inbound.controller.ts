import type { FastifyInstance } from "fastify";
import { requireRole } from "../../plugins/tenant.js";
import { badRequest, unauthorized } from "../../lib/errors.js";
import { config } from "../../config.js";
import { processInboundEmail, type PostmarkInboundPayload } from "./inbound.service.js";

export async function inboundRoutes(app: FastifyInstance) {
  /**
   * Postmark inbound webhook. Always returns 200 (idempotent on MessageID);
   * unmatched replies are dropped silently. When POSTMARK_WEBHOOK_TOKEN is set
   * the webhook must present it (query `token` or `X-Postmark-Server-Token`).
   */
  app.post(
    "/inbound/postmark",
    { config: { public: true } },
    async (req) => {
      if (config.nodeEnv === "production" && !config.inboundWebhookToken) {
        throw badRequest(
          "POSTMARK_WEBHOOK_TOKEN must be configured in production",
          "WEBHOOK_NOT_CONFIGURED",
        );
      }
      if (config.inboundWebhookToken) {
        const q = req.query as { token?: string };
        const header = (req.headers["x-postmark-server-token"] as string) ?? "";
        if (q.token !== config.inboundWebhookToken && header !== config.inboundWebhookToken) {
          throw unauthorized("Invalid webhook token", "INVALID_WEBHOOK_TOKEN");
        }
      }
      const payload = (req.body ?? {}) as PostmarkInboundPayload;
      const result = await processInboundEmail(payload);
      return { ok: true, ...result };
    },
  );

  /**
   * Dev/demo simulator: synthesize a Postmark inbound payload and run the same
   * pipeline. If no invoiceId is given, the tenant's most recent send is used.
   */
  app.post(
    "/integrations/postmark/dev-inbound",
    { preHandler: requireRole("admin") },
    async (req) => {
      const body = (req.body ?? {}) as {
        invoiceId?: string;
        from?: string;
        text?: string;
        subject?: string;
      };
      const text = (body.text ?? "").trim();
      if (!text) throw badRequest("Missing reply text");

      let invoiceId = body.invoiceId;
      let threadId: string | null = null;

      if (invoiceId) {
        const m = await req.db.query<{ provider_msg_id: string | null }>(
          `SELECT provider_msg_id FROM messages
            WHERE invoice_id = $1 AND tenant_id = $2
            ORDER BY created_at DESC LIMIT 1`,
          [invoiceId, req.user.tenantId],
        );
        threadId = m.rows[0]?.provider_msg_id ?? null;
      } else {
        const m = await req.db.query<{ invoice_id: string | null; provider_msg_id: string | null }>(
          `SELECT m.invoice_id, m.provider_msg_id
             FROM messages m
            WHERE m.tenant_id = $1 AND m.invoice_id IS NOT NULL
            ORDER BY m.created_at DESC LIMIT 1`,
          [req.user.tenantId],
        );
        invoiceId = m.rows[0]?.invoice_id ?? undefined;
        threadId = m.rows[0]?.provider_msg_id ?? null;
      }

      if (!invoiceId) throw badRequest("No invoice to attach the reply to");

      const payload: PostmarkInboundPayload = {
        MessageID: `dev-inbound-${Math.random().toString(36).slice(2, 12)}`,
        FromFull: { Email: body.from ?? "client@example.com", Name: "Client" },
        Subject: body.subject ?? `Re: invoice ${invoiceId}`,
        TextBody: text,
        MailboxHash: invoiceId,
        Headers: threadId ? [{ Name: "In-Reply-To", Value: `<${threadId}>` }] : [],
      };

      const result = await processInboundEmail(payload);
      return { ok: true, ...result };
    },
  );
}