import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { pool } from "../lib/db.js";
import { authenticate, type AuthUser } from "../lib/auth.js";
import { forbidden } from "../lib/errors.js";
import type { UserRole } from "@autocollect/shared";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
    db: import("pg").PoolClient;
  }
}

/**
 * Authentication + per-request tenant scoping.
 * Public routes (webhooks, health) are marked `{ config: { public: true } }`.
 * Every authed request gets a dedicated connection with `app.tenant_id` set,
 * so Postgres RLS isolates data for the whole request lifetime.
 */
export default fp(async (app: FastifyInstance) => {
  app.addHook("onRequest", async (req) => {
    if ((req.routeOptions.config as { public?: boolean }).public) return;

    const client = await pool.connect();
    req.db = client;

    try {
      req.user = await authenticate(req);
    } catch (err) {
      client.release();
      throw err;
    }
  });

  app.addHook("onResponse", async (req, _reply) => {
    const client = (req as { db?: import("pg").PoolClient }).db;
    if (client) {
      try {
        client.release();
      } catch {
        /* ignore */
      }
    }
  });
});

/** Guard a route handler by minimum role. */
export function requireRole(role: UserRole) {
  return async function roleHook(req: import("fastify").FastifyRequest) {
    const roles: Record<UserRole, number> = { member: 0, admin: 1, owner: 2 };
    if (roles[req.user.role] < roles[role]) {
      throw forbidden(`Requires role: ${role}`);
    }
  };
}