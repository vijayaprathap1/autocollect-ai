import type { FastifyInstance } from "fastify";
import { servicePool } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import { assertPostmarkWebhook } from "../inbound/inbound.controller.js";

/**
 * Postmark delivery/engagement webhook (Delivery, Bounce, Open, Click,
 * SpamComplaint, SubscriptionChange). Configure in Postmark as
 *   https://<api>/email/webhook/postmark?token=<POSTMARK_WEBHOOK_TOKEN>
 */
type PostmarkEvent = {
  RecordType?: string;
  Type?: string;
  MessageID?: string;
  Inactive?: boolean;
  SuppressSending?: boolean;
  [key: string]: unknown;
};

// Status only moves forward; bounced/failed are terminal.
const RANK: Record<string, number> = { sending: 0, sent: 1, delivered: 2, opened: 3, clicked: 4, bounced: 9, failed: 9 };
const RANK_SQL = `CASE status ${Object.entries(RANK).map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(" ")} ELSE 0 END`;

// Bounce types that don't mean the address is bad.
const TEMPORARY_BOUNCES = new Set(["Transient", "SoftBounce", "DnsError", "AutoResponder", "Unknown", "Blocked"]);

export function statusFor(event: PostmarkEvent): string | null {
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
    case "SubscriptionChange":
      return event.SuppressSending ? "bounced" : null;
    default:
      return null;
  }
}

export async function postmarkRoutes(app: FastifyInstance) {
  app.post("/email/webhook/postmark", { config: { public: true, rateLimit: false } }, async (req, reply) => {
    assertPostmarkWebhook(req);

    const body = req.body as PostmarkEvent | PostmarkEvent[] | undefined;
    const events = Array.isArray(body) ? body : body ? [body] : [];
    if (events.length === 0) throw badRequest("Empty webhook payload");

    let updated = 0;
    for (const event of events.slice(0, 500)) {
      const status = statusFor(event);
      if (!event.MessageID || !status) continue;

      const res = await servicePool.query<{ tenant_id: string; invoice_id: string | null }>(
        `UPDATE messages SET status = $1
          WHERE provider_msg_id = $2 AND (${RANK_SQL}) < $3
          RETURNING tenant_id, invoice_id`,
        [status, event.MessageID, RANK[status]],
      );
      updated += res.rowCount ?? 0;

      // A hard bounce / complaint / unsubscribe means more reminders to this
      // address won't land and would hurt sender reputation: pause for review.
      const row = res.rows[0];
      if (status === "bounced" && row?.invoice_id) {
        const paused = await servicePool.query(
          `UPDATE invoices SET status = 'paused', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'open'`,
          [row.invoice_id, row.tenant_id],
        );
        if (paused.rowCount) {
          await servicePool.query(
            `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'postmark', 'email_bounced_invoice_paused', $2::jsonb)`,
            [row.tenant_id, JSON.stringify({ invoice_id: row.invoice_id, record_type: event.RecordType, bounce_type: event.Type ?? null })],
          );
        }
      }
    }
    return reply.send({ received: true, updated });
  });
}
