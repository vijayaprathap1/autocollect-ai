import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { config } from "../../config.js";
import { servicePool, query } from "../../lib/db.js";
import {
  hashPassword, verifyPassword, createSession, setSessionCookie,
  clearSessionCookie, extractCookieToken, hashToken, generateToken,
  findUserByEmail, resolveUserMembership, provisionUserAndTenant, listUserMemberships,
} from "../../lib/auth.js";
import { z } from "zod";

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), "Password must contain at least one letter and one number");

const signupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.string().trim().email("Enter a valid email address").max(254),
  password: passwordSchema,
  orgName: z.string().trim().max(100).optional(),
});
import { badRequest, unauthorized, notFound } from "../../lib/errors.js";
import { sendEmail, postmarkEnabled } from "../../lib/postmark.js";
import { passwordResetEmail, emailVerificationEmail, teamInviteEmail } from "../../lib/email-templates.js";

/**
 * All authentication endpoints. Public routes for unauthenticated users,
 * protected routes for session holders.
 */
export async function authRoutes(app: FastifyInstance) {
  // ─── POST /auth/signup ────────────────────────────────────────────────
  // Self-serve registration: creates the user, their organization, default
  // workflow, credit wallet and Starter subscription in one transaction.
  // Production requires email verification before the first login; dev
  // verifies immediately and signs the user in.
  app.post("/auth/signup", { config: { public: true } }, async (req, reply) => {
    const body = signupSchema.parse(req.body ?? {});
    const email = body.email.toLowerCase().trim();
    const displayName = body.name.trim();
    const orgName = body.orgName?.trim() || displayName;

    if (await findUserByEmail(servicePool, email)) {
      throw badRequest("An account with this email already exists. Sign in or reset your password.", "EMAIL_EXISTS");
    }

    const passwordHash = await hashPassword(body.password);
    const verifyNow = config.nodeEnv !== "production";

    const client = await servicePool.connect();
    let userId: string;
    let tenantId: string;
    try {
      await client.query("BEGIN");
      const created = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, status, email_verified_at)
         VALUES ($1, $2, $3, 'active', ${verifyNow ? "now()" : "NULL"})
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [email, passwordHash, displayName],
      );
      if (!created.rows[0]) {
        throw badRequest("An account with this email already exists. Sign in or reset your password.", "EMAIL_EXISTS");
      }
      userId = created.rows[0].id;
      const org = await provisionUserAndTenant(client, userId, orgName);
      tenantId = org.tenantId;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (verifyNow) {
      const token = await createSession(servicePool, userId, req.ip, req.headers["user-agent"], "tenant", tenantId);
      setSessionCookie(reply, token);
      return { ok: true, userId, tenantId };
    }

    const rawToken = generateToken();
    await servicePool.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [userId, hashToken(rawToken), new Date(Date.now() + config.verifyTokenTtlHours * 3600_000).toISOString()],
    );
    const verifyUrl = `${config.webOrigin}/verify-email?token=${rawToken}`;
    if (postmarkEnabled) {
      const tmpl = emailVerificationEmail(verifyUrl, displayName || email);
      await sendEmail({ to: email, subject: tmpl.subject, text: tmpl.text, html: tmpl.html, tag: "email-verification" })
        .catch((err) => req.log.error({ err }, "failed to send verification email"));
    } else {
      console.log(`\n✉️  Email verification link for ${email}:\n   ${verifyUrl}\n`);
    }
    return { ok: true, verificationRequired: true };
  });

  // ─── POST /auth/login ─────────────────────────────────────────────────
  // Email + password login. Sets session cookie on success.
  app.post("/auth/login", { config: { public: true } }, async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const email = body.email?.toLowerCase().trim();
    const password = body.password;

    if (!email || !password) {
      throw badRequest("Email and password are required");
    }

    const user = await findUserByEmail(servicePool, email);
    if (!user) throw badRequest("Invalid email or password", "INVALID_CREDENTIALS");
    if (user.status !== "active") throw badRequest("Account is not active", "ACCOUNT_INACTIVE");

    const valid = await verifyPassword(user.password_hash, password);
    if (!valid) throw badRequest("Invalid email or password", "INVALID_CREDENTIALS");
    if (user.is_super_admin) throw badRequest("Use the super admin sign in", "ADMIN_LOGIN_REQUIRED");

    // Update last login
    await servicePool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

    if (config.nodeEnv === "production" && !user.email_verified_at) {
      throw badRequest("Please verify your email address first. Check your inbox for the link.", "EMAIL_NOT_VERIFIED");
    }

    // Get membership (an active organization is preferred)
    const membership = await resolveUserMembership(servicePool, user.id);
    if (!membership) throw badRequest("No organization associated with this account", "NO_ORG");
    if (membership.tenantStatus !== "active") {
      throw badRequest("This organization has been suspended. Contact support.", "TENANT_SUSPENDED");
    }

    // Create session pinned to that organization
    const token = await createSession(
      servicePool, user.id, req.ip, req.headers["user-agent"], "tenant", membership.tenantId,
    );
    setSessionCookie(reply, token);

    return {
      ok: true,
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      isSuperAdmin: user.is_super_admin,
      tenantId: membership.tenantId,
      role: membership.role,
      tenantSlug: membership.tenantSlug,
      sessionType: "tenant",
    };
  });

  // Platform administrators use a separate portal and session audience.
  app.post("/auth/admin/login", { config: { public: true } }, async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const email = body.email?.toLowerCase().trim();
    if (!email || !body.password) throw badRequest("Email and password are required");

    const user = await findUserByEmail(servicePool, email);
    if (!user || !user.is_super_admin || !(await verifyPassword(user.password_hash, body.password))) {
      throw badRequest("Invalid admin credentials", "INVALID_CREDENTIALS");
    }
    if (user.status !== "active") throw badRequest("Account is not active", "ACCOUNT_INACTIVE");

    await servicePool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    const token = await createSession(servicePool, user.id, req.ip, req.headers["user-agent"], "admin");
    setSessionCookie(reply, token);
    return { ok: true, userId: user.id, email: user.email, isSuperAdmin: true, sessionType: "admin" };
  });

  // ─── POST /auth/logout ────────────────────────────────────────────────
  // Delete session and clear cookie.
  app.post("/auth/logout", { config: { public: true } }, async (req, reply) => {
    const token = extractCookieToken(req);
    if (token) {
      const tokenHash = hashToken(token);
      await servicePool.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]).catch(() => {});
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  // ─── POST /auth/forgot-password ───────────────────────────────────────
  // Create a reset token and (in dev) log it to console.
  app.post("/auth/forgot-password", { config: { public: true } }, async (req) => {
    const body = (req.body ?? {}) as { email?: string };
    const email = body.email?.toLowerCase().trim();
    if (!email) throw badRequest("Email is required");

    const user = await findUserByEmail(servicePool, email);
    if (!user) {
      // Don't reveal whether user exists
      return { ok: true, message: "If an account exists, a reset link has been sent" };
    }

    // Invalidate old reset tokens
    await servicePool.query(
      `DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    );

    // Create new token
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + config.resetTokenTtlMinutes * 60_000);

    await servicePool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt.toISOString()],
    );

    // In dev: log the token. In production: send email via Postmark.
    const resetUrl = `${config.webOrigin}/reset-password?token=${rawToken}`;

    if (postmarkEnabled) {
      const tmpl = passwordResetEmail(resetUrl, user.display_name || user.email);
      await sendEmail({ to: user.email, subject: tmpl.subject, text: tmpl.text, html: tmpl.html, tag: "password-reset" })
        .catch((err) => console.error("Failed to send reset email:", err));
    } else {
      console.log(`\n🔑 Password reset link for ${email}:\n   ${resetUrl}\n`);
    }

    return { ok: true, message: "If an account exists, a reset link has been sent" };
  });

  // ─── POST /auth/reset-password ────────────────────────────────────────
  // Verify reset token and set new password.
  app.post("/auth/reset-password", { config: { public: true } }, async (req) => {
    const body = (req.body ?? {}) as { token?: string; password?: string };
    const rawToken = body.token;
    const password = body.password;

    if (!rawToken || !password) throw badRequest("Token and new password are required");
    if (password.length < 8) throw badRequest("Password must be at least 8 characters");
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      throw badRequest("Password must contain at least one letter and one number");
    }

    const tokenHash = hashToken(rawToken);
    const row = await servicePool.query<{ user_id: string }>(
      `SELECT user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );

    if (!row.rows[0]) throw badRequest("Invalid or expired reset token", "INVALID_TOKEN");

    const userId = row.rows[0].user_id;
    const newHash = await hashPassword(password);

    // Update password + mark token used + invalidate all sessions. The reset
    // link was delivered to the user's inbox, which also proves the address.
    await servicePool.query(
      `UPDATE users SET password_hash = $1, email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
       WHERE id = $2`,
      [newHash, userId],
    );
    await servicePool.query(`UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1`, [tokenHash]);
    await servicePool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);

    return { ok: true, message: "Password has been reset. Please log in." };
  });

  // ─── POST /auth/change-password ───────────────────────────────────────
  // Authenticated: change password (requires current password).
  app.post("/auth/change-password", async (req) => {
    const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    const current = body.currentPassword;
    const newPw = body.newPassword;

    if (!current || !newPw) throw badRequest("Current and new password are required");
    if (newPw.length < 8) throw badRequest("New password must be at least 8 characters");
    if (!/[a-zA-Z]/.test(newPw) || !/[0-9]/.test(newPw)) {
      throw badRequest("Password must contain at least one letter and one number");
    }

    const user = await findUserByEmail(servicePool, req.user.email);
    if (!user) throw unauthorized("User not found");

    const valid = await verifyPassword(user.password_hash, current);
    if (!valid) throw badRequest("Current password is incorrect", "INVALID_PASSWORD");

    const newHash = await hashPassword(newPw);
    await servicePool.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [newHash, user.id]);
    // Invalidate all sessions except current
    const currentToken = extractCookieToken(req);
    if (currentToken) {
      await servicePool.query(
        `DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2`,
        [user.id, hashToken(currentToken)],
      );
    }

    return { ok: true, message: "Password changed successfully" };
  });

  // ─── POST /auth/dev-login ─────────────────────────────────────────────
  // Dev-only fast login (no password required). Seeds a user if needed.
  app.post("/auth/dev-login", { config: { public: true } }, async (req, reply) => {
    if (config.nodeEnv === "production") throw notFound("Disabled in production");

    const body = (req.body ?? {}) as { email?: string };
    const email = body.email?.toLowerCase().trim();
    if (!email) throw badRequest("Email is required");

    // Auto-create user + tenant if they don't exist
    let user = await findUserByEmail(servicePool, email);
    if (!user) {
      const name = email.split("@")[0];
      const passwordHash = await hashPassword("dev-password-auto");
      const created = await servicePool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, status, email_verified_at)
         VALUES ($1, $2, $3, 'active', now())
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [email, passwordHash, name],
      );
      if (created.rows[0]) {
        await provisionUserAndTenant(servicePool, created.rows[0].id, name);
        user = await findUserByEmail(servicePool, email);
      } else {
        user = await findUserByEmail(servicePool, email);
      }
    }

    if (!user) throw badRequest("Failed to create user", "USER_CREATE_FAILED");

    // Ensure user has a membership
    let membership = await resolveUserMembership(servicePool, user.id);
    if (!membership) {
      // Create a tenant for this user
      const org = await provisionUserAndTenant(servicePool, user.id, user.display_name || email.split("@")[0]);
      membership = { tenantId: org.tenantId, role: org.role, tenantSlug: org.tenantSlug, tenantStatus: "active" };
    }

    // Create session pinned to the resolved organization
    const token = await createSession(
      servicePool, user.id, req.ip, req.headers["user-agent"], "tenant", membership.tenantId,
    );
    setSessionCookie(reply, token);

    return {
      ok: true,
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      isSuperAdmin: user.is_super_admin,
      tenantId: membership.tenantId,
      role: membership.role,
      tenantSlug: membership.tenantSlug,
    };
  });

  // ─── POST /auth/verify-email ───────────────────────────────────────────
  // Verify email token and mark as verified.
  app.post("/auth/verify-email", { config: { public: true } }, async (req) => {
    const body = (req.body ?? {}) as { token?: string };
    const rawToken = body.token;
    if (!rawToken) throw badRequest("Token is required");

    const tokenHash = hashToken(rawToken);
    const row = await servicePool.query<{ user_id: string }>(
      `SELECT user_id FROM email_verification_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );

    if (!row.rows[0]) throw badRequest("Invalid or expired verification token", "INVALID_TOKEN");

    const userId = row.rows[0].user_id;
    await servicePool.query(`UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1`, [userId]);
    await servicePool.query(`UPDATE email_verification_tokens SET used_at = now() WHERE token_hash = $1`, [tokenHash]);

    return { ok: true, message: "Email verified successfully" };
  });

  // ─── GET /auth/organizations ──────────────────────────────────────────
  // Authenticated: organizations the user belongs to (for an org switcher).
  app.get("/auth/organizations", async (req) => {
    if (req.user.sessionType !== "tenant") return { organizations: [], activeTenantId: null };
    const orgs = await listUserMemberships(servicePool, req.user.userId);
    return { organizations: orgs, activeTenantId: req.user.tenantId };
  });

  // ─── POST /auth/switch-organization ───────────────────────────────────
  // Authenticated: point the current session at another organization the
  // user is an active member of.
  app.post("/auth/switch-organization", async (req) => {
    if (req.user.sessionType !== "tenant") throw badRequest("Tenant session required");
    const body = (req.body ?? {}) as { tenantId?: string };
    const tenantId = body.tenantId?.trim();
    if (!tenantId) throw badRequest("tenantId is required");

    const orgs = await listUserMemberships(servicePool, req.user.userId);
    const target = orgs.find((o) => o.tenantId === tenantId);
    if (!target) throw notFound("Organization not found");
    if (target.status !== "active") {
      throw badRequest("This organization has been suspended. Contact support.", "TENANT_SUSPENDED");
    }

    const token = extractCookieToken(req);
    if (!token) throw unauthorized("Missing session cookie");
    await servicePool.query(`UPDATE sessions SET tenant_id = $2 WHERE token_hash = $1`, [hashToken(token), tenantId]);
    return { ok: true, tenantId, role: target.role, tenantSlug: target.slug };
  });

  // ─── POST /auth/create-organization ───────────────────────────────────
  // Authenticated: create a new organization (for users without a tenant).
  app.post("/auth/create-organization", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string };
    const name = body.name?.trim();
    if (!name) throw badRequest("Organization name is required");

    // Check if user already has a membership
    const existing = await resolveUserMembership(servicePool, req.user.userId);
    if (existing) throw badRequest("You already belong to an organization", "HAS_ORG");

    const org = await provisionUserAndTenant(servicePool, req.user.userId, name);

    return {
      ok: true,
      tenantId: org.tenantId,
      tenantSlug: org.tenantSlug,
      role: org.role,
    };
  });
}
