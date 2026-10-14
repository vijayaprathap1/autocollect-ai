import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config, isDevLike } from "../../config.js";
import { servicePool, withServiceTransaction } from "../../lib/db.js";
import {
  hashPassword,
  verifyPassword,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  extractCookieToken,
  hashToken,
  generateToken,
  findUserByEmail,
  resolveUserMembership,
  provisionUserAndTenant,
  recordLoginFailure,
  recordLoginSuccess,
  revokeUserSessions,
  isLocked,
  lockedError,
  passwordSchema,
  emailSchema,
  type UserRecord,
} from "../../lib/auth.js";
import { ApiError, badRequest, notFound, unauthorized, assertUuid } from "../../lib/errors.js";
import { sendEmail } from "../../lib/postmark.js";
import {
  passwordResetEmail,
  emailVerificationEmail,
  accountExistsEmail,
  passwordChangedEmail,
} from "../../lib/email-templates.js";
import { googleEnabled } from "../../lib/oauth.js";
import { isValidTimeZone } from "../../lib/schedule.js";
import { googleAuthRoutes } from "./google.controller.js";

/** Fire-and-log: auth emails must never turn a successful action into a 500. */
async function sendAccountEmail(
  req: FastifyRequest,
  to: string,
  tmpl: { subject: string; text: string; html: string },
  tag: string,
): Promise<void> {
  try {
    await sendEmail({ to, subject: tmpl.subject, text: tmpl.text, html: tmpl.html, tag });
  } catch (err) {
    req.log.error({ err, tag }, "failed to send account email");
  }
}

async function issueVerificationToken(userId: string): Promise<string> {
  const raw = generateToken();
  await servicePool.query(`DELETE FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await servicePool.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashToken(raw), new Date(Date.now() + config.verifyTokenTtlHours * 3600_000).toISOString()],
  );
  return raw;
}

async function issueResetToken(userId: string, ttlMinutes = config.resetTokenTtlMinutes): Promise<string> {
  const raw = generateToken();
  await servicePool.query(`DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await servicePool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashToken(raw), new Date(Date.now() + ttlMinutes * 60_000).toISOString()],
  );
  return raw;
}

function webUrl(path: string): string {
  return `${config.webOrigin.split(",")[0].replace(/\/$/, "")}${path}`;
}

/** Start a session. `persistent=false` = browser-session cookie + 12h server expiry. */
async function startSession(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  opts: { sessionType?: "tenant" | "admin"; tenantId?: string | null; persistent?: boolean } = {},
): Promise<void> {
  const token = await createSession(servicePool, userId, {
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    sessionType: opts.sessionType ?? "tenant",
    tenantId: opts.tenantId ?? null,
  });
  if (opts.persistent === false) {
    await servicePool.query(`UPDATE sessions SET expires_at = now() + interval '12 hours' WHERE token_hash = $1`, [
      hashToken(token),
    ]);
  }
  setSessionCookie(reply, token, opts.persistent !== false);
}

const AUTH_LIMIT = { max: 10, timeWindow: "1 minute" };
const STRICT_LIMIT = { max: 5, timeWindow: "1 minute" };

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "Email is required").max(254),
  password: z.string().min(1, "Password is required").max(128),
  rememberMe: z.boolean().optional(),
});

/**
 * Shared password check with lockout + timing equalisation. Returns the user
 * only when the password is correct; every failure looks identical.
 */
async function checkCredentials(email: string, password: string): Promise<UserRecord> {
  const user = await findUserByEmail(servicePool, email);
  if (user && isLocked(user)) {
    // Still spend the hashing time so lock state can't be probed by timing.
    await verifyPassword(null, password);
    throw lockedError();
  }
  const ok = await verifyPassword(user?.password_hash ?? null, password);
  if (!user || !ok) {
    if (user) await recordLoginFailure(user.id);
    throw unauthorized("Incorrect email or password", "INVALID_CREDENTIALS");
  }
  return user;
}

export async function authRoutes(app: FastifyInstance) {
  // ─── GET /auth/providers ─────────────────────────────────────────────
  // Lets the UI render only the sign-in options that actually work.
  app.get("/auth/providers", { config: { public: true } }, async () => ({
    password: true,
    google: googleEnabled,
    signup: true,
  }));

  // ─── POST /auth/signup ───────────────────────────────────────────────
  // Creates a pending user + complete trial workspace atomically. The
  // response never reveals whether the address was already registered.
  app.post("/auth/signup", { config: { public: true, rateLimit: STRICT_LIMIT } }, async (req, reply) => {
    const input = z
      .object({
        email: emailSchema,
        password: passwordSchema,
        name: z.string().trim().min(1).max(100).optional(),
        displayName: z.string().trim().min(1).max(100).optional(),
        organizationName: z.string().trim().min(1).max(120).optional(),
        timezone: z.string().trim().max(64).optional(),
      })
      .parse(req.body ?? {});
    const timezone = input.timezone && isValidTimeZone(input.timezone) ? input.timezone : "UTC";
    const displayName = input.displayName ?? input.name ?? input.email.split("@")[0];
    const organizationName = input.organizationName ?? `${displayName}'s workspace`;
    const passwordHash = await hashPassword(input.password);

    const existing = await findUserByEmail(servicePool, input.email);
    if (existing) {
      if (existing.status === "pending" && !existing.email_verified_at) {
        // Re-signup of an unverified account: refresh credentials + resend the link.
        await servicePool.query(`UPDATE users SET password_hash = $2, display_name = $3, updated_at = now() WHERE id = $1`, [
          existing.id,
          passwordHash,
          displayName,
        ]);
        const token = await issueVerificationToken(existing.id);
        await sendAccountEmail(req, input.email, emailVerificationEmail(webUrl(`/verify-email?token=${token}`), displayName), "email-verification");
      } else {
        await sendAccountEmail(req, input.email, accountExistsEmail(webUrl("/login"), webUrl("/forgot-password")), "account-exists");
      }
      return reply.status(202).send({ ok: true, message: "Check your inbox to confirm your email address." });
    }

    const rawToken = generateToken();
    const created = await withServiceTransaction(async (client) => {
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, status, email_verified_at, password_changed_at)
         VALUES ($1, $2, $3, 'pending', NULL, now())
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [input.email, passwordHash, displayName],
      );
      if (!user.rows[0]) return false; // lost a race with a concurrent signup
      await provisionUserAndTenant(client, user.rows[0].id, organizationName, input.email, { timezone });
      await client.query(`INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
        user.rows[0].id,
        hashToken(rawToken),
        new Date(Date.now() + config.verifyTokenTtlHours * 3600_000).toISOString(),
      ]);
      return true;
    });

    if (created) {
      await sendAccountEmail(req, input.email, emailVerificationEmail(webUrl(`/verify-email?token=${rawToken}`), displayName), "email-verification");
    }
    return reply.status(202).send({ ok: true, message: "Check your inbox to confirm your email address." });
  });

  // ─── POST /auth/resend-verification ──────────────────────────────────
  app.post("/auth/resend-verification", { config: { public: true, rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (req) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body ?? {});
    const user = await findUserByEmail(servicePool, email);
    if (user && user.status === "pending" && !user.email_verified_at) {
      const token = await issueVerificationToken(user.id);
      await sendAccountEmail(req, user.email, emailVerificationEmail(webUrl(`/verify-email?token=${token}`), user.display_name || user.email), "email-verification");
    }
    return { ok: true, message: "If that account is awaiting verification, a new link is on its way." };
  });

  // ─── POST /auth/verify-email ─────────────────────────────────────────
  // Consumes the token atomically and signs the user straight in.
  app.post("/auth/verify-email", { config: { public: true, rateLimit: AUTH_LIMIT } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body ?? {});
    const result = await servicePool.query<{ id: string; status: string; is_super_admin: boolean }>(
      `WITH consumed AS (
         UPDATE email_verification_tokens
            SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING user_id
       )
       UPDATE users
          SET email_verified_at = COALESCE(email_verified_at, now()),
              status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
              updated_at = now()
         FROM consumed
        WHERE users.id = consumed.user_id
        RETURNING users.id, users.status, users.is_super_admin`,
      [hashToken(token)],
    );
    const user = result.rows[0];
    if (!user) {
      throw badRequest("This verification link is invalid or has expired. Request a new one from the sign-in page.", "INVALID_TOKEN");
    }

    let signedIn = false;
    if (user.status === "active" && !user.is_super_admin && (await resolveUserMembership(servicePool, user.id))) {
      await startSession(req, reply, user.id);
      await recordLoginSuccess(user.id);
      signedIn = true;
    }
    return { ok: true, signedIn, message: "Email verified." };
  });

  // ─── POST /auth/login ────────────────────────────────────────────────
  app.post("/auth/login", { config: { public: true, rateLimit: AUTH_LIMIT } }, async (req, reply) => {
    const { email, password, rememberMe } = credentialsSchema.parse(req.body ?? {});
    const user = await checkCredentials(email, password);

    // The password is proven correct, so it's safe to be specific from here on.
    if (user.is_super_admin) throw new ApiError(403, "ADMIN_LOGIN_REQUIRED", "Use the platform admin sign-in page.");
    if (user.status === "suspended") throw new ApiError(403, "ACCOUNT_SUSPENDED", "This account has been suspended.");
    if (user.status !== "active" || !user.email_verified_at) {
      throw new ApiError(403, "EMAIL_NOT_VERIFIED", "Please confirm your email address first. We can send you a new link.");
    }

    const membership = await resolveUserMembership(servicePool, user.id);
    if (!membership) {
      const suspended = await servicePool.query(
        `SELECT 1 FROM memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'suspended' LIMIT 1`,
        [user.id],
      );
      if (suspended.rows.length) throw new ApiError(403, "TENANT_SUSPENDED", "This workspace has been suspended. Contact support.");
    }
    await recordLoginSuccess(user.id);
    await startSession(req, reply, user.id, { tenantId: membership?.tenantId ?? null, persistent: rememberMe !== false });

    return {
      ok: true,
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      tenantId: membership?.tenantId ?? null,
      role: membership?.role ?? null,
      sessionType: "tenant",
    };
  });

  // ─── POST /auth/admin/login ──────────────────────────────────────────
  // Platform administrators use a separate portal and session audience.
  app.post("/auth/admin/login", { config: { public: true, rateLimit: STRICT_LIMIT } }, async (req, reply) => {
    const { email, password } = credentialsSchema.parse(req.body ?? {});
    const user = await checkCredentials(email, password);
    if (!user.is_super_admin || user.status !== "active") {
      throw unauthorized("Incorrect email or password", "INVALID_CREDENTIALS");
    }
    await recordLoginSuccess(user.id);
    await startSession(req, reply, user.id, { sessionType: "admin", persistent: false });
    return { ok: true, userId: user.id, email: user.email, isSuperAdmin: true, sessionType: "admin" };
  });

  // ─── POST /auth/logout ───────────────────────────────────────────────
  app.post("/auth/logout", { config: { public: true } }, async (req, reply) => {
    const token = extractCookieToken(req);
    if (token) await servicePool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]).catch(() => {});
    clearSessionCookie(reply);
    return { ok: true };
  });

  // ─── POST /auth/forgot-password ──────────────────────────────────────
  app.post("/auth/forgot-password", { config: { public: true, rateLimit: STRICT_LIMIT } }, async (req) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body ?? {});
    const user = await findUserByEmail(servicePool, email);
    if (user && user.status !== "suspended") {
      const token = await issueResetToken(user.id);
      await sendAccountEmail(
        req,
        user.email,
        passwordResetEmail(webUrl(`/reset-password?token=${token}`), user.display_name || user.email),
        "password-reset",
      );
    }
    return { ok: true, message: "If an account exists for that email, a reset link is on its way." };
  });

  // ─── POST /auth/reset-password ───────────────────────────────────────
  // Atomic single-use token. Proves inbox ownership, so it also verifies the
  // email, clears any lockout and signs out every existing session.
  app.post("/auth/reset-password", { config: { public: true, rateLimit: AUTH_LIMIT } }, async (req) => {
    const { token, password } = z
      .object({ token: z.string().min(10).max(200), password: passwordSchema })
      .parse(req.body ?? {});
    const newHash = await hashPassword(password);

    const userId = await withServiceTransaction(async (client) => {
      const consumed = await client.query<{ user_id: string }>(
        `UPDATE password_reset_tokens SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING user_id`,
        [hashToken(token)],
      );
      const id = consumed.rows[0]?.user_id;
      if (!id) return null;
      await client.query(
        `UPDATE users
            SET password_hash = $2,
                password_changed_at = now(),
                email_verified_at = COALESCE(email_verified_at, now()),
                status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
                failed_login_count = 0,
                locked_until = NULL,
                updated_at = now()
          WHERE id = $1`,
        [id, newHash],
      );
      await client.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      await client.query(`DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`, [id]);
      return id;
    });
    if (!userId) {
      throw badRequest("This reset link is invalid or has expired. Request a new one.", "INVALID_TOKEN");
    }
    return { ok: true, message: "Your password has been updated. Please sign in." };
  });

  // ─── POST /auth/change-password (authenticated) ──────────────────────
  app.post("/auth/change-password", { config: { allowNoTenant: true, rateLimit: STRICT_LIMIT } }, async (req) => {
    const body = z
      .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
      .parse(req.body ?? {});
    if (body.currentPassword === body.newPassword) {
      throw badRequest("Choose a password different from your current one", "PASSWORD_UNCHANGED");
    }
    const user = await findUserByEmail(servicePool, req.user.email);
    if (!user) throw unauthorized("User not found");
    if (!(await verifyPassword(user.password_hash, body.currentPassword))) {
      await recordLoginFailure(user.id);
      throw badRequest("Your current password is incorrect", "INVALID_PASSWORD");
    }
    await servicePool.query(
      `UPDATE users SET password_hash = $1, password_changed_at = now(), updated_at = now() WHERE id = $2`,
      [await hashPassword(body.newPassword), user.id],
    );
    const revoked = await revokeUserSessions(user.id, req.user.sessionHash);
    await sendAccountEmail(req, user.email, passwordChangedEmail(user.display_name || user.email, webUrl("/forgot-password")), "password-changed");
    return { ok: true, message: "Password changed", otherSessionsSignedOut: revoked };
  });

  // ─── Profile ─────────────────────────────────────────────────────────
  app.put("/auth/profile", { config: { allowNoTenant: true } }, async (req) => {
    const { displayName } = z.object({ displayName: z.string().trim().min(1).max(100) }).parse(req.body ?? {});
    await servicePool.query(`UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1`, [req.user.userId, displayName]);
    return { ok: true, displayName };
  });

  // ─── Sessions (devices) ──────────────────────────────────────────────
  app.get("/auth/sessions", { config: { allowNoTenant: true } }, async (req) => {
    const rows = await servicePool.query<{
      id: string; token_hash: string; ip: string | null; user_agent: string | null;
      created_at: string; last_seen_at: string | null; expires_at: string; session_type: string;
    }>(
      `SELECT id, token_hash, host(ip) AS ip, user_agent, created_at, last_seen_at, expires_at, session_type
         FROM sessions WHERE user_id = $1 AND expires_at > now()
        ORDER BY last_seen_at DESC NULLS LAST`,
      [req.user.userId],
    );
    return {
      sessions: rows.rows.map((s) => ({
        id: s.id,
        ip: s.ip,
        userAgent: s.user_agent,
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        expiresAt: s.expires_at,
        current: s.token_hash === req.user.sessionHash,
      })),
    };
  });

  app.delete("/auth/sessions/:id", { config: { allowNoTenant: true } }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Session");
    const res = await servicePool.query(
      `DELETE FROM sessions WHERE id = $1 AND user_id = $2 AND token_hash <> $3`,
      [id, req.user.userId, req.user.sessionHash],
    );
    if (!res.rowCount) throw notFound("Session not found (use sign out for this device)");
    return { ok: true };
  });

  app.post("/auth/sessions/revoke-others", { config: { allowNoTenant: true } }, async (req) => {
    const revoked = await revokeUserSessions(req.user.userId, req.user.sessionHash);
    return { ok: true, revoked };
  });

  // ─── Organizations (multi-workspace users) ───────────────────────────
  app.get("/auth/organizations", { config: { allowNoTenant: true } }, async (req) => {
    const rows = await servicePool.query<{ id: string; name: string; slug: string; role: string }>(
      `SELECT t.id, t.name, t.slug, m.role
         FROM memberships m JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active'
        ORDER BY m.created_at ASC`,
      [req.user.userId],
    );
    return {
      organizations: rows.rows.map((r) => ({ ...r, current: r.id === req.user.tenantId })),
    };
  });

  app.post("/auth/switch-organization", { config: { allowNoTenant: true } }, async (req) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.body ?? {});
    const membership = await resolveUserMembership(servicePool, req.user.userId, tenantId);
    if (!membership || membership.tenantId !== tenantId) throw notFound("Workspace not found");
    await servicePool.query(`UPDATE sessions SET tenant_id = $2 WHERE token_hash = $1`, [req.user.sessionHash, tenantId]);
    return { ok: true, tenantId, role: membership.role };
  });

  app.post("/auth/create-organization", { config: { allowNoTenant: true, rateLimit: STRICT_LIMIT } }, async (req) => {
    if (req.user.sessionType !== "tenant") throw badRequest("Workspace sessions only");
    const { name } = z.object({ name: z.string().trim().min(1, "Organization name is required").max(120) }).parse(req.body ?? {});
    const org = await withServiceTransaction((client) => provisionUserAndTenant(client, req.user.userId, name, req.user.email));
    await servicePool.query(`UPDATE sessions SET tenant_id = $2 WHERE token_hash = $1`, [req.user.sessionHash, org.tenantId]);
    return { ok: true, tenantId: org.tenantId, tenantSlug: org.tenantSlug, role: org.role };
  });

  // ─── POST /auth/dev-login (development/test only) ────────────────────
  app.post("/auth/dev-login", { config: { public: true } }, async (req, reply) => {
    if (!isDevLike) throw notFound("Route not found");
    const { email } = z.object({ email: emailSchema }).parse(req.body ?? {});
    let user = await findUserByEmail(servicePool, email);
    if (!user) {
      const name = email.split("@")[0];
      await withServiceTransaction(async (client) => {
        const created = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, display_name, status, email_verified_at)
           VALUES ($1, $2, $3, 'active', now()) ON CONFLICT (email) DO NOTHING RETURNING id`,
          [email, await hashPassword("dev-password-auto"), name],
        );
        if (created.rows[0]) await provisionUserAndTenant(client, created.rows[0].id, `${name}'s workspace`, email);
      });
      user = await findUserByEmail(servicePool, email);
    }
    if (!user) throw badRequest("Failed to create user", "USER_CREATE_FAILED");
    let membership = await resolveUserMembership(servicePool, user.id);
    if (!membership) {
      const org = await withServiceTransaction((client) => provisionUserAndTenant(client, user!.id, `${email.split("@")[0]}'s workspace`, email));
      membership = { tenantId: org.tenantId, role: org.role, tenantSlug: org.tenantSlug };
    }
    await startSession(req, reply, user.id, { tenantId: membership.tenantId });
    return { ok: true, userId: user.id, email: user.email, tenantId: membership.tenantId, role: membership.role };
  });

  // ─── Google OAuth ────────────────────────────────────────────────────
  void app.register(googleAuthRoutes);
}
