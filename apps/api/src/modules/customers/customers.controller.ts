import type { FastifyInstance } from "fastify";

type CustomerRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  source: string;
  sms_opt_out: boolean;
  created_at: string;
  open_count: number;
  open_total: number;
  paid_count: number;
};

export async function customerRoutes(app: FastifyInstance) {
  /**
   * List the tenant's customers with outstanding balances.
   */
  app.get("/customers", async (req) => {
    const q = req.query as { q?: string; limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? "100") || 100, 1), 500);
    const offset = Math.max(Number(q.offset ?? "0") || 0, 0);

    const rows = await req.db.query<CustomerRow>(
      `SELECT c.id, c.name, c.email, c.phone, c.source, c.sms_opt_out, c.created_at,
              COUNT(i.id) FILTER (WHERE i.status = 'open')::int AS open_count,
              COALESCE(SUM(i.amount_due) FILTER (WHERE i.status = 'open'), 0)::bigint AS open_total,
              COUNT(i.id) FILTER (WHERE i.status = 'paid')::int AS paid_count
         FROM customers c
         LEFT JOIN invoices i ON i.customer_id = c.id
        WHERE c.tenant_id = $1
          AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%' OR c.email ILIKE '%' || $2 || '%')
        GROUP BY c.id
        ORDER BY open_total DESC, c.created_at DESC
        LIMIT $3 OFFSET $4`,
      [req.user.tenantId, q.q ?? null, limit, offset],
    );

    return {
      customers: rows.rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        source: r.source,
        smsOptOut: r.sms_opt_out,
        createdAt: r.created_at,
        openCount: r.open_count,
        openTotal: Number(r.open_total),
        paidCount: r.paid_count,
      })),
      limit,
      offset,
    };
  });
}