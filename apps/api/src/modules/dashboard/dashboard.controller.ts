import type { FastifyInstance } from "fastify";
import { z } from "zod";

const dashboardQuerySchema = z.object({
  range: z.enum(["7d", "30d", "90d"]).default("30d"),
});

const rangeDays = { "7d": 7, "30d": 30, "90d": 90 } as const;

function isoTimestamp(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { range?: string } }>("/dashboard", async (req) => {
    const { range } = dashboardQuerySchema.parse(req.query);
    const tenantId = req.user.tenantId;

    const metadata = await req.db.query<{
      currency: string;
      balance: number | null;
      monthly_allowance: number | null;
      period_start: Date | string | null;
      period_end: Date | string | null;
      subscription_status: string | null;
      range_from: string;
      range_to: string;
      as_of: Date | string;
      last_updated_at: Date | string | null;
    }>(
      `SELECT t.currency,
              w.balance,
              s.credits_per_month AS monthly_allowance,
              s.current_period_start AS period_start,
              s.current_period_end AS period_end,
              s.status AS subscription_status,
              (CURRENT_DATE - $2::int)::text AS range_from,
              CURRENT_DATE::text AS range_to,
              now() AS as_of,
              GREATEST(t.created_at, MAX(i.updated_at), MAX(s.updated_at), MAX(w.updated_at)) AS last_updated_at
         FROM tenants t
         LEFT JOIN credit_wallets w ON w.tenant_id = t.id
         LEFT JOIN LATERAL (
           SELECT credits_per_month, current_period_start, current_period_end, status, updated_at
             FROM subscriptions
            WHERE tenant_id = t.id
            ORDER BY created_at DESC
            LIMIT 1
         ) s ON TRUE
         LEFT JOIN invoices i ON i.tenant_id = t.id
        WHERE t.id = $1
        GROUP BY t.currency, t.created_at, w.balance, s.credits_per_month, s.current_period_start,
                 s.current_period_end, s.status, s.updated_at`,
      [tenantId, rangeDays[range]],
    );
    const m = metadata.rows[0];

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
      range: {
        from: m.range_from,
        to: m.range_to,
        asOf: isoTimestamp(m.as_of),
        lastUpdatedAt: isoTimestamp(m.last_updated_at),
      },
      currency: m.currency,
      credits: {
        balance: Number(m.balance ?? 0),
        monthlyAllowance: Number(m.monthly_allowance ?? 0),
        periodStart: isoTimestamp(m.period_start),
        periodEnd: isoTimestamp(m.period_end),
        subscriptionStatus: m.subscription_status,
      },
    };
  });
}