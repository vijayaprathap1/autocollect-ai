import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { requireRole } from "../../plugins/tenant.js";
import { stripe, stripeEnabled, stripeOAuthRedirectUri } from "../../lib/stripe.js";
import { servicePool } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { decodeState, encodeState } from "../../lib/oauth.js";
import { extractCookieToken } from "../../lib/auth.js";
import { PLAN_KEYS, setTenantPlan, type PlanKey } from "../../lib/billing.js";
import { smsEnabled } from "../../lib/sms.js";
import { ingestStripeInvoice, markInvoicePaid, tenantByStripeAccount } from "./ingest.service.js";
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from "../../lib/webhook-events.js";

const MOCK_ACCOUNT_ID = "acct_dev_mock";

const PRICE_TO_PLAN: Record<string, PlanKey> = {
  [config.billingGrowthPriceId]: "growth",
  [config.billingProPriceId]: "pro",
  [config.billingAgencyPriceId]: "agency",
};

function planFromSession(session: { metadata?: Record<string, string> }): PlanKey | null {
  const plan = session.metadata?.plan;
  return plan && PLAN_KEYS.includes(plan as PlanKey) ? (plan as PlanKey) : null;
}

/** Resolve the plan from the purchased subscription's price (authoritative). */
async function planFromSubscription(subscriptionId: string): Promise<PlanKey | null> {
  if (!stripeEnabled) return null;
  try {
    const sub = await stripe!.subscriptions.retrieve(subscriptionId);
    const priceId = sub.items?.data?.[0]?.price?.id;
    return priceId ? (PRICE_TO_PLAN[priceId] ?? null) : null;
  } catch {
    return null;
  }
}

export async function stripeRoutes(app: FastifyInstance) {
  /**
   * List the tenant's connected integrations.
   */
  app.get("/integrations", async (req) => {
    const rows = await req.db.query<{
      id: string;
      source: string;
      status: string;
      created_at: string;
    }>(
      `SELECT id, source, status, created_at FROM integrations
        WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [req.user.tenantId],
    );
    return {
      integrations: rows.rows.map((r) => ({
        id: r.id,
        source: r.source,
        status: r.status,
        createdAt: r.created_at,
      })),
      sms: {
        enabled: smsEnabled,
        mock: !smsEnabled,
        fromNumber: config.twilioFromNumber ?? null,
      },
    };
  });

  /**
   * Begin Stripe Connect onboarding.
   * Returns `{ url }` to redirect the user to.
   */
  app.post(
    "/integrations/stripe/connect",
    { preHandler: requireRole("admin") },
    async (req) => {
      const sessionToken = extractCookieToken(req);
      if (!sessionToken) throw badRequest("Missing session cookie");
      const state = await encodeState(req.user.tenantId, "stripe", sessionToken);
      let url: string;

      if (stripeEnabled) {
        url = await stripe!.oauth.authorizeUrl({
          client_id: config.stripeConnectClientId,
          state,
          redirect_uri: stripeOAuthRedirectUri(),
          response_type: "code",
          scope: "read_write",
        });
      } else {
        // Stripe-mock mode: return a URL that resolves entirely within our app.
        url = `${config.appUrl}/integrations/stripe/callback?state=${encodeURIComponent(
          state,
        )}&code=dev_stripe_code`;
      }

      return { url };
    },
  );

  /**
   * Stripe Connect OAuth redirect target.
   * Exchanges the code, stores the connected account, redirects back to the SPA.
   */
  app.get(
    "/integrations/stripe/callback",
    { config: { public: true } },
    async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };

    if (q.error) {
      return reply.redirect(`${config.webOrigin}/settings?stripe=error`);
    }
    if (!q.code || !q.state) throw badRequest("Missing code or state");

    const sessionToken = extractCookieToken(req);
    if (!sessionToken) throw badRequest("Missing session cookie");
    const tenantId = await decodeState(q.state, "stripe", sessionToken);
    let stripeAccountId: string;

    if (stripeEnabled) {
      const token = await stripe!.oauth.token({
        grant_type: "authorization_code",
        code: q.code,
      });
      if (!token.stripe_user_id) throw badRequest("OAuth did not return an account");
      stripeAccountId = token.stripe_user_id;
    } else {
      if (q.code !== "dev_stripe_code") throw badRequest("Invalid dev OAuth code");
      stripeAccountId = MOCK_ACCOUNT_ID;
    }

    const client = await servicePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
      await client.query(
        `INSERT INTO integrations (tenant_id, source, status, credentials)
         VALUES ($1, 'stripe', 'active', $2::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          JSON.stringify({ stripe_account_id: stripeAccountId, connected_at: new Date().toISOString() }),
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return reply.redirect(`${config.webOrigin}/settings?stripe=connected`);
  });

  /**
   * Stripe Connect webhook receiver (public, signature-verified).
   * Routes to the owning tenant via `event.account`.
   */
  app.post(
    "/integrations/stripe/webhook",
    { config: { public: true } },
    async (req, reply) => {
      if (!stripeEnabled) throw notFound("Webhook endpoint disabled (stripe-mock mode)");
      if (!config.stripeWebhookSecret) throw badRequest("STRIPE_WEBHOOK_SECRET is not configured");
      const sig = (req.headers["stripe-signature"] as string) ?? "";
      if (!sig) throw badRequest("Missing stripe-signature");
      const payload = (req.rawBody as Buffer | undefined)?.toString("utf8") ?? "";
      let event: import("stripe").Stripe.Event;
      try {
        event = stripe!.webhooks.constructEvent(payload, sig, config.stripeWebhookSecret);
      } catch {
        throw badRequest("Invalid signature", "INVALID_SIGNATURE");
      }

      const accountId = (event as { account?: string }).account;

      // Platform subscription events (self-serve billing) have no `account`.
      // checkout.session.completed -> upgrade to Growth; subscription deleted -> Starter.
      if (!accountId && (event.type === "checkout.session.completed" || event.type === "customer.subscription.deleted")) {
        const session = (event.data.object as {
          metadata?: Record<string, string>;
          client_reference_id?: string | null;
          subscription?: string | null;
        }) ?? {};
        const tenantId = session.metadata?.tenantId ?? session.client_reference_id;
        if (tenantId) {
          const claimed = await claimWebhookEvent(event.id, "stripe", tenantId);
          if (claimed) {
            try {
            let plan: PlanKey | null = null;
            if (event.type === "checkout.session.completed") {
              plan = planFromSession(session);
              // No metadata.plan (older checkout or partial payload): derive from the price.
              if (plan === null && session.subscription) {
                plan = await planFromSubscription(session.subscription);
              }
            }
            plan = plan ?? "starter";
            if (PLAN_KEYS.includes(plan)) {
              const prev = await servicePool.query<{ plan: string }>(
                `SELECT plan FROM tenants WHERE id = $1`,
                [tenantId],
              );
              await setTenantPlan(servicePool, tenantId, plan);
              await servicePool.query(
                `INSERT INTO audit_log (tenant_id, actor, action, detail)
                 VALUES ($1, 'stripe', 'plan_changed', $2::jsonb)`,
                [tenantId, JSON.stringify({ from: prev.rows[0]?.plan ?? "starter", to: plan, method: event.type })],
              );
            }
              await completeWebhookEvent(event.id);
            } catch (err) {
              await failWebhookEvent(event.id, err).catch(() => {});
              throw err;
            }
          }
        }
        return reply.send({ received: true });
      }

      if (!accountId) throw badRequest("Missing event.account");

      const conn = await tenantByStripeAccount(accountId);
      if (!conn) return reply.send({ received: true, ignored: "unknown_account" });

      const inv = (event.data.object as {
        id?: string;
        status?: string;
        amount_due?: number;
        currency?: string;
        created?: number;
        customer?: string | null;
        customer_name?: string | null;
        customer_email?: string | null;
        hosted_invoice_url?: string | null;
        due_date?: number | null;
        period_start?: number | null;
        lines?: { data?: { description?: string | null; quantity?: number | null; amount?: number }[] };
      }) ?? {};

      const claimed = await claimWebhookEvent(event.id, "stripe", conn.tenantId);
      if (claimed) {
        try {
        if (event.type === "invoice.paid" && inv.id) {
          await markInvoicePaid(conn.tenantId, inv.id);
        } else if (event.type === "invoice.created" || event.type === "invoice.updated") {
          await ingestStripeInvoice(conn.tenantId, {
            id: inv.id ?? "",
            customer: inv.customer ?? null,
            customer_name: inv.customer_name,
            customer_email: inv.customer_email,
            amount_due: inv.amount_due ?? 0,
            currency: inv.currency ?? "usd",
            created: inv.created ?? Math.floor(Date.now() / 1000),
            status: inv.status ?? "open",
            hosted_invoice_url: inv.hosted_invoice_url,
            due_date: inv.due_date,
            period_start: inv.period_start,
            line_items: inv.lines?.data?.map((l) => ({
              description: l.description,
              quantity: l.quantity ?? 1,
              amount: l.amount,
            })),
          });
        }
          await completeWebhookEvent(event.id);
        } catch (err) {
          await failWebhookEvent(event.id, err).catch(() => {});
          throw err;
        }
      }

      return reply.send({ received: true });
    },
  );

  /**
   * Dev-only simulator: lets you exercise ingest without a real Stripe account.
   * Enabled only when Stripe keys are absent. Mirrors `stripe listen` in test mode.
   */
  app.post(
    "/integrations/stripe/dev-event",
    { config: { public: true } },
    async (req, reply) => {
      if (stripeEnabled) throw notFound("Dev-event endpoint disabled (real Stripe keys set)");
      const body = (req.body ?? {}) as {
        type?: string;
        account?: string;
        invoice?: {
          id?: string;
          amount_due?: number;
          currency?: string;
          customer?: string | null;
          customer_name?: string | null;
          customer_email?: string | null;
          due_days?: number;
          line_items?: { description?: string; quantity?: number; amount?: number }[];
        };
      };
      const account = body.account ?? MOCK_ACCOUNT_ID;
      const conn = await tenantByStripeAccount(account);
      if (!conn) throw notFound("No integration for that account (connect first)");

      const inv = body.invoice ?? {};
      const id = inv.id ?? `in_dev_${Math.random().toString(36).slice(2, 10)}`;
      const type = body.type ?? "invoice.created";

      if (type === "invoice.paid") {
        await markInvoicePaid(conn.tenantId, id);
        return reply.send({ received: true, action: "marked_paid", invoice: id });
      }

      const now = Date.now();
      const dueDays = inv.due_days ?? 3;
      const issue = now / 1000;
      await ingestStripeInvoice(conn.tenantId, {
        id,
        customer: inv.customer ?? "cus_dev_acme",
        customer_name: inv.customer_name ?? "Alex Client",
        customer_email: inv.customer_email ?? "client@example.com",
        amount_due: inv.amount_due ?? 120000,
        currency: inv.currency ?? "usd",
        created: Math.floor(issue),
        status: "open",
        hosted_invoice_url: "https://pay.stripe.com/dev-mock",
        due_date: Math.floor(issue) + dueDays * 86400,
        period_start: Math.floor(issue),
        line_items: inv.line_items ?? [
          { description: "Website design retainer", quantity: 1, amount: 120000 },
        ],
      });

      return reply.send({ received: true, action: "ingested", invoice: id });
    },
  );
}
