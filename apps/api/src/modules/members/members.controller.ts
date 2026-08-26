import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { pool } from "../../lib/db.js";
import { requireRole } from "../../plugins/tenant.js";
import { badRequest } from "../../lib/errors.js";
import { assertSeatCapacity } from "../../lib/billing.js";
import { hashToken, generateToken, createSession, setSessionCookie } from "../../lib/auth.js";
import { sendEmail, postmarkEnabled } from "../../lib/postmark.js";
import { teamInviteEmail } from "../../lib/email-templates.js";
import type { UserRole } from "@autocollect/shared";

export async function membersRoutes(app: FastifyInstance) {
  // GET /users - list members via memberships
  app.get("/users", { preHandler: requireRole("admin") }, async (req) => {
    const rows = await req.db.query<{
      id: string; email: string; display_name: string | null; role: string; created_at: string;
    }>(
      `SELECT u.id, u.email, u.display_name, m.role, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1 AND m.status = 'active'
       ORDER BY m.created_at ASC`,
      [req.user.tenantId],
    );
    return {
      members: rows.rows.map((r) => ({
        id: r.id, email: r.email, displayName: r.display_name, role: r.role, createdAt: r.created_at,
      })),
    };
  });

  // GET /invitations - list pending invitations
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
        id: r.id, email: r.email, role: r.role, status: r.status,
        expiresAt: r.expires_at, createdAt: r.created_at,
      })),
    };
  });

  // POST /invitations - send invitation
  app.post("/invitations", { preHandler: requireRole("admin") }, async (req) => {
    const body = (req.body ?? {}) as { email?: string; role?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Invalid email");
    const role: UserRole = body.role === "admin" ? "admin" : "member";

    await assertSeatCapacity(req.db, req.user.tenantId);

    const existingMember = await req.db.query<{ id: string }>(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1 AND u.email = $2`,
      [req.user.tenantId, email],
    );
    if (existingMember.rows.length > 0) {
      throw badRequest("This person is already a member of your organization");
    }

    await req.db.query(
      `UPDATE invitations SET status = 'revoked'
       WHERE tenant_id = $1 AND email = $2 AND status = 'pending'`,
      [req.user.tenantId, email],
    );

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 3_600_000);

    const result = await req.db.query<{ id: string }>(
      `INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.user.tenantId, email, role, tokenHash, req.user.userId, expiresAt.toISOString()],
    );

    const inviteUrl = `${config.webOrigin}/accept-invite?id=${result.rows[0].id}&token=${rawToken}`;
    const orgName = req.user.tenantSlug ?? "an organization";

    if (postmarkEnabled) {
      const tmpl = teamInviteEmail(inviteUrl, req.user.email, orgName);
      await sendEmail({ to: email, subject: tmpl.subject, text: tmpl.text, html: tmpl.html, tag: "team-invite" })
        .catch((err: Error) => console.error("Failed to send invitation email:", err));
    } else {
      console.log(`\nTeam invitation for ${email}:\n   ${inviteUrl}\n`);
    }

    await req.db.query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail)
       VALUES ($1, $2, 'member_invited', $3::jsonb)`,
      [req.user.tenantId, req.user.email, JSON.stringify({ email, role })],
    );

    return { invitation: { id: result.rows[0].id, email, role, expiresAt: expiresAt.toISOString() } };
  });

  // POST /invitations/:id/accept - accept invitation (public, auto-logs in)
  app.post("/invitations/:id/accept", { config: { public: true } }, async (req, reply) => {
    const params = req.params as { id?: string };
    const body = (req.body ?? {}) as { token?: string };
    if (!body.token) throw badRequest("Token is required");

    const tokenHash = hashToken(body.token);
    const invitation = await pool.query<{
      id: string; tenant_id: string; email: string; role: string;
    }>(
      `SELECT id, tenant_id, email, role FROM invitations
       WHERE id = $1 AND token_hash = $2 AND status = 'pending' AND expires_at > now()`,
      [params.id, tokenHash],
    );
    if (invitation.rows.length === 0) {
      throw badRequest("Invalid or expired invitation", "INVALID_INVITATION");
    }
    const inv = invitation.rows[0];

    const existingUser = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`, [inv.email],
    );
    if (existingUser.rows.length === 0) {
      throw badRequest("No account found for this email. Please sign up first.", "ACCOUNT_REQUIRED");
    }
    const userId = existingUser.rows[0].id;

    const alreadyMember = await pool.query<{ id: string }>(
      `SELECT 1 FROM memberships WHERE user_id = $1 AND tenant_id = $2`,
      [userId, inv.tenant_id],
    );
    if (alreadyMember.rows.length > 0) {
      await pool.query(`UPDATE invitations SET status = 'accepted', accepted_at = now() WHERE id = $1`, [inv.id]);
      // Auto-login
      const sessionToken = await createSession(pool, userId, req.ip, req.headers["user-agent"]);
      setSessionCookie(reply, sessionToken);
      return { ok: true, message: "You are already a member of this organization" };
    }

    await pool.query(
      `INSERT INTO memberships (user_id, tenant_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [userId, inv.tenant_id, inv.role],
    );
    await pool.query(`UPDATE invitations SET status = 'accepted', accepted_at = now() WHERE id = $1`, [inv.id]);
    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'member_joined', $3::jsonb)`,
      [inv.tenant_id, inv.email, JSON.stringify({ role: inv.role })],
    );

    // Auto-login after accepting invitation
    const sessionToken = await createSession(pool, userId, req.ip, req.headers["user-agent"]);
    setSessionCookie(reply, sessionToken);

    return { ok: true, message: "Welcome! You have joined the organization." };
  });

  // DELETE /invitations/:id - revoke invitation
  app.delete("/invitations/:id", { preHandler: requireRole("admin") }, async (req) => {
    const params = req.params as { id?: string };
    const result = await req.db.query(
      `UPDATE invitations SET status = 'revoked'
       WHERE id = $1 AND tenant_id = $2 AND status = 'pending' RETURNING id`,
      [params.id, req.user.tenantId],
    );
    if (result.rows.length === 0) throw badRequest("Invitation not found or already processed");
    return { ok: true };
  });
}
