import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config, isDevLike } from "../../config.js";
import { requireRole, requireTenant } from "../../plugins/tenant.js";
import { stripe, stripeEnabled } from "../../lib/stripe.js";
import { ApiError, badRequest, notFound } from "../../lib/errors.js";
import { PLANS, PLAN_KEYS, isPlanKey, normalizePlan, type PlanKey } from "../../lib/billing.js";
import { PLAN_TO_PRICE, applyMockUpgrade } from "../../lib/subscriptions.js";
import { hashToken } from "../../lib/auth.js";
import { servicePool } from "../../lib/db.js";

function webUrl(path: string): string {
  return `${config.webOrigin.split(",")[0].replace(/\/$/, "")}${path}`;
}

type SubRow = {
  plan: string;
  status: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  credits_per_month: number;
};

async function loadSubscription(db: { query: typeof servicePool.query }, tenantId: string): Promise<SubRow | undefined> {
  const r = await db.query<SubRow>(
    `SELECT plan, status, stripe_subscription_id, stripe_customer_id, current_period_end, cancel_at_period_end, credits_per_month
       FROM subscriptions WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0];
}

const hasLiveSubscription = (s?: SubRow) =>
  Boolean(s?.stripe_subscription_id && ["active", "trialing", "past_due", "unpaid", "incomplete"].includes(s.status));

export async function billingRoutes(app: FastifyInstance) {
  /** Plan, usage, credits and what the UI may offer. */
  app.get("/billing", { preHandler: requireTenant() }, async (req) => {
    const t = await req.db.query<{ plan: string; invoice_limit: number | null; seat_limit: number | null }>(
      `SELECT plan, invoice_limit, seat_limit FROM tenants WHERE id = $1`,
      [req.user.tenantId],
    );
    const usage = await req.db.query<{ open: number; members: number; balance: number; sent30: number }>(
      `SELECT (SELECT count(*) FROM invoices WHERE tenant_id = $1 AND status IN ('open','paused'))::int AS open,
              (SELECT count(*) FROM memberships WHERE tenant_id = $1 AND status = 'active')::int AS members,
              COALESCE((SELECT balance FROM credit_wallets WHERE tenant_id = $1), 0)::int AS balance,
              (SELECT count(*) FROM messages WHERE tenant_id = $1 AND sent_at > now() - interval '30 days')::int AS sent30`,
      [req.user.tenantId],
    );
    const sub = await loadSubscription(req.db, req.user.tenantId);
    const plan = normalizePlan(t.rows[0]?.plan);
    const u = usage.rows[0];
    return {
      plan,
      planName: PLANS[plan].name,
      invoiceLimit: t.rows[0]?.invoice_limit ?? null,
      invoicesUsed: u.open,
      seatLimit: t.rows[0]?.seat_limit ?? null,
      seatsUsed: u.members,
      credits: { balance: u.balance, perMonth: PLANS[plan].creditsPerMonth, sentLast30Days: u.sent30 },
      subscription: {
        status: sub?.status ?? "active",
        currentPeriodEnd: sub?.current_period_end ?? null,
        cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
        managedByStripe: hasLiveSubscription(sub),
      },
      canManageBilling: stripeEnabled && Boolean(sub?.stripe_customer_id),
      mode: stripeEnabled ? "stripe" : isDevLike ? "mock" : "disabled",
      plans: PLAN_KEYS.map((k) => ({
        key: k,
        name: PLANS[k].name,
        monthlyPriceCents: PLANS[k].monthlyPriceCents,
        invoiceLimit: PLANS[k].invoiceLimit,
        seatLimit: PLANS[k].seatLimit,
        creditsPerMonth: PLANS[k].creditsPerMonth,
        whiteLabel: PLANS[k].whiteLabel,
        available: k === "starter" || !stripeEnabled || Boolean(PLAN_TO_PRICE(k)),
      })),
    };
  });

  /**
   * Start checkout for a paid plan. If the workspace already has a Stripe
   * subscription, plan changes go through the Billing Portal instead — this
   * prevents a second, parallel subscription (double billing).
   */
  app.post("/billing/checkout", { preHandler: requireRole("admin"), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { plan } = z.object({ plan: z.string() }).parse(req.body ?? {});
    if (!isPlanKey(plan)) throw badRequest("Unknown plan");
    if (plan === "starter") throw badRequest("Starter is free — cancel your subscription from the billing portal to downgrade");
    const planKey: PlanKey = plan;

    if (!stripeEnabled) {
      if (!isDevLike) throw new ApiError(503, "BILLING_NOT_CONFIGURED", "Billing is not configured on this server");
      const url = `${config.appUrl}/billing/checkout/callback?plan=${planKey}&tenant=${encodeURIComponent(req.user.tenantId)}&sig=${hashToken(
        `${req.user.tenantId}:${planKey}:${config.stateSecret || "dev"}`,
      ).slice(0, 24)}`;
      return { url, plan: planKey, mode: "mock" };
    }

    const priceId = PLAN_TO_PRICE(planKey);
    if (!priceId) throw badRequest(`The ${PLANS[planKey].name} plan isn't available yet`, "BILLING_NOT_CONFIGURED");

    const sub = await loadSubscription(servicePool, req.user.tenantId);
    if (hasLiveSubscription(sub) && sub?.stripe_customer_id) {
      const portal = await stripe!.billingPortal.sessions.create({
        customer: sub.stripe_customer_id,
        return_url: webUrl("/settings?tab=billing"),
      });
      return { url: portal.url, plan: planKey, mode: "portal" };
    }

    const session = await stripe!.checkout.sessions.create(
      {
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: webUrl(`/settings?tab=billing&billing=success&plan=${planKey}`),
        cancel_url: webUrl("/settings?tab=billing&billing=cancelled"),
        client_reference_id: req.user.tenantId,
        ...(sub?.stripe_customer_id ? { customer: sub.stripe_customer_id } : { customer_email: req.user.email }),
        allow_promotion_codes: true,
        billing_address_collection: "auto",
        subscription_data: { metadata: { tenantId: req.user.tenantId, plan: planKey } },
        metadata: { tenantId: req.user.tenantId, plan: planKey },
      },
      // Double-clicks within the same minute reuse one session.
      { idempotencyKey: `checkout:${req.user.tenantId}:${planKey}:${Math.floor(Date.now() / 60_000)}` },
    );
    if (!session.url) throw new ApiError(502, "CHECKOUT_FAILED", "Stripe did not return a checkout URL");
    return { url: session.url, plan: planKey, mode: "checkout" };
  });

  /** Stripe Customer Portal: update card, download invoices, change or cancel plan. */
  app.post("/billing/portal", { preHandler: requireRole("admin") }, async (req) => {
    if (!stripeEnabled) throw new ApiError(503, "BILLING_NOT_CONFIGURED", "Billing is not configured on this server");
    const sub = await loadSubscription(servicePool, req.user.tenantId);
    if (!sub?.stripe_customer_id) throw notFound("No billing account yet — choose a plan first", "NO_BILLING_ACCOUNT");
    const portal = await stripe!.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: webUrl("/settings?tab=billing"),
    });
    return { url: portal.url };
  });

  /** Development-only completion of mock checkout (never runs with real Stripe or in production). */
  app.get("/billing/checkout/callback", { config: { public: true } }, async (req, reply) => {
    if (stripeEnabled || !isDevLike) return reply.redirect(webUrl("/settings?tab=billing"));
    const q = req.query as { plan?: string; tenant?: string; sig?: string };
    const expected =
      q.tenant && q.plan ? hashToken(`${q.tenant}:${q.plan}:${config.stateSecret || "dev"}`).slice(0, 24) : "";
    if (!q.plan || !q.tenant || !isPlanKey(q.plan) || q.sig !== expected) {
      return reply.redirect(webUrl("/settings?tab=billing&billing=error"));
    }
    await applyMockUpgrade(q.tenant, q.plan);
    return reply.redirect(webUrl(`/settings?tab=billing&billing=success&plan=${q.plan}`));
  });
}
