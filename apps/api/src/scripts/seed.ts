import { pool, query } from "../lib/db.js";
import { hashPassword } from "../lib/auth.js";
import { DEFAULT_STEPS, DEFAULT_TEMPLATE_BODIES as TEMPLATE_BODIES } from "../lib/default-sequence.js";

const DEV_USER = process.env.SEED_DEV_USER ?? "dev-user@autocollect.local";
const DEV_TENANT_SLUG = "acme";

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

  // Credits: without a wallet every send is skipped as "no credits".
  await query(
    `INSERT INTO credit_wallets (tenant_id, balance) VALUES ($1, 500)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
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