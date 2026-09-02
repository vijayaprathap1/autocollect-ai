import type { FastifyRequest, FastifyReply } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import argon2 from "argon2";
import { query, servicePool, setTenantForRequest } from "./db.js";
import { config } from "../config.js";
import { unauthorized, badRequest } from "./errors.js";
import type { UserRole } from "@autocollect/shared";

export type AuthUser = {
  userId: string;
  tenantId: string;
  role: UserRole;
  email: string;
  tenantSlug: string;
  isSuperAdmin: boolean;
  sessionType: "tenant" | "admin";
};

const COOKIE_NAME = "autocollect_session";
const TOKEN_BYTES = 32;

// ─── Token utilities ──────────────────────────────────────────────────────

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ─── Password utilities ──────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (hash === "needs_password_reset") return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// ─── Session management ──────────────────────────────────────────────────

export async function createSession(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  userId: string,
  ip?: string,
  userAgent?: string,
  sessionType: "tenant" | "admin" = "tenant",
): Promise<string> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);

  await client.query(
    `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at, session_type)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, tokenHash, ip ?? null, userAgent ?? null, expiresAt.toISOString(), sessionType],
  );

  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  const maxAge = config.sessionTtlHours * 3600;
  reply.header("Set-Cookie", [
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.nodeEnv === "production" ? "; Secure" : ""}`,
  ]);
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header("Set-Cookie", [
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.nodeEnv === "production" ? "; Secure" : ""}`,
  ]);
}

export function extractCookieToken(req: FastifyRequest): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.split("=");
    if (name?.trim() === COOKIE_NAME) return rest.join("=")?.trim();
  }
  return undefined;
}

// ─── User lookup / provisioning ──────────────────────────────────────────

export async function findUserByEmail(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  email: string,
): Promise<{ id: string; email: string; password_hash: string; display_name: string | null; status: string; email_verified_at: string | null; is_super_admin: boolean } | null> {
  const rows = await client.query<{
    id: string; email: string; password_hash: string; display_name: string | null;
    status: string; email_verified_at: string | null; is_super_admin: boolean;
  }>(
    `SELECT id, email, password_hash, display_name, status, email_verified_at, is_super_admin
     FROM users WHERE email = $1`,
    [email.toLowerCase().trim()],
  );
  return rows.rows[0] ?? null;
}

export async function resolveUserMembership(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  userId: string,
): Promise<{ tenantId: string; role: UserRole; tenantSlug: string } | null> {
  const rows = await client.query<{ tenant_id: string; role: string; slug: string }>(
    `SELECT m.tenant_id, m.role, t.slug
     FROM memberships m
     JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = $1 AND m.status = 'active'
     ORDER BY m.created_at ASC
     LIMIT 1`,
    [userId],
  );
  const r = rows.rows[0];
  if (!r) return null;
  return { tenantId: r.tenant_id, role: r.role as UserRole, tenantSlug: r.slug };
}

export async function provisionUserAndTenant(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  userId: string,
  displayName: string,
): Promise<{ userId: string; tenantId: string; role: UserRole; tenantSlug: string }> {
  const base = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30) || "org";
  const slug = `${base}-${Date.now().toString(36)}`;

  // Create tenant
  const tenant = await client.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
    [displayName || base, slug],
  );
  const tenantId = tenant.rows[0].id;

  // Create membership as owner
  await client.query(
    `INSERT INTO memberships (user_id, tenant_id, role, status)
     VALUES ($1, $2, 'owner', 'active')`,
    [userId, tenantId],
  );

  // Create default workflow
  await client.query(
    `INSERT INTO workflows (tenant_id, name, is_default, enabled, steps)
     VALUES ($1, 'Default sequence', TRUE, FALSE, '[]'::jsonb)`,
    [tenantId],
  );

  // Create credit wallet
  await client.query(
    `INSERT INTO credit_wallets (tenant_id, balance) VALUES ($1, 50)`,
    [tenantId],
  );

  // Create starter subscription
  await client.query(
    `INSERT INTO subscriptions
       (tenant_id, plan, status, credits_per_month, trial_started_at, trial_ends_at)
     VALUES ($1, 'free', 'trialing', 50, now(), now() + interval '14 days')`,
    [tenantId],
  );

  await client.query(
    `INSERT INTO credit_transactions (tenant_id, delta, reason, actor, created_at)
     VALUES ($1, 50, 'trial_grant', 'system', now())`,
    [tenantId],
  );

  // Create audit entry
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor, action, detail)
     VALUES ($1, $2, 'org_created', $3::jsonb)`,
    [tenantId, displayName, JSON.stringify({ plan: "free" })],
  );

  return { userId, tenantId, role: "owner", tenantSlug: slug };
}

// ─── Main authenticate function ──────────────────────────────────────────

export async function authenticate(req: FastifyRequest): Promise<AuthUser> {
  const token = extractCookieToken(req);
  if (!token) throw unauthorized("Missing session cookie");

  const tokenHash = hashToken(token);

  // Look up session → user → membership
  const rows = await servicePool.query<{
    user_id: string; session_type: "tenant" | "admin"; email: string; display_name: string | null;
    is_super_admin: boolean; status: string;
    tenant_id: string | null; role: string | null; slug: string | null;
  }>(
    `SELECT s.user_id, s.session_type, u.email, u.display_name, u.is_super_admin, u.status,
            m.tenant_id, m.role, t.slug
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
     LEFT JOIN tenants t ON t.id = m.tenant_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );

  const row = rows.rows[0];
  if (!row) throw unauthorized("Invalid or expired session");
  if (row.status !== "active") throw unauthorized("Account is not active");

  // Update last_seen_at (fire and forget)
  servicePool.query(`UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1`, [tokenHash]).catch(() => {});

  // Super admin with no tenant: return early
  if (row.session_type === "admin") {
    return {
      userId: row.user_id,
      tenantId: "",
      role: "owner",
      email: row.email,
      tenantSlug: "",
      isSuperAdmin: true,
      sessionType: "admin",
    };
  }

  if (!row.tenant_id || !row.role) {
    throw unauthorized("No organization associated with this account");
  }

  // Set tenant on the request's database connection
  await setTenantForRequest(req.db, row.tenant_id);

  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    role: row.role as UserRole,
    email: row.email,
    tenantSlug: row.slug ?? "",
    isSuperAdmin: row.is_super_admin,
    sessionType: "tenant",
  };
}

// ─── Dev login (non-prod) ────────────────────────────────────────────────

export async function devLogin(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  email: string,
): Promise<{ userId: string; tenantId: string; role: UserRole; tenantSlug: string; isSuperAdmin: boolean }> {
  const user = await findUserByEmail(client, email);
  if (!user) throw badRequest("User not found. Run the seed script first.", "USER_NOT_FOUND");
  if (user.status !== "active") throw badRequest("Account is not active", "ACCOUNT_INACTIVE");

  const membership = await resolveUserMembership(client, user.id);
  if (!membership) throw badRequest("No organization associated with this account", "NO_ORG");

  return {
    userId: user.id,
    tenantId: membership.tenantId,
    role: membership.role,
    tenantSlug: membership.tenantSlug,
    isSuperAdmin: user.is_super_admin,
  };
}
