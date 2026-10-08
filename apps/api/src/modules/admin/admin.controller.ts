import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSuperAdmin } from "../../plugins/tenant.js";
import { servicePool, withServiceTransaction } from "../../lib/db.js";
import { conflict, notFound, assertUuid } from "../../lib/errors.js";
import { config } from "../../config.js";
import { generateToken, hashToken, provisionUserAndTenant, emailSchema } from "../../lib/auth.js";
import { accountSetupEmail } from "../../lib/email-templates.js";
import { sendEmail } from "../../lib/postmark.js";
import { isPlanKey, setTenantPlan, PLAN_KEYS } from "../../lib/billing.js";

const SETUP_LINK_TTL_MINUTES = 72 * 60;

const pageSchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

async function platformAudit(actor: string, action: string, detail: Record<string, unknown>, tenantId: string | null = null) {
  await servicePool
    .query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, $3, $4::jsonb)`, [
      tenantId,
      `admin:${actor}`,
      action,
      JSON.stringify(detail),
    ])
    .catch(() => {});
}

/** Super admin console. Every route requires an admin-audience session. */
export async function adminRoutes(app: FastifyInstance) {
  const guard = { preHandler: requireSuperAdmin() };

  // Create a workspace + first owner; the owner receives a set-password link.
  app.post("/admin/tenants", guard, async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(1, "Organization name is required").max(120),
        ownerEmail: emailSchema,
        ownerName: z.string().trim().max(100).optional(),
      })
      .parse(req.body ?? {});
    const ownerName = body.ownerName || body.ownerEmail.split("@")[0];
    const token = generateToken();

    const created = await withServiceTransaction(async (client) => {
      const existing = await client.query(`SELECT 1 FROM users WHERE email = $1`, [body.ownerEmail]);
      if (existing.rows.length) throw conflict("That owner email already has an account", "EMAIL_EXISTS");
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, status, email_verified_at)
         VALUES ($1, NULL, $2, 'active', NULL) RETURNING id`,
        [body.ownerEmail, ownerName],
      );
      const org = await provisionUserAndTenant(client, user.rows[0].id, body.name, `admin:${req.user.email}`);
      await client.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
        user.rows[0].id,
        hashToken(token),
        new Date(Date.now() + SETUP_LINK_TTL_MINUTES * 60_000).toISOString(),
      ]);
      return org;
    });

    const setupUrl = `${config.webOrigin.split(",")[0]}/reset-password?token=${token}&setup=1`;
    let setupSent = true;
    try {
      const email = accountSetupEmail(setupUrl, ownerName, body.name);
      await sendEmail({ to: body.ownerEmail, subject: email.subject, text: email.text, html: email.html, tag: "tenant-owner-setup" });
    } catch (err) {
      setupSent = false;
      req.log.error({ err }, "failed to send owner setup email");
    }
    await platformAudit(req.user.email, "tenant_created", { ownerEmail: body.ownerEmail, name: body.name }, created.tenantId);
    return { ok: true, tenant: { id: created.tenantId, name: body.name, slug: created.tenantSlug }, owner: { email: body.ownerEmail }, setupSent };
  });

  app.get("/admin/stats", guard, async () => {
    const r = await servicePool.query<{
      tenants: number; active_tenants: number; users: number; invoices: number; open_invoices: number;
      messages_30d: number; credits: number; paid_tenants: number; outstanding_cents: number;
    }>(
      `SELECT (SELECT count(*) FROM tenants)::int AS tenants,
              (SELECT count(*) FROM tenants WHERE status = 'active')::int AS active_tenants,
              (SELECT count(*) FROM users WHERE NOT is_super_admin)::int AS users,
              (SELECT count(*) FROM invoices)::int AS invoices,
              (SELECT count(*) FROM invoices WHERE status = 'open')::int AS open_invoices,
              (SELECT count(*) FROM messages WHERE sent_at > now() - interval '30 days')::int AS messages_30d,
              (SELECT COALESCE(sum(balance), 0) FROM credit_wallets)::int AS credits,
              (SELECT count(*) FROM tenants WHERE plan <> 'starter')::int AS paid_tenants,
              (SELECT COALESCE(sum(amount_due), 0) FROM invoices WHERE status = 'open')::bigint AS outstanding_cents`,
    );
    const s = r.rows[0];
    return {
      tenants: s.tenants,
      activeTenants: s.active_tenants,
      paidTenants: s.paid_tenants,
      users: s.users,
      invoices: s.invoices,
      openInvoices: s.open_invoices,
      messages: s.messages_30d,
      messages30d: s.messages_30d,
      totalCredits: s.credits,
      outstandingCents: Number(s.outstanding_cents),
    };
  });

  app.get("/admin/tenants", guard, async (req) => {
    const { q, limit, offset } = pageSchema.parse(req.query ?? {});
    const rows = await servicePool.query<{
      id: string; name: string; slug: string; plan: string; status: string; created_at: string;
      invoice_count: number; user_count: number; credit_balance: number; owner_email: string | null;
    }>(
      `SELECT t.id, t.name, t.slug, t.plan, t.status, t.created_at,
              (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id)::int AS invoice_count,
              (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active')::int AS user_count,
              COALESCE((SELECT cw.balance FROM credit_wallets cw WHERE cw.tenant_id = t.id), 0) AS credit_balance,
              (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
                WHERE m.tenant_id = t.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_email
         FROM tenants t
        WHERE ($1::text IS NULL OR t.name ILIKE '%' || $1 || '%' OR t.slug ILIKE '%' || $1 || '%')
        ORDER BY t.created_at DESC
        LIMIT $2 OFFSET $3`,
      [q ?? null, limit + 1, offset],
    );
    return {
      tenants: rows.rows.slice(0, limit).map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        plan: r.plan,
        status: r.status,
        invoiceCount: r.invoice_count,
        userCount: r.user_count,
        creditBalance: r.credit_balance,
        ownerEmail: r.owner_email,
        createdAt: r.created_at,
      })),
      hasMore: rows.rows.length > limit,
    };
  });

  app.get("/admin/users", guard, async (req) => {
    const { q, limit, offset } = pageSchema.parse(req.query ?? {});
    const rows = await servicePool.query<{
      id: string; email: string; display_name: string | null; status: string; is_super_admin: boolean;
      last_login_at: string | null; created_at: string; tenant_name: string | null; role: string | null; locked: boolean;
    }>(
      `SELECT u.id, u.email, u.display_name, u.status, u.is_super_admin, u.last_login_at, u.created_at,
              (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
              mm.name AS tenant_name, mm.role
         FROM users u
         LEFT JOIN LATERAL (
           SELECT t.name, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id
            WHERE m.user_id = u.id AND m.status = 'active' ORDER BY m.created_at LIMIT 1
         ) mm ON TRUE
        WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%')
        ORDER BY u.created_at DESC
        LIMIT $2 OFFSET $3`,
      [q ?? null, limit + 1, offset],
    );
    return {
      users: rows.rows.slice(0, limit).map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        status: r.status,
        isSuperAdmin: r.is_super_admin,
        locked: r.locked,
        lastLoginAt: r.last_login_at,
        createdAt: r.created_at,
        tenantName: r.tenant_name,
        role: r.role,
      })),
      hasMore: rows.rows.length > limit,
    };
  });

  // Suspend / reactivate a workspace. Suspension signs members out and pauses dunning.
  app.put("/admin/tenants/:id/status", guard, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Tenant");
    const { status } = z.object({ status: z.enum(["active", "suspended"]) }).parse(req.body ?? {});
    const res = await servicePool.query(`UPDATE tenants SET status = $2, updated_at = now() WHERE id = $1 RETURNING id`, [id, status]);
    if (!res.rowCount) throw notFound("Tenant not found");
    if (status === "suspended") {
      await servicePool.query(`DELETE FROM sessions WHERE tenant_id = $1`, [id]);
    }
    await platformAudit(req.user.email, status === "suspended" ? "tenant_suspended" : "tenant_reactivated", {}, id);
    return { ok: true, status };
  });

  // Manually set a plan (comped / enterprise deals). Stripe-managed plans will be re-synced by webhooks.
  app.put("/admin/tenants/:id/plan", guard, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Tenant");
    const { plan } = z.object({ plan: z.enum(PLAN_KEYS as [string, ...string[]]) }).parse(req.body ?? {});
    if (!isPlanKey(plan)) throw notFound("Unknown plan");
    await setTenantPlan(servicePool, id, plan);
    await platformAudit(req.user.email, "plan_set_by_admin", { plan }, id);
    return { ok: true, plan };
  });

  // Credit adjustment for support (positive grant or negative correction).
  app.post("/admin/tenants/:id/credits", guard, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Tenant");
    const { amount, reason } = z
      .object({
        amount: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, "Amount can't be zero"),
        reason: z.string().trim().min(3).max(200),
      })
      .parse(req.body ?? {});
    const balance = await withServiceTransaction(async (client) => {
      const w = await client.query<{ balance: number }>(
        `INSERT INTO credit_wallets (tenant_id, balance) VALUES ($1, GREATEST($2, 0))
         ON CONFLICT (tenant_id) DO UPDATE SET balance = GREATEST(credit_wallets.balance + $2, 0), updated_at = now()
         RETURNING balance`,
        [id, amount],
      );
      await client.query(
        `INSERT INTO credit_transactions (tenant_id, delta, reason, reference_id, actor) VALUES ($1, $2, 'admin_adjustment', $3, $4)`,
        [id, amount, reason, `admin:${req.user.email}`],
      );
      return w.rows[0].balance;
    });
    await platformAudit(req.user.email, "credits_adjusted", { amount, reason }, id);
    return { ok: true, balance };
  });

  // Unlock a user locked out by failed sign-ins.
  app.post("/admin/users/:id/unlock", guard, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "User");
    const res = await servicePool.query(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [id]);
    if (!res.rowCount) throw notFound("User not found");
    await platformAudit(req.user.email, "user_unlocked", { user_id: id });
    return { ok: true };
  });
}
