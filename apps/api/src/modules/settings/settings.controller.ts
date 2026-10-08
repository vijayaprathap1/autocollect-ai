import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../../plugins/tenant.js";
import { badRequest, forbidden } from "../../lib/errors.js";
import { tenantPlan } from "../../lib/billing.js";
import { isValidTimeZone } from "../../lib/schedule.js";

export type TenantBranding = {
  appName?: string;
  logoUrl?: string;
  primaryColor?: string;
  hideBranding?: boolean;
};

const organizationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    tone: z.enum(["friendly", "professional", "firm"]),
    currency: z.string().trim().toLowerCase().regex(/^[a-z]{3}$/, "Use a 3-letter ISO currency code"),
    timezone: z.string().trim().max(64).refine(isValidTimeZone, "Unknown time zone"),
    sendHour: z.number().int().min(0).max(23),
    skipWeekends: z.boolean(),
    replyNotifications: z.boolean(),
  })
  .partial();

export async function settingsRoutes(app: FastifyInstance) {
  /** Workspace details + reminder scheduling preferences. */
  app.put("/settings/organization", { preHandler: requireRole("admin") }, async (req) => {
    const body = organizationSchema.parse(req.body ?? {});
    const columns: Record<keyof typeof body, string> = {
      name: "name",
      tone: "tone",
      currency: "currency",
      timezone: "timezone",
      sendHour: "send_hour",
      skipWeekends: "skip_weekends",
      replyNotifications: "reply_notifications",
    };
    const sets: string[] = [];
    const values: unknown[] = [req.user.tenantId];
    for (const [key, col] of Object.entries(columns) as [keyof typeof body, string][]) {
      if (body[key] === undefined) continue;
      values.push(body[key]);
      sets.push(`${col} = $${values.length}`);
    }
    if (!sets.length) throw badRequest("Nothing to update");
    await req.db.query(`UPDATE tenants SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, values);

    // Scheduling changed: let the engine recompute every open invoice's next send time.
    if (body.timezone !== undefined || body.sendHour !== undefined || body.skipWeekends !== undefined) {
      await req.db.query(
        `UPDATE invoices SET next_step_due_at = NULL WHERE tenant_id = $1 AND status = 'open' AND next_step_index < 9999`,
        [req.user.tenantId],
      );
    }
    await req.db.query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'organization_updated', $3::jsonb)`,
      [req.user.tenantId, req.user.email, JSON.stringify(body)],
    );
    return { ok: true, organization: body };
  });

  /**
   * White-label branding. Hiding the platform branding is gated to the
   * Agency plan; other fields are available to everyone.
   */
  app.put("/settings/branding", { preHandler: requireRole("admin") }, async (req) => {
    const body = z
      .object({
        appName: z.string().trim().max(60).optional(),
        logoUrl: z.union([z.literal(""), z.string().trim().url().max(500).regex(/^https:\/\//, "Logo URL must use https://")]).optional(),
        primaryColor: z.union([z.literal(""), z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #2563EB")]).optional(),
        hideBranding: z.boolean().optional(),
      })
      .parse(req.body ?? {});

    const { plan } = await tenantPlan(req.db, req.user.tenantId);
    if (body.hideBranding && plan !== "agency") {
      throw forbidden("Hiding platform branding requires the Agency plan", "PLAN_GATE");
    }

    const current = await req.db.query<{ branding: TenantBranding | null }>(`SELECT branding FROM tenants WHERE id = $1`, [
      req.user.tenantId,
    ]);
    const merged: TenantBranding = { ...(current.rows[0]?.branding ?? {}) };
    // Empty string clears a field.
    for (const key of ["appName", "logoUrl", "primaryColor"] as const) {
      const v = body[key];
      if (v === undefined) continue;
      if (v === "") delete merged[key];
      else merged[key] = v;
    }
    if (body.hideBranding !== undefined) merged.hideBranding = body.hideBranding;

    await req.db.query(`UPDATE tenants SET branding = $2::jsonb, updated_at = now() WHERE id = $1`, [
      req.user.tenantId,
      JSON.stringify(merged),
    ]);
    await req.db.query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'branding_update', $3::jsonb)`,
      [req.user.tenantId, req.user.email, JSON.stringify(body)],
    );
    return { branding: merged, plan };
  });
}
