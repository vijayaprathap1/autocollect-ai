import type { FastifyInstance } from "fastify";
import { PLANS, type PlanKey } from "../../lib/billing.js";

/**
 * GET /me — returns the current user, their membership, and org details.
 * This is the primary endpoint the frontend calls on load to determine auth state.
 */
export async function meRoutes(app: FastifyInstance) {
  app.get("/me", async (req) => {
    // If no tenant (super admin with no org), return minimal user info
    if (!req.user.tenantId) {
      return {
        user: {
          id: req.user.userId,
          email: req.user.email,
          role: "owner",
          isSuperAdmin: true,
          sessionType: req.user.sessionType,
        },
        tenant: null,
        templates: { approvedTemplates: 0, totalTemplates: 0 },
      };
    }

    const rows = await req.db.query<{
      id: string; name: string; slug: string; tone: string; email_domain: string | null;
      plan: string; invoice_limit: number | null; seat_limit: number | null;
      branding: Record<string, unknown> | null; user_count: string;
      has_unapproved: boolean; workflow_enabled: boolean; invoice_count: string;
    }>(
      `SELECT t.id, t.name, t.slug, t.tone, t.email_domain, t.plan, t.invoice_limit, t.seat_limit,
              t.branding,
              COALESCE(bool_or(w.enabled), FALSE) AS workflow_enabled,
              EXISTS (
                SELECT 1 FROM templates tp
                WHERE tp.tenant_id = t.id AND tp.approved = FALSE
              ) AS has_unapproved,
              (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id) AS invoice_count,
              (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS user_count
         FROM tenants t
         LEFT JOIN workflows w ON w.tenant_id = t.id
        WHERE t.id = $1
        GROUP BY t.id`,
      [req.user.tenantId],
    );

    const tenant = rows.rows[0];
    if (!tenant) {
      return {
        user: { id: req.user.userId, email: req.user.email, role: req.user.role, isSuperAdmin: req.user.isSuperAdmin, sessionType: req.user.sessionType },
        tenant: null,
        templates: { approvedTemplates: 0, totalTemplates: 0 },
      };
    }

    const workflow = await req.db.query<{ approvedTemplates: number; totalTemplates: number }>(
      `SELECT count(*) FILTER (WHERE approved)::int AS "approvedTemplates",
              count(*)::int AS "totalTemplates"
         FROM templates WHERE tenant_id = $1`,
      [req.user.tenantId],
    );

    // Get credit balance
    const credits = await req.db.query<{ balance: number }>(
      `SELECT balance FROM credit_wallets WHERE tenant_id = $1`,
      [req.user.tenantId],
    );

    // Get subscription info
    const subscription = await req.db.query<{ plan: string; status: string; credits_per_month: number }>(
      `SELECT plan, status, credits_per_month FROM subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.user.tenantId],
    );

    const plan = (subscription.rows[0]?.plan ?? tenant.plan ?? "starter") as PlanKey;
    const planLimits = PLANS[plan] ?? PLANS.starter;
    const seatsUsed = Number(tenant.user_count ?? 0);
    const creditBalance = credits.rows[0]?.balance ?? 0;
    const creditsPerMonth = subscription.rows[0]?.credits_per_month ?? 0;

    return {
      user: {
        id: req.user.userId,
        email: req.user.email,
        role: req.user.role,
        isSuperAdmin: req.user.isSuperAdmin,
        sessionType: req.user.sessionType,
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        tone: tenant.tone,
        emailDomain: tenant.email_domain,
        plan,
        invoiceLimit: tenant.invoice_limit ?? planLimits.invoiceLimit,
        seatLimit: tenant.seat_limit ?? planLimits.seatLimit,
        seatsUsed,
        branding: tenant.branding ?? {},
        workflowEnabled: tenant.workflow_enabled,
        hasUnapprovedTemplates: tenant.has_unapproved,
        invoiceCount: Number(tenant.invoice_count),
        creditBalance,
        creditsPerMonth,
      },
      templates: workflow.rows[0] ?? { approvedTemplates: 0, totalTemplates: 0 },
    };
  });
}
