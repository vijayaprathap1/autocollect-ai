import type { FastifyInstance } from "fastify";
import { requireRole } from "../../plugins/tenant.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { draftReminderTemplates } from "../../lib/ai.js";
import { linkDefaultWorkflowSteps } from "../../lib/default-sequence.js";
import type { TenantTone, WorkflowStep } from "@autocollect/shared";

function validSteps(value: unknown): value is WorkflowStep[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (s) =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as WorkflowStep).order === "number" &&
      typeof (s as WorkflowStep).delayDays === "number" &&
      ((s as WorkflowStep).channel === "email" || (s as WorkflowStep).channel === "sms"),
  );
}

export async function workflowRoutes(app: FastifyInstance) {
  app.get("/workflows", async (req) => {
    const rows = await req.db.query<{
      id: string;
      name: string;
      is_default: boolean;
      enabled: boolean;
      steps: WorkflowStep[];
      created_at: string;
    }>(`SELECT id, name, is_default, enabled, steps, created_at FROM workflows WHERE tenant_id = $1 ORDER BY is_default DESC`, [req.user.tenantId]);
    return {
      workflows: rows.rows.map((r) => ({
        id: r.id,
        name: r.name,
        isDefault: r.is_default,
        enabled: r.enabled,
        steps: r.steps,
        createdAt: r.created_at,
      })),
    };
  });

  app.put("/workflows/:id", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { enabled?: boolean; steps?: unknown; name?: string };

    const exists = await req.db.query<{ id: string }>(`SELECT id FROM workflows WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
    if (exists.rows.length === 0) throw notFound("Workflow not found");

    const sets: string[] = [];
    const values: unknown[] = [id];
    const add = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (typeof body.enabled === "boolean") {
      sets.push(`enabled = ${add(body.enabled)}`);
    }
    if (typeof body.name === "string") {
      sets.push(`name = ${add(body.name)}`);
    }
    if (body.steps !== undefined) {
      if (!validSteps(body.steps)) throw badRequest("Invalid steps");
      sets.push(`steps = ${add(JSON.stringify(body.steps))}::jsonb`);
    }

    if (sets.length === 0) throw badRequest("Nothing to update");

    await req.db.query(`UPDATE workflows SET ${sets.join(", ")} WHERE id = $1`, values);

    if (typeof body.enabled === "boolean") {
      await req.db.query(
        `INSERT INTO audit_log (tenant_id, actor, action, detail)
         VALUES ($1, $2, 'workflow_update', $3::jsonb)`,
        [req.user.tenantId, req.user.email, JSON.stringify({ workflow_id: id, enabled: body.enabled })],
      );
    }

    const updated = await req.db.query<{
      id: string;
      name: string;
      is_default: boolean;
      enabled: boolean;
      steps: WorkflowStep[];
    }>(`SELECT id, name, is_default, enabled, steps FROM workflows WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);

    return {
      workflow: {
        id: updated.rows[0].id,
        name: updated.rows[0].name,
        isDefault: updated.rows[0].is_default,
        enabled: updated.rows[0].enabled,
        steps: updated.rows[0].steps,
      },
    };
  });

  app.get("/templates", async (req) => {
    const rows = await req.db.query<{
      id: string;
      step_key: string;
      subject: string;
      body: string;
      approved: boolean;
      created_at: string;
    }>(`SELECT id, step_key, subject, body, approved, created_at FROM templates WHERE tenant_id = $1 ORDER BY created_at ASC`, [req.user.tenantId]);
    return {
      templates: rows.rows.map((r) => ({
        id: r.id,
        stepKey: r.step_key,
        subject: r.subject,
        body: r.body,
        approved: r.approved,
        createdAt: r.created_at,
      })),
    };
  });

  app.post("/templates/draft", { preHandler: requireRole("admin") }, async (req) => {
    const tenant = await req.db.query<{ tone: string }>(`SELECT tone FROM tenants WHERE id = $1`, [
      req.user.tenantId,
    ]);
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

    // If the default workflow has no steps yet, link it to these templates.
    await linkDefaultWorkflowSteps(req.db, req.user.tenantId);

    await req.db.query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail)
       VALUES ($1, $2, 'templates_drafted', $3::jsonb)`,
      [req.user.tenantId, req.user.email, JSON.stringify({ count: drafts.length, tone })],
    );

    return { drafts };
  });

  app.put("/templates/:id", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { subject?: string; body?: string; approved?: boolean };

    const exists = await req.db.query<{ id: string }>(`SELECT id FROM templates WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
    if (exists.rows.length === 0) throw notFound("Template not found");

    const sets: string[] = [];
    const values: unknown[] = [id];

    if (typeof body.subject === "string" && body.subject.trim() !== "") {
      sets.push(`subject = $${values.length + 1}`);
      values.push(body.subject.trim());
    }
    if (typeof body.body === "string" && body.body.trim() !== "") {
      sets.push(`body = $${values.length + 1}`);
      values.push(body.body.trim());
    }
    if (typeof body.approved === "boolean") {
      sets.push(`approved = $${values.length + 1}`);
      values.push(body.approved);
    }

    if (sets.length === 0) throw badRequest("Nothing to update");

    await req.db.query(`UPDATE templates SET ${sets.join(", ")} WHERE id = $1`, values);

    if (body.approved === true) {
      await req.db.query(
        `INSERT INTO audit_log (tenant_id, actor, action, detail)
         VALUES ($1, $2, 'template_approved', $3::jsonb)`,
        [req.user.tenantId, req.user.email, JSON.stringify({ template_id: id })],
      );
    }

    const updated = await req.db.query<{
      id: string;
      step_key: string;
      subject: string;
      body: string;
      approved: boolean;
    }>(`SELECT id, step_key, subject, body, approved FROM templates WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);

    return {
      template: {
        id: updated.rows[0].id,
        stepKey: updated.rows[0].step_key,
        subject: updated.rows[0].subject,
        body: updated.rows[0].body,
        approved: updated.rows[0].approved,
      },
    };
  });
}