import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { servicePool } from "../../lib/db.js";
import { badRequest, unauthorized } from "../../lib/errors.js";

/**
 * Postmark delivery/engagement webhook ("Delivery", "Bounce", "Open",
 * "Click", "SpamComplaint").
 *
 * Postmark POSTs one JSON object per event and identifies it with
 * `RecordType`. Configure the webhook URL in Postmark as
 *   https://<api>/email/webhook/postmark?token=<POSTMARK_WEBHOOK_TOKEN>
 * (or put the token in the webhook's Basic-auth password).
 */

type PostmarkEvent = {
  RecordType?: string;
  Type?: string; // bounce type, e.g. HardBounce / SoftBounce
  MessageID?: string;
  Inactive?: boolean;
  [key: string]: unknown;
};

// Status can only move forward; bounced/failed are terminal.
const RANK: Record<string, number> = { sending: 0, sent: 1, delivered: 2, opened: 3, clicked: 4, bounced: 9, failed: 9 };

// Bounce types that don't mean the address is bad.
const TEMPORARY_BOUNCES = new Set(["Transient", "SoftBounce", "DnsError", "AutoResponder", "Unknown"]);

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function presentedToken(req: FastifyRequest): string {
  const q = (req.query as { token?: string }).token;
  if (q) return q;
  const auth = (req.headers.authorization as string | undefined) ?? "";
  if (auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    return decoded.slice(decoded.indexOf(":") + 1);
  }
  return (req.headers["x-postmark-webhook-token"] as string | undefined) ?? "";
}

function statusFor(event: PostmarkEvent): string | null {
  switch (event.RecordType) {
    case "Delivery":
      return "delivered";
    case "Open":
      return "opened";
    case "Click":
      return "clicked";
    case "Bounce":
      return TEMPORARY_BOUNCES.has(event.Type ?? "") && !event.Inactive ? null : "bounced";
    case "SpamComplaint":
      return "bounced";
    default:
      return null;
  }
}

export async function postmarkRoutes(app: FastifyInstance) {
  app.post("/email/webhook/postmark", { config: { public: true } }, async (req, reply) => {
    if (config.inboundWebhookToken) {
      if (!sameSecret(presentedToken(req), config.inboundWebhookToken)) {
        throw unauthorized("Invalid webhook token", "INVALID_WEBHOOK_TOKEN");
      }
    } else if (config.nodeEnv === "production") {
      throw badRequest("POSTMARK_WEBHOOK_TOKEN must be configured in production", "WEBHOOK_NOT_CONFIGURED");
    }

    // One event per request; tolerate an array too.
    const body = req.body as PostmarkEvent | PostmarkEvent[] | undefined;
    const events = Array.isArray(body) ? body : body ? [body] : [];
    if (events.length === 0) throw badRequest("Empty webhook payload");

    let updated = 0;
    for (const event of events) {
      const status = statusFor(event);
      if (!event.MessageID || !status) continue;

      const res = await servicePool.query<{ tenant_id: string; invoice_id: string | null }>(
        `UPDATE messages
            SET status = $1
          WHERE provider_msg_id = $2
            AND (CASE status ${Object.entries(RANK).map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(" ")} ELSE 0 END) < $3
          RETURNING tenant_id, invoice_id`,
        [status, event.MessageID, RANK[status]],
      );
      updated += res.rowCount ?? 0;

      // A hard bounce or spam complaint means more reminders to this address
      // won't land (and hurt sender reputation): pause the invoice for review.
      const row = res.rows[0];
      if (status === "bounced" && row?.invoice_id) {
        await servicePool.query(
          `UPDATE invoices SET status = 'paused', updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND status = 'open'`,
          [row.invoice_id, row.tenant_id],
        );
        await servicePool.query(
          `INSERT INTO audit_log (tenant_id, actor, action, detail)
           VALUES ($1, 'postmark', 'email_bounced_invoice_paused', $2::jsonb)`,
          [row.tenant_id, JSON.stringify({ invoice_id: row.invoice_id, record_type: event.RecordType, bounce_type: event.Type ?? null })],
        );
      }
    }

    return reply.send({ received: true, updated });
  });
}
