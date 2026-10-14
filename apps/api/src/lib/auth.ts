import type { FastifyRequest, FastifyReply } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import argon2 from "argon2";
import { z } from "zod";
import { servicePool, setTenantForRequest, type Queryable } from "./db.js";
import { config, isProduction } from "../config.js";
import { ApiError, unauthorized } from "./errors.js";
import type { UserRole } from "@autocollect/shared";
import { installDefaultSequence } from "./default-sequence.js";
import { PLANS } from "./billing.js";

export type AuthUser = {
  userId: string;
  tenantId: string;
  role: UserRole;
  email: string;
  displayName: string | null;
  tenantSlug: string;
  isSuperAdmin: boolean;
  sessionType: "tenant" | "admin";
  /** sha256 of the session token (identifies the current session). */
  sessionHash: string;
};

// `__Host-` cookies must be Secure, Path=/ and host-only: the browser then
// refuses any attempt to set/overwrite them from a sibling subdomain.
export const SESSION_COOKIE = isProduction ? "__Host-autocollect_session" : "autocollect_session";
const TOKEN_BYTES = 32;

// ─── Token utilities ──────────────────────────────────────────────────────

export function generateToken(bytes = TOKEN_BYTES): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ─── Password utilities ──────────────────────────────────────────────────

// The test suite hashes dozens of passwords; full-strength parameters make it
// take minutes on slower machines. Verification reads parameters from the hash,
// so test and production hashes stay mutually verifiable.
const ARGON_OPTS =
  process.env.NODE_ENV === "test"
    ? ({ type: argon2.argon2id, memoryCost: 4096, timeCost: 1, parallelism: 1 } as const)
    : ({ type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const);

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters")
  .regex(/[a-zA-Z]/, "Password must contain at least one letter")
  .regex(/[0-9]/, "Password must contain at least one number");

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTS);
}

let dummyHash: Promise<string> | null = null;

/**
 * Verify a password. Pass `null` for unknown users: a dummy hash is still
 * verified so response time doesn't reveal whether the email exists.
 */
export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash || !hash.startsWith("$argon2")) {
    dummyHash ??= hashPassword(generateToken());
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// ─── Cookies ─────────────────────────────────────────────────────────────

/** `maxAgeSeconds = null` creates a browser-session cookie (dropped when the browser closes). */
function cookie(name: string, value: string, maxAgeSeconds: number | null): string {
  const maxAge = maxAgeSeconds === null ? "" : `; Max-Age=${maxAgeSeconds}`;
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${maxAge}${isProduction ? "; Secure" : ""}`;
}

/** Fastify appends repeated Set-Cookie headers, so this never clobbers other cookies. */
export function setCookie(reply: FastifyReply, name: string, value: string, maxAgeSeconds: number | null): void {
  reply.header("set-cookie", cookie(name, value, maxAgeSeconds));
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function setSessionCookie(reply: FastifyReply, token: string, persistent = true): void {
  setCookie(reply, SESSION_COOKIE, token, persistent ? config.sessionTtlHours * 3600 : null);
}

export function clearSessionCookie(reply: FastifyReply): void {
  setCookie(reply, SESSION_COOKIE, "", 0);
}

export function extractCookieToken(req: FastifyRequest): string | undefined {
  return readCookie(req, SESSION_COOKIE) || undefined;
}

// ─── Sessions ────────────────────────────────────────────────────────────

export async function createSession(
  client: Queryable,
  userId: string,
  opts: { ip?: string; userAgent?: string; sessionType?: "tenant" | "admin"; tenantId?: string | null } = {},
): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  await client.query(
    `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at, session_type, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      userId,
      hashToken(token),
      opts.ip ?? null,
      opts.userAgent?.slice(0, 512) ?? null,
      expiresAt.toISOString(),
      opts.sessionType ?? "tenant",
      opts.tenantId ?? null,
    ],
  );
  return token;
}

/** Revoke every session for a user, optionally keeping one (the caller's). */
export async function revokeUserSessions(userId: string, keepSessionHash?: string): Promise<number> {
  const res = await servicePool.query(
    `DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR token_hash <> $2)`,
    [userId, keepSessionHash ?? null],
  );
  return res.rowCount ?? 0;
}

// ─── User lookup / lockout ───────────────────────────────────────────────

export type UserRecord = {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string | null;
  status: string;
  email_verified_at: string | null;
  is_super_admin: boolean;
  failed_login_count: number;
  locked_until: string | null;
};

export async function findUserByEmail(client: Queryable, email: string): Promise<UserRecord | null> {
  const rows = await client.query<UserRecord>(
    `SELECT id, email, password_hash, display_name, status, email_verified_at, is_super_admin,
            failed_login_count, locked_until
       FROM users WHERE email = $1`,
    [email.toLowerCase().trim()],
  );
  return rows.rows[0] ?? null;
}

export function isLocked(user: Pick<UserRecord, "locked_until">): boolean {
  return Boolean(user.locked_until && new Date(user.locked_until).getTime() > Date.now());
}

/** Count a failed password attempt; lock the account after N consecutive failures. */
export async function recordLoginFailure(userId: string): Promise<void> {
  await servicePool.query(
    `UPDATE users
        SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
            locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + ($3 * interval '1 minute') ELSE locked_until END
      WHERE id = $1`,
    [userId, config.loginMaxFailures, config.loginLockoutMinutes],
  );
}

export async function recordLoginSuccess(userId: string): Promise<void> {
  await servicePool.query(
    `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
    [userId],
  );
}

export function lockedError(): ApiError {
  return new ApiError(
    429,
    "ACCOUNT_LOCKED",
    `Too many failed sign-in attempts. Try again in ${config.loginLockoutMinutes} minutes or reset your password.`,
  );
}

export async function resolveUserMembership(
  client: Queryable,
  userId: string,
  preferredTenantId?: string | null,
): Promise<{ tenantId: string; role: UserRole; tenantSlug: string } | null> {
  const rows = await client.query<{ tenant_id: string; role: string; slug: string }>(
    `SELECT m.tenant_id, m.role, t.slug
       FROM memberships m
       JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active'
      ORDER BY (m.tenant_id = $2::uuid) DESC NULLS LAST, m.created_at ASC
      LIMIT 1`,
    [userId, preferredTenantId ?? null],
  );
  const r = rows.rows[0];
  if (!r) return null;
  return { tenantId: r.tenant_id, role: r.role as UserRole, tenantSlug: r.slug };
}

export function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "org";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

/**
 * Create a complete, ready-to-use workspace owned by `userId`: tenant, owner
 * membership, default (disabled) workflow + unapproved templates, credit
 * wallet with the Starter allowance, subscription row and audit entry.
 * Must run on a connection that can write every tenant table (service pool).
 */
export async function provisionUserAndTenant(
  client: Queryable,
  userId: string,
  organizationName: string,
  actor: string = organizationName,
  opts: { timezone?: string } = {},
): Promise<{ userId: string; tenantId: string; role: UserRole; tenantSlug: string }> {
  const name = organizationName.trim().slice(0, 120) || "My workspace";
  const slug = slugify(name);
  const starter = PLANS.starter;

  const tenant = await client.query<{ id: string }>(
    `INSERT INTO tenants (name, slug, plan, invoice_limit, seat_limit, timezone) VALUES ($1, $2, 'starter', $3, $4, $5) RETURNING id`,
    [name, slug, starter.invoiceLimit, starter.seatLimit, opts.timezone ?? "UTC"],
  );
  const tenantId = tenant.rows[0].id;

  await client.query(
    `INSERT INTO memberships (user_id, tenant_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
    [userId, tenantId],
  );
  await client.query(
    `INSERT INTO workflows (tenant_id, name, is_default, enabled, steps)
     VALUES ($1, 'Default sequence', TRUE, FALSE, '[]'::jsonb)`,
    [tenantId],
  );
  // Default reminder templates (unapproved) linked into the workflow, so the
  // workspace can send as soon as the owner approves them.
  await installDefaultSequence(client, tenantId);

  await client.query(`INSERT INTO credit_wallets (tenant_id, balance) VALUES ($1, $2)`, [tenantId, starter.creditsPerMonth]);
  await client.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, credits_per_month, trial_started_at, trial_ends_at)
     VALUES ($1, 'starter', 'active', $2, now(), now() + interval '14 days')`,
    [tenantId, starter.creditsPerMonth],
  );
  await client.query(
    `INSERT INTO credit_transactions (tenant_id, delta, reason, actor) VALUES ($1, $2, 'trial_grant', 'system')`,
    [tenantId, starter.creditsPerMonth],
  );
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'org_created', $3::jsonb)`,
    [tenantId, actor, JSON.stringify({ plan: "starter" })],
  );

  return { userId, tenantId, role: "owner", tenantSlug: slug };
}

// ─── Main authenticate function ──────────────────────────────────────────

type SessionRow = {
  user_id: string;
  session_type: "tenant" | "admin";
  last_seen_at: string | null;
  email: string;
  display_name: string | null;
  is_super_admin: boolean;
  status: string;
  tenant_id: string | null;
  role: string | null;
  slug: string | null;
  tenant_status: string | null;
  suspended_tenant: boolean;
};

/**
 * Resolve the session cookie to a user + active tenant and scope the request's
 * DB connection to that tenant. The session remembers which organization the
 * user last switched to (sessions.tenant_id); otherwise their oldest active
 * membership is used. Deterministic even for users in several organizations.
 */
export async function authenticate(req: FastifyRequest, opts: { allowNoTenant?: boolean } = {}): Promise<AuthUser> {
  const token = extractCookieToken(req);
  if (!token) throw unauthorized("Missing session cookie");
  const tokenHash = hashToken(token);

  const rows = await servicePool.query<SessionRow>(
    `SELECT s.user_id, s.session_type, s.last_seen_at,
            u.email, u.display_name, u.is_super_admin, u.status,
            mm.tenant_id, mm.role, mm.slug, mm.tenant_status,
            EXISTS (
              SELECT 1 FROM memberships m2 JOIN tenants t2 ON t2.id = m2.tenant_id
               WHERE m2.user_id = u.id AND m2.status = 'active' AND t2.status = 'suspended'
            ) AS suspended_tenant
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN LATERAL (
         SELECT m.tenant_id, m.role, t.slug, t.status AS tenant_status
           FROM memberships m
           JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = u.id AND m.status = 'active' AND t.status = 'active'
          ORDER BY (m.tenant_id = s.tenant_id) DESC NULLS LAST, m.created_at ASC
          LIMIT 1
       ) mm ON TRUE
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );

  const row = rows.rows[0];
  if (!row) throw unauthorized("Your session has expired. Please sign in again.", "SESSION_EXPIRED");
  if (row.status !== "active") throw unauthorized("Account is not active", "ACCOUNT_INACTIVE");

  // Throttled activity tracking (avoid a write on every request).
  if (!row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    servicePool.query(`UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1`, [tokenHash]).catch(() => {});
  }

  if (row.session_type === "admin") {
    // Admin audience requires the flag to still be set (revocation takes effect immediately).
    if (!row.is_super_admin) throw unauthorized("Admin access revoked", "ADMIN_REVOKED");
    return {
      userId: row.user_id,
      tenantId: "",
      role: "owner",
      email: row.email,
      displayName: row.display_name,
      tenantSlug: "",
      isSuperAdmin: true,
      sessionType: "admin",
      sessionHash: tokenHash,
    };
  }

  if (!row.tenant_id || !row.role) {
    if (row.suspended_tenant) {
      throw new ApiError(403, "TENANT_SUSPENDED", "This workspace has been suspended. Contact support.");
    }
    if (opts.allowNoTenant) {
      // Signed in but not (or no longer) a member of any workspace: only
      // profile / create-or-switch-organization routes are reachable.
      return {
        userId: row.user_id,
        tenantId: "",
        role: "member",
        email: row.email,
        displayName: row.display_name,
        tenantSlug: "",
        isSuperAdmin: false,
        sessionType: "tenant",
        sessionHash: tokenHash,
      };
    }
    throw new ApiError(403, "NO_ORG", "You're not a member of any workspace yet.");
  }

  await setTenantForRequest(req.db, row.tenant_id);

  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    role: row.role as UserRole,
    email: row.email,
    displayName: row.display_name,
    tenantSlug: row.slug ?? "",
    isSuperAdmin: row.is_super_admin,
    sessionType: "tenant",
    sessionHash: tokenHash,
  };
}
