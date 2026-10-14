import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { pool, releaseRequestClient } from "../lib/db.js";
import { authenticate, type AuthUser } from "../lib/auth.js";
import { forbidden } from "../lib/errors.js";
import type { UserRole } from "@autocollect/shared";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
    db: PoolClient;
  }
  interface FastifyContextConfig {
    /** Route does not require a session (webhooks, health, auth, OAuth callbacks). */
    public?: boolean;
    /** Authenticated route that also works for users without a workspace. */
    allowNoTenant?: boolean;
    /** fastify-raw-body: keep the raw request body (signature verification). */
    rawBody?: boolean;
  }
}

const released = new WeakSet<FastifyRequest>();

/** A route is public if marked so — or if no route matched (404s never need auth). */
export function isPublicRoute(req: FastifyRequest): boolean {
  if (!req.routeOptions?.url) return true;
  return Boolean((req.routeOptions.config as { public?: boolean } | undefined)?.public);
}

async function release(req: FastifyRequest): Promise<void> {
  const client = (req as { db?: PoolClient }).db;
  if (!client || released.has(req)) return;
  released.add(req);
  await releaseRequestClient(client);
}

/**
 * Authentication + per-request tenant scoping.
 * Every authenticated request gets a dedicated connection with app.tenant_id
 * set, so Postgres RLS isolates data for the whole request. The connection is
 * ALWAYS reset and returned — on normal completion and on client aborts — so a
 * tenant scope can never leak to the next borrower.
 */
export default fp(async (app: FastifyInstance) => {
  app.decorateRequest("db", null as unknown as PoolClient);
  app.decorateRequest("user", null as unknown as AuthUser);

  app.addHook("onRequest", async (req) => {
    if (isPublicRoute(req)) return;
    const client = await pool.connect();
    req.db = client;
    try {
      const allowNoTenant = Boolean((req.routeOptions.config as { allowNoTenant?: boolean }).allowNoTenant);
      req.user = await authenticate(req, { allowNoTenant });
      // Platform-admin sessions are a separate audience: only /admin routes
      // (and account routes that tolerate no workspace) accept them.
      if (req.user.sessionType === "admin" && !allowNoTenant && !req.routeOptions.url?.includes("/admin/")) {
        throw forbidden("Admin sessions can't access workspace routes", "ADMIN_SESSION");
      }
    } catch (err) {
      await release(req);
      throw err;
    }
  });

  app.addHook("onResponse", async (req) => release(req));
  app.addHook("onRequestAbort", async (req) => release(req));
});

const RANK: Record<UserRole, number> = { member: 0, admin: 1, owner: 2 };

/** Guard a route handler by minimum role. */
export function requireRole(role: UserRole) {
  return async function roleHook(req: FastifyRequest) {
    if (req.user.sessionType !== "tenant") throw forbidden("Workspace session required");
    if (RANK[req.user.role] < RANK[role]) throw forbidden(`This action requires the ${role} role`, "INSUFFICIENT_ROLE");
  };
}

/** Guard a route handler for super admin only. */
export function requireSuperAdmin() {
  return async function superAdminHook(req: FastifyRequest) {
    if (!req.user.isSuperAdmin || req.user.sessionType !== "admin") {
      throw forbidden("Requires super admin access");
    }
  };
}

/** Guard: tenant (workspace) session, any role. */
export function requireTenant() {
  return async function tenantHook(req: FastifyRequest) {
    if (req.user.sessionType !== "tenant" || !req.user.tenantId) throw forbidden("Workspace session required");
  };
}
