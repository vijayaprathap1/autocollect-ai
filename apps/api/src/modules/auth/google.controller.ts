import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../../config.js";
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
import { googleEnabled, googleExchangeCode, googleGetUserInfo, googleAuthorizeUrl } from "../../lib/oauth.js";

const NONCE_COOKIE = "ac_google_nonce";
const STATE_TTL_MS = 15 * 60 * 1000;

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

/**
 * "Sign in with Google".
 *
 * Security properties:
 *  - Login CSRF: `state` is single-use AND bound to the initiating browser via
 *    an HttpOnly nonce cookie, so a victim can't be logged into an attacker's
 *    account by visiting a crafted callback URL.
 *  - Account pre-hijacking: if someone pre-registered this email with a
 *    password but never verified it, Google's verified email proves ownership,
 *    so that unverified password and any sessions are wiped.
 *  - Platform admins cannot use Google sign-in (separate admin audience).
 */
export async function googleAuthRoutes(app: FastifyInstance) {
  app.get("/auth/google", { config: { public: true, rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (_req, reply) => {
    if (!googleEnabled) return reply.redirect(webUrl("/login?error=google_unavailable"));
    const state = generateToken();
    const nonce = generateToken();
    await servicePool.query(
      `INSERT INTO oauth_states (state_hash, tenant_id, provider, session_hash, expires_at)
       VALUES ($1, NULL, 'google', $2, $3)`,
      [hashToken(state), hashToken(nonce), new Date(Date.now() + STATE_TTL_MS).toISOString()],
    );
    setCookie(reply, NONCE_COOKIE, nonce, STATE_TTL_MS / 1000);
    return reply.redirect(googleAuthorizeUrl(state));
  });

  app.get("/auth/google/callback", { config: { public: true, rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) return fail(reply, q.error === "access_denied" ? "google_cancelled" : "google_failed");
    if (!googleEnabled) return fail(reply, "google_unavailable");
    if (!q.code || !q.state) return fail(reply, "google_failed");

    const nonce = readCookie(req, NONCE_COOKIE);
    if (!nonce) return fail(reply, "google_state");
    const claimed = await servicePool.query(
      `UPDATE oauth_states SET consumed_at = now()
        WHERE state_hash = $1 AND provider = 'google' AND session_hash = $2
          AND consumed_at IS NULL AND expires_at > now()
        RETURNING id`,
      [hashToken(q.state), hashToken(nonce)],
    );
    if (!claimed.rowCount) return fail(reply, "google_state");
    setCookie(reply, NONCE_COOKIE, "", 0);

    // Network calls happen before (never inside) a DB transaction.
    let profile: { email: string; name: string };
    try {
      const tokens = await googleExchangeCode(q.code);
      const info = await googleGetUserInfo(tokens.accessToken);
      if (!info.email || !info.verified_email) return fail(reply, "google_unverified");
      profile = { email: info.email.toLowerCase().trim(), name: (info.name || info.email.split("@")[0]).slice(0, 100) };
    } catch (err) {
      req.log.error({ err }, "google oauth exchange failed");
      return fail(reply, "google_failed");
    }

    try {
      const result = await withServiceTransaction(async (client) => {
        const existing = await client.query<{
          id: string; status: string; is_super_admin: boolean; email_verified_at: string | null;
        }>(`SELECT id, status, is_super_admin, email_verified_at FROM users WHERE email = $1 FOR UPDATE`, [profile.email]);

        let userId: string;
        let isNew = false;
        const row = existing.rows[0];
        if (!row) {
          const created = await client.query<{ id: string }>(
            `INSERT INTO users (email, password_hash, display_name, status, email_verified_at, last_login_at)
             VALUES ($1, NULL, $2, 'active', now(), now()) RETURNING id`,
            [profile.email, profile.name],
          );
          userId = created.rows[0].id;
          isNew = true;
        } else {
          if (row.is_super_admin) throw new OAuthFlowError("admin_use_password");
          if (row.status === "suspended") throw new OAuthFlowError("account_suspended");
          userId = row.id;
          if (!row.email_verified_at || row.status === "pending") {
            // Pre-hijack defence: the unverified password was never proven to belong to this inbox.
            await client.query(
              `UPDATE users SET password_hash = NULL, status = 'active', email_verified_at = now(),
                                failed_login_count = 0, locked_until = NULL, updated_at = now()
                WHERE id = $1`,
              [userId],
            );
            await client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
            await client.query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [userId]);
          } else {
            await client.query(`UPDATE users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1`, [userId]);
          }
        }

        let membership = await resolveUserMembership(client, userId);
        if (!membership) {
          const org = await provisionUserAndTenant(client, userId, `${profile.name}'s workspace`, profile.email);
          membership = { tenantId: org.tenantId, role: org.role, tenantSlug: org.tenantSlug };
          isNew = true;
        }
        const token = await createSession(client, userId, {
          ip: req.ip,
          userAgent: req.headers["user-agent"],
          tenantId: membership.tenantId,
        });
        return { token, isNew };
      });

      setSessionCookie(reply, result.token);
      return reply.redirect(webUrl(result.isNew ? "/dashboard?welcome=1" : "/dashboard"));
    } catch (err) {
      if (err instanceof OAuthFlowError) return fail(reply, err.code);
      req.log.error({ err }, "google sign-in failed");
      return fail(reply, "google_failed");
    }
  });
}
