import { pool, query } from "../lib/db.js";
import { hashPassword } from "../lib/auth.js";

const DEV_USER = process.env.SEED_DEV_USER ?? "dev-user@autocollect.local";
const DEV_TENANT_SLUG = "acme";

// Default dunning steps (relative to due date) per design docs: [-2d, +3d, +10d, +21d]
const DEFAULT_STEPS = [
  { key: "reminder_pre", delayDays: -2, subject: "Quick heads-up: {client_name} — invoice {amount} coming due", tone: "friendly" },
  { key: "reminder_1d", delayDays: 1, subject: "Invoice {amount} is now due — {client_name}", tone: "friendly" },
  { key: "reminder_7d", delayDays: 7, subject: "Reminder: invoice {amount} from {company_name}", tone: "professional" },
  { key: "reminder_14d", delayDays: 14, subject: "Overdue: invoice {amount} ({company_name})", tone: "firm" },
] as const;

const TEMPLATE_BODIES: Record<string, string> = {
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

export async function seed(): Promise<void> {
  const demoPasswordHash = await hashPassword("dev-password-auto");
  const tenantResult = await query(
    `INSERT INTO tenants (name, slug, tone)
     VALUES ($1, $2, 'friendly')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    ["Acme Studio", DEV_TENANT_SLUG],
  );
  const tenantId = tenantResult.rows[0].id as string;

  await query(
    `INSERT INTO users (email, password_hash, display_name, status, email_verified_at)
     VALUES ($1, $2, 'Dev User', 'active', now())
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [DEV_USER, demoPasswordHash],
  );

  const userResult = await query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`,
    [DEV_USER],
  );
  const userId = userResult.rows[0].id;

  await query(
    `INSERT INTO memberships (user_id, tenant_id, role, status)
     VALUES ($1, $2, 'owner', 'active')
     ON CONFLICT (user_id, tenant_id) DO NOTHING`,
    [userId, tenantId],
  );

  // Templates (one per step), approved=false so the approve-once flow is meaningful
  for (const step of DEFAULT_STEPS) {
    await query(
      `INSERT INTO templates (tenant_id, step_key, subject, body, approved)
       VALUES ($1, $2, $3, $4, FALSE)
       ON CONFLICT (tenant_id, step_key) DO UPDATE
         SET subject = EXCLUDED.subject, body = EXCLUDED.body`,
      [tenantId, step.key, step.subject, TEMPLATE_BODIES[step.key]],
    );
  }

  // Default workflow
  const tplRows = (
    await query<{ step_key: string; id: string }>(
      `SELECT step_key, id FROM templates WHERE tenant_id = $1`,
      [tenantId],
    )
  ).rows;

  const steps = DEFAULT_STEPS.map((s, i) => ({
    order: i,
    delayDays: s.delayDays,
    channel: "email",
    templateId: tplRows.find((t) => t.step_key === s.key)?.id ?? null,
  }));

  await query(
    `INSERT INTO workflows (tenant_id, name, is_default, enabled, steps)
     VALUES ($1, 'Default sequence', TRUE, TRUE, $2::jsonb)
     ON CONFLICT DO NOTHING`,
    [tenantId, JSON.stringify(steps)],
  );

  console.log(`Seed complete: tenant "${DEV_TENANT_SLUG}" (${tenantId}), user ${DEV_USER}`);
  console.log("Templates seeded (unapproved). Approve them in the app to start dunning.");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}