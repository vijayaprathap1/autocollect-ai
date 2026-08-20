import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { requireRole } from "../../plugins/tenant.js";
import { servicePool } from "../../lib/db.js";
import { stripe, stripeEnabled } from "../../lib/stripe.js";
import { badRequest } from "../../lib/errors.js";
import { PLAN_KEYS, setTenantPlan, type PlanKey } from "../../lib/billing.js";

const PRICE_ID_FOR_PLAN: Record<Exclude<PlanKey, "starter">, string | undefined> = {
  growth: config.billingGrowthPriceId,
  pro: config.billingProPriceId,
  agency: config.billingAgencyPriceId,
};

export async function billingRoutes(app: FastifyInstance) {
  /**
   * Current plan + usage. Used by the UI to display and gate.
   */
  app.get("/billing", async (req) => {
    const row = await req.db.query<{ plan: string; invoice_limit: number | null }>(
      `SELECT plan, invoice_limit FROM tenants WHERE id = $1`,
      [req.user.tenantId],
    );
    const t = row.rows[0];

    const usage = await req.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM invoices WHERE tenant_id = $1`,
      [req.user.tenantId],
    );

    return {
      plan: t?.plan ?? "starter",
      invoiceLimit: t?.invoice_limit ?? null,
      invoicesUsed: usage.rows[0]?.count ?? 0,
    };
  });

  /**
   * Start self-serve checkout for a plan.
   * Real mode: Stripe Checkout subscription session.
   * Mock mode: a callback URL inside our app that completes the upgrade.
   */
  app.post(
    "/billing/checkout",
    { preHandler: requireRole("admin") },
    async (req) => {
      const body = (req.body ?? {}) as { plan?: string };
      const plan = body.plan;
      if (!plan || !PLAN_KEYS.includes(plan as PlanKey)) throw badRequest("Unknown plan");
      const planKey = plan as PlanKey;
      if (planKey === "starter") throw badRequest("Starter is the free plan — nothing to check out");

      let url: string;
      if (stripeEnabled) {
        const priceId = PRICE_ID_FOR_PLAN[planKey];
        if (!priceId) {
          throw badRequest(`Stripe Price ID not configured for the ${plan} plan`, "BILLING_NOT_CONFIGURED");
        }
        const session = await stripe!.checkout.sessions.create({
          mode: "subscription",
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: `${config.webOrigin}/settings?billing=success&plan=${plan}`,
          cancel_url: `${config.webOrigin}/settings`,
          client_reference_id: req.user.tenantId,
          subscription_data: {
            metadata: { tenantId: req.user.tenantId, plan: planKey },
          },
          metadata: { tenantId: req.user.tenantId, plan: planKey },
        });
        url = session.url ?? "";
        if (!url) throw badRequest("Stripe did not return a checkout URL");
      } else {
        url = `${config.appUrl}/billing/checkout/callback?plan=${planKey}&tenant=${encodeURIComponent(
          req.user.tenantId,
        )}`;
      }

      return { url, plan: planKey };
    },
  );

  /**
   * Mock-mode completion of checkout. Real upgrades happen via the
   * `checkout.session.completed` webhook; this route is only for the
   * no-keys demo flow.
   */
  app.get(
    "/billing/checkout/callback",
    { config: { public: true } },
    async (req, reply) => {
      if (stripeEnabled || config.nodeEnv === "production") {
        // Real mode (or production): the webhook upgrades the plan; just bounce
        // back to the UI. The mock upgrade path must never run in production.
        return reply.redirect(`${config.webOrigin}/settings`);
      }
      const q = req.query as { plan?: string; tenant?: string };
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        !q.plan ||
        !q.tenant ||
        !isUuid.test(q.tenant) ||
        !PLAN_KEYS.includes(q.plan as PlanKey)
      ) {
        return reply.redirect(`${config.webOrigin}/settings?billing=error`);
      }
      const plan = q.plan as PlanKey;
      await setTenantPlan(servicePool, q.tenant, plan);
      await servicePool.query(
        `INSERT INTO audit_log (tenant_id, actor, action, detail)
         VALUES ($1, 'system', 'plan_changed', $2::jsonb)`,
        [q.tenant, JSON.stringify({ from: "starter", to: plan, method: "mock_checkout" })],
      );
      return reply.redirect(`${config.webOrigin}/settings?billing=success&plan=${plan}`);
    },
  );
}