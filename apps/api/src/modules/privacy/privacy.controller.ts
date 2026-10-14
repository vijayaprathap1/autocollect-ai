import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../../plugins/tenant.js";
import { servicePool, withServiceTransaction } from "../../lib/db.js";
import { clearSessionCookie, findUserByEmail, recordLoginFailure, verifyPassword } from "../../lib/auth.js";
import { badRequest, conflict, unauthorized } from "../../lib/errors.js";
import { stripe, stripeEnabled } from "../../lib/stripe.js";
import { config } from "../../config.js";

/** Tables exported verbatim (all tenant-scoped). Integration credentials are never exported. */
const EXPORT_TABLES = ["customers", "invoices", "messages", "replies", "workflows", "templates", "credit_transactions", "audit_log"] as const;

const STRICT_LIMIT = { max: 5, timeWindow: "1 minute" };

/**
 * Re-authenticate before an irreversible action. Accounts created with Google
 * have no password; for those the typed confirmation is the safeguard.
 */
async function assertPassword(req: FastifyRequest, password: string | undefined): Promise<void> {
  const user = await findUserByEmail(servicePool, req.user.email);
  if (!user) throw unauthorized("User not found");
  if (!user.password_hash) return;
  if (!password || !(await verifyPassword(user.password_hash, password))) {
    await recordLoginFailure(user.id);
    throw badRequest("Your password is incorrect", "INVALID_PASSWORD");
  }
}

/**
 * GDPR tooling: data export (portability) and erasure for workspaces and
 * personal accounts.
 */
export async function privacyRoutes(app: FastifyInstance) {
  /** Download everything stored for the current workspace as JSON. Uses the RLS-scoped request connection. */
  app.get("/settings/export", { preHandler: requireRole("owner"), config: { rateLimit: STRICT_LIMIT } }, async (req, reply) => {
    const tenantId = req.user.tenantId;
    const tenant = await req.db.query(
      `SELECT id, name, slug, plan, status, currency, timezone, send_hour, skip_weekends, tone, branding, created_at
         FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const members = await req.db.query(
      `SELECT u.email, u.display_name, m.role, m.status, m.created_at
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 ORDER BY m.created_at`,
      [tenantId],
    );
    const integrations = await req.db.query(
      `SELECT id, source, status, created_at, updated_at FROM integrations WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    const data: Record<string, unknown[]> = {};
    for (const table of EXPORT_TABLES) {
      data[table] = (await req.db.query(`SELECT * FROM ${table} WHERE tenant_id = $1 ORDER BY created_at`, [tenantId])).rows;
    }
    await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'data_exported', '{}'::jsonb)`, [
      tenantId,
      req.user.email,
    ]);

    const slug = String(tenant.rows[0]?.slug ?? "workspace").replace(/[^a-z0-9-]/gi, "");
    reply.header("content-disposition", `attachment; filename="autocollect-${slug}-${new Date().toISOString().slice(0, 10)}.json"`);
    return {
      exportedAt: new Date().toISOString(),
      exportedBy: req.user.email,
      workspace: tenant.rows[0] ?? null,
      members: members.rows,
      integrations: integrations.rows,
      ...data,
    };
  });

  /**
   * Permanently delete the current workspace and all of its data. Cancels the
   * platform subscription and disconnects Stripe Connect first, so nothing keeps
   * billing or syncing afterwards.
   */
  app.post("/settings/delete-workspace", { preHandler: requireRole("owner"), config: { rateLimit: STRICT_LIMIT } }, async (req, reply) => {
    const body = z.object({ confirmName: z.string(), password: z.string().max(128).optional() }).parse(req.body ?? {});
    const tenantId = req.user.tenantId;
    const tenant = await req.db.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
    if (!tenant.rows[0] || body.confirmName.trim() !== tenant.rows[0].name.trim()) {
      throw badRequest("Type the workspace name exactly to confirm", "CONFIRMATION_MISMATCH");
    }
    await assertPassword(req, body.password);

    const sub = await req.db.query<{ stripe_subscription_id: string | null; status: string | null }>(
      `SELECT stripe_subscription_id, status FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    const connect = await req.db.query<{ account: string | null }>(
      `SELECT credentials->>'stripe_account_id' AS account FROM integrations WHERE tenant_id = $1 AND source = 'stripe' AND status = 'active'`,
      [tenantId],
    );
    if (stripeEnabled && stripe) {
      const subscriptionId = sub.rows[0]?.stripe_subscription_id;
      if (subscriptionId && sub.rows[0]?.status !== "canceled") {
        // Must succeed: deleting the workspace while Stripe keeps charging would be worse than refusing.
        await stripe.subscriptions.cancel(subscriptionId).catch((err: { code?: string }) => {
          if (err?.code !== "resource_missing") throw err;
        });
      }
      const account = connect.rows[0]?.account;
      if (account && config.stripeConnectClientId) {
        await stripe.oauth
          .deauthorize({ client_id: config.stripeConnectClientId, stripe_user_id: account })
          .catch((err: unknown) => req.log.warn({ err }, "stripe deauthorize failed during workspace deletion (continuing)"));
      }
    }

    await withServiceTransaction(async (client) => {
      // Tables without ON DELETE CASCADE to tenants.
      await client.query(`UPDATE users SET tenant_id = NULL WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM webhook_events WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]); // cascades everything else, incl. sessions
    });
    req.log.warn({ tenantId, actor: req.user.email }, "workspace deleted");
    clearSessionCookie(reply);
    return { ok: true };
  });

  /**
   * Permanently delete the signed-in user's account. Owners must first delete
   * their workspaces or transfer ownership, so no workspace is left without one.
   */
  app.post("/auth/delete-account", { config: { allowNoTenant: true, rateLimit: STRICT_LIMIT } }, async (req, reply) => {
    const body = z.object({ confirmEmail: z.string(), password: z.string().max(128).optional() }).parse(req.body ?? {});
    if (body.confirmEmail.trim().toLowerCase() !== req.user.email.toLowerCase()) {
      throw badRequest("Type your email address exactly to confirm", "CONFIRMATION_MISMATCH");
    }
    if (req.user.isSuperAdmin) throw badRequest("Platform admin accounts can't be deleted here", "SUPER_ADMIN");
    await assertPassword(req, body.password);

    const userId = req.user.userId;
    await withServiceTransaction(async (client) => {
      const owned = await client.query<{ name: string }>(
        `SELECT t.name FROM memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 AND m.role = 'owner' AND m.status = 'active'`,
        [userId],
      );
      if (owned.rows.length) {
        throw conflict(
          `You own ${owned.rows.map((r) => `"${r.name}"`).join(", ")}. Delete those workspaces or transfer ownership first.`,
          "OWNS_WORKSPACES",
        );
      }
      await client.query(`UPDATE invitations SET invited_by = NULL WHERE invited_by = $1`, [userId]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]); // cascades memberships, sessions, tokens
    });
    req.log.warn({ userId }, "user account deleted");
    clearSessionCookie(reply);
    return { ok: true };
  });
}
