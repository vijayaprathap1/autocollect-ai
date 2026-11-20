import { servicePool } from "../../lib/db.js";
import { replyToForInvoice, sendEmail } from "../../lib/postmark.js";
import { sendSms } from "../../lib/sms.js";
import { renderTemplate } from "./render.js";
import { notFound } from "../../lib/errors.js";
import { deductCredit, refundCredit } from "../../lib/billing.js";
import { acquireJobLease, releaseJobLease } from "../../lib/job-lock.js";
import { unsubscribeHeaders, unsubscribeUrl } from "../../lib/unsubscribe.js";
import {
  MAX_SEND_ATTEMPTS,
  buildSmsBody,
  isSmsUnsubscribedError,
  withUnsubscribeFooter,
} from "./send-helpers.js";
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
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_sms_opt_out: boolean | null;
  customer_email_opt_out: boolean | null;
  tenant_name: string;
  tenant_status: string | null;
  tone: string;
};

type WorkflowRow = { id: string; enabled: boolean; steps: WorkflowStep[] };

type ProcessResult = "sent" | "advanced" | "skipped" | "noop";

const INVOICE_SELECT = `
  SELECT i.id, i.tenant_id, i.amount_due, i.currency, i.due_date, i.payment_link,
         i.external_id, i.next_step_index, i.next_step_due_at, i.workflow_id,
         c.id AS customer_id, c.name AS customer_name, c.email AS customer_email,
         c.phone AS customer_phone, c.sms_opt_out AS customer_sms_opt_out,
         c.email_opt_out AS customer_email_opt_out,
         t.name AS tenant_name, t.status AS tenant_status, t.tone
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

async function audit(tenantId: string, action: string, detail: Record<string, unknown>): Promise<void> {
  await servicePool
    .query(
      `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'system', $2, $3::jsonb)`,
      [tenantId, action, JSON.stringify(detail)],
    )
    .catch(() => {});
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
    `UPDATE invoices SET next_step_index = 9999, next_step_due_at = NULL, updated_at = now()
     WHERE id = $1`,
    [inv.id],
  );
}

/** Move the invoice past its current step (sent, skipped or abandoned). */
async function advanceSequence(inv: InvoiceForEngine, steps: WorkflowStep[], now: Date): Promise<void> {
  const nextIndex = inv.next_step_index + 1;
  const nextStep = steps[nextIndex];
  if (!nextStep) {
    await completeSequence(inv);
    return;
  }
  const nextScheduled = scheduledFor(inv.due_date, nextStep.delayDays, now);
  await servicePool.query(
    `UPDATE invoices SET next_step_index = $2, next_step_due_at = $3, updated_at = now()
     WHERE id = $1 AND next_step_index = $4`,
    [inv.id, nextIndex, nextScheduled.toISOString(), inv.next_step_index],
  );
}

async function skipStep(
  inv: InvoiceForEngine,
  steps: WorkflowStep[],
  now: Date,
  reason: string,
  channel: string,
): Promise<ProcessResult> {
  await audit(inv.tenant_id, "dunning_step_skipped", {
    invoice_id: inv.id,
    step_index: inv.next_step_index,
    channel,
    reason,
  });
  await advanceSequence(inv, steps, now);
  return "advanced";
}

/**
 * Claim this invoice step for sending and pay for it in one transaction.
 * A step whose previous attempt failed can be claimed again (with backoff,
 * up to MAX_SEND_ATTEMPTS); a `sending` claim left behind by a crashed
 * process is reclaimed after 30 minutes.
 */
async function claimSend(
  inv: InvoiceForEngine,
  channel: "email" | "sms",
  force: boolean,
): Promise<{ claimed: true; attempts: number; reclaimed: boolean } | { claimed: false; reason: "no_credits" | "conflict" }> {
  const client = await servicePool.connect();
  try {
    await client.query("BEGIN");
    const creditAvailable = await deductCredit(client, inv.tenant_id, "dunning_send", inv.id);
    if (!creditAvailable) {
      await client.query("ROLLBACK");
      return { claimed: false, reason: "no_credits" };
    }

    const claimed = await client.query<{ attempts: number; prev_status: string | null }>(
      `WITH prev AS (
         SELECT status FROM messages
          WHERE tenant_id = $1 AND invoice_id = $2 AND step_index = $3
       )
       INSERT INTO messages (tenant_id, invoice_id, step_index, channel, status, attempts, updated_at)
       VALUES ($1, $2, $3, $4, 'sending', 1, now())
       ON CONFLICT (tenant_id, invoice_id, step_index) WHERE step_index IS NOT NULL DO UPDATE
         SET status = 'sending',
             channel = EXCLUDED.channel,
             attempts = messages.attempts + 1,
             last_error = NULL,
             updated_at = now()
       WHERE (messages.status = 'failed'
              AND messages.attempts < $5
              AND ($6 OR messages.updated_at < now() - (interval '15 minutes' * messages.attempts)))
          OR (messages.status = 'sending' AND messages.updated_at < now() - interval '30 minutes')
       RETURNING messages.attempts, (SELECT status FROM prev) AS prev_status`,
      [inv.tenant_id, inv.id, inv.next_step_index, channel, MAX_SEND_ATTEMPTS, force],
    );
    if (claimed.rows.length === 0) {
      await client.query("ROLLBACK");
      return { claimed: false, reason: "conflict" };
    }
    await client.query("COMMIT");
    const row = claimed.rows[0];
    return { claimed: true, attempts: row.attempts, reclaimed: row.prev_status === "sending" };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The step could not be claimed because a message row already exists.
 * Repair invoices whose step finished but never advanced (crash after the
 * provider accepted the message) or whose attempts are exhausted.
 */
async function resolveClaimConflict(
  inv: InvoiceForEngine,
  steps: WorkflowStep[],
  now: Date,
): Promise<ProcessResult> {
  const r = await servicePool.query<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM messages WHERE tenant_id = $1 AND invoice_id = $2 AND step_index = $3`,
    [inv.tenant_id, inv.id, inv.next_step_index],
  );
  const msg = r.rows[0];
  if (!msg) return "noop";
  if (msg.status !== "sending" && msg.status !== "failed") {
    await advanceSequence(inv, steps, now); // already sent/delivered: just advance
    return "advanced";
  }
  if (msg.status === "failed" && msg.attempts >= MAX_SEND_ATTEMPTS) {
    await audit(inv.tenant_id, "dunning_step_abandoned", {
      invoice_id: inv.id,
      step_index: inv.next_step_index,
      attempts: msg.attempts,
    });
    await advanceSequence(inv, steps, now);
    return "advanced";
  }
  return "noop"; // in flight, or waiting for retry backoff
}

/**
 * Process a single invoice.
 * - When `force` is true (manual "send now") the schedule is ignored, but the
 *   workflow must exist and the template must still be approved.
 * - `next_step_due_at` set by an inbound "promise to pay" reply is honored: the
 *   sequence stays quiet until that date passes.
 * - Sends are claimed once per invoice+step; failed sends are retried with
 *   backoff and abandoned after MAX_SEND_ATTEMPTS so the invoice never stalls.
 */
async function processOne(inv: InvoiceForEngine, now: Date, force: boolean): Promise<ProcessResult> {
  if (inv.tenant_status && inv.tenant_status !== "active") return "noop";

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
    if (deferred && deferred > now) return "noop"; // promise-deferred or scheduled: keep waiting

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

  const channel = step.channel === "sms" ? "sms" : "email";
  // A step the customer cannot (or asked not to) receive is skipped, not
  // retried forever, so later steps on other channels still run.
  if (channel === "sms" && !inv.customer_phone) return skipStep(inv, steps, now, "no_phone", channel);
  if (channel === "sms" && inv.customer_sms_opt_out) return skipStep(inv, steps, now, "sms_opt_out", channel);
  if (channel === "email" && !inv.customer_email) return skipStep(inv, steps, now, "no_email", channel);
  if (channel === "email" && inv.customer_email_opt_out) return skipStep(inv, steps, now, "email_opt_out", channel);
  const recipient = channel === "sms" ? inv.customer_phone! : inv.customer_email!;

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

  const claim = await claimSend(inv, channel, force);
  if (!claim.claimed) {
    if (claim.reason === "no_credits") {
      await audit(inv.tenant_id, "dunning_skipped_no_credits", {
        invoice_id: inv.id,
        step_index: inv.next_step_index,
        channel,
      });
      return "noop";
    }
    return resolveClaimConflict(inv, steps, now);
  }
  if (claim.reclaimed) {
    await audit(inv.tenant_id, "dunning_send_reclaimed", {
      invoice_id: inv.id,
      step_index: inv.next_step_index,
      attempts: claim.attempts,
    });
  }

  let providerMsgId: string;
  try {
    if (channel === "sms") {
      providerMsgId = (await sendSms({ to: recipient, body: buildSmsBody(rendered.body, inv.payment_link) })).providerMsgId;
    } else {
      providerMsgId = (
        await sendEmail({
          to: recipient,
          subject: rendered.subject,
          text: inv.customer_id ? withUnsubscribeFooter(rendered.body, unsubscribeUrl(inv.customer_id)) : rendered.body,
          tag: `invoice-${inv.external_id ?? inv.id}`,
          replyTo: replyToForInvoice(inv.id),
          headers: inv.customer_id ? unsubscribeHeaders(inv.customer_id) : undefined,
        })
      ).providerMsgId;
    }
  } catch (err) {
    const errorText = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    let attempts = claim.attempts;
    const settleClient = await servicePool.connect();
    try {
      await settleClient.query("BEGIN");
      const failed = await settleClient.query<{ attempts: number }>(
        `UPDATE messages SET status = 'failed', last_error = $4, updated_at = now()
         WHERE tenant_id = $1 AND invoice_id = $2 AND step_index = $3 AND status = 'sending'
         RETURNING attempts`,
        [inv.tenant_id, inv.id, inv.next_step_index, errorText],
      );
      attempts = failed.rows[0]?.attempts ?? attempts;
      await refundCredit(settleClient, inv.tenant_id, "dunning_send_failed", inv.id);
      await settleClient.query("COMMIT");
    } catch {
      await settleClient.query("ROLLBACK").catch(() => {});
    } finally {
      settleClient.release();
    }

    if (channel === "sms" && isSmsUnsubscribedError(err) && inv.customer_id) {
      await servicePool.query(`UPDATE customers SET sms_opt_out = TRUE WHERE id = $1`, [inv.customer_id]);
      return skipStep(inv, steps, now, "sms_unsubscribed_at_carrier", channel);
    }
    if (attempts >= MAX_SEND_ATTEMPTS) {
      await audit(inv.tenant_id, "dunning_step_abandoned", {
        invoice_id: inv.id,
        step_index: inv.next_step_index,
        attempts,
        error: errorText,
      });
      await advanceSequence(inv, steps, now);
    }
    throw err;
  }

  await servicePool.query(
    `UPDATE messages SET provider_msg_id = $1, status = 'sent', sent_at = now(), updated_at = now()
     WHERE tenant_id = $2 AND invoice_id = $3 AND step_index = $4 AND status = 'sending'`,
    [providerMsgId, inv.tenant_id, inv.id, inv.next_step_index],
  );

  await audit(inv.tenant_id, "dunning_sent", {
    invoice_id: inv.id,
    step_index: inv.next_step_index,
    channel,
    provider_msg_id: providerMsgId,
    attempts: claim.attempts,
    manual: force,
  });

  await advanceSequence(inv, steps, now);
  return "sent";
}

/**
 * Evaluate all open invoices of active tenants against their dunning workflow.
 * Sends due reminders (only with approved templates) and advances sequences.
 * A failure on one invoice is isolated so the rest of the batch still runs.
 * Returns the number of emails/SMS sent.
 */
export async function runDunning(now = new Date()): Promise<number> {
  const acquired = await acquireJobLease("dunning");
  if (!acquired) return 0;

  try {
    const candidates = await servicePool.query<InvoiceForEngine>(
      `${INVOICE_SELECT}
        WHERE i.status = 'open' AND i.next_step_index < 9999 AND t.status = 'active'`,
    );

    let sent = 0;

    for (const inv of candidates.rows) {
      try {
        const result = await processOne(inv, now, false);
        if (result === "sent") sent += 1;
      } catch (err) {
        await audit(inv.tenant_id, "dunning_error", {
          invoice_id: inv.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return sent;
  } finally {
    await releaseJobLease("dunning").catch(() => {});
  }
}

/** Manual "send now" for a single invoice (admin-triggered). */
export async function sendNowForInvoice(
  tenantId: string,
  invoiceId: string,
): Promise<{ sent: boolean }> {
  const inv = await loadInvoice(tenantId, invoiceId);
  if (!inv) throw notFound("Invoice not found");
  const result = await processOne(inv, new Date(), true);
  return { sent: result === "sent" };
}
