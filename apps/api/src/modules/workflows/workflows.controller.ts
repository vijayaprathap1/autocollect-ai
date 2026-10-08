import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../../plugins/tenant.js";
import { badRequest, notFound, assertUuid } from "../../lib/errors.js";
import { draftReminderTemplates } from "../../lib/ai.js";
import { linkDefaultWorkflowSteps } from "../../lib/default-sequence.js";
import { smsEnabled } from "../../lib/sms.js";
import { isProduction } from "../../config.js";
import { unknownPlaceholders, TEMPLATE_VARIABLES } from "./render.js";
import type { TenantTone, WorkflowStep } from "@autocollect/shared";

const stepSchema = z.object({
  order: z.number().int().min(0).max(50).optional(),
  delayDays: z.number().int().min(-60).max(365),
  channel: z.enum(["email", "sms"]),
  templateId: z.string().uuid().nullable(),
});

const workflowUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  steps: z.array(stepSchema).max(20).optional(),
});

export async function workflowRoutes(app: FastifyInstance) {
  app.get("/workflows", async (req) => {
    const rows = await req.db.query<{
      id: string; name: string; is_default: boolean; enabled: boolean; steps: WorkflowStep[]; created_at: string;
    }>(`SELECT id, name, is_default, enabled, steps, created_at FROM workflows WHERE tenant_id = $1 ORDER BY is_default DESC, created_at`, [
      req.user.tenantId,
    ]);
    return {
      workflows: rows.rows.map((r) => ({
        id: r.id, name: r.name, isDefault: r.is_default, enabled: r.enabled, steps: r.steps, createdAt: r.created_at,
      })),
      smsAvailable: smsEnabled || !isProduction,
    };
  });

  app.put("/workflows/:id", { preHandler: requireRole("admin") }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Workflow");
    const body = workflowUpdateSchema.parse(req.body ?? {});

    const exists = await req.db.query<{ id: string }>(`SELECT id FROM workflows WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
    if (!exists.rows.length) throw notFound("Workflow not found");

    const sets: string[] = [];
    const values: unknown[] = [id];
    const add = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (body.enabled !== undefined) sets.push(`enabled = ${add(body.enabled)}`);
    if (body.name !== undefined) sets.push(`name = ${add(body.name)}`);

    let steps: WorkflowStep[] | undefined;
    if (body.steps !== undefined) {
      // Canonical order is by timing; `order` is rewritten to match.
      steps = [...body.steps]
        .sort((a, b) => a.delayDays - b.delayDays)
        .map((s, i) => ({ order: i, delayDays: s.delayDays, channel: s.channel, templateId: s.templateId }));
      const delays = steps.map((s) => s.delayDays);
      if (new Set(delays).size !== delays.length) throw badRequest("Two steps can't be scheduled on the same day", "DUPLICATE_STEP_DAY");
      if (steps.some((s) => s.channel === "sms") && isProduction && !smsEnabled) {
        throw badRequest("SMS isn't configured for this account yet — use email steps", "SMS_NOT_CONFIGURED");
      }
      const templateIds = [...new Set(steps.map((s) => s.templateId).filter((t): t is string => Boolean(t)))];
      if (templateIds.length) {
        const owned = await req.db.query<{ id: string }>(`SELECT id FROM templates WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [
          req.user.tenantId,
          templateIds,
        ]);
        if (owned.rows.length !== templateIds.length) throw badRequest("A step references a template that doesn't exist", "UNKNOWN_TEMPLATE");
      }
      if (steps.some((s) => !s.templateId)) throw badRequest("Every step needs a template", "STEP_WITHOUT_TEMPLATE");
      sets.push(`steps = ${add(JSON.stringify(steps))}::jsonb`);
    }

    if (sets.length === 0) throw badRequest("Nothing to update");
    await req.db.query(`UPDATE workflows SET ${sets.join(", ")} WHERE id = $1`, values);

    if (steps !== undefined || body.enabled === true) {
      // Recompute send times for open invoices on this workflow (the engine's
      // minimum-gap guard prevents back-to-back sends after a change).
      await req.db.query(
        `UPDATE invoices SET next_step_due_at = NULL,
                next_step_index = LEAST(next_step_index, $3)
          WHERE tenant_id = $1 AND status = 'open' AND next_step_index < 9999
            AND (workflow_id = $2 OR workflow_id IS NULL)`,
        [req.user.tenantId, id, steps ? steps.length : 9998],
      );
    }
    await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'workflow_update', $3::jsonb)`, [
      req.user.tenantId,
      req.user.email,
      JSON.stringify({ workflow_id: id, enabled: body.enabled, steps: steps?.length, name: body.name }),
    ]);

    const updated = await req.db.query<{ id: string; name: string; is_default: boolean; enabled: boolean; steps: WorkflowStep[] }>(
      `SELECT id, name, is_default, enabled, steps FROM workflows WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tenantId],
    );
    const w = updated.rows[0];
    return { workflow: { id: w.id, name: w.name, isDefault: w.is_default, enabled: w.enabled, steps: w.steps } };
  });

  app.get("/templates", async (req) => {
    const rows = await req.db.query<{ id: string; step_key: string; subject: string; body: string; approved: boolean; created_at: string }>(
      `SELECT id, step_key, subject, body, approved, created_at FROM templates WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [req.user.tenantId],
    );
    return {
      templates: rows.rows.map((r) => ({
        id: r.id,
        stepKey: r.step_key,
        subject: r.subject,
        body: r.body,
        approved: r.approved,
        createdAt: r.created_at,
        unknownPlaceholders: unknownPlaceholders(`${r.subject}\n${r.body}`),
      })),
      variables: TEMPLATE_VARIABLES,
    };
  });

  app.post("/templates/draft", { preHandler: requireRole("admin"), config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const tenant = await req.db.query<{ tone: string }>(`SELECT tone FROM tenants WHERE id = $1`, [req.user.tenantId]);
    const tone = (tenant.rows[0]?.tone ?? "friendly") as TenantTone;
    const drafts = await draftReminderTemplates(tone);

    for (const d of drafts) {
      await req.db.query(
        `INSERT INTO templates (tenant_id, step_key, subject, body, approved)
         VALUES ($1, $2, $3, $4, FALSE)
         ON CONFLICT (tenant_id, step_key)
         DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, approved = FALSE`,
        [req.user.tenantId, d.stepKey, d.subject, d.body],
      );
    }
    await linkDefaultWorkflowSteps(req.db, req.user.tenantId);
    await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'templates_drafted', $3::jsonb)`, [
      req.user.tenantId,
      req.user.email,
      JSON.stringify({ count: drafts.length, tone }),
    ]);
    return { drafts };
  });

  app.put("/templates/:id", { preHandler: requireRole("admin") }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Template");
    const body = z
      .object({
        subject: z.string().trim().min(1).max(250).optional(),
        body: z.string().trim().min(1).max(10_000).optional(),
        approved: z.boolean().optional(),
      })
      .parse(req.body ?? {});

    const exists = await req.db.query<{ id: string }>(`SELECT id FROM templates WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
    if (!exists.rows.length) throw notFound("Template not found");

    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, col] of [["subject", "subject"], ["body", "body"], ["approved", "approved"]] as const) {
      if (body[key] === undefined) continue;
      values.push(body[key]);
      sets.push(`${col} = $${values.length}`);
    }
    if (!sets.length) throw badRequest("Nothing to update");
    await req.db.query(`UPDATE templates SET ${sets.join(", ")} WHERE id = $1`, values);

    if (body.approved === true) {
      await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'template_approved', $3::jsonb)`, [
        req.user.tenantId,
        req.user.email,
        JSON.stringify({ template_id: id }),
      ]);
      // Invoices waiting on this approval are picked up on the next run.
      await req.db.query(
        `UPDATE invoices SET next_step_due_at = NULL WHERE tenant_id = $1 AND status = 'open' AND next_step_index < 9999 AND next_step_due_at > now()`,
        [req.user.tenantId],
      );
    }

    const updated = await req.db.query<{ id: string; step_key: string; subject: string; body: string; approved: boolean }>(
      `SELECT id, step_key, subject, body, approved FROM templates WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tenantId],
    );
    const t = updated.rows[0];
    return {
      template: {
        id: t.id,
        stepKey: t.step_key,
        subject: t.subject,
        body: t.body,
        approved: t.approved,
        unknownPlaceholders: unknownPlaceholders(`${t.subject}\n${t.body}`),
      },
    };
  });
}
