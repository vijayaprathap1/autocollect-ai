import { servicePool } from "../../lib/db.js";
import { sendEmail } from "../../lib/postmark.js";
import { sendSms } from "../../lib/sms.js";
import { renderTemplate } from "./render.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { deductCredit } from "../../lib/billing.js";
import { acquireJobLease, releaseJobLease } from "../../lib/job-lock.js";
import type { WorkflowStep } from "@autocollect/shared";

type InvoiceForEngine = {
  id: string;
  tenant_id: string;
  amount_due: number;
  currency: string;
  due_date: string | null;
  payment_link: string | null;
  external_id: string | null;
  next_step_index: number;
  next_step_due_at: string | null;
  workflow_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_sms_opt_out: boolean | null;
  tenant_name: string;
  tone: string;
};

type WorkflowRow = { id: string; enabled: boolean; steps: WorkflowStep[] };

/** Automatic retries per step before giving up (manual "send now" can still retry). */
const MAX_SEND_ATTEMPTS = 5;

const INVOICE_SELECT = `
  SELECT i.id, i.tenant_id, i.amount_due, i.currency, i.due_date, i.payment_link,
         i.external_id, i.next_step_index, i.next_step_due_at, i.workflow_id,
         c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
         c.sms_opt_out AS customer_sms_opt_out,
         t.name AS tenant_name, t.tone
    FROM invoices i
    JOIN tenants t ON t.id = i.tenant_id
    LEFT JOIN customers c ON c.id = i.customer_id
`;

function addDays(date: Date | string, days: number): Date {
  const base =
    typeof date === "string"
      ? (() => {
          const [y, m, d] = date.split("-").map(Number);
          return new Date(y, m - 1, d, 0, 0, 0, 0);
        })()
      : date;
  return new Date(base.getTime() + days * 86400000);
}

function scheduledFor(dueDate: Date | string | null, delayDays: number, fallbackNow: Date): Date {
  if (!dueDate) return fallbackNow;
  return addDays(dueDate, delayDays);
}

async function getWorkflow(inv: InvoiceForEngine): Promise<WorkflowRow | null> {
  if (inv.workflow_id) {
    const r = await servicePool.query<WorkflowRow>(
      `SELECT id, enabled, steps FROM workflows WHERE id = $1 AND tenant_id = $2`,
      [inv.workflow_id, inv.tenant_id],
    );
    return r.rows[0] ?? null;
  }
  const r = await servicePool.query<WorkflowRow>(
    `SELECT id, enabled, steps FROM workflows WHERE tenant_id = $1 AND is_default = TRUE LIMIT 1`,
    [inv.tenant_id],
  );
  return r.rows[0] ?? null;
}

async function loadInvoice(tenantId: string, invoiceId: string): Promise<InvoiceForEngine | null> {
  const r = await servicePool.query<InvoiceForEngine>(
    `${INVOICE_SELECT} WHERE i.id = $1 AND i.tenant_id = $2`,
    [invoiceId, tenantId],
  );
  return r.rows[0] ?? null;
}

async function completeSequence(inv: InvoiceForEngine): Promise<void> {
  await servicePool.query(
    `UPDATE invoices SET next_step_index = 9999, next_step_due_at = NULL, updated_at = now()\n     WHERE id = $1`,
    [inv.id],
  );
}

/**
 * Process a single invoice.
 * - When `force` is true (manual "send now") the schedule is ignored, but the
 *   workflow must exist and the template must still be approved.
 * - `next_step_due_at` set by an inbound "promise to pay" reply is honored: the
 *   sequence stays quiet until that date passes.
 * - Sends are recorded idempotently (unique per invoice+step), so a crash
 *   between send and advance cannot double-send.
 */
async function processOne(
  inv: InvoiceForEngine,
  now: Date,
  force: boolean,
): Promise<"sent" | "advanced" | "skipped" | "noop"> {
  const wf = await getWorkflow(inv);
  if (!wf) return "noop";
  if (!force && !wf.enabled) return "noop";

  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  const step = steps[inv.next_step_index];

  if (!step) {
    await completeSequence(inv);
    return "advanced";
  }

  if (!force) {
    const deferred = inv.next_step_due_at ? new Date(inv.next_step_due_at) : null;
    if (deferred && deferred > now) return "noop"; // promise-deferred: keep waiting

    const scheduled = scheduledFor(inv.due_date, step.delayDays, now);
    if (now < scheduled) {
      await servicePool.query(
        `UPDATE invoices SET next_step_due_at = $2, updated_at = now() WHERE id = $1`,
        [inv.id, scheduled.toISOString()],
      );
      return "skipped";
    }
  }

  const template = step.templateId
    ? (
        await servicePool.query<{ id: string; subject: string; body: string; approved: boolean }>(
          `SELECT id, subject, body, approved FROM templates WHERE id = $1 AND tenant_id = $2`,
          [step.templateId, inv.tenant_id],
        )
      ).rows[0]
    : undefined;

  if (!template?.approved) return "noop"; // never send unapproved templates

  const rendered = renderTemplate(template, {
    clientName: inv.customer_name,
    companyName: inv.tenant_name,
    amountCents: inv.amount_due,
    currency: inv.currency,
    dueDate: inv.due_date,
    payLink: inv.payment_link,
    invoiceNumber: inv.external_id,
    tone: inv.tone,
  });

  const channel = step.channel === "sms" ? "sms" : "email";
  if (channel === "sms" && (!inv.customer_phone || inv.customer_sms_opt_out)) return "noop";
  if (channel === "email" && !inv.customer_email) return "noop";
  const recipient = channel === "sms" ? inv.customer_phone : inv.customer_email;
  if (!recipient) return "noop";

  // Reserve, send, record and advance in one transaction so a crash can't
  // double-send or leave the sequence out of step with what was sent.
  const claimClient = await servicePool.connect();
  let finished = false; // COMMIT or ROLLBACK already issued
  try {
    await claimClient.query("BEGIN");
    const creditAvailable = await deductCredit(claimClient, inv.tenant_id, "dunning_send", inv.id);
    if (!creditAvailable) {
      await claimClient.query("ROLLBACK");
      finished = true;
      await servicePool
        .query(
          `INSERT INTO audit_log (tenant_id, actor, action, detail)
           VALUES ($1, 'system', 'dunning_skipped_no_credits', $2::jsonb)`,
          [
            inv.tenant_id,
            JSON.stringify({ invoice_id: inv.id, step_index: inv.next_step_index, channel }),
          ],
        )
        .catch(() => {});
      return "noop";
    }

    // Claim this (invoice, step). A row left 'sending' by a crashed worker is
    // reclaimed once its lease expires; a 'failed' row is retried with backoff
    // (manual "send now" retries immediately).
    const claim = await claimClient.query<{ attempts: number }>(
      `INSERT INTO messages (tenant_id, invoice_id, step_index, channel, status, reserved_until, attempts)
       VALUES ($1, $2, $3, $4, 'sending', now() + interval '5 minutes', 1)
       ON CONFLICT (tenant_id, invoice_id, step_index) WHERE step_index IS NOT NULL
       DO UPDATE SET status = 'sending',
                     channel = EXCLUDED.channel,
                     reserved_until = now() + interval '5 minutes',
                     attempts = messages.attempts + 1
        WHERE (messages.status = 'sending'
                AND (messages.reserved_until IS NULL OR messages.reserved_until < now()))
           OR (messages.status = 'failed'
                AND ($5::boolean
                     OR ((messages.reserved_until IS NULL OR messages.reserved_until < now())
                         AND messages.attempts < $6)))
       RETURNING attempts`,
      [inv.tenant_id, inv.id, inv.next_step_index, channel, force, MAX_SEND_ATTEMPTS],
    );

    if (claim.rows.length === 0) {
      await claimClient.query("ROLLBACK"); // also returns the credit
      finished = true;
      // Already sent for this step but the sequence didn't advance (legacy
      // data): advance now so the invoice isn't stuck on this step.
      const existing = await servicePool.query<{ status: string }>(
        `SELECT status FROM messages WHERE tenant_id = $1 AND invoice_id = $2 AND step_index = $3`,
        [inv.tenant_id, inv.id, inv.next_step_index],
      );
      const st = existing.rows[0]?.status;
      if (st && !["sending", "failed"].includes(st)) {
        await advanceSequence(servicePool, inv, steps, now);
        return "advanced";
      }
      return "noop"; // in flight elsewhere, or waiting for retry backoff
    }
    const attempts = claim.rows[0].attempts;

    let providerMsgId: string;
    try {
      if (channel === "sms") {
        const body = rendered.body.replace(/\s+/g, " ").trim().slice(0, 160);
        providerMsgId = (await sendSms({ to: recipient, body })).providerMsgId;
      } else {
        providerMsgId = (
          await sendEmail({
            to: recipient,
            subject: rendered.subject,
            text: rendered.body,
            tag: `invoice-${inv.external_id ?? inv.id}`,
          })
        ).providerMsgId;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Record the failure, back off before the next automatic retry, refund.
      await claimClient.query(
        `UPDATE messages
            SET status = 'failed', last_error = $4,
                reserved_until = now() + ($5 * interval '10 minutes')
          WHERE tenant_id = $1 AND invoice_id = $2 AND step_index = $3`,
        [inv.tenant_id, inv.id, inv.next_step_index, message.slice(0, 1000), attempts],
      );
      await claimClient.query(
        `UPDATE credit_wallets SET balance = balance + 1, updated_at = now() WHERE tenant_id = $1`,
        [inv.tenant_id],
      );
      await claimClient.query(
        `INSERT INTO credit_transactions (tenant_id, delta, reason, reference_id, actor, created_at)
         VALUES ($1, 1, 'dunning_send_failed', $2, 'engine', now())`,
        [inv.tenant_id, inv.id],
      );
      await claimClient.query(
        `INSERT INTO audit_log (tenant_id, actor, action, detail)
         VALUES ($1, 'system', $2, $3::jsonb)`,
        [
          inv.tenant_id,
          attempts >= MAX_SEND_ATTEMPTS ? "dunning_send_gave_up" : "dunning_send_failed",
          JSON.stringify({ invoice_id: inv.id, step_index: inv.next_step_index, channel, attempts, error: message.slice(0, 300) }),
        ],
      );
      await claimClient.query("COMMIT");
      finished = true;
      throw new ApiError(502, "SEND_FAILED", `Reminder not sent: ${message.slice(0, 300)}`);
    }

    await claimClient.query(
      `UPDATE messages
          SET provider_msg_id = $1, status = 'sent', sent_at = now(), reserved_until = NULL, last_error = NULL
        WHERE tenant_id = $2 AND invoice_id = $3 AND step_index = $4`,
      [providerMsgId, inv.tenant_id, inv.id, inv.next_step_index],
    );
    await claimClient.query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail)
       VALUES ($1, 'system', 'dunning_sent', $2::jsonb)`,
      [
        inv.tenant_id,
        JSON.stringify({
          invoice_id: inv.id,
          step_index: inv.next_step_index,
          channel,
          provider_msg_id: providerMsgId,
          manual: force,
        }),
      ],
    );
    await advanceSequence(claimClient, inv, steps, now);

    await claimClient.query("COMMIT");
    finished = true;
    return "sent";
  } catch (err) {
    if (!finished) await claimClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    claimClient.release();
  }
}

async function advanceSequence(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  inv: InvoiceForEngine,
  steps: WorkflowStep[],
  now: Date,
): Promise<void> {
  const nextIndex = inv.next_step_index + 1;
  const nextStep = steps[nextIndex];
  if (!nextStep) {
    await db.query(
      `UPDATE invoices SET next_step_index = 9999, next_step_due_at = NULL, updated_at = now() WHERE id = $1`,
      [inv.id],
    );
    return;
  }
  const nextScheduled = scheduledFor(inv.due_date, nextStep.delayDays, now);
  await db.query(
    `UPDATE invoices SET next_step_index = $2, next_step_due_at = $3, updated_at = now() WHERE id = $1`,
    [inv.id, nextIndex, nextScheduled.toISOString()],
  );
}

/**
 * Evaluate all open invoices against their dunning workflow.
 * Sends due reminders (only with approved templates) and advances sequences.
 * A failure on one invoice is isolated so the rest of the batch still runs.
 * Returns the number of emails/SMS sent.
 */
export async function runDunning(now = new Date()): Promise<number> {
  const acquired = await acquireJobLease("dunning");
  if (!acquired) return 0;

  try {
    const candidates = await servicePool.query<InvoiceForEngine>(
      `${INVOICE_SELECT} WHERE i.status = 'open' AND i.next_step_index < 9999`
    );

    let sent = 0;

    for (const inv of candidates.rows) {
      try {
        const result = await processOne(inv, now, false);
        if (result === "sent") sent += 1;
      } catch (err) {
        await servicePool
          .query(
            `INSERT INTO audit_log (tenant_id, actor, action, detail)
             VALUES ($1, 'system', 'dunning_error', $2::jsonb)`,
            [
              inv.tenant_id,
              JSON.stringify({
                invoice_id: inv.id,
                error: err instanceof Error ? err.message : String(err),
              }),
            ],
          )
          .catch(() => {});
      }
    }

    return sent;
  } finally {
    await releaseJobLease("dunning").catch(() => {});
  }
}

/**
 * Manual "send now" for a single invoice (admin-triggered).
 */
export async function sendNowForInvoice(
  tenantId: string,
  invoiceId: string,
): Promise<{ sent: boolean }> {
  const inv = await loadInvoice(tenantId, invoiceId);
  if (!inv) throw notFound("Invoice not found");
  const result = await processOne(inv, new Date(), true);
  return { sent: result === "sent" };
}