/**
 * The default 4-step reminder sequence every workspace starts with.
 *
 * Templates are created unapproved (approve-once flow), and the default
 * workflow's steps are linked to them. Without this a new signup had a
 * workflow with zero steps and could never send a reminder.
 */
type Db = { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

// Relative to the invoice due date; negative = before due.
export const DEFAULT_STEPS = [
  { key: "reminder_pre", delayDays: -2, subject: "Quick heads-up: {client_name} — invoice {amount} coming due" },
  { key: "reminder_1d", delayDays: 1, subject: "Invoice {amount} is now due — {client_name}" },
  { key: "reminder_7d", delayDays: 7, subject: "Reminder: invoice {amount} from {company_name}" },
  { key: "reminder_14d", delayDays: 14, subject: "Overdue: invoice {amount} ({company_name})" },
] as const;

export const DEFAULT_TEMPLATE_BODIES: Record<string, string> = {
  reminder_pre:
    "Hi {client_name},\n\nJust a quick heads-up that invoice {amount} is due {due_date}. " +
    "You can pay in one click here: {pay_link}\n\nThanks for your business!\n{company_name}",
  reminder_1d:
    "Hi {client_name},\n\nA gentle reminder that invoice {amount} is now due. " +
    "You can settle it here: {pay_link}\n\nLet us know if anything looks off.\n{company_name}",
  reminder_7d:
    "Hi {client_name},\n\nThis is a reminder that invoice {amount} is past due. " +
    "Please arrange payment at your earliest convenience: {pay_link}\n\nIf you have questions, just reply.\n{company_name}",
  reminder_14d:
    "Hi {client_name},\n\nInvoice {amount} remains unpaid and is now overdue. " +
    "Please make payment here promptly: {pay_link}\n\nWe value the relationship — reach out if there's an issue we can resolve.\n{company_name}",
};

/** Create the default templates (if missing) without overwriting user edits. */
export async function ensureDefaultTemplates(db: Db, tenantId: string): Promise<void> {
  for (const step of DEFAULT_STEPS) {
    await db.query(
      `INSERT INTO templates (tenant_id, step_key, subject, body, approved)
       VALUES ($1, $2, $3, $4, FALSE)
       ON CONFLICT (tenant_id, step_key) DO NOTHING`,
      [tenantId, step.key, step.subject, DEFAULT_TEMPLATE_BODIES[step.key]],
    );
  }
}

/**
 * Link the default workflow's steps to the tenant's templates, but only when
 * the workflow has no steps yet (never clobbers a customised sequence).
 */
export async function linkDefaultWorkflowSteps(db: Db, tenantId: string): Promise<void> {
  const templates = await db.query<{ id: string; step_key: string }>(
    `SELECT id, step_key FROM templates WHERE tenant_id = $1`,
    [tenantId],
  );
  const steps = DEFAULT_STEPS.map((s, i) => ({
    order: i,
    delayDays: s.delayDays,
    channel: "email",
    templateId: templates.rows.find((t) => t.step_key === s.key)?.id ?? null,
  })).filter((s) => s.templateId !== null);
  if (steps.length === 0) return;

  await db.query(
    `UPDATE workflows
        SET steps = $2::jsonb
      WHERE tenant_id = $1 AND is_default = TRUE
        AND (steps IS NULL OR jsonb_array_length(steps) = 0)`,
    [tenantId, JSON.stringify(steps)],
  );
}

export async function installDefaultSequence(db: Db, tenantId: string): Promise<void> {
  await ensureDefaultTemplates(db, tenantId);
  await linkDefaultWorkflowSteps(db, tenantId);
}
