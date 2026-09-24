import type { FastifyInstance } from "fastify";
import { requireSuperAdmin } from "../../plugins/tenant.js";
import { servicePool } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import { config } from "../../config.js";
import { generateToken, hashToken } from "../../lib/auth.js";
import { passwordResetEmail } from "../../lib/email-templates.js";
import { postmarkEnabled, sendEmail } from "../../lib/postmark.js";
import { installDefaultSequence } from "../../lib/default-sequence.js";

/**
 * Super admin console endpoints.
 * All routes require super admin access.
 */
export async function adminRoutes(app: FastifyInstance) {
  // Create a tenant and its first owner without exposing password handling to the platform admin.
  app.post("/admin/tenants", { preHandler: requireSuperAdmin() }, async (req) => {
    const body = (req.body ?? {}) as { name?: string; ownerEmail?: string; ownerName?: string };
    const name = body.name?.trim();
    const ownerEmail = body.ownerEmail?.trim().toLowerCase();
    const ownerName = body.ownerName?.trim() || ownerEmail?.split("@")[0];
    if (!name) throw badRequest("Organization name is required");
    if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw badRequest("Valid owner email is required");

    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30) || "org"}-${Date.now().toString(36)}`;
    const token = generateToken();
    const client = await servicePool.connect();
    let tenantId = "";
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [ownerEmail]);
      if (existing.rows.length) throw badRequest("That owner email already has an account", "EMAIL_EXISTS");
      const tenant = await client.query<{ id: string }>(`INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`, [name, slug]);
      tenantId = tenant.rows[0].id;
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, status, email_verified_at)
         VALUES ($1, 'needs_password_reset', $2, 'active', NULL) RETURNING id`,
        [ownerEmail, ownerName],
      );
      await client.query(`INSERT INTO memberships (user_id, tenant_id, role, status) VALUES ($1, $2, 'owner', 'active')`, [user.rows[0].id, tenantId]);
      await client.query(`INSERT INTO workflows (tenant_id, name, is_default, enabled, steps) VALUES ($1, 'Default sequence', TRUE, FALSE, '[]'::jsonb)`, [tenantId]);
      await installDefaultSequence(client, tenantId);
      await client.query(`INSERT INTO credit_wallets (tenant_id, balance) VALUES ($1, 50)`, [tenantId]);
      await client.query(`INSERT INTO subscriptions (tenant_id, plan, status, credits_per_month) VALUES ($1, 'free', 'active', 50)`, [tenantId]);
      const tokenHash = hashToken(token);
      await client.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [user.rows[0].id, tokenHash, new Date(Date.now() + config.resetTokenTtlMinutes * 60_000).toISOString()]);
      await client.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'org_created_by_super_admin', $3::jsonb)`, [tenantId, req.user.email, JSON.stringify({ ownerEmail })]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const setupUrl = `${config.webOrigin}/reset-password?token=${token}`;
    if (postmarkEnabled) {
      const email = passwordResetEmail(setupUrl, ownerName ?? ownerEmail);
      await sendEmail({ to: ownerEmail, subject: email.subject, text: email.text, html: email.html, tag: "tenant-owner-setup" });
    } else {
      console.log(`\nOwner setup link for ${ownerEmail}:\n   ${setupUrl}\n`);
    }
    return { ok: true, tenant: { id: tenantId, name, slug }, owner: { email: ownerEmail }, setupSent: postmarkEnabled };
  });

  // GET /admin/stats — system-wide statistics
  app.get("/admin/stats", { preHandler: requireSuperAdmin() }, async (req) => {
    const [tenants, users, invoices, messages, credits] = await Promise.all([
      servicePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM tenants`),
      servicePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM users`),
      servicePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM invoices`),
      servicePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM messages`),
      servicePool.query<{ total: string }>(`SELECT COALESCE(sum(balance), 0)::text AS total FROM credit_wallets`),
    ]);
    return {
      tenants: Number(tenants.rows[0].count),
      users: Number(users.rows[0].count),
      invoices: Number(invoices.rows[0].count),
      messages: Number(messages.rows[0].count),
      totalCredits: Number(credits.rows[0].total),
    };
  });

  // GET /admin/tenants — list all tenants with details
  app.get("/admin/tenants", { preHandler: requireSuperAdmin() }, async (req) => {
    const rows = await servicePool.query<{
      id: string; name: string; slug: string; plan: string; status: string;
      invoice_count: string; user_count: string; credit_balance: number;
      created_at: string;
    }>(
      `SELECT t.id, t.name, t.slug, t.plan, t.status, t.created_at,
              (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id) AS invoice_count,
              (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS user_count,
              COALESCE((SELECT cw.balance FROM credit_wallets cw WHERE cw.tenant_id = t.id), 0) AS credit_balance
       FROM tenants t
       ORDER BY t.created_at DESC`,
    );
    return {
      tenants: rows.rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        plan: r.plan,
        status: r.status,
        invoiceCount: Number(r.invoice_count),
        userCount: Number(r.user_count),
        creditBalance: r.credit_balance,
        createdAt: r.created_at,
      })),
    };
  });

  // GET /admin/users — list all users
  app.get("/admin/users", { preHandler: requireSuperAdmin() }, async (req) => {
    const rows = await servicePool.query<{
      id: string; email: string; display_name: string | null; status: string;
      is_super_admin: boolean; last_login_at: string | null; created_at: string;
      tenant_name: string | null; role: string | null;
    }>(
      `SELECT u.id, u.email, u.display_name, u.status, u.is_super_admin,
              u.last_login_at, u.created_at,
              t.name AS tenant_name, m.role
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
       LEFT JOIN tenants t ON t.id = m.tenant_id
       ORDER BY u.created_at DESC`,
    );
    return {
      users: rows.rows.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        status: r.status,
        isSuperAdmin: r.is_super_admin,
        lastLoginAt: r.last_login_at,
        createdAt: r.created_at,
        tenantName: r.tenant_name,
        role: r.role,
      })),
    };
  });

  // PUT /admin/tenants/:id/status — update tenant status (suspend/activate)
  app.put("/admin/tenants/:id/status", { preHandler: requireSuperAdmin() }, async (req) => {
    const params = req.params as { id?: string };
    const body = (req.body ?? {}) as { status?: string };
    if (!body.status || !["active", "suspended"].includes(body.status)) {
      throw new Error("Status must be 'active' or 'suspended'");
    }
    await servicePool.query(
      `UPDATE tenants SET status = $2, updated_at = now() WHERE id = $1`,
      [params.id, body.status],
    );
    return { ok: true };
  });
}
