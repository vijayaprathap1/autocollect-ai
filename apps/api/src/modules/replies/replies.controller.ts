import type { FastifyInstance } from "fastify";
import { requireRole } from "../../plugins/tenant.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { sendEmail } from "../../lib/postmark.js";
import { suggestReply } from "../../lib/ai.js";

type ReplyRow = {
  id: string;
  invoice_id: string | null;
  content: string;
  classification: string;
  suggested_body: string | null;
  resolved: boolean;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
  external_id: string | null;
};

export async function repliesRoutes(app: FastifyInstance) {
  /**
   * Reply inbox — inbound customer replies with AI-suggested responses,
   * unresolved first.
   */
  app.get("/replies", async (req) => {
    const rows = await req.db.query<ReplyRow>(
      `SELECT r.id, r.invoice_id, r.content, r.classification, r.suggested_body,
              r.resolved, r.created_at, c.name AS customer_name, c.email AS customer_email,
              i.external_id
         FROM replies r
         LEFT JOIN invoices i ON i.id = r.invoice_id
         LEFT JOIN customers c ON c.id = i.customer_id
        WHERE r.tenant_id = $1
        ORDER BY r.resolved ASC, r.created_at DESC
        LIMIT 50`,
      [req.user.tenantId],
    );
    return {
      replies: rows.rows.map((r) => ({
        id: r.id,
        invoiceId: r.invoice_id,
        content: r.content,
        classification: r.classification,
        suggestedBody: r.suggested_body,
        resolved: r.resolved,
        createdAt: r.created_at,
        customerName: r.customer_name,
        customerEmail: r.customer_email,
        invoiceNumber: r.external_id,
      })),
    };
  });

  /**
   * Act on a reply: send the suggested reply back, regenerate a new
   * suggestion, or mark it resolved without sending.
   */
  app.put("/replies/:id", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { action?: string; body?: string };
    const action = body.action;
    if (!action || !["send", "regenerate", "resolve"].includes(action)) {
      throw badRequest("Unknown action (send | regenerate | resolve)");
    }

    const row = await req.db.query<ReplyRow>(
      `SELECT r.id, r.invoice_id, r.content, r.classification, r.suggested_body,
              r.resolved, c.email AS customer_email, c.name AS customer_name, i.external_id
         FROM replies r
         LEFT JOIN invoices i ON i.id = r.invoice_id
         LEFT JOIN customers c ON c.id = i.customer_id
        WHERE r.id = $1 AND r.tenant_id = $2`,
      [id, req.user.tenantId],
    );
    const reply = row.rows[0];
    if (!reply) throw notFound("Reply not found");

    if (action === "regenerate") {
      const inv = await req.db.query<{
        amount_due: number;
        currency: string;
        due_date: string | null;
        payment_link: string | null;
      }>(`SELECT amount_due, currency, due_date::text AS due_date, payment_link
           FROM invoices WHERE id = $1`, [reply.invoice_id]);
      const i = inv.rows[0];
      const suggestion = await suggestReply({
        classification: reply.classification as "dispute" | "promise" | "question" | "junk",
        replyText: reply.content,
        clientName: reply.customer_name,
        amountCents: i?.amount_due ?? 0,
        currency: i?.currency ?? "usd",
        dueDate: i?.due_date ?? null,
        payLink: i?.payment_link ?? null,
        invoiceNumber: reply.external_id,
      });
      await req.db.query(`UPDATE replies SET suggested_body = $2 WHERE id = $1 AND tenant_id = $3`, [
        id,
        suggestion?.body ?? null,
        req.user.tenantId,
      ]);
      return { ok: true, action, suggestedBody: suggestion?.body ?? null };
    }

    if (action === "resolve") {
      await req.db.query(`UPDATE replies SET resolved = TRUE WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
      return { ok: true, action, resolved: true };
    }

    // action === "send"
    const email = body.body?.trim() || reply.suggested_body?.trim();
    if (!email) throw badRequest("No reply body to send — regenerate or provide one");
    if (!reply.customer_email) throw badRequest("Customer has no email address to reply to");

    const { providerMsgId } = await sendEmail({
      to: reply.customer_email,
      subject: reply.external_id ? `Re: invoice ${reply.external_id}` : "Re: your invoice",
      text: email,
      tag: `reply-${reply.id}`,
    });

    await req.db.query(
      `INSERT INTO messages (tenant_id, invoice_id, channel, provider_msg_id, status, sent_at)
       VALUES ($1, $2, 'email', $3, 'sent', now())`,
      [req.user.tenantId, reply.invoice_id, providerMsgId],
    );
    await req.db.query(`UPDATE replies SET resolved = TRUE WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
    await req.db.query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail)
       VALUES ($1, $2, 'reply_sent', $3::jsonb)`,
      [req.user.tenantId, req.user.email, JSON.stringify({ reply_id: id, provider_msg_id: providerMsgId })],
    );

    return { ok: true, action, providerMsgId };
  });
}