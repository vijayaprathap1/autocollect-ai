import type { FastifyInstance, FastifyReply } from "fastify";
import { config, isDevLike } from "../../config.js";
import { servicePool, withServiceTransaction } from "../../lib/db.js";
import {
  createSession,
  setSessionCookie,
  hashToken,
  generateToken,
  resolveUserMembership,
  provisionUserAndTenant,
  readCookie,
  setCookie,
} from "../../lib/auth.js";
import { stripe, stripeEnabled } from "../../lib/stripe.js";
import { issueVerificationToken, sendAccountEmail } from "../../lib/account-emails.js";
import { emailVerificationEmail } from "../../lib/email-templates.js";
import {
  backfillStripeInvoices,
  connectStripeAccount,
  linkStripeIdentity,
  StripeAccountInUseError,
  type StripeConnectCredentials,
} from "../integrations/stripe.controller.js";

const NONCE_COOKIE = "ac_stripe_nonce";
const STATE_TTL_MS = 15 * 60 * 1000;
const DEV_CODE = "dev_stripe_login";
const RATE_LIMIT = { max: 20, timeWindow: "1 minute" };

/** "Continue with Stripe" works when Stripe Connect is configured (or in dev, with a mock). */
export function stripeLoginEnabled(): boolean {
  return (stripeEnabled && Boolean(config.stripeConnectClientId)) || (!stripeEnabled && isDevLike);
}

export function stripeLoginRedirectUri(): string {
  return `${config.appUrl.replace(/\/$/, "")}/auth/stripe/callback`;
}

function webUrl(path: string): string {
  return `${config.webOrigin.split(",")[0].replace(/\/$/, "")}${path}`;
}

function fail(reply: FastifyReply, code: string) {
  setCookie(reply, NONCE_COOKIE, "", 0);
  return reply.redirect(webUrl(`/login?error=${encodeURIComponent(code)}`));
}

class OAuthFlowError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

type StripeProfile = { credentials: StripeConnectCredentials; email: string | null; name: string | null };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * "Continue with Stripe": sign in or sign up by connecting a Stripe account.
 *
 * Stripe's own Connect screen is the consent step ("Connect AutoCollect AI to
 * your Stripe account"); after it, the account's open invoices are imported and
 * kept in sync by the Connect webhook, exactly like Settings → Connect Stripe.
 *
 * Identity is the Stripe ACCOUNT id (acct_...), stored in user_identities.
 * Stripe does not guarantee the account email is verified, so:
 *  - the email never links to, or signs into, an existing AutoCollect user;
 *  - a new user created from it starts unverified and is sent a verification link.
 * Login CSRF is prevented the same way as Google: single-use state bound to an
 * HttpOnly nonce cookie in the initiating browser.
 */
export async function stripeLoginRoutes(app: FastifyInstance) {
  app.get("/auth/stripe", { config: { public: true, rateLimit: RATE_LIMIT } }, async (_req, reply) => {
    if (!stripeLoginEnabled()) return reply.redirect(webUrl("/login?error=stripe_unavailable"));
    const state = generateToken();
    const nonce = generateToken();
    await servicePool.query(
      `INSERT INTO oauth_states (state_hash, tenant_id, provider, session_hash, expires_at)
       VALUES ($1, NULL, 'stripe_login', $2, $3)`,
      [hashToken(state), hashToken(nonce), new Date(Date.now() + STATE_TTL_MS).toISOString()],
    );
    setCookie(reply, NONCE_COOKIE, nonce, STATE_TTL_MS / 1000);

    const url = stripeEnabled
      ? stripe!.oauth.authorizeUrl({
          client_id: config.stripeConnectClientId,
          response_type: "code",
          scope: "read_write",
          redirect_uri: stripeLoginRedirectUri(),
          state,
          // Existing Stripe users land on Stripe's sign-in form, not registration.
          stripe_landing: "login",
        })
      : `${stripeLoginRedirectUri()}?state=${encodeURIComponent(state)}&code=${DEV_CODE}`;
    return reply.redirect(url);
  });

  app.get("/auth/stripe/callback", { config: { public: true, rateLimit: RATE_LIMIT } }, async (req, reply) => {
    const q = req.query as {
      code?: string;
      state?: string;
      error?: string;
      dev_account?: string;
      dev_email?: string;
      dev_name?: string;
    };
    if (q.error) return fail(reply, q.error === "access_denied" ? "stripe_cancelled" : "stripe_failed");
    if (!stripeLoginEnabled()) return fail(reply, "stripe_unavailable");
    if (!q.code || !q.state) return fail(reply, "stripe_failed");

    const nonce = readCookie(req, NONCE_COOKIE);
    if (!nonce) return fail(reply, "stripe_state");
    const claimed = await servicePool.query(
      `UPDATE oauth_states SET consumed_at = now()
        WHERE state_hash = $1 AND provider = 'stripe_login' AND session_hash = $2
          AND consumed_at IS NULL AND expires_at > now()
        RETURNING id`,
      [hashToken(q.state), hashToken(nonce)],
    );
    if (!claimed.rowCount) return fail(reply, "stripe_state");
    setCookie(reply, NONCE_COOKIE, "", 0);

    // Network calls happen before (never inside) a DB transaction.
    let profile: StripeProfile;
    try {
      profile = await exchangeCode(q);
    } catch (err) {
      req.log.error({ err }, "stripe sign-in exchange failed");
      return fail(reply, "stripe_failed");
    }

    let result: { token: string; tenantId: string; userId: string; isNew: boolean; connected: boolean; verifyEmail: string | null };
    try {
      result = await withServiceTransaction(async (client) => {
        const acct = profile.credentials.stripe_account_id;
        const identity = await client.query<{ user_id: string }>(
          `SELECT user_id FROM user_identities WHERE provider = 'stripe' AND subject = $1 FOR UPDATE`,
          [acct],
        );
        // Workspace this Stripe account is currently connected to (if any).
        const connectedTo = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM integrations WHERE source = 'stripe' AND status = 'active' AND credentials->>'stripe_account_id' = $1`,
          [acct],
        );
        const accountTenant = connectedTo.rows[0]?.tenant_id ?? null;

        let userId: string;
        let isNew = false;
        let verifyEmail: string | null = null;

        if (identity.rows[0]) {
          // ── Returning user ─────────────────────────────────────────
          userId = identity.rows[0].user_id;
          const u = await client.query<{ status: string; is_super_admin: boolean }>(
            `SELECT status, is_super_admin FROM users WHERE id = $1 FOR UPDATE`,
            [userId],
          );
          if (u.rows[0]?.is_super_admin) throw new OAuthFlowError("admin_use_password");
          if (!u.rows[0] || u.rows[0].status === "suspended") throw new OAuthFlowError("account_suspended");
          await client.query(`UPDATE users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1`, [userId]);
        } else {
          // ── New user ───────────────────────────────────────────────
          // An account another workspace already uses can only be reached by a linked user.
          if (accountTenant) throw new OAuthFlowError("stripe_account_in_use");
          const email = profile.email?.toLowerCase().trim() ?? "";
          if (!EMAIL_RE.test(email)) throw new OAuthFlowError("stripe_no_email");
          const existing = await client.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
          // Never attach a Stripe account to an existing user by email alone.
          if (existing.rowCount) throw new OAuthFlowError("stripe_email_exists");

          const displayName = (profile.name || email.split("@")[0]).slice(0, 100);
          const created = await client.query<{ id: string }>(
            `INSERT INTO users (email, password_hash, display_name, status, email_verified_at, last_login_at)
             VALUES ($1, NULL, $2, 'active', NULL, now()) RETURNING id`,
            [email, displayName],
          );
          userId = created.rows[0].id;
          isNew = true;
          verifyEmail = email;
        }

        await linkStripeIdentity(client, userId, profile.credentials.stripe_account_id);
        await client.query(`UPDATE user_identities SET last_used_at = now() WHERE provider = 'stripe' AND subject = $1`, [acct]);

        // Prefer the workspace this Stripe account is connected to.
        let membership = await resolveUserMembership(client, userId, accountTenant);
        if (!membership) {
          const orgName = `${(profile.name || profile.email?.split("@")[0] || "My").slice(0, 80)}${profile.name ? "" : "'s workspace"}`;
          const org = await provisionUserAndTenant(client, userId, orgName, profile.email ?? orgName);
          membership = { tenantId: org.tenantId, role: org.role, tenantSlug: org.tenantSlug };
          isNew = true;
        }

        // (Re)connect the account to the workspace, unless that workspace
        // already syncs a different Stripe account.
        let connected = false;
        if (accountTenant) {
          // Already connected and syncing (to this workspace, or to another one
          // this user can reach by switching workspace): nothing to change.
          connected = false;
        } else {
          const other = await client.query(
            `SELECT 1 FROM integrations WHERE tenant_id = $1 AND source = 'stripe' AND status = 'active'
                AND credentials->>'stripe_account_id' <> $2`,
            [membership.tenantId, acct],
          );
          if (!other.rowCount) {
            await connectStripeAccount(client, membership.tenantId, profile.credentials);
            connected = true;
          }
        }

        await client.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, $3, $4::jsonb)`, [
          membership.tenantId,
          profile.email ?? acct,
          isNew ? "signup_stripe" : "login_stripe",
          JSON.stringify({ account: acct, livemode: profile.credentials.livemode ?? false }),
        ]);

        const token = await createSession(client, userId, {
          ip: req.ip,
          userAgent: req.headers["user-agent"],
          tenantId: membership.tenantId,
        });
        return { token, tenantId: membership.tenantId, userId, isNew, connected, verifyEmail };
      });
    } catch (err) {
      if (err instanceof OAuthFlowError) return fail(reply, err.code);
      if (err instanceof StripeAccountInUseError) return fail(reply, "stripe_account_in_use");
      req.log.error({ err }, "stripe sign-in failed");
      return fail(reply, "stripe_failed");
    }

    setSessionCookie(reply, result.token);

    if (result.verifyEmail) {
      const token = await issueVerificationToken(result.userId).catch(() => null);
      if (token) {
        await sendAccountEmail(
          req,
          result.verifyEmail,
          emailVerificationEmail(webUrl(`/verify-email?token=${token}`), profile.name || result.verifyEmail),
          "email-verification",
        );
      }
    }

    if (!result.connected) return reply.redirect(webUrl(result.isNew ? "/dashboard?welcome=1" : "/dashboard"));

    // Import open invoices within a time budget; the scheduler finishes large accounts.
    let imported = { imported: 0, failed: 0, done: false };
    try {
      imported = await backfillStripeInvoices(result.tenantId, 15_000);
    } catch (err) {
      req.log.error({ err, tenantId: result.tenantId }, "stripe initial import failed (will resume in background)");
    }
    const params = new URLSearchParams({ welcome: "stripe", imported: String(imported.imported) });
    if (imported.failed) params.set("failed", String(imported.failed));
    if (!imported.done) params.set("importing", "1");
    return reply.redirect(webUrl(`/dashboard?${params.toString()}`));
  });
}

/** Exchange the OAuth code for the connected account and read its profile. */
async function exchangeCode(q: { code?: string; dev_account?: string; dev_email?: string; dev_name?: string }): Promise<StripeProfile> {
  if (!stripeEnabled) {
    // Dev/test mock: no Stripe keys. Tests pick the account and email via query params.
    if (!isDevLike || q.code !== DEV_CODE) throw new Error("Invalid dev OAuth code");
    const account = q.dev_account && /^acct_[A-Za-z0-9_]{3,64}$/.test(q.dev_account) ? q.dev_account : "acct_dev_login";
    return {
      credentials: { stripe_account_id: account, livemode: false, connected_at: new Date().toISOString() },
      email: q.dev_email ?? `${account}@example.com`,
      name: q.dev_name ?? "Dev Stripe Business",
    };
  }

  const token = await stripe!.oauth.token({ grant_type: "authorization_code", code: q.code! });
  if (!token.stripe_user_id) throw new Error("OAuth did not return an account");
  const account = await stripe!.accounts.retrieve(token.stripe_user_id);
  const a = account as unknown as {
    email?: string | null;
    business_profile?: { name?: string | null } | null;
    settings?: { dashboard?: { display_name?: string | null } | null } | null;
  };
  return {
    credentials: {
      stripe_account_id: token.stripe_user_id,
      scope: token.scope,
      livemode: token.livemode,
      connected_at: new Date().toISOString(),
    },
    email: a.email ?? null,
    name: a.business_profile?.name || a.settings?.dashboard?.display_name || null,
  };
}
