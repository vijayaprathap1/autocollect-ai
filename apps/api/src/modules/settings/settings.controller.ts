import type { FastifyInstance } from "fastify";
import { requireRole } from "../../plugins/tenant.js";
import { badRequest, forbidden } from "../../lib/errors.js";
import { tenantPlan } from "../../lib/billing.js";

export type TenantBranding = {
  appName?: string;
  logoUrl?: string;
  primaryColor?: string;
  hideBranding?: boolean;
};

export async function settingsRoutes(app: FastifyInstance) {
  /**
   * White-label branding. Hiding the platform branding is gated to the
   * Agency plan; other fields are available to everyone.
   */
  app.put("/settings/branding", { preHandler: requireRole("admin") }, async (req) => {
    const body = (req.body ?? {}) as TenantBranding;

    const updates: Record<string, unknown> = {};
    if (typeof body.appName === "string" && body.appName.trim() !== "") updates.appName = body.appName.trim().slice(0, 60);
    if (typeof body.logoUrl === "string" && body.logoUrl.trim() !== "") {
      if (!/^https?:\/\/.+/.test(body.logoUrl)) throw badRequest("logoUrl must be an absolute http(s) URL");
      updates.logoUrl = body.logoUrl.trim();
    }
    if (typeof body.primaryColor === "string" && body.primaryColor.trim() !== "") {
      if (!/^#[0-9a-fA-F]{6}$/.test(body.primaryColor.trim())) throw badRequest("primaryColor must be a hex color like #2563EB");
      updates.primaryColor = body.primaryColor.trim();
    }
    if (typeof body.hideBranding === "boolean") {
      if (body.hideBranding) {
        const { plan } = await tenantPlan(req.db, req.user.tenantId);
        if (plan !== "agency") {
          throw forbidden("Hiding platform branding requires the Agency plan", "PLAN_GATE");
        }
      }
      updates.hideBranding = body.hideBranding;
    }

    if (Object.keys(updates).length === 0) throw badRequest("Nothing to update");

    const { plan } = await tenantPlan(req.db, req.user.tenantId);
    const current = await req.db.query<{ branding: Record<string, unknown> | null }>(
      `SELECT branding FROM tenants WHERE id = $1`,
      [req.user.tenantId],
    );
    const merged = { ...(current.rows[0]?.branding ?? {}), ...updates };

    await req.db.query(`UPDATE tenants SET branding = $2::jsonb WHERE id = $1`, [
      req.user.tenantId,
      JSON.stringify(merged),
    ]);
    await req.db.query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail)
       VALUES ($1, $2, 'branding_update', $3::jsonb)`,
      [req.user.tenantId, req.user.email, JSON.stringify(updates)],
    );

    return { branding: merged, plan };
  });
}