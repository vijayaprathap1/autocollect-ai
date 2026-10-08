import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { servicePool, withServiceTransaction } from "../../lib/db.js";
import { requireRole, requireTenant } from "../../plugins/tenant.js";
import { ApiError, badRequest, conflict, forbidden, notFound, assertUuid } from "../../lib/errors.js";
import { assertSeatCapacity } from "../../lib/billing.js";
import {
  hashToken,
  generateToken,
  createSession,
  setSessionCookie,
  hashPassword,
  passwordSchema,
  emailSchema,
} from "../../lib/auth.js";
import { sendEmail } from "../../lib/postmark.js";
import { teamInviteEmail } from "../../lib/email-templates.js";

const INVITE_TTL_MS = 7 * 24 * 3_600_000;

function webUrl(path: string): string {
  return `${config.webOrigin.split(",")[0].replace(/\/$/, "")}${path}`;
}

export async function membersRoutes(app: FastifyInstance) {
  // ─── Members ─────────────────────────────────────────────────────────
  app.get("/users", { preHandler: requireTenant() }, async (req) => {
    const rows = await req.db.query<{
      id: string; email: string; display_name: string | null; role: string; created_at: string; last_login_at: string | null;
    }>(
      `SELECT u.id, u.email, u.display_name, m.role, m.created_at, u.last_login_at
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.status = 'active'
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at ASC`,
      [req.user.tenantId],
    );
    return {
      members: rows.rows.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        role: r.role,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
        isYou: r.id === req.user.userId,
      })),
    };
  });

  /** Change a member's role. Owners only; a workspace always keeps at least one owner. */
  app.put("/users/:id/role", { preHandler: requireRole("owner") }, async (req) => {
    const userId = assertUuid((req.params as { id: string }).id, "Member");
    const { role } = z.object({ role: z.enum(["owner", "admin", "member"]) }).parse(req.body ?? {});
    await withServiceTransaction(async (client) => {
      const owners = await client.query<{ user_id: string }>(
        `SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'owner' AND status = 'active' FOR UPDATE`,
        [req.user.tenantId],
      );
      const target = await client.query<{ role: string }>(
        `SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
        [req.user.tenantId, userId],
      );
      if (!target.rows[0]) throw notFound("Member not found");
      if (target.rows[0].role === "owner" && role !== "owner" && owners.rows.length <= 1) {
        throw conflict("A workspace needs at least one owner. Make someone else an owner first.", "LAST_OWNER");
      }
      await client.query(`UPDATE memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2`, [req.user.tenantId, userId, role]);
      await client.query(
        `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'member_role_changed', $3::jsonb)`,
        [req.user.tenantId, req.user.email, JSON.stringify({ user_id: userId, from: target.rows[0].role, to: role })],
      );
    });
    return { ok: true, role };
  });

  /** Remove a member (admins can remove members/admins; only owners can remove owners). */
  app.delete("/users/:id", { preHandler: requireRole("admin") }, async (req) => {
    const userId = assertUuid((req.params as { id: string }).id, "Member");
    if (userId === req.user.userId) throw badRequest("Use “Leave workspace” to remove yourself", "USE_LEAVE");
    await withServiceTransaction(async (client) => {
      const target = await client.query<{ role: string; email: string }>(
        `SELECT m.role, u.email FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active' FOR UPDATE OF m`,
        [req.user.tenantId, userId],
      );
      const t = target.rows[0];
      if (!t) throw notFound("Member not found");
      if (t.role === "owner" && req.user.role !== "owner") throw forbidden("Only an owner can remove another owner");
      if (t.role === "owner") {
        const owners = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'`,
          [req.user.tenantId],
        );
        if (owners.rows[0].n <= 1) throw conflict("A workspace needs at least one owner.", "LAST_OWNER");
      }
      await client.query(`DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [req.user.tenantId, userId]);
      // Sign them out of this workspace immediately.
      await client.query(`DELETE FROM sessions WHERE user_id = $1 AND (tenant_id = $2 OR tenant_id IS NULL)`, [userId, req.user.tenantId]);
      await client.query(
        `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'member_removed', $3::jsonb)`,
        [req.user.tenantId, req.user.email, JSON.stringify({ user_id: userId, email: t.email, role: t.role })],
      );
    });
    return { ok: true };
  });

  /** Leave the current workspace (the last owner can't leave). */
  app.post("/users/leave", { preHandler: requireTenant() }, async (req) => {
    await withServiceTransaction(async (client) => {
      if (req.user.role === "owner") {
        const owners = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'`,
          [req.user.tenantId],
        );
        if (owners.rows[0].n <= 1) throw conflict("You're the only owner. Transfer ownership before leaving.", "LAST_OWNER");
      }
      await client.query(`DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [req.user.tenantId, req.user.userId]);
      await client.query(`UPDATE sessions SET tenant_id = NULL WHERE user_id = $1 AND tenant_id = $2`, [req.user.userId, req.user.tenantId]);
      await client.query(
        `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'member_left', '{}'::jsonb)`,
        [req.user.tenantId, req.user.email],
      );
    });
    return { ok: true };
  });

  // ─── Invitations ─────────────────────────────────────────────────────
  app.get("/invitations", { preHandler: requireRole("admin") }, async (req) => {
    const rows = await req.db.query<{
      id: string; email: string; role: string; status: string; expires_at: string; created_at: string;
    }>(
      `SELECT id, email, role, status, expires_at, created_at
         FROM invitations WHERE tenant_id = $1 AND status = 'pending' AND expires_at > now()
        ORDER BY created_at DESC`,
      [req.user.tenantId],
    );
    return {
      invitations: rows.rows.map((r) => ({
        id: r.id, email: r.email, role: r.role, status: r.status, expiresAt: r.expires_at, createdAt: r.created_at,
      })),
    };
  });

  async function sendInvite(tenantId: string, email: string, role: string, inviter: { id: string; email: string; name: string | null }) {
    const rawToken = generateToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const created = await withServiceTransaction(async (client) => {
      await client.query(
        `UPDATE invitations SET status = 'revoked' WHERE tenant_id = $1 AND email = $2 AND status = 'pending'`,
        [tenantId, email],
      );
      const inv = await client.query<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenantId, email, role, hashToken(rawToken), inviter.id, expiresAt.toISOString()],
      );
      const org = await client.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
      return { id: inv.rows[0].id, orgName: org.rows[0]?.name ?? "a workspace" };
    });
    const inviteUrl = webUrl(`/accept-invite?id=${created.id}&token=${rawToken}`);
    const tmpl = teamInviteEmail(inviteUrl, inviter.name || inviter.email, created.orgName);
    await sendEmail({ to: email, subject: tmpl.subject, text: tmpl.text, html: tmpl.html, tag: "team-invite" });
    return { id: created.id, expiresAt: expiresAt.toISOString() };
  }

  app.post("/invitations", { preHandler: requireRole("admin"), config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const body = z
      .object({ email: emailSchema, role: z.enum(["admin", "member"]).default("member") })
      .parse(req.body ?? {});
    // Only owners may invite admins.
    if (body.role === "admin" && req.user.role !== "owner") throw forbidden("Only owners can invite admins");

    const existingMember = await req.db.query(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND u.email = $2 AND m.status = 'active'`,
      [req.user.tenantId, body.email],
    );
    if (existingMember.rows.length > 0) throw conflict("This person is already a member of your workspace", "ALREADY_MEMBER");

    // A replacement invite for the same email doesn't consume an extra seat.
    await assertSeatCapacity(req.db, req.user.tenantId, { excludeInvitationEmail: body.email });

    const inv = await sendInvite(req.user.tenantId, body.email, body.role, {
      id: req.user.userId, email: req.user.email, name: req.user.displayName,
    });
    await req.db.query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'member_invited', $3::jsonb)`,
      [req.user.tenantId, req.user.email, JSON.stringify({ email: body.email, role: body.role })],
    );
    return { invitation: { id: inv.id, email: body.email, role: body.role, status: "pending", expiresAt: inv.expiresAt } };
  });

  app.post("/invitations/:id/resend", { preHandler: requireRole("admin"), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Invitation");
    const row = await req.db.query<{ email: string; role: string }>(
      `SELECT email, role FROM invitations WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
      [id, req.user.tenantId],
    );
    if (!row.rows[0]) throw notFound("Invitation not found or already used");
    const inv = await sendInvite(req.user.tenantId, row.rows[0].email, row.rows[0].role, {
      id: req.user.userId, email: req.user.email, name: req.user.displayName,
    });
    return { ok: true, invitation: { id: inv.id, expiresAt: inv.expiresAt } };
  });

  app.delete("/invitations/:id", { preHandler: requireRole("admin") }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Invitation");
    const result = await req.db.query(
      `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND tenant_id = $2 AND status = 'pending' RETURNING id`,
      [id, req.user.tenantId],
    );
    if (result.rows.length === 0) throw notFound("Invitation not found or already processed");
    return { ok: true };
  });

  /** Public: what the accept page needs to render (workspace, email, new vs existing account). */
  app.get("/invitations/:id/preview", { config: { public: true, rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Invitation");
    const token = (req.query as { token?: string }).token ?? "";
    const row = await servicePool.query<{ email: string; role: string; org_name: string; account_exists: boolean }>(
      `SELECT i.email, i.role, t.name AS org_name,
              EXISTS (SELECT 1 FROM users u WHERE u.email = i.email) AS account_exists
         FROM invitations i JOIN tenants t ON t.id = i.tenant_id
        WHERE i.id = $1 AND i.token_hash = $2 AND i.status = 'pending' AND i.expires_at > now() AND t.status = 'active'`,
      [id, hashToken(token)],
    );
    const r = row.rows[0];
    if (!r) throw new ApiError(410, "INVALID_INVITATION", "This invitation is invalid, expired or was already used.");
    return { email: r.email, role: r.role, organizationName: r.org_name, accountExists: r.account_exists };
  });

  /**
   * Public: accept an invitation. The link was delivered to the invitee's
   * inbox, so it proves ownership of that address (like a reset link):
   *  - existing account  -> joins the workspace and is signed in to it
   *  - no account yet    -> must choose a name + password; the account is
   *                         created verified and ONLY joins this workspace
   */
  app.post("/invitations/:id/accept", { config: { public: true, rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const id = assertUuid((req.params as { id: string }).id, "Invitation");
    const body = z
      .object({
        token: z.string().min(10).max(200),
        displayName: z.string().trim().min(1).max(100).optional(),
        password: z.string().max(128).optional(),
      })
      .parse(req.body ?? {});

    const result = await withServiceTransaction(async (client) => {
      const invRes = await client.query<{ id: string; tenant_id: string; email: string; role: string }>(
        `SELECT i.id, i.tenant_id, i.email, i.role
           FROM invitations i JOIN tenants t ON t.id = i.tenant_id
          WHERE i.id = $1 AND i.token_hash = $2 AND i.status = 'pending' AND i.expires_at > now() AND t.status = 'active'
          FOR UPDATE OF i`,
        [id, hashToken(body.token)],
      );
      const inv = invRes.rows[0];
      if (!inv) throw new ApiError(410, "INVALID_INVITATION", "This invitation is invalid, expired or was already used.");

      const existing = await client.query<{ id: string; status: string; is_super_admin: boolean }>(
        `SELECT id, status, is_super_admin FROM users WHERE email = $1 FOR UPDATE`,
        [inv.email],
      );
      let userId: string;
      if (existing.rows[0]) {
        const u = existing.rows[0];
        if (u.status === "suspended") throw forbidden("This account has been suspended", "ACCOUNT_SUSPENDED");
        if (u.is_super_admin) throw forbidden("Platform admin accounts can't join workspaces", "ADMIN_ACCOUNT");
        userId = u.id;
        await client.query(
          `UPDATE users SET status = 'active', email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1`,
          [userId],
        );
      } else {
        if (!body.password || !body.displayName) {
          throw new ApiError(400, "ACCOUNT_DETAILS_REQUIRED", "Choose your name and a password to create your account.");
        }
        const password = passwordSchema.parse(body.password);
        const created = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, display_name, status, email_verified_at, password_changed_at)
           VALUES ($1, $2, $3, 'active', now(), now()) RETURNING id`,
          [inv.email, await hashPassword(password), body.displayName],
        );
        userId = created.rows[0].id;
      }

      const already = await client.query(
        `SELECT 1 FROM memberships WHERE user_id = $1 AND tenant_id = $2 AND status = 'active'`,
        [userId, inv.tenant_id],
      );
      if (!already.rows.length) {
        // Re-check seats at acceptance time (plan may have changed since invite).
        await assertSeatCapacity(client, inv.tenant_id, { countInvitations: false });
        await client.query(
          `INSERT INTO memberships (user_id, tenant_id, role, status) VALUES ($1, $2, $3, 'active')
           ON CONFLICT (user_id, tenant_id) DO UPDATE SET status = 'active', role = EXCLUDED.role`,
          [userId, inv.tenant_id, inv.role],
        );
        await client.query(
          `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'member_joined', $3::jsonb)`,
          [inv.tenant_id, inv.email, JSON.stringify({ role: inv.role })],
        );
      }
      await client.query(`UPDATE invitations SET status = 'accepted', accepted_at = now() WHERE id = $1`, [inv.id]);

      const token = await createSession(client, userId, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        tenantId: inv.tenant_id,
      });
      return { token, tenantId: inv.tenant_id };
    });

    setSessionCookie(reply, result.token);
    return { ok: true, tenantId: result.tenantId, message: "Welcome! You've joined the workspace." };
  });
}
