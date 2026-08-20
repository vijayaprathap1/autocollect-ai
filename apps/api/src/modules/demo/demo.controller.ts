import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { requireRole } from "../../plugins/tenant.js";
import { notFound } from "../../lib/errors.js";
import { withTenant } from "../../lib/db.js";

/**
 * Dev-only "load demo data" seeder. One click in the UI and a fresh tenant has:
 *  - approved reminder templates + an enabled default workflow
 *  - a realistic mix of customers and invoices (overdue buckets, paid, paused)
 *  - a couple of inbound replies so the reply inbox has something to show
 *
 * Disabled in production.
 */
const DEMO_TEMPLATES = [
  {
    key: "reminder_pre",
    subject: "Quick heads-up: invoice {amount} coming due",
    body:
      "Hi {client_name},\n\nJust a quick heads-up that invoice {amount} is due {due_date}. " +
      "You can pay in one click here: {pay_link}\n\nThanks for your business!\n{company_name}",
  },
  {
    key: "reminder_1d",
    subject: "Invoice {amount} is now due",
    body:
      "Hi {client_name},\n\nA gentle reminder that invoice {amount} is now due. " +
      "You can settle it here: {pay_link}\n\nLet us know if anything looks off.\n{company_name}",
  },
  {
    key: "reminder_7d",
    subject: "Reminder: invoice {amount} is past due",
    body:
      "Hi {client_name},\n\nThis is a reminder that invoice {amount} is past due. " +
      "Please arrange payment at your earliest convenience: {pay_link}\n\nIf you have questions, just reply.\n{company_name}",
  },
  {
    key: "reminder_14d",
    subject: "Invoice {amount} remains unpaid",
    body:
      "Hi {client_name},\n\nInvoice {amount} remains unpaid and is now overdue. " +
      "Please make payment promptly here: {pay_link}\n\nWe value the relationship — reach out if there's an issue.\n{company_name}",
  },
];

const DEMO_CUSTOMERS = [
  { key: "c1", name: "Northwind Design Co.", email: "ap@northwind.example", phone: "+14155550101" },
  { key: "c2", name: "Lumen Labs", email: "payments@lumenlabs.example", phone: "+14155550102" },
  { key: "c3", name: "Brightpath Studio", email: "accounts@brightpath.example", phone: null },
  { key: "c4", name: "Marina & Co", email: "finance@marinaco.example", phone: "+14155550104" },
  { key: "c5", name: "Hyperion Media", email: "billing@hyperion.example", phone: null },
];

type DemoInvoice = {
  customerKey: string;
  number: string;
  amountCents: number;
  dueOffsetDays: number;
  status: "open" | "paid" | "paused";
};

const DEMO_INVOICES: DemoInvoice[] = [
  { customerKey: "c1", number: "INV-2026-014", amountCents: 185000, dueOffsetDays: -12, status: "open" },
  { customerKey: "c2", number: "INV-2026-015", amountCents: 420000, dueOffsetDays: -45, status: "open" },
  { customerKey: "c3", number: "INV-2026-016", amountCents: 96000, dueOffsetDays: -6, status: "open" },
  { customerKey: "c4", number: "INV-2026-017", amountCents: 250000, dueOffsetDays: -75, status: "open" },
  { customerKey: "c5", number: "INV-2026-018", amountCents: 64000, dueOffsetDays: -95, status: "open" },
  { customerKey: "c1", number: "INV-2026-019", amountCents: 120000, dueOffsetDays: 5, status: "open" },
  { customerKey: "c2", number: "INV-2026-020", amountCents: 310000, dueOffsetDays: -20, status: "open" },
  { customerKey: "c3", number: "INV-2026-021", amountCents: 78000, dueOffsetDays: -30, status: "paid" },
  { customerKey: "c4", number: "INV-2026-022", amountCents: 150000, dueOffsetDays: -15, status: "paid" },
  { customerKey: "c5", number: "INV-2026-023", amountCents: 89000, dueOffsetDays: -40, status: "paused" },
];

export async function demoRoutes(app: FastifyInstance) {
  app.post(
    "/demo/seed",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      if (config.nodeEnv === "production") throw notFound("Disabled in production");

      const tenantId = req.user.tenantId;

      await withTenant(tenantId, async (client) => {
        // 1) Approved templates (upsert by step_key).
        const templateIds = new Map<string, string>();
        for (const t of DEMO_TEMPLATES) {
          const row = await client.query<{ id: string }>(
            `INSERT INTO templates (tenant_id, step_key, subject, body, approved)
             VALUES ($1, $2, $3, $4, TRUE)
             ON CONFLICT (tenant_id, step_key)
             DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, approved = TRUE
             RETURNING id`,
            [tenantId, t.key, t.subject, t.body],
          );
          templateIds.set(t.key, row.rows[0].id);
        }

        // 2) Default workflow enabled, steps linked to the approved templates.
        const steps = [
          { order: 0, delayDays: -2, channel: "email", templateId: templateIds.get("reminder_pre") },
          { order: 1, delayDays: 1, channel: "email", templateId: templateIds.get("reminder_1d") },
          { order: 2, delayDays: 7, channel: "email", templateId: templateIds.get("reminder_7d") },
          { order: 3, delayDays: 14, channel: "email", templateId: templateIds.get("reminder_14d") },
        ];
        const wf = await client.query<{ id: string }>(
          `SELECT id FROM workflows WHERE tenant_id = $1 AND is_default = TRUE LIMIT 1`,
          [tenantId],
        );
        if (wf.rows[0]) {
          await client.query(
            `UPDATE workflows SET enabled = TRUE, steps = $2::jsonb WHERE id = $1`,
            [wf.rows[0].id, JSON.stringify(steps)],
          );
        } else {
          await client.query(
            `INSERT INTO workflows (tenant_id, name, is_default, enabled, steps)
             VALUES ($1, 'Default sequence', TRUE, TRUE, $2::jsonb)`,
            [tenantId, JSON.stringify(steps)],
          );
        }

        // 3) Customers.
        const customerIds = new Map<string, string>();
        for (const c of DEMO_CUSTOMERS) {
          const row = await client.query<{ id: string }>(
            `INSERT INTO customers (tenant_id, source, external_id, name, email, phone)
             VALUES ($1, 'csv', $2, $3, $4, $5)
             ON CONFLICT (tenant_id, source, external_id)
             DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone
             RETURNING id`,
            [tenantId, c.key, c.name, c.email, c.phone],
          );
          customerIds.set(c.key, row.rows[0].id);
        }

        // 4) Invoices across aging buckets.
        for (const inv of DEMO_INVOICES) {
          const issue = new Date();
          issue.setDate(issue.getDate() - inv.dueOffsetDays - 14); // issue 14d before due
          const due = new Date();
          due.setDate(due.getDate() - inv.dueOffsetDays);

          const row = await client.query<{ id: string }>(
            `INSERT INTO invoices (tenant_id, customer_id, external_id, source, amount_due,
                                   currency, issue_date, due_date, status, payment_link)
             VALUES ($1, $2, $3, 'csv', $4, 'usd', $5, $6, $7, $8)
             ON CONFLICT (tenant_id, source, external_id)
             DO UPDATE SET amount_due = EXCLUDED.amount_due, due_date = EXCLUDED.due_date,
                           status = EXCLUDED.status, payment_link = EXCLUDED.payment_link
             RETURNING id`,
            [
              tenantId,
              customerIds.get(inv.customerKey),
              inv.number,
              inv.amountCents,
              issue.toISOString().slice(0, 10),
              due.toISOString().slice(0, 10),
              inv.status,
              `https://pay.stripe.com/demo-${inv.number.toLowerCase().replace(/[^a-z0-9]+/g, "")}`,
            ],
          );

          if (inv.status === "open") {
            // Spread next sends so the timeline has upcoming steps.
            const next = new Date();
            next.setDate(next.getDate() + ((inv.dueOffsetDays * 7) % 5) + 1);
            await client.query(
              `UPDATE invoices SET next_step_due_at = $2 WHERE id = $1`,
              [row.rows[0].id, next.toISOString()],
            );
          }
        }

        // 5) A couple of inbound replies so the reply inbox is populated.
        const openInv = await client.query<{ id: string; customer_id: string | null }>(
          `SELECT id, customer_id FROM invoices
            WHERE tenant_id = $1 AND external_id = 'INV-2026-014' LIMIT 1`,
          [tenantId],
        );
        if (openInv.rows[0]) {
          const disputeInv = await client.query<{ id: string }>(
            `SELECT id FROM invoices WHERE tenant_id = $1 AND external_id = 'INV-2026-023' LIMIT 1`,
            [tenantId],
          );
          await client.query(
            `INSERT INTO replies (tenant_id, invoice_id, channel, content, classification, resolved)
             VALUES ($1, $2, 'email',
                     'Hi — can we get a copy of the invoice? I don''t recognize the amount for the retainer. Thanks!',
                     'question', FALSE)`,
            [tenantId, openInv.rows[0].id],
          );
          if (disputeInv.rows[0]) {
            const promise = new Date();
            promise.setDate(promise.getDate() + 5);
            await client.query(
              `INSERT INTO replies (tenant_id, invoice_id, channel, content, classification, promise_date, resolved)
               VALUES ($1, $2, 'email', 'We''ll get this settled by end of week, sorry for the delay!', 'promise', $3, FALSE)`,
              [tenantId, disputeInv.rows[0].id, promise.toISOString().slice(0, 10)],
            );
          }
        }

        await client.query(
          `INSERT INTO audit_log (tenant_id, actor, action, detail)
           VALUES ($1, $2, 'demo_seeded', $3::jsonb)`,
          [tenantId, req.user.email, JSON.stringify({ invoices: DEMO_INVOICES.length, customers: DEMO_CUSTOMERS.length })],
        );
      });

      return { ok: true, customers: DEMO_CUSTOMERS.length, invoices: DEMO_INVOICES.length };
    },
  );
}