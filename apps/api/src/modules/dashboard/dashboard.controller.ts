import type { FastifyInstance } from "fastify";

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/dashboard", async (req) => {
    const tenantId = req.user.tenantId;

    const kpis = await req.db.query<{
      outstanding: number;
      overdue: number;
      recovered30d: number;
      open_count: number;
      paid_count_30d: number;
      avg_dso_days: number | null;
    }>(
      `SELECT
         COALESCE(SUM(amount_due) FILTER (WHERE status = 'open'), 0)::bigint AS outstanding,
         COALESCE(SUM(amount_due) FILTER (WHERE status = 'open' AND due_date < CURRENT_DATE), 0)::bigint AS overdue,
         COALESCE(SUM(amount_due) FILTER (WHERE status = 'paid' AND updated_at >= now() - interval '30 days'), 0)::bigint AS recovered30d,
         COUNT(*) FILTER (WHERE status = 'open')::int AS open_count,
         COUNT(*) FILTER (WHERE status = 'paid' AND updated_at >= now() - interval '30 days')::int AS paid_count_30d,
         AVG(updated_at::date - issue_date)::int AS avg_dso_days
       FROM invoices
       WHERE tenant_id = $1`,
      [tenantId],
    );
    const k = kpis.rows[0];

    const aging = await req.db.query<{ bucket: string; count: number; amount: number }>(
      `SELECT CASE
                WHEN (CURRENT_DATE - due_date) <= 30 THEN '0-30'
                WHEN (CURRENT_DATE - due_date) <= 60 THEN '31-60'
                WHEN (CURRENT_DATE - due_date) <= 90 THEN '61-90'
                ELSE '90+'
              END AS bucket,
              COUNT(*)::int AS count,
              COALESCE(SUM(amount_due), 0)::bigint AS amount
         FROM invoices
        WHERE tenant_id = $1 AND status = 'open' AND due_date < CURRENT_DATE
        GROUP BY 1
        ORDER BY 1`,
      [tenantId],
    );

    return {
      outstandingTotal: Number(k.outstanding),
      overdueTotal: Number(k.overdue),
      recovered30d: Number(k.recovered30d),
      avgDsoDays: k.avg_dso_days,
      openCount: k.open_count,
      paidCount30d: k.paid_count_30d,
      aging: aging.rows.map((r) => ({
        bucket: r.bucket,
        count: r.count,
        amount: Number(r.amount),
      })),
    };
  });
}