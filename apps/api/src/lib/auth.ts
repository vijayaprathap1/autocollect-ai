import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { query, setTenantForRequest } from "./db.js";
import { config } from "../config.js";
import { unauthorized } from "./errors.js";
import type { UserRole } from "@autocollect/shared";

export type AuthUser = {
  userId: string;
  tenantId: string;
  role: UserRole;
  email: string;
  tenantSlug: string;
};

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    const issuer = config.clerkIssuer;
    if (!issuer) throw unauthorized("Clerk issuer not configured");
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  }
  return jwks;
}

async function verifyClerkToken(token: string): Promise<{ sub: string; email?: string }> {
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: config.clerkIssuer,
    });
    return { sub: payload.sub ?? "", email: (payload.email as string | undefined) ?? undefined };
  } catch {
    throw unauthorized("Invalid session token");
  }
}

/**
 * Ensure a user + tenant exist, mirroring Clerk identity into our tables.
 * First-time sign-in creates an org workspace.
 */
export async function provisionUser(
  clerkUserId: string,
  email: string,
): Promise<AuthUser> {
  const existing = await query<{
    id: string; tenant_id: string; role: UserRole; email: string | null; slug: string;
  }>(
    `SELECT u.id, u.tenant_id, u.role, u.email, t.slug
       FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.clerk_user_id = $1`,
    [clerkUserId],
  );
  if (existing.rows[0]) {
    const r = existing.rows[0];
    return {
      userId: r.id, tenantId: r.tenant_id, role: r.role,
      email: r.email ?? email, tenantSlug: r.slug,
    };
  }

  const base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30) || "org";
  const slug = `${base}-${Date.now().toString(36)}`;

  const tx = await query<{ id: string; tenant_id: string }>(
    `WITH t AS (
       INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id
     ), u AS (
       INSERT INTO users (tenant_id, clerk_user_id, email, role)
       SELECT id, $3, $4, 'owner' FROM t RETURNING id, tenant_id
     )
     SELECT u.id, u.tenant_id FROM u`,
    [base, slug, clerkUserId, email],
  );
  const row = tx.rows[0];

  // Auto-create a default workflow so the tenant can start immediately
  await query(
    `INSERT INTO workflows (tenant_id, name, is_default, enabled, steps)
     VALUES ($1, 'Default sequence', TRUE, FALSE, '[]'::jsonb)`,
    [row.tenant_id],
  );

  return {
    userId: row.id, tenantId: row.tenant_id, role: "owner",
    email, tenantSlug: slug,
  };
}

/**
 * Authenticate a request. Dev mode (no Clerk) trusts the x-dev-user header
 * and provisions on the fly. Production uses Clerk session JWTs.
 */
export async function authenticate(req: FastifyRequest): Promise<AuthUser> {
  if (config.devAuthEnabled) {
    const email = (req.headers["x-dev-user"] as string | undefined)?.trim().toLowerCase();
    if (!email) throw unauthorized("Missing x-dev-user header (dev auth mode)");
    const user = await provisionUser(email, email);
    await setTenantForRequest(req.db, user.tenantId);
    return user;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized("Missing Bearer token");
  const token = header.slice(7);
  const { sub, email } = await verifyClerkToken(token);
  if (!sub) throw unauthorized("Invalid token subject");
  const user = await provisionUser(sub, email ?? "");
  await setTenantForRequest(req.db, user.tenantId);
  return user;
}