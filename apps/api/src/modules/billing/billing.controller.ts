import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { requireRole } from "../../plugins/tenant.js";
import { servicePool } from "../../lib/db.js";
import { stripe, stripeEnabled } from "../../lib/stripe.js";
import { badRequest } from "../../lib/errors.js";
import { PLAN_KEYS, type PlanKey } from "../../lib/billing.js";
import { activatePlan } from "./billing.webhooks.js";

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

        const billing = await servicePool.query<{
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          status: string | null;
        }>(
          `SELECT t.stripe_customer_id, s.stripe_subscription_id, s.status
             FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id
            WHERE t.id = $1`,
          [req.user.tenantId],
        );
        const current = billing.rows[0];

        // Already subscribed: change the price on the existing subscription
        // (prorated) instead of opening a second one. The
        // customer.subscription.updated webhook syncs plan + credits.
        if (current?.stripe_subscription_id && current.status && ["active", "trialing", "past_due"].includes(current.status)) {
          const sub = await stripe!.subscriptions.retrieve(current.stripe_subscription_id);
          const itemId = sub.items?.data?.[0]?.id;
          if (sub.status !== "canceled" && itemId) {
            await stripe!.subscriptions.update(current.stripe_subscription_id, {
              items: [{ id: itemId, price: priceId }],
              proration_behavior: "create_prorations",
              metadata: { tenantId: req.user.tenantId, plan: planKey },
            });
            return { url: `${config.webOrigin}/settings?billing=updated&plan=${plan}`, plan: planKey };
          }
        }

        const session = await stripe!.checkout.sessions.create({
          mode: "subscription",
          ...(current?.stripe_customer_id ? { customer: current.stripe_customer_id } : {}),
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
      const exists = await servicePool.query(`SELECT 1 FROM tenants WHERE id = $1`, [q.tenant]);
      if (exists.rows.length === 0) return reply.redirect(`${config.webOrigin}/settings?billing=error`);

      const { previousPlan, granted } = await activatePlan(q.tenant, plan, {
        reason: plan === "starter" ? "plan_changed" : "plan_activated",
        referenceId: "mock_checkout",
      });
      await servicePool.query(
        `INSERT INTO audit_log (tenant_id, actor, action, detail)
         VALUES ($1, 'system', 'plan_changed', $2::jsonb)`,
        [q.tenant, JSON.stringify({ from: previousPlan, to: plan, method: "mock_checkout", credits_granted: granted })],
      );
      return reply.redirect(`${config.webOrigin}/settings?billing=success&plan=${plan}`);
    },
  );

  /**
   * Stripe Customer Portal: update card, view invoices, cancel. Plan changes
   * flow back through the subscription webhooks.
   */
  app.post(
    "/billing/portal",
    { preHandler: requireRole("admin") },
    async (req) => {
      if (!stripeEnabled) {
        return { url: `${config.webOrigin}/settings?billing=portal-unavailable` };
      }
      const row = await servicePool.query<{ stripe_customer_id: string | null }>(
        `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
        [req.user.tenantId],
      );
      const customer = row.rows[0]?.stripe_customer_id;
      if (!customer) throw badRequest("No billing account yet. Choose a paid plan first.", "NO_BILLING_ACCOUNT");
      const session = await stripe!.billingPortal.sessions.create({
        customer,
        return_url: `${config.webOrigin}/settings`,
      });
      return { url: session.url };
    },
  );
}