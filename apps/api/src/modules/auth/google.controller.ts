import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { servicePool, query } from "../../lib/db.js";
import {
  hashPassword, verifyPassword, createSession, setSessionCookie,
  clearSessionCookie, extractCookieToken, hashToken, generateToken,
  findUserByEmail, resolveUserMembership, provisionUserAndTenant, devLogin,
} from "../../lib/auth.js";
import { badRequest, unauthorized, notFound } from "../../lib/errors.js";
import { sendEmail, postmarkEnabled } from "../../lib/postmark.js";
import { passwordResetEmail, emailVerificationEmail, teamInviteEmail } from "../../lib/email-templates.js";
import { googleEnabled, googleExchangeCode, googleGetUserInfo, googleAuthorizeUrl } from "../../lib/oauth.js";

/**
 * Google OAuth authentication endpoints.
 */
export async function googleAuthRoutes(app: FastifyInstance) {
  // ─── GET /auth/google ────────────────────────────────────────────────
  // Initiate Google OAuth flow
  app.get("/auth/google", { config: { public: true } }, async (req, reply) => {
    if (!googleEnabled) {
      throw notFound("Google OAuth not configured");
    }

    // Generate state for CSRF protection
    const state = generateToken();
    const stateHash = hashToken(state);
    
    // Store state in oauth_states table (reuse existing mechanism)
    const client = await servicePool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO oauth_states (state_hash, tenant_id, provider, session_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          stateHash,
          null, // No tenant yet for Google OAuth
          "google",
          hashToken(state), // Session hash is the state itself for OAuth
          new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min TTL
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const googleUrl = googleAuthorizeUrl(state);
    return reply.redirect(googleUrl);
  });

  // ─── GET /auth/google/callback ───────────────────────────────────────
  // Handle Google OAuth callback
  app.get("/auth/google/callback", { config: { public: true } }, async (req, reply) => {
    const query = req.query as { code?: string; state?: string };
    const { code, state } = query;

    if (!code || !state) {
      throw badRequest("Missing code or state parameter");
    }

    if (!googleEnabled) {
      throw notFound("Google OAuth not configured");
    }

    // Verify state
    const client = await servicePool.connect();
    try {
      await client.query("BEGIN");
      
      // Check if state exists and is valid
      const stateResult = await client.query<{ state_hash: string }>(
        `SELECT state_hash FROM oauth_states 
         WHERE state_hash = $1 AND provider = $2 AND consumed_at IS NULL AND expires_at > now()`,
        [hashToken(state), "google"]
      );

      if (!stateResult.rows[0]) {
        await client.query("ROLLBACK");
        throw badRequest("Invalid or expired OAuth state");
      }

      // Mark state as used
      await client.query(
        `UPDATE oauth_states SET consumed_at = now() WHERE state_hash = $1`,
        [hashToken(state)]
      );

      // Exchange code for tokens
      const tokens = await googleExchangeCode(code);
      
      // Get user info from Google
      const googleUser = await googleGetUserInfo(tokens.accessToken);
      
      // Check if email is verified
      if (!googleUser.verified_email) {
        await client.query("ROLLBACK");
        throw badRequest("Google email not verified");
      }

      // Find or create user
      let user = await findUserByEmail(client, googleUser.email);
      let isNewUser = false;

      if (!user) {
        // Create new user
        isNewUser = true;
        const passwordHash = await hashToken(generateToken()); // Random password for OAuth users
        const userResult = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, display_name, status, email_verified_at)
           VALUES ($1, $2, $3, 'active', now())
           RETURNING id`,
          [googleUser.email, passwordHash, googleUser.name]
        );
        
        if (!userResult.rows[0]) {
          await client.query("ROLLBACK");
          throw badRequest("Failed to create user");
        }
        
        user = await findUserByEmail(client, googleUser.email);
        
        // Double-check that we got the user back
        if (!user) {
          await client.query("ROLLBACK");
          throw badRequest("Failed to retrieve created user");
        }
      } else if (user.status !== "active") {
        await client.query("ROLLBACK");
        throw badRequest("Account is not active");
      }

      // Provision tenant if needed (similar to dev-login)
      let membership = await resolveUserMembership(client, user.id);
      if (!membership) {
        // Create a tenant for this user
        const orgName = googleUser.name || googleUser.email.split("@")[0];
        const org = await provisionUserAndTenant(client, user.id, orgName);
        membership = { tenantId: org.tenantId, role: org.role, tenantSlug: org.tenantSlug };
      }

      // Create session
      const token = await createSession(client, user.id, req.ip, req.headers["user-agent"]);
      setSessionCookie(reply, token);
      
      await client.query("COMMIT");

      // Redirect to frontend
      const redirectUrl = isNewUser 
        ? `${config.webOrigin}/dashboard?welcome=true`
        : `${config.webOrigin}/dashboard`;
      
      return reply.redirect(redirectUrl);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}