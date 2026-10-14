import type { FastifyInstance, FastifyReply } from "fastify";
import type Stripe from "stripe";
import { config, isDevLike } from "../../config.js";
import { requireRole } from "../../plugins/tenant.js";
import { stripe, stripeEnabled, stripeOAuthRedirectUri, constructWebhookEvent } from "../../lib/stripe.js";
import { servicePool, withServiceTransaction } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { decodeState, encodeState } from "../../lib/oauth.js";
import { extractCookieToken } from "../../lib/auth.js";
import { smsEnabled } from "../../lib/sms.js";
import { handleCheckoutCompleted, handleSubscriptionInvoicePaid, invoiceSubscriptionId, syncSubscription } from "../../lib/subscriptions.js";
import {
  ingestStripeInvoice,
  markInvoicePaid,
  markInvoicePaidById,
  recordPaymentFailure,
  tenantByStripeAccount,
  type StripeInvoiceLike,
} from "./ingest.service.js";
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from "../../lib/webhook-events.js";

const MOCK_ACCOUNT_ID = "acct_dev_mock";

function webUrl(path: string): string {
  return `${config.webOrigin.split(",")[0].replace(/\/$/, "")}${path}`;
}

function settingsRedirect(reply: FastifyReply, params: Record<string, string>) {
  return reply.redirect(webUrl(`/settings?tab=integrations&${new URLSearchParams(params).toString()}`));
}

/** Normalise a Stripe Invoice object (expanded or not) for ingest. */
export function toInvoiceLike(inv: Stripe.Invoice | Record<string, unknown>): StripeInvoiceLike {
  const i = inv as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cust = i.customer && typeof i.customer === "object" && !i.customer.deleted ? i.customer : null;
  return {
    id: i.id,
    number: i.number ?? null,
    customer: cust?.id ?? (typeof i.customer === "string" ? i.customer : null),
    customer_name: cust?.name ?? i.customer_name ?? null,
    customer_email: cust?.email ?? i.customer_email ?? null,
    customer_phone: cust?.phone ?? i.customer_phone ?? null,
    amount_due: i.amount_due ?? 0,
    amount_remaining: i.amount_remaining ?? null,
    currency: i.currency ?? "usd",
    created: i.created ?? Math.floor(Date.now() / 1000),
    status: i.status ?? "open",
    hosted_invoice_url: i.hosted_invoice_url ?? null,
    due_date: i.due_date ?? null,
    period_start: i.period_start ?? null,
    line_items: (i.lines?.data ?? []).map((l: Record<string, any>) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      description: l.description ?? null,
      quantity: l.quantity ?? 1,
      amount: l.amount ?? 0,
    })),
  };
}

/**
 * Import the connected account's OPEN invoices, resumably: progress is stored
 * as a cursor in integrations.settings, so a large account is imported across
 * several runs (callback + scheduler) without hitting request timeouts.
 */
export async function backfillStripeInvoices(tenantId: string, budgetMs: number): Promise<{ imported: number; failed: number; done: boolean }> {
  const out = { imported: 0, failed: 0, done: false };
  const row = await servicePool.query<{ id: string; account: string; cursor: string | null; completed: string | null }>(
    `SELECT id, credentials->>'stripe_account_id' AS account, settings->>'backfill_cursor' AS cursor,
            historical_sync_completed_at AS completed
       FROM integrations WHERE tenant_id = $1 AND source = 'stripe' AND status = 'active'`,
    [tenantId],
  );
  const integ = row.rows[0];
  if (!integ || integ.completed) return { ...out, done: true };
  if (!stripeEnabled || !stripe || integ.account === MOCK_ACCOUNT_ID) {
    await servicePool.query(`UPDATE integrations SET historical_sync_completed_at = now() WHERE id = $1`, [integ.id]);
    return { ...out, done: true };
  }

  const started = Date.now();
  let cursor = integ.cursor ?? undefined;
  while (Date.now() - started < budgetMs) {
    const page = await stripe.invoices.list(
      { limit: 100, status: "open", starting_after: cursor, expand: ["data.customer"] },
      { stripeAccount: integ.account },
    );
    for (const inv of page.data) {
      try {
        await ingestStripeInvoice(tenantId, toInvoiceLike(inv));
        out.imported += 1;
      } catch {
        out.failed += 1; // e.g. plan limit — keep going with the rest
      }
    }
    cursor = page.data.length ? page.data[page.data.length - 1].id : cursor;
    if (!page.has_more || page.data.length === 0) {
      out.done = true;
      break;
    }
    await servicePool.query(
      `UPDATE integrations SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('backfill_cursor', $2::text) WHERE id = $1`,
      [integ.id, cursor],
    );
  }
  if (out.done) {
    await servicePool.query(
      `UPDATE integrations SET historical_sync_completed_at = now(), settings = COALESCE(settings, '{}'::jsonb) - 'backfill_cursor' WHERE id = $1`,
      [integ.id],
    );
  }
  await servicePool
    .query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'stripe', 'stripe_historical_sync', $2::jsonb)`, [
      tenantId,
      JSON.stringify(out),
    ])
    .catch(() => {});
  return out;
}

/** Scheduler/cron hook: continue any unfinished Stripe imports. */
export async function resumeStripeBackfills(budgetMs = 20_000): Promise<{ tenants: number }> {
  const pending = await servicePool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM integrations
      WHERE source = 'stripe' AND status = 'active' AND historical_sync_completed_at IS NULL
      ORDER BY created_at LIMIT 5`,
  );
  const started = Date.now();
  for (const p of pending.rows) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 1000) break;
    await backfillStripeInvoices(p.tenant_id, left).catch(() => {});
  }
  return { tenants: pending.rowCount ?? 0 };
}

export async function stripeRoutes(app: FastifyInstance) {
  /** The tenant's integrations + SMS availability. */
  app.get("/integrations", async (req) => {
    const rows = await req.db.query<{
      id: string; source: string; status: string; created_at: string; credentials: Record<string, unknown>;
      historical_sync_completed_at: string | null; settings: Record<string, unknown> | null;
    }>(
      `SELECT id, source, status, created_at, credentials, historical_sync_completed_at, settings
         FROM integrations WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [req.user.tenantId],
    );
    return {
      integrations: rows.rows.map((r) => ({
        id: r.id,
        source: r.source,
        status: r.status,
        createdAt: r.created_at,
        accountId: r.source === "stripe" ? ((r.credentials?.stripe_account_id as string) ?? null) : null,
        livemode: r.source === "stripe" ? Boolean(r.credentials?.livemode) : null,
        importComplete: r.source === "stripe" ? Boolean(r.historical_sync_completed_at) : null,
        lastSyncAt: (r.settings?.last_sync_at as string | undefined) ?? null,
      })),
      sms: { enabled: smsEnabled, mock: !smsEnabled, fromNumber: config.twilioFromNumber || null },
      stripe: { mode: stripeEnabled ? (config.stripeSecretKey.startsWith("sk_live") ? "live" : "test") : "mock" },
    };
  });

  /** Begin Stripe Connect (OAuth). Returns `{ url }` to redirect the browser to. */
  app.post("/integrations/stripe/connect", { preHandler: requireRole("admin") }, async (req) => {
    const sessionToken = extractCookieToken(req);
    if (!sessionToken) throw badRequest("Missing session cookie");
    if (!stripeEnabled && !isDevLike) throw badRequest("Stripe is not configured on this server", "STRIPE_NOT_CONFIGURED");
    if (stripeEnabled && !config.stripeConnectClientId) throw badRequest("STRIPE_CONNECT_CLIENT_ID is not configured", "STRIPE_NOT_CONFIGURED");
    const state = await encodeState(req.user.tenantId, "stripe", sessionToken);
    const url = stripeEnabled
      ? stripe!.oauth.authorizeUrl({
          client_id: config.stripeConnectClientId,
          state,
          redirect_uri: stripeOAuthRedirectUri(),
          response_type: "code",
          scope: "read_write",
        })
      : `${config.appUrl}/integrations/stripe/callback?state=${encodeURIComponent(state)}&code=dev_stripe_code`;
    return { url };
  });

  /** Stripe Connect OAuth redirect target. Always ends on the settings page. */
  app.get("/integrations/stripe/callback", { config: { public: true } }, async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (q.error) return settingsRedirect(reply, { stripe: "error", reason: q.error === "access_denied" ? "cancelled" : "denied" });
    if (!q.code || !q.state) return settingsRedirect(reply, { stripe: "error", reason: "invalid_request" });

    const sessionToken = extractCookieToken(req);
    if (!sessionToken) return settingsRedirect(reply, { stripe: "error", reason: "signed_out" });

    let tenantId: string;
    try {
      tenantId = await decodeState(q.state, "stripe", sessionToken);
    } catch {
      return settingsRedirect(reply, { stripe: "error", reason: "expired" });
    }

    let credentials: { stripe_account_id: string; scope?: string; livemode?: boolean; connected_at: string };
    try {
      if (stripeEnabled) {
        const token = await stripe!.oauth.token({ grant_type: "authorization_code", code: q.code });
        if (!token.stripe_user_id) throw new Error("OAuth did not return an account");
        // With Connect + the platform key we act via the Stripe-Account header;
        // the connected account's own OAuth tokens are not needed, so not stored.
        credentials = {
          stripe_account_id: token.stripe_user_id,
          scope: token.scope,
          livemode: token.livemode,
          connected_at: new Date().toISOString(),
        };
      } else {
        if (!isDevLike || q.code !== "dev_stripe_code") throw new Error("Invalid dev OAuth code");
        credentials = { stripe_account_id: MOCK_ACCOUNT_ID, livemode: false, connected_at: new Date().toISOString() };
      }
    } catch (err) {
      req.log.error({ err }, "stripe connect token exchange failed");
      return settingsRedirect(reply, { stripe: "error", reason: "exchange_failed" });
    }

    const owner = await servicePool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM integrations WHERE source = 'stripe' AND status = 'active'
          AND credentials->>'stripe_account_id' = $1 AND tenant_id <> $2`,
      [credentials.stripe_account_id, tenantId],
    );
    if (owner.rows.length && credentials.stripe_account_id !== MOCK_ACCOUNT_ID) {
      return settingsRedirect(reply, { stripe: "error", reason: "account_in_use" });
    }
    if (owner.rows.length) {
      // Dev convenience: the shared mock account moves to the latest workspace.
      await servicePool.query(
        `UPDATE integrations SET status = 'disconnected' WHERE source = 'stripe' AND credentials->>'stripe_account_id' = $1 AND tenant_id <> $2`,
        [MOCK_ACCOUNT_ID, tenantId],
      );
    }

    await withServiceTransaction(async (c) => {
      await c.query(
        `INSERT INTO integrations (tenant_id, source, status, credentials, settings)
         VALUES ($1, 'stripe', 'active', $2::jsonb, '{}'::jsonb)
         ON CONFLICT (tenant_id, source) DO UPDATE
           SET status = 'active', credentials = EXCLUDED.credentials, historical_sync_completed_at = NULL,
               settings = COALESCE(integrations.settings, '{}'::jsonb) - 'backfill_cursor', updated_at = now()`,
        [tenantId, JSON.stringify(credentials)],
      );
      await c.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'stripe', 'stripe_connected', $2::jsonb)`, [
        tenantId,
        JSON.stringify({ account: credentials.stripe_account_id, livemode: credentials.livemode ?? false }),
      ]);
    });

    // Import open invoices within a time budget; the scheduler finishes big accounts.
    let result = { imported: 0, failed: 0, done: false };
    try {
      result = await backfillStripeInvoices(tenantId, 15_000);
    } catch (err) {
      req.log.error({ err, tenantId }, "stripe initial import failed (will resume in background)");
    }
    return settingsRedirect(reply, {
      stripe: "connected",
      imported: String(result.imported),
      ...(result.failed ? { failed: String(result.failed) } : {}),
      ...(result.done ? {} : { importing: "1" }),
    });
  });

  /** Disconnect Stripe. Existing invoices stay; they stop syncing. */
  app.post("/integrations/stripe/disconnect", { preHandler: requireRole("admin") }, async (req) => {
    const row = await req.db.query<{ account: string | null }>(
      `SELECT credentials->>'stripe_account_id' AS account FROM integrations WHERE tenant_id = $1 AND source = 'stripe' AND status = 'active'`,
      [req.user.tenantId],
    );
    const account = row.rows[0]?.account;
    if (!account) throw notFound("Stripe is not connected");
    if (stripeEnabled && account !== MOCK_ACCOUNT_ID) {
      await stripe!.oauth
        .deauthorize({ client_id: config.stripeConnectClientId, stripe_user_id: account })
        .catch((err: unknown) => req.log.warn({ err }, "stripe deauthorize failed (continuing)"));
    }
    await req.db.query(`UPDATE integrations SET status = 'disconnected', updated_at = now() WHERE tenant_id = $1 AND source = 'stripe'`, [
      req.user.tenantId,
    ]);
    await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'stripe_disconnected', $3::jsonb)`, [
      req.user.tenantId,
      req.user.email,
      JSON.stringify({ account }),
    ]);
    return { ok: true };
  });

  /**
   * Stripe webhook receiver (public, signature-verified) for BOTH:
   *  - Connect events from customers' accounts (event.account set): invoice sync
   *  - platform events (no account): our own subscription billing
   * Unknown or irrelevant events get 200 so Stripe doesn't retry/disable the endpoint.
   */
  app.post("/integrations/stripe/webhook", { config: { public: true, rawBody: true, rateLimit: false } }, async (req, reply) => {
    if (!stripeEnabled) throw notFound("Webhook endpoint disabled (Stripe not configured)");
    if (!config.stripeWebhookSecrets.length) throw badRequest("STRIPE_WEBHOOK_SECRET is not configured", "WEBHOOK_NOT_CONFIGURED");
    const sig = (req.headers["stripe-signature"] as string) ?? "";
    if (!sig) throw badRequest("Missing stripe-signature", "INVALID_SIGNATURE");
    const raw = (req as { rawBody?: Buffer | string }).rawBody;
    if (!raw) throw badRequest("Missing body", "INVALID_SIGNATURE");

    let event: Stripe.Event;
    try {
      event = constructWebhookEvent(raw, sig);
    } catch {
      throw badRequest("Invalid signature", "INVALID_SIGNATURE");
    }

    const accountId = (event as { account?: string }).account ?? null;
    const object = event.data.object as unknown as Record<string, unknown>;

    // ── Platform (our billing) events ──────────────────────────────────
    if (!accountId) {
      const relevant = [
        "checkout.session.completed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "invoice.paid",
        "invoice.payment_failed",
      ];
      if (!relevant.includes(event.type)) return reply.send({ received: true, ignored: event.type });
      if (!(await claimWebhookEvent(event.id, "stripe"))) return reply.send({ received: true, duplicate: true });
      try {
        switch (event.type) {
          case "checkout.session.completed":
            await handleCheckoutCompleted(object);
            break;
          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted":
            await syncSubscription(object);
            break;
          case "invoice.paid":
            if (invoiceSubscriptionId(object)) await handleSubscriptionInvoicePaid(object);
            break;
          case "invoice.payment_failed": {
            const subId = invoiceSubscriptionId(object);
            if (subId && stripe) await syncSubscription(await stripe.subscriptions.retrieve(subId));
            break;
          }
        }
        await completeWebhookEvent(event.id);
      } catch (err) {
        await failWebhookEvent(event.id, err).catch(() => {});
        throw err; // 5xx -> Stripe retries with backoff
      }
      return reply.send({ received: true });
    }

    // ── Connect events (customer's Stripe account) ─────────────────────
    if (event.type === "account.application.deauthorized") {
      await servicePool.query(
        `UPDATE integrations SET status = 'disconnected', updated_at = now()
          WHERE source = 'stripe' AND credentials->>'stripe_account_id' = $1`,
        [accountId],
      );
      return reply.send({ received: true });
    }

    const conn = await tenantByStripeAccount(accountId);
    if (!conn) return reply.send({ received: true, ignored: "unknown_account" });

    const handled = [
      "invoice.finalized",
      "invoice.updated",
      "invoice.voided",
      "invoice.marked_uncollectible",
      "invoice.paid",
      "invoice.payment_failed",
      "checkout.session.completed",
    ];
    if (!handled.includes(event.type)) return reply.send({ received: true, ignored: event.type });
    if (!(await claimWebhookEvent(event.id, "stripe", conn.tenantId))) return reply.send({ received: true, duplicate: true });

    try {
      switch (event.type) {
        case "invoice.paid":
          if (object.id) await markInvoicePaid(conn.tenantId, String(object.id));
          break;
        case "invoice.finalized":
        case "invoice.updated":
        case "invoice.voided":
        case "invoice.marked_uncollectible":
          if (object.id) await ingestStripeInvoice(conn.tenantId, toInvoiceLike(object));
          break;
        case "invoice.payment_failed": {
          const err = (object.last_payment_error ?? null) as { message?: string; code?: string } | null;
          if (object.id) await recordPaymentFailure(conn.tenantId, String(object.id), err?.message ?? "Payment failed", err?.code ?? "payment_failed");
          break;
        }
        case "checkout.session.completed": {
          // A customer paid one of our Payment Links (CSV/QBO invoices).
          if (object.payment_status !== "paid" || !object.payment_link) break;
          let invoiceId = (object.metadata as Record<string, string> | null)?.autocollect_invoice_id;
          if (!invoiceId && stripe) {
            const link = await stripe.paymentLinks.retrieve(String(object.payment_link), {}, { stripeAccount: accountId });
            invoiceId = link.metadata?.autocollect_invoice_id;
          }
          if (invoiceId) await markInvoicePaidById(conn.tenantId, invoiceId);
          break;
        }
      }
      await completeWebhookEvent(event.id);
    } catch (err) {
      await failWebhookEvent(event.id, err).catch(() => {});
      throw err;
    }
    return reply.send({ received: true });
  });

  /**
   * Development-only simulator (mirrors `stripe trigger`). Disabled when real
   * Stripe keys are set or outside development/test.
   */
  app.post("/integrations/stripe/dev-event", { preHandler: requireRole("admin") }, async (req, reply) => {
    if (stripeEnabled || !isDevLike) throw notFound("Route not found");
    const body = (req.body ?? {}) as {
      type?: string;
      invoice?: {
        id?: string; amount_due?: number; currency?: string; customer?: string | null; customer_name?: string | null;
        customer_email?: string | null; due_days?: number; failure_reason?: string; failure_code?: string;
        line_items?: { description?: string; quantity?: number; amount?: number }[];
      };
    };
    const tenantId = req.user.tenantId;
    const inv = body.invoice ?? {};
    const id = inv.id ?? `in_dev_${Math.random().toString(36).slice(2, 10)}`;
    const type = body.type ?? "invoice.finalized";

    if (type === "invoice.paid") {
      await markInvoicePaid(tenantId, id);
      return reply.send({ received: true, action: "marked_paid", invoice: id });
    }
    if (type === "invoice.payment_failed") {
      await recordPaymentFailure(tenantId, id, inv.failure_reason ?? "Payment failed", inv.failure_code ?? "payment_failed");
      return reply.send({ received: true, action: "payment_failed", invoice: id });
    }
    const now = Math.floor(Date.now() / 1000);
    await ingestStripeInvoice(tenantId, {
      id,
      customer: inv.customer ?? "cus_dev_acme",
      customer_name: inv.customer_name ?? "Alex Client",
      customer_email: inv.customer_email ?? "client@example.com",
      amount_due: inv.amount_due ?? 120000,
      currency: inv.currency ?? "usd",
      created: now,
      status: "open",
      hosted_invoice_url: "https://pay.stripe.com/dev-mock",
      due_date: now + (inv.due_days ?? 3) * 86400,
      period_start: now,
      line_items: inv.line_items ?? [{ description: "Website design retainer", quantity: 1, amount: 120000 }],
    });
    return reply.send({ received: true, action: "ingested", invoice: id });
  });
}
