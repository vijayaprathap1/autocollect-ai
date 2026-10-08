/**
 * Stripe webhook handling through the REAL signature-verification path
 * (stripe.webhooks.constructEvent), with two endpoint secrets configured the
 * way production needs them: one for Connect events, one for platform billing.
 * No network calls are made.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";

const CONNECT_SECRET = "whsec_connect_test_secret";
const BILLING_SECRET = "whsec_billing_test_secret";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy_for_signature_tests";
process.env.STRIPE_CONNECT_CLIENT_ID = "ca_test";
process.env.STRIPE_WEBHOOK_SECRET = CONNECT_SECRET;
process.env.STRIPE_BILLING_WEBHOOK_SECRET = BILLING_SECRET;
process.env.BILLING_GROWTH_PRICE_ID = "price_growth_test";

const d = process.env.DATABASE_URL ? describe : describe.skip;
const stripe = new Stripe("sk_test_dummy_for_signature_tests");
const run = Date.now().toString(36);

type App = ReturnType<typeof import("../../src/app.js").buildApp>;
let app: App;
let db: typeof import("../../src/lib/db.js");
let tenantId = "";
const account = `acct_test_${run}`;

async function send(event: Record<string, unknown>, secret: string, signature?: string) {
  const payload = JSON.stringify(event);
  const header = signature ?? stripe.webhooks.generateTestHeaderString({ payload, secret });
  const res = await app.inject({
    method: "POST",
    url: "/integrations/stripe/webhook",
    payload,
    headers: { "content-type": "application/json", "stripe-signature": header },
  });
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") as Record<string, unknown> };
}

const invoiceEvent = (id: string, type: string, status: string, extra: Record<string, unknown> = {}) => ({
  id: `evt_${id}_${type}_${run}`,
  type,
  account,
  data: {
    object: {
      id,
      object: "invoice",
      status,
      amount_due: 50000,
      amount_remaining: status === "paid" ? 0 : 50000,
      currency: "usd",
      created: Math.floor(Date.now() / 1000),
      due_date: Math.floor(Date.now() / 1000) + 5 * 86400,
      customer: `cus_${run}`,
      customer_email: `billing-${run}@customer.example`,
      customer_name: "Customer Inc",
      hosted_invoice_url: "https://invoice.stripe.com/i/test",
      lines: { data: [{ description: "Consulting", quantity: 1, amount: 50000 }] },
      ...extra,
    },
  },
});

d("Stripe webhooks (signed)", () => {
  beforeAll(async () => {
    const { migrate } = await import("../../src/scripts/migrate.js");
    await migrate();
    db = await import("../../src/lib/db.js");
    const { provisionUserAndTenant } = await import("../../src/lib/auth.js");
    tenantId = await db.withServiceTransaction(async (c) => {
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, status, email_verified_at) VALUES ($1, NULL, 'Hook', 'active', now()) RETURNING id`,
        [`hooks-${run}@example.com`],
      );
      const org = await provisionUserAndTenant(c, u.rows[0].id, "Hook Co");
      await c.query(
        `INSERT INTO integrations (tenant_id, source, status, credentials) VALUES ($1, 'stripe', 'active', $2::jsonb)`,
        [org.tenantId, JSON.stringify({ stripe_account_id: account })],
      );
      return org.tenantId;
    });
    const mod = await import("../../src/app.js");
    app = mod.buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.closeDb();
  });

  it("rejects forged signatures", async () => {
    const res = await send(invoiceEvent("in_forged", "invoice.finalized", "open"), "whsec_attacker");
    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe("INVALID_SIGNATURE");
  });

  it("ingests a finalized invoice from a connected account and closes it on payment", async () => {
    const id = `in_hook_${run}`;
    expect((await send(invoiceEvent(id, "invoice.finalized", "open"), CONNECT_SECRET)).status).toBe(200);
    const row = await db.servicePool.query<{ status: string; amount_due: number }>(
      `SELECT status, amount_due FROM invoices WHERE tenant_id = $1 AND external_id = $2`,
      [tenantId, id],
    );
    expect(row.rows[0]).toEqual({ status: "open", amount_due: 50000 });

    expect((await send(invoiceEvent(id, "invoice.paid", "paid"), CONNECT_SECRET)).status).toBe(200);
    // A late, out-of-order "updated/open" must not reopen a paid invoice.
    expect((await send(invoiceEvent(id, "invoice.updated", "open"), CONNECT_SECRET)).status).toBe(200);
    const after = await db.servicePool.query<{ status: string }>(`SELECT status FROM invoices WHERE tenant_id = $1 AND external_id = $2`, [tenantId, id]);
    expect(after.rows[0].status).toBe("paid");
  });

  it("is idempotent for replayed events", async () => {
    const ev = invoiceEvent(`in_replay_${run}`, "invoice.finalized", "open");
    expect((await send(ev, CONNECT_SECRET)).body).toEqual({ received: true });
    expect((await send(ev, CONNECT_SECRET)).body).toEqual({ received: true, duplicate: true });
  });

  it("acknowledges irrelevant events with 200 so Stripe never disables the endpoint", async () => {
    const res = await send({ id: `evt_misc_${run}`, type: "charge.refunded", data: { object: {} } }, BILLING_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe("charge.refunded");
    const unknownAccount = await send({ ...invoiceEvent("in_x", "invoice.finalized", "open"), account: "acct_unknown" }, CONNECT_SECRET);
    expect(unknownAccount.body.ignored).toBe("unknown_account");
  });

  it("syncs platform subscriptions signed with the billing endpoint's secret", async () => {
    const sub = {
      id: `sub_${run}`,
      object: "subscription",
      status: "active",
      customer: `cus_platform_${run}`,
      cancel_at_period_end: false,
      metadata: { tenantId },
      items: { data: [{ price: { id: "price_growth_test" }, current_period_start: 1_790_000_000, current_period_end: 1_792_600_000 }] },
    };
    const res = await send({ id: `evt_sub_${run}`, type: "customer.subscription.updated", data: { object: sub } }, BILLING_SECRET);
    expect(res.status).toBe(200);
    const t = await db.servicePool.query<{ plan: string; seat_limit: number | null }>(`SELECT plan, seat_limit FROM tenants WHERE id = $1`, [tenantId]);
    expect(t.rows[0]).toEqual({ plan: "growth", seat_limit: 3 });
    const s = await db.servicePool.query<{ stripe_customer_id: string; current_period_end: string }>(
      `SELECT stripe_customer_id, current_period_end FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(s.rows[0].stripe_customer_id).toBe(`cus_platform_${run}`);
    expect(s.rows[0].current_period_end).not.toBeNull();

    const cancelled = await send(
      { id: `evt_sub_del_${run}`, type: "customer.subscription.deleted", data: { object: { ...sub, status: "canceled" } } },
      BILLING_SECRET,
    );
    expect(cancelled.status).toBe(200);
    const t2 = await db.servicePool.query<{ plan: string }>(`SELECT plan FROM tenants WHERE id = $1`, [tenantId]);
    expect(t2.rows[0].plan).toBe("starter");
  });

  it("marks the integration disconnected when the account deauthorizes us", async () => {
    const res = await send({ id: `evt_deauth_${run}`, type: "account.application.deauthorized", account, data: { object: {} } }, CONNECT_SECRET);
    expect(res.status).toBe(200);
    const r = await db.servicePool.query<{ status: string }>(`SELECT status FROM integrations WHERE tenant_id = $1 AND source = 'stripe'`, [tenantId]);
    expect(r.rows[0].status).toBe("disconnected");
  });
});
