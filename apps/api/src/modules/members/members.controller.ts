import type { FastifyInstance } from "fastify";
import { requireRole } from "../../plugins/tenant.js";
import { badRequest } from "../../lib/errors.js";
import { assertSeatCapacity } from "../../lib/billing.js";
import type { UserRole } from "@autocollect/shared";

export async function membersRoutes(app: FastifyInstance) {
  /**
   * List the tenant's members (seats).
   */
  app.get("/users", { preHandler: requireRole("admin") }, async (req) => {
    const rows = await req.db.query<{ id: string; email: string | null; role: string; created_at: string }>(
      `SELECT id, email, role, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [req.user.tenantId],
    );
    return {
      members: rows.rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        createdAt: r.created_at,
      })),
    };
  });

  /**
   * Invite a member by email (enforces the plan's seat limit).
   * In dev auth mode the invitee can log in with `x-dev-user: <email>` and
   * lands in this tenant.
   */
  app.post("/users", { preHandler: requireRole("admin") }, async (req) => {
    const body = (req.body ?? {}) as { email?: string; role?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Invalid email");
    const role: UserRole = body.role === "admin" ? "admin" : "member";

    await assertSeatCapacity(req.db, req.user.tenantId);

    const inserted = await req.db.query<{ id: string }>(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role)
       VALUES ($1, $2, $2, $3)
       ON CONFLICT (clerk_user_id) DO NOTHING
       RETURNING id`,
      [req.user.tenantId, email, role],
    );
    if (inserted.rows.length === 0) throw badRequest("That person is already a member of a workspace");

    await req.db.query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail)
       VALUES ($1, $2, 'member_added', $3::jsonb)`,
      [req.user.tenantId, req.user.email, JSON.stringify({ email, role })],
    );

    return { member: { id: inserted.rows[0].id, email, role } };
  });
}