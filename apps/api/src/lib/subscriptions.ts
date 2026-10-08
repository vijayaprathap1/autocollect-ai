import { config } from "../config.js";
import { servicePool, withServiceTransaction } from "./db.js";
import { stripe, stripeEnabled } from "./stripe.js";
import { grantPlanCredits, normalizePlan, setTenantPlan, type PlanKey } from "./billing.js";
import { isUuid } from "./errors.js";

/**
 * Platform billing (tenants paying us) synchronised from Stripe webhooks.
 *
 * Field access is deliberately defensive: webhook payloads use the API version
 * configured on each endpoint, and recent versions moved fields around
 * (invoice.subscription -> invoice.parent.subscription_details.subscription,
 *  subscription.current_period_end -> subscription.items[].current_period_end).
 */

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose => (v && typeof v === "object" ? (v as Loose) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v).id);

export const PRICE_TO_PLAN = (): Record<string, PlanKey> => {
  const m: Record<string, PlanKey> = {};
  if (config.billingGrowthPriceId) m[config.billingGrowthPriceId] = "growth";
  if (config.billingProPriceId) m[config.billingProPriceId] = "pro";
  if (config.billingAgencyPriceId) m[config.billingAgencyPriceId] = "agency";
  return m;
};

export const PLAN_TO_PRICE = (plan: PlanKey): string | undefined =>
  ({ growth: config.billingGrowthPriceId, pro: config.billingProPriceId, agency: config.billingAgencyPriceId } as Record<string, string>)[plan] ||
  undefined;

/** Subscription id referenced by a Stripe invoice (old + new API shapes). */
export function invoiceSubscriptionId(invoice: unknown): string | null {
  const inv = obj(invoice);
  return idOf(inv.subscription) ?? idOf(obj(obj(inv.parent).subscription_details).subscription);
}

function invoiceSubscriptionMetadata(invoice: unknown): Loose {
  const inv = obj(invoice);
  const current = obj(obj(obj(inv.parent).subscription_details).metadata);
  return Object.keys(current).length ? current : obj(obj(inv.subscription_details).metadata);
}

function subscriptionPriceId(sub: unknown): string | null {
  const items = obj(obj(sub).items).data;
  const first = Array.isArray(items) ? obj(items[0]) : {};
  return idOf(first.price) ?? idOf(obj(first.plan).id);
}

function subscriptionPeriod(sub: unknown): { start: number | null; end: number | null } {
  const s = obj(sub);
  const items = obj(s.items).data;
  const first = Array.isArray(items) ? obj(items[0]) : {};
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    start: n(s.current_period_start) ?? n(first.current_period_start),
    end: n(s.current_period_end) ?? n(first.current_period_end),
  };
}

export function planForSubscription(sub: unknown): PlanKey | null {
  const price = subscriptionPriceId(sub);
  if (price && PRICE_TO_PLAN()[price]) return PRICE_TO_PLAN()[price];
  const metaPlan = str(obj(obj(sub).metadata).plan);
  return metaPlan ? normalizePlan(metaPlan) : null;
}

/** Find our tenant for a Stripe subscription/customer. */
async function tenantFor(opts: { tenantHint?: string | null; subscriptionId?: string | null; customerId?: string | null }): Promise<string | null> {
  if (opts.tenantHint && isUuid(opts.tenantHint)) {
    const t = await servicePool.query(`SELECT 1 FROM tenants WHERE id = $1`, [opts.tenantHint]);
    if (t.rowCount) return opts.tenantHint;
  }
  if (opts.subscriptionId) {
    const r = await servicePool.query<{ tenant_id: string }>(`SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id = $1`, [opts.subscriptionId]);
    if (r.rows[0]) return r.rows[0].tenant_id;
  }
  if (opts.customerId) {
    const r = await servicePool.query<{ tenant_id: string }>(`SELECT tenant_id FROM subscriptions WHERE stripe_customer_id = $1`, [opts.customerId]);
    if (r.rows[0]) return r.rows[0].tenant_id;
  }
  return null;
}

const ENTITLED = new Set(["active", "trialing", "past_due"]);

/**
 * Apply a Stripe Subscription object to our records: plan, status, period,
 * cancel-at-period-end. Ended subscriptions drop the workspace to Starter.
 */
export async function syncSubscription(subscription: unknown, tenantHint?: string | null): Promise<{ tenantId: string; plan: PlanKey; status: string } | null> {
  const sub = obj(subscription);
  const subscriptionId = idOf(sub.id);
  const customerId = idOf(sub.customer);
  const tenantId = await tenantFor({
    tenantHint: tenantHint ?? str(obj(sub.metadata).tenantId),
    subscriptionId,
    customerId,
  });
  if (!tenantId || !subscriptionId) return null;

  const status = str(sub.status) ?? "active";
  const mapped = planForSubscription(sub);
  const plan: PlanKey = ENTITLED.has(status) && mapped ? mapped : "starter";
  const period = subscriptionPeriod(sub);
  const toIso = (s: number | null) => (s ? new Date(s * 1000).toISOString() : null);

  await withServiceTransaction(async (c) => {
    await c.query(
      `INSERT INTO subscriptions (tenant_id, stripe_subscription_id, stripe_customer_id, plan, status, price_id,
                                  current_period_start, current_period_end, cancel_at_period_end, credits_per_month, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
         plan = EXCLUDED.plan, status = EXCLUDED.status, price_id = EXCLUDED.price_id,
         current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end, updated_at = now()`,
      [
        tenantId,
        subscriptionId,
        customerId,
        plan,
        ["active", "trialing", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"].includes(status) ? status : "active",
        subscriptionPriceId(sub),
        toIso(period.start),
        toIso(period.end),
        Boolean(sub.cancel_at_period_end),
      ],
    );
    const prev = await c.query<{ plan: string }>(`SELECT plan FROM tenants WHERE id = $1`, [tenantId]);
    await setTenantPlan(c, tenantId, plan);
    if (prev.rows[0]?.plan !== plan) {
      await c.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'stripe', 'plan_changed', $2::jsonb)`, [
        tenantId,
        JSON.stringify({ from: prev.rows[0]?.plan ?? null, to: plan, status, subscription: subscriptionId }),
      ]);
    }
  });
  return { tenantId, plan, status };
}

/** checkout.session.completed (mode=subscription) for our own plans. */
export async function handleCheckoutCompleted(session: unknown): Promise<string | null> {
  const s = obj(session);
  if (str(s.mode) && s.mode !== "subscription") return null;
  const tenantHint = str(obj(s.metadata).tenantId) ?? str(s.client_reference_id);
  const subscriptionId = idOf(s.subscription);
  const customerId = idOf(s.customer);
  if (!tenantHint || !isUuid(tenantHint)) return null;

  // Remember the customer immediately so the Billing Portal works even before sync.
  if (customerId) {
    await servicePool.query(
      `UPDATE subscriptions SET stripe_customer_id = $2, stripe_subscription_id = COALESCE($3, stripe_subscription_id), updated_at = now()
        WHERE tenant_id = $1`,
      [tenantHint, customerId, subscriptionId],
    );
  }
  if (subscriptionId && stripeEnabled && stripe) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    await syncSubscription(sub, tenantHint);
  }
  return tenantHint;
}

/**
 * invoice.paid for a platform subscription: grant the period's credits
 * (idempotent per Stripe invoice) and make sure the plan is current.
 */
export async function handleSubscriptionInvoicePaid(invoice: unknown): Promise<{ tenantId: string; granted: boolean } | null> {
  const inv = obj(invoice);
  const subscriptionId = invoiceSubscriptionId(inv);
  if (!subscriptionId) return null;
  const invoiceId = idOf(inv.id);
  if (!invoiceId) return null;

  let tenantId = await tenantFor({
    tenantHint: str(invoiceSubscriptionMetadata(inv).tenantId),
    subscriptionId,
    customerId: idOf(inv.customer),
  });
  let plan: PlanKey | null = null;
  if (stripeEnabled && stripe) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const synced = await syncSubscription(sub, tenantId);
    if (synced) {
      tenantId = synced.tenantId;
      plan = synced.plan;
    }
  }
  if (!tenantId) return null;
  if (!plan) {
    const r = await servicePool.query<{ plan: string }>(`SELECT plan FROM subscriptions WHERE tenant_id = $1`, [tenantId]);
    plan = normalizePlan(r.rows[0]?.plan);
  }
  if (plan === "starter") return { tenantId, granted: false };

  const granted = await withServiceTransaction((c) => grantPlanCredits(c, tenantId!, plan!, invoiceId));
  if (granted) {
    await servicePool.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'stripe', 'credits_granted', $2::jsonb)`, [
      tenantId,
      JSON.stringify({ plan, invoice: invoiceId }),
    ]);
    // Invoices that were waiting on credits get re-evaluated on the next run.
    await servicePool.query(
      `UPDATE invoices SET next_step_due_at = NULL WHERE tenant_id = $1 AND status = 'open' AND next_step_index < 9999 AND next_step_due_at > now()`,
      [tenantId],
    );
  }
  return { tenantId, granted };
}

/** Development-only: emulate a successful checkout + first paid invoice without Stripe. */
export async function applyMockUpgrade(tenantId: string, plan: PlanKey): Promise<void> {
  await withServiceTransaction(async (c) => {
    await c.query(
      `UPDATE subscriptions SET status = 'active', stripe_subscription_id = $2, stripe_customer_id = COALESCE(stripe_customer_id, $3),
              current_period_start = now(), current_period_end = now() + interval '1 month', cancel_at_period_end = FALSE, updated_at = now()
        WHERE tenant_id = $1`,
      [tenantId, `sub_mock_${tenantId.slice(0, 8)}`, `cus_mock_${tenantId.slice(0, 8)}`],
    );
    await setTenantPlan(c, tenantId, plan);
    await grantPlanCredits(c, tenantId, plan, `mock_${plan}_${new Date().toISOString().slice(0, 7)}`);
    await c.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'system', 'plan_changed', $2::jsonb)`, [
      tenantId,
      JSON.stringify({ to: plan, method: "mock_checkout" }),
    ]);
  });
}
