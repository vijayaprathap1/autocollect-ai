import type { FastifyInstance } from "fastify";

export async function activityRoutes(app: FastifyInstance) {
  app.get("/activity", async (req) => {
    const audit = await req.db.query<{
      id: string;
      actor: string;
      action: string;
      detail: unknown;
      created_at: string;
    }>(`SELECT id, actor, action, detail, created_at
         FROM audit_log
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 30`, [req.user.tenantId]);

    const messages = await req.db.query<{
      id: string;
      channel: string;
      status: string;
      sent_at: string | null;
      step_index: number;
      external_id: string | null;
      customer_name: string | null;
    }>(`SELECT m.id, m.channel, m.status, m.sent_at, m.step_index,
                i.external_id, c.name AS customer_name
           FROM messages m
           LEFT JOIN invoices i ON i.id = m.invoice_id
           LEFT JOIN customers c ON c.id = i.customer_id
          WHERE m.tenant_id = $1
          ORDER BY m.sent_at DESC NULLS LAST
          LIMIT 20`, [req.user.tenantId]);

    const replies = await req.db.query<{
      id: string;
      classification: string;
      content: string;
      created_at: string;
      external_id: string | null;
      customer_name: string | null;
    }>(`SELECT r.id, r.classification, r.content, r.created_at,
               i.external_id, c.name AS customer_name
          FROM replies r
          LEFT JOIN invoices i ON i.id = r.invoice_id
          LEFT JOIN customers c ON c.id = i.customer_id
         WHERE r.tenant_id = $1
         ORDER BY r.created_at DESC
         LIMIT 20`, [req.user.tenantId]);

    return {
      audit: audit.rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        detail: r.detail,
        createdAt: r.created_at,
      })),
      messages: messages.rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        status: r.status,
        sentAt: r.sent_at,
        stepIndex: r.step_index,
        invoiceNumber: r.external_id,
        customerName: r.customer_name,
      })),
      replies: replies.rows.map((r) => ({
        id: r.id,
        classification: r.classification,
        content: r.content,
        createdAt: r.created_at,
        invoiceNumber: r.external_id,
        customerName: r.customer_name,
      })),
    };
  });
}