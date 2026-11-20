import type Stripe from "stripe";
import { config } from "../../config.js";
import { servicePool } from "../../lib/db.js";
import { stripe, stripeEnabled } from "../../lib/stripe.js";
import {
  PLAN_KEYS,
  refillCredits,
  setTenantPlan,
  upsertSubscription,
  type PlanKey,
} from "../../lib/billing.js";
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from "../../lib/webhook-events.js";

/**
 * Platform (self-serve) billing webhooks: events on our own Stripe account,
 * i.e. without `event.account`. Keeps tenant plan, the single subscription
 * row and the credit wallet in sync with Stripe.
 */

export const PLATFORM_BILLING_EVENTS = new Set([
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Map configured Stripe Price IDs to plans (ignores unset env vars). */
export function planForPrice(priceId: string | null | undefined): PlanKey | null {
  if (!priceId) return null;
  const entries: [string, PlanKey][] = [
    [config.billingGrowthPriceId, "growth"],
    [config.billingProPriceId, "pro"],
    [config.billingAgencyPriceId, "agency"],
  ];
  return entries.find(([id]) => id && id === priceId)?.[1] ?? null;
}

type Loose = Record<string, any>; // Stripe payload shapes vary across API versions.

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as Loose).id === "string") return (value as Loose).id;
  return null;
}

function toDate(unix: unknown): Date | null {
  return typeof unix === "number" ? new Date(unix * 1000) : null;
}

function planFromMetadata(meta: Loose | null | undefined): PlanKey | null {
  const plan = meta?.plan;
  return typeof plan === "string" && PLAN_KEYS.includes(plan as PlanKey) ? (plan as PlanKey) : null;
}

/** Subscription id an invoice belongs to (old and new API shapes). */
function invoiceSubscriptionId(inv: Loose): string | null {
  return idOf(inv.parent?.subscription_details?.subscription) ?? idOf(inv.subscription);
}

function invoiceSubscriptionMetadata(inv: Loose): Loose | null {
  return inv.parent?.subscription_details?.metadata ?? inv.subscription_details?.metadata ?? null;
}

async function tenantExists(tenantId: string | null | undefined): Promise<string | null> {
  if (!tenantId || !UUID_RE.test(tenantId)) return null;
  const r = await servicePool.query<{ id: string }>(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
  return r.rows[0]?.id ?? null;
}

async function tenantByCustomer(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const r = await servicePool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE stripe_customer_id = $1`,
    [customerId],
  );
  return r.rows[0]?.id ?? null;
}

async function tenantBySubscription(subscriptionId: string | null): Promise<string | null> {
  if (!subscriptionId) return null;
  const r = await servicePool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id = $1`,
    [subscriptionId],
  );
  return r.rows[0]?.tenant_id ?? null;
}

async function resolveTenant(event: Stripe.Event): Promise<string | null> {
  const obj = event.data.object as Loose;
  switch (event.type) {
    case "checkout.session.completed":
      return tenantExists(obj.metadata?.tenantId ?? obj.client_reference_id);
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return (
        (await tenantExists(obj.metadata?.tenantId)) ??
        (await tenantBySubscription(obj.id)) ??
        (await tenantByCustomer(idOf(obj.customer)))
      );
    case "invoice.paid":
    case "invoice.payment_failed":
      return (
        (await tenantByCustomer(idOf(obj.customer))) ??
        (await tenantBySubscription(invoiceSubscriptionId(obj))) ??
        (await tenantExists(invoiceSubscriptionMetadata(obj)?.tenantId))
      );
    default:
      return null;
  }
}

async function currentSubscription(tenantId: string): Promise<{ stripe_subscription_id: string | null; plan: string } | null> {
  const r = await servicePool.query<{ stripe_subscription_id: string | null; plan: string }>(
    `SELECT stripe_subscription_id, plan FROM subscriptions WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0] ?? null;
}

async function audit(tenantId: string, action: string, detail: Record<string, unknown>): Promise<void> {
  await servicePool
    .query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'stripe', $2, $3::jsonb)`,
      [tenantId, action, JSON.stringify(detail)],
    )
    .catch(() => {});
}

/** Run `fn` in a service-role transaction. */
async function tx<T>(fn: (db: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await servicePool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Apply a paid plan to a tenant: plan + limits, subscription row and an
 * immediate top-up to the plan allowance. Shared by the real webhook and the
 * mock checkout callback.
 */
export async function activatePlan(
  tenantId: string,
  plan: PlanKey,
  opts: {
    stripeSubscriptionId?: string | null;
    stripeCustomerId?: string | null;
    priceId?: string | null;
    status?: string;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    reason: string;
    referenceId?: string | null;
  },
): Promise<{ previousPlan: string; granted: number }> {
  return tx(async (db) => {
    const prev = await db.query<{ plan: string }>(`SELECT plan FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
    if (opts.stripeCustomerId) {
      await db.query(
        `UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS DISTINCT FROM $2`,
        [tenantId, opts.stripeCustomerId],
      );
    }
    await setTenantPlan(db, tenantId, plan);
    await upsertSubscription(db, tenantId, {
      plan,
      status: opts.status ?? "active",
      stripeSubscriptionId: opts.stripeSubscriptionId,
      priceId: opts.priceId,
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
    });
    const granted = await refillCredits(db, tenantId, plan, opts.reason, opts.referenceId);
    return { previousPlan: prev.rows[0]?.plan ?? "starter", granted };
  });
}

async function downgradeToStarter(tenantId: string, subscriptionId: string | null, status: string): Promise<void> {
  await tx(async (db) => {
    await setTenantPlan(db, tenantId, "starter");
    await upsertSubscription(db, tenantId, { plan: "starter", status, stripeSubscriptionId: subscriptionId });
  });
}

async function handleCheckoutCompleted(tenantId: string, session: Loose, eventId: string): Promise<void> {
  if (session.mode && session.mode !== "subscription") return;
  const subscriptionId = idOf(session.subscription);
  let plan = planFromMetadata(session.metadata);
  let priceId: string | null = null;
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;

  if (subscriptionId && stripeEnabled) {
    try {
      const sub = (await stripe!.subscriptions.retrieve(subscriptionId)) as unknown as Loose;
      const item = sub.items?.data?.[0];
      priceId = item?.price?.id ?? null;
      plan = planForPrice(priceId) ?? plan;
      periodStart = toDate(item?.current_period_start ?? sub.current_period_start);
      periodEnd = toDate(item?.current_period_end ?? sub.current_period_end);
    } catch {
      /* fall back to metadata */
    }
  }
  if (!plan || plan === "starter") {
    await audit(tenantId, "billing_checkout_unmapped_plan", { event: eventId, subscription: subscriptionId });
    return;
  }

  const previous = await currentSubscription(tenantId);
  const { previousPlan, granted } = await activatePlan(tenantId, plan, {
    stripeSubscriptionId: subscriptionId,
    stripeCustomerId: idOf(session.customer),
    priceId,
    periodStart,
    periodEnd,
    reason: "plan_activated",
    referenceId: subscriptionId ?? eventId,
  });
  await audit(tenantId, "plan_changed", { from: previousPlan, to: plan, method: "checkout", credits_granted: granted });

  // Never leave two live subscriptions: cancel the one this checkout replaced.
  const oldId = previous?.stripe_subscription_id;
  if (oldId && subscriptionId && oldId !== subscriptionId && stripeEnabled) {
    try {
      await stripe!.subscriptions.cancel(oldId, { prorate: true });
      await audit(tenantId, "subscription_replaced", { canceled: oldId, replacement: subscriptionId });
    } catch (err) {
      await audit(tenantId, "subscription_replace_failed", {
        canceled: oldId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function handleInvoicePaid(tenantId: string, inv: Loose): Promise<void> {
  const subscriptionId = invoiceSubscriptionId(inv);
  if (!subscriptionId) return; // one-off invoice, not a plan renewal

  const current = await currentSubscription(tenantId);
  if (current?.stripe_subscription_id && current.stripe_subscription_id !== subscriptionId) {
    // Invoice for a subscription we have since replaced: do not touch the plan.
    return;
  }

  const line = inv.lines?.data?.find((l: Loose) => l.pricing?.price_details?.price || l.price) ?? inv.lines?.data?.[0];
  const priceId = idOf(line?.pricing?.price_details?.price) ?? idOf(line?.price);
  const plan =
    planForPrice(priceId) ??
    (current && PLAN_KEYS.includes(current.plan as PlanKey) ? (current.plan as PlanKey) : null) ??
    planFromMetadata(invoiceSubscriptionMetadata(inv));
  if (!plan || plan === "starter") return;

  const { granted } = await activatePlan(tenantId, plan, {
    stripeSubscriptionId: subscriptionId,
    stripeCustomerId: idOf(inv.customer),
    priceId,
    periodStart: toDate(line?.period?.start),
    periodEnd: toDate(line?.period?.end),
    reason: "monthly_refill",
    referenceId: inv.id ?? null,
  });
  await audit(tenantId, "credits_refilled", { invoice: inv.id, plan, credits_granted: granted });
}

async function handlePaymentFailed(tenantId: string, inv: Loose): Promise<void> {
  const subscriptionId = invoiceSubscriptionId(inv);
  const current = await currentSubscription(tenantId);
  if (subscriptionId && current?.stripe_subscription_id && current.stripe_subscription_id !== subscriptionId) return;
  await servicePool.query(
    `UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE tenant_id = $1`,
    [tenantId],
  );
  await audit(tenantId, "subscription_payment_failed", {
    invoice: inv.id,
    attempt_count: inv.attempt_count ?? null,
    next_payment_attempt: inv.next_payment_attempt ?? null,
  });
}

async function handleSubscriptionUpdated(tenantId: string, sub: Loose): Promise<void> {
  const current = await currentSubscription(tenantId);
  const isCurrent = !current?.stripe_subscription_id || current.stripe_subscription_id === sub.id;
  const status: string = sub.status ?? "active";
  if (!isCurrent) return; // a replaced/old subscription changing state is irrelevant

  if (["canceled", "unpaid", "incomplete_expired"].includes(status)) {
    await downgradeToStarter(tenantId, sub.id, status === "canceled" ? "canceled" : status);
    await audit(tenantId, "plan_changed", { to: "starter", method: `subscription_${status}` });
    return;
  }

  const item = sub.items?.data?.[0];
  const priceId: string | null = item?.price?.id ?? null;
  const plan = planForPrice(priceId) ?? planFromMetadata(sub.metadata);
  if (!plan || plan === "starter") {
    await servicePool.query(
      `UPDATE subscriptions SET status = $2, updated_at = now() WHERE tenant_id = $1`,
      [tenantId, status],
    );
    return;
  }

  const { previousPlan, granted } = await activatePlan(tenantId, plan, {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: idOf(sub.customer),
    priceId,
    status,
    periodStart: toDate(item?.current_period_start ?? sub.current_period_start),
    periodEnd: toDate(item?.current_period_end ?? sub.current_period_end),
    reason: "plan_changed",
    referenceId: sub.id,
  });
  if (previousPlan !== plan) {
    await audit(tenantId, "plan_changed", { from: previousPlan, to: plan, method: "subscription_updated", credits_granted: granted });
  }
}

async function handleSubscriptionDeleted(tenantId: string, sub: Loose): Promise<void> {
  const current = await currentSubscription(tenantId);
  if (current?.stripe_subscription_id && current.stripe_subscription_id !== sub.id) {
    return; // the deleted subscription was already replaced by a newer one
  }
  await downgradeToStarter(tenantId, sub.id, "canceled");
  await audit(tenantId, "plan_changed", { from: current?.plan ?? null, to: "starter", method: "subscription_deleted" });
}

/** Handle a platform billing event idempotently. Unknown events are ignored. */
export async function handlePlatformBillingEvent(event: Stripe.Event): Promise<void> {
  if (!PLATFORM_BILLING_EVENTS.has(event.type)) return;
  const tenantId = await resolveTenant(event);
  if (!tenantId) return;

  if (!(await claimWebhookEvent(event.id, "stripe", tenantId))) return;
  try {
    const obj = event.data.object as Loose;
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(tenantId, obj, event.id);
        break;
      case "invoice.paid":
        await handleInvoicePaid(tenantId, obj);
        break;
      case "invoice.payment_failed":
        await handlePaymentFailed(tenantId, obj);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(tenantId, obj);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(tenantId, obj);
        break;
    }
    await completeWebhookEvent(event.id);
  } catch (err) {
    await failWebhookEvent(event.id, err).catch(() => {});
    throw err;
  }
}
