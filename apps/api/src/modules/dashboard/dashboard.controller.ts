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
         LEFT JOIN subscriptions s ON s.tenant_id = t.id
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
         AVG(updated_at::date - issue_date) FILTER (WHERE status = 'paid' AND issue_date IS NOT NULL AND updated_at::date >= issue_date AND updated_at >= now() - ($2::int * interval '1 day'))::int AS avg_dso_days
       FROM invoices
       WHERE tenant_id = $1`,
      [tenantId, rangeDays[range]],
    );
    const k = kpis.rows[0];

    const days = rangeDays[range];
    const ceiRow = await req.db.query<{ beginning: number; credit_sales: number; ending_total: number; ending_current: number }>(
        `WITH sales AS (
           SELECT COALESCE(SUM(amount_due), 0)::bigint AS credit_sales
             FROM invoices
            WHERE tenant_id = $1 AND status <> 'void'
              AND COALESCE(issue_date, created_at::date) >= CURRENT_DATE - $2::int
         ),
         collected AS (
           SELECT COALESCE(SUM(amount_due), 0)::bigint AS collected
             FROM invoices
            WHERE tenant_id = $1 AND status = 'paid' AND updated_at::date >= CURRENT_DATE - $2::int
         ),
         ending AS (
           SELECT COALESCE(SUM(amount_due) FILTER (WHERE status = 'open'), 0)::bigint AS ending_total,
                  COALESCE(SUM(amount_due) FILTER (WHERE status = 'open' AND (due_date IS NULL OR due_date >= CURRENT_DATE)), 0)::bigint AS ending_current
             FROM invoices WHERE tenant_id = $1
         )
         SELECT GREATEST(ending.ending_total + collected.collected - sales.credit_sales, 0)::bigint AS beginning,
                sales.credit_sales, ending.ending_total, ending.ending_current
           FROM sales, collected, ending`,
        [tenantId, days],
      );
    const cash = await req.db.query<{ date: string; amount: number }>(
        `SELECT updated_at::date::text AS date, COALESCE(SUM(amount_due), 0)::bigint AS amount
           FROM invoices
          WHERE tenant_id = $1 AND status = 'paid' AND updated_at::date >= CURRENT_DATE - $2::int
          GROUP BY 1 ORDER BY 1`,
        [tenantId, days],
      );
    const dsoTrend = await req.db.query<{ date: string; days: number | null }>(
        `SELECT date_trunc('week', updated_at)::date::text AS date,
                AVG(updated_at::date - issue_date) FILTER (WHERE issue_date IS NOT NULL AND updated_at::date >= issue_date)::int AS days
           FROM invoices
          WHERE tenant_id = $1 AND status = 'paid' AND updated_at::date >= CURRENT_DATE - $2::int
          GROUP BY 1 ORDER BY 1`,
        [tenantId, days],
      );
    const disputeKpis = await req.db.query<{ open: number; resolved: number; avg_days: number | null }>(
        `SELECT count(*) FILTER (WHERE status IN ('open', 'investigating', 'pending_customer'))::int AS open,
                count(*) FILTER (WHERE resolved_at::date >= CURRENT_DATE - $2::int)::int AS resolved,
                AVG(EXTRACT(EPOCH FROM (resolved_at - opened_at)) / 86400) FILTER (WHERE resolved_at IS NOT NULL AND resolved_at::date >= CURRENT_DATE - $2::int)::int AS avg_days
           FROM disputes WHERE tenant_id = $1`,
        [tenantId, days],
      );
    const promiseKpis = await req.db.query<{ open: number; kept: number; broken: number }>(
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
                count(*) FILTER (WHERE status = 'kept' AND kept_at::date >= CURRENT_DATE - $2::int)::int AS kept,
                count(*) FILTER (WHERE status = 'broken' AND broken_at::date >= CURRENT_DATE - $2::int)::int AS broken
           FROM promises WHERE tenant_id = $1`,
        [tenantId, days],
      );
    const ceiSrc = ceiRow.rows[0];
    const beginning = Number(ceiSrc?.beginning ?? 0);
    const creditSales = Number(ceiSrc?.credit_sales ?? 0);
    const endingTotal = Number(ceiSrc?.ending_total ?? 0);
    const endingCurrent = Number(ceiSrc?.ending_current ?? 0);
    const ceiDenom = beginning + creditSales - endingCurrent;
    const cei = ceiDenom > 0 ? Math.round(((beginning + creditSales - endingTotal) / ceiDenom) * 1000) / 10 : null;
    const disputes = disputeKpis.rows[0];
    const promises = promiseKpis.rows[0];
    const kept = promises?.kept ?? 0;
    const broken = promises?.broken ?? 0;

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
      cei,
      cashCollected: cash.rows.map((r) => ({ date: r.date, amount: Number(r.amount) })),
      dsoTrend: dsoTrend.rows.map((r) => ({ date: r.date, days: r.days })),
      disputeKpis: { open: disputes?.open ?? 0, resolvedInRange: disputes?.resolved ?? 0, avgDaysToResolve: disputes?.avg_days ?? null },
      promiseKpis: {
        open: promises?.open ?? 0,
        kept,
        broken,
        keptRate: kept + broken > 0 ? Math.round((kept / (kept + broken)) * 1000) / 10 : null,
      },
    };
  });
}