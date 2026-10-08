import type { FastifyInstance } from "fastify";
import { servicePool } from "../../lib/db.js";
import { PLANS, normalizePlan } from "../../lib/billing.js";
import { stripeEnabled } from "../../lib/stripe.js";

/**
 * GET /me — the current user, their active workspace and its settings.
 * The SPA calls this on load to decide what to render. Works for users who
 * are signed in but not (or no longer) a member of any workspace.
 */
export async function meRoutes(app: FastifyInstance) {
  app.get("/me", { config: { allowNoTenant: true } }, async (req) => {
    const orgCount = await servicePool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memberships m JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active'`,
      [req.user.userId],
    );
    const user = {
      id: req.user.userId,
      email: req.user.email,
      displayName: req.user.displayName,
      role: req.user.tenantId ? req.user.role : null,
      isSuperAdmin: req.user.isSuperAdmin,
      sessionType: req.user.sessionType,
      organizationCount: orgCount.rows[0]?.n ?? 0,
    };

    if (!req.user.tenantId) {
      return { user, tenant: null, templates: { approvedTemplates: 0, totalTemplates: 0 } };
    }

    const rows = await req.db.query<{
      id: string; name: string; slug: string; tone: string; email_domain: string | null;
      plan: string; invoice_limit: number | null; seat_limit: number | null; currency: string;
      timezone: string; send_hour: number; skip_weekends: boolean; reply_notifications: boolean;
      branding: Record<string, unknown> | null; user_count: number; workflow_enabled: boolean;
      invoice_count: number; approved_templates: number; total_templates: number;
      balance: number | null; sub_plan: string | null; sub_status: string | null; credits_per_month: number | null;
      current_period_end: string | null; cancel_at_period_end: boolean | null; has_billing_account: boolean;
      stripe_connected: boolean;
    }>(
      `SELECT t.id, t.name, t.slug, t.tone, t.email_domain, t.plan, t.invoice_limit, t.seat_limit, t.currency,
              t.timezone, t.send_hour, t.skip_weekends, t.reply_notifications, t.branding,
              (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active')::int AS user_count,
              COALESCE((SELECT bool_or(w.enabled) FROM workflows w WHERE w.tenant_id = t.id), FALSE) AS workflow_enabled,
              (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id)::int AS invoice_count,
              (SELECT count(*) FILTER (WHERE approved) FROM templates tp WHERE tp.tenant_id = t.id)::int AS approved_templates,
              (SELECT count(*) FROM templates tp WHERE tp.tenant_id = t.id)::int AS total_templates,
              w.balance,
              s.plan AS sub_plan, s.status AS sub_status, s.credits_per_month, s.current_period_end,
              s.cancel_at_period_end, (s.stripe_customer_id IS NOT NULL) AS has_billing_account,
              EXISTS (SELECT 1 FROM integrations ig WHERE ig.tenant_id = t.id AND ig.source = 'stripe' AND ig.status = 'active') AS stripe_connected
         FROM tenants t
         LEFT JOIN credit_wallets w ON w.tenant_id = t.id
         LEFT JOIN subscriptions s ON s.tenant_id = t.id
        WHERE t.id = $1`,
      [req.user.tenantId],
    );
    const t = rows.rows[0];
    if (!t) return { user, tenant: null, templates: { approvedTemplates: 0, totalTemplates: 0 } };

    const plan = normalizePlan(t.plan);
    const limits = PLANS[plan];
    return {
      user,
      tenant: {
        id: t.id,
        name: t.name,
        slug: t.slug,
        tone: t.tone,
        emailDomain: t.email_domain,
        currency: t.currency,
        timezone: t.timezone,
        sendHour: t.send_hour,
        skipWeekends: t.skip_weekends,
        replyNotifications: t.reply_notifications,
        plan,
        planName: limits.name,
        invoiceLimit: t.invoice_limit ?? limits.invoiceLimit,
        seatLimit: t.seat_limit ?? limits.seatLimit,
        seatsUsed: t.user_count,
        branding: t.branding ?? {},
        workflowEnabled: t.workflow_enabled,
        hasUnapprovedTemplates: t.approved_templates < t.total_templates,
        invoiceCount: t.invoice_count,
        creditBalance: t.balance ?? 0,
        creditsPerMonth: t.credits_per_month ?? limits.creditsPerMonth,
        stripeConnected: t.stripe_connected,
        subscription: {
          status: t.sub_status ?? "active",
          currentPeriodEnd: t.current_period_end,
          cancelAtPeriodEnd: Boolean(t.cancel_at_period_end),
          canManageBilling: stripeEnabled && t.has_billing_account,
        },
      },
      templates: { approvedTemplates: t.approved_templates, totalTemplates: t.total_templates },
    };
  });
}
