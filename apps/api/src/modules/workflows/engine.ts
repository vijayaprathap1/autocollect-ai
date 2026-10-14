import type { PoolClient } from "pg";
import { servicePool } from "../../lib/db.js";
import { sendEmail, PermanentEmailError } from "../../lib/postmark.js";
import { sendSms, PermanentSmsError } from "../../lib/sms.js";
import { renderTemplate } from "./render.js";
import { ApiError, badRequest, notFound } from "../../lib/errors.js";
import { deductCredit, refundCredit } from "../../lib/billing.js";
import { acquireJobLease, releaseJobLease } from "../../lib/job-lock.js";
import { scheduledSendTime, stepToSend, type ScheduleOptions } from "../../lib/schedule.js";
import { reminderEmail } from "../../lib/email-templates.js";
import { replyAddressFor } from "../../lib/reply-address.js";
import { config } from "../../config.js";
import type { WorkflowStep } from "@autocollect/shared";

/**
 * Dunning engine.
 *
 * Delivery model (at-least-once, crash-safe):
 *   1. CLAIM   — short transaction: deduct a credit + reserve (invoice, step) in
 *                `messages` with a 5-minute lease. The unique index on
 *                (tenant, invoice, step) makes concurrent workers mutually exclusive.
 *   2. SEND    — call the provider with NO transaction or row lock held.
 *   3. RECORD  — short transaction: mark sent + advance the sequence, or mark
 *                failed + refund + schedule a retry with backoff.
 * A worker that dies between 1 and 3 leaves a lease that expires, so the step is
 * retried (at worst one duplicate if the provider had already accepted it).
 */

type InvoiceForEngine = {
  id: string;
  tenant_id: string;
  amount_due: number;
  currency: string;
  due_date: string | null;
  anchor_date: string;
  payment_link: string | null;
  external_id: string | null;
  next_step_index: number;
  next_step_due_at: string | null;
  snoozed_until: string | null;
  workflow_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_sms_opt_out: boolean | null;
  tenant_name: string;
  tone: string;
  timezone: string;
  send_hour: number;
  skip_weekends: boolean;
  hide_branding: boolean;
  business_address: string | null;
};

type WorkflowRow = { id: string; enabled: boolean; steps: WorkflowStep[] };
type TemplateRow = { id: string; subject: string; body: string; approved: boolean };

export type ProcessResult = "sent" | "advanced" | "waiting" | "skipped" | "failed" | "noop";

/** Automatic retries per step before the invoice is paused for review. */
export const MAX_SEND_ATTEMPTS = 5;
/** Never send two reminders for the same invoice closer together than this. */
const MIN_GAP_MS = 20 * 3_600_000;
const HOUR = 3_600_000;

const INVOICE_SELECT = `
  SELECT i.id, i.tenant_id, i.amount_due, i.currency, i.due_date, i.payment_link,
         COALESCE(i.due_date, i.issue_date, i.created_at::date)::text AS anchor_date,
         i.external_id, i.next_step_index, i.next_step_due_at, i.snoozed_until, i.workflow_id,
         c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
         c.sms_opt_out AS customer_sms_opt_out,
         t.name AS tenant_name, t.tone, t.timezone, t.send_hour, t.skip_weekends,
         COALESCE((t.branding->>'hideBranding')::boolean, FALSE) AS hide_branding,
         t.branding->>'businessAddress' AS business_address
    FROM invoices i
    JOIN tenants t ON t.id = i.tenant_id
    LEFT JOIN customers c ON c.id = i.customer_id
`;

/** Per-run caches so a batch doesn't re-read the same workflow/template N times. */
class RunContext {
  private workflows = new Map<string, Promise<WorkflowRow | null>>();
  private templates = new Map<string, Promise<TemplateRow | null>>();

  workflow(inv: InvoiceForEngine): Promise<WorkflowRow | null> {
    const key = `${inv.tenant_id}:${inv.workflow_id ?? "default"}`;
    let p = this.workflows.get(key);
    if (!p) {
      p = (
        inv.workflow_id
          ? servicePool.query<WorkflowRow>(`SELECT id, enabled, steps FROM workflows WHERE id = $1 AND tenant_id = $2`, [inv.workflow_id, inv.tenant_id])
          : servicePool.query<WorkflowRow>(
              `SELECT id, enabled, steps FROM workflows WHERE tenant_id = $1 AND is_default = TRUE ORDER BY created_at LIMIT 1`,
              [inv.tenant_id],
            )
      ).then((r) => r.rows[0] ?? null);
      this.workflows.set(key, p);
    }
    return p;
  }

  template(tenantId: string, templateId: string | null): Promise<TemplateRow | null> {
    if (!templateId) return Promise.resolve(null);
    const key = `${tenantId}:${templateId}`;
    let p = this.templates.get(key);
    if (!p) {
      p = servicePool
        .query<TemplateRow>(`SELECT id, subject, body, approved FROM templates WHERE id = $1 AND tenant_id = $2`, [templateId, tenantId])
        .then((r) => r.rows[0] ?? null);
      this.templates.set(key, p);
    }
    return p;
  }
}

function scheduleOpts(inv: InvoiceForEngine): ScheduleOptions {
  return { timezone: inv.timezone, sendHour: inv.send_hour, skipWeekends: inv.skip_weekends };
}

async function audit(tenantId: string, action: string, detail: Record<string, unknown>, db: Pick<PoolClient, "query"> = servicePool) {
  await db
    .query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'system', $2, $3::jsonb)`, [
      tenantId,
      action,
      JSON.stringify(detail),
    ])
    .catch(() => {});
}

async function deferInvoice(invoiceId: string, until: Date): Promise<void> {
  await servicePool.query(`UPDATE invoices SET next_step_due_at = $2, updated_at = now() WHERE id = $1`, [invoiceId, until.toISOString()]);
}

async function transaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await servicePool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function isPermanent(err: unknown): boolean {
  return err instanceof PermanentEmailError || err instanceof PermanentSmsError;
}

/** Next step's time, but never sooner than MIN_GAP after the send we just made. */
function nextDueAfterSend(inv: InvoiceForEngine, steps: WorkflowStep[], sentIndex: number, now: Date): Date | null {
  const next = steps[sentIndex + 1];
  if (!next) return null;
  const scheduled = scheduledSendTime(inv.anchor_date, next.delayDays, scheduleOpts(inv), now);
  return new Date(Math.max(scheduled.getTime(), now.getTime() + MIN_GAP_MS));
}

async function processOne(inv: InvoiceForEngine, now: Date, force: boolean, ctx: RunContext): Promise<ProcessResult> {
  const wf = await ctx.workflow(inv);
  if (!wf || (!force && !wf.enabled)) {
    if (force) throw badRequest("This invoice has no active reminder workflow", "NO_WORKFLOW");
    await deferInvoice(inv.id, new Date(now.getTime() + HOUR));
    return "noop";
  }
  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  if (inv.next_step_index >= steps.length) {
    if (force) throw badRequest("All reminders in this sequence have already been sent", "SEQUENCE_COMPLETE");
    await servicePool.query(`UPDATE invoices SET next_step_index = 9999, next_step_due_at = NULL, updated_at = now() WHERE id = $1`, [inv.id]);
    return "advanced";
  }

  let index = inv.next_step_index;
  if (!force) {
    if (inv.snoozed_until && new Date(inv.snoozed_until) > now) {
      await deferInvoice(inv.id, new Date(inv.snoozed_until)); // promise-to-pay: stay quiet
      return "waiting";
    }
    // Hard floor between two contacts with the same customer about the same
    // invoice, derived from what was actually sent (robust to schedule resets).
    const last = await servicePool.query<{ last: string | null }>(
      `SELECT max(sent_at) AS last FROM messages WHERE tenant_id = $1 AND invoice_id = $2 AND sent_at IS NOT NULL`,
      [inv.tenant_id, inv.id],
    );
    const lastSent = last.rows[0]?.last ? new Date(last.rows[0].last).getTime() : 0;
    if (lastSent && now.getTime() - lastSent < MIN_GAP_MS) {
      await deferInvoice(inv.id, new Date(lastSent + MIN_GAP_MS));
      return "waiting";
    }
    const due = stepToSend(steps, index, inv.anchor_date, scheduleOpts(inv), now);
    if (due === -1) {
      await deferInvoice(inv.id, scheduledSendTime(inv.anchor_date, steps[index].delayDays, scheduleOpts(inv), now));
      return "waiting";
    }
    if (due > index) {
      // Several steps are already overdue (late import / downtime): send only the latest.
      await servicePool.query(`UPDATE invoices SET next_step_index = $2, updated_at = now() WHERE id = $1`, [inv.id, due]);
      await audit(inv.tenant_id, "dunning_steps_skipped", { invoice_id: inv.id, from_step: index, to_step: due });
      index = due;
    }
  }

  const step = steps[index];
  const template = await ctx.template(inv.tenant_id, step.templateId);
  if (!template?.approved) {
    if (force) throw badRequest("Approve this step's template before sending", "TEMPLATE_NOT_APPROVED");
    await deferInvoice(inv.id, new Date(now.getTime() + HOUR)); // re-evaluated when templates are approved
    return "noop";
  }

  const channel: "email" | "sms" = step.channel === "sms" ? "sms" : "email";
  const recipient =
    channel === "sms" ? (inv.customer_sms_opt_out ? null : inv.customer_phone) : inv.customer_email;
  if (!recipient) {
    if (force) throw badRequest(channel === "sms" ? "Customer has no phone number (or opted out of SMS)" : "Customer has no email address", "NO_RECIPIENT");
    await audit(inv.tenant_id, "dunning_skipped_no_recipient", { invoice_id: inv.id, step_index: index, channel });
    await deferInvoice(inv.id, new Date(now.getTime() + 24 * HOUR));
    return "skipped";
  }

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

  // ── 1. CLAIM ───────────────────────────────────────────────────────────
  const claim = await transaction(async (c) => {
    if (!(await deductCredit(c, inv.tenant_id, "dunning_send", inv.id))) return { kind: "no_credit" as const };
    const r = await c.query<{ attempts: number }>(
      `INSERT INTO messages (tenant_id, invoice_id, step_index, channel, status, reserved_until, attempts)
       VALUES ($1, $2, $3, $4, 'sending', now() + interval '5 minutes', 1)
       ON CONFLICT (tenant_id, invoice_id, step_index) WHERE step_index IS NOT NULL
       DO UPDATE SET status = 'sending', channel = EXCLUDED.channel,
                     reserved_until = now() + interval '5 minutes',
                     attempts = messages.attempts + 1, last_error = NULL
        WHERE (messages.status = 'sending' AND (messages.reserved_until IS NULL OR messages.reserved_until < now()))
           OR (messages.status = 'failed' AND ($5::boolean
                OR ((messages.reserved_until IS NULL OR messages.reserved_until < now()) AND messages.attempts < $6)))
       RETURNING attempts`,
      [inv.tenant_id, inv.id, index, channel, force, MAX_SEND_ATTEMPTS],
    );
    if (!r.rows.length) throw new ClaimConflict(); // rolls back the credit
    return { kind: "claimed" as const, attempts: r.rows[0].attempts };
  }).catch((err) => {
    if (err instanceof ClaimConflict) return { kind: "conflict" as const };
    throw err;
  });

  if (claim.kind === "no_credit") {
    if (force) throw new ApiError(402, "NO_CREDITS", "You're out of reminder credits. Upgrade your plan to keep sending.");
    await audit(inv.tenant_id, "dunning_skipped_no_credits", { invoice_id: inv.id, step_index: index, channel });
    await deferInvoice(inv.id, new Date(now.getTime() + HOUR)); // re-evaluated when credits are granted
    return "noop";
  }
  if (claim.kind === "conflict") {
    const existing = await servicePool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM messages WHERE tenant_id = $1 AND invoice_id = $2 AND step_index = $3`,
      [inv.tenant_id, inv.id, index],
    );
    const st = existing.rows[0]?.status;
    if (st && !["sending", "failed"].includes(st)) {
      // Already delivered for this step but the sequence didn't advance: advance now.
      const nextDue = nextDueAfterSend(inv, steps, index, now);
      await servicePool.query(
        `UPDATE invoices SET next_step_index = $2, next_step_due_at = $3, updated_at = now() WHERE id = $1`,
        [inv.id, nextDue ? index + 1 : 9999, nextDue?.toISOString() ?? null],
      );
      return "advanced";
    }
    if (force) throw new ApiError(409, "SEND_IN_PROGRESS", "A reminder for this step is already being sent. Try again in a few minutes.");
    await deferInvoice(inv.id, new Date(now.getTime() + 5 * 60_000));
    return "noop";
  }

  // ── 2. SEND (no transaction held) ─────────────────────────────────────
  let providerMsgId: string;
  try {
    if (channel === "sms") {
      const body = rendered.body.replace(/\s+/g, " ").trim().slice(0, 320);
      providerMsgId = (await sendSms({ to: recipient, body })).providerMsgId;
    } else {
      const email = reminderEmail({
        subject: rendered.subject,
        body: rendered.body,
        payLink: inv.payment_link,
        companyName: inv.tenant_name,
        hideBranding: inv.hide_branding,
        businessAddress: inv.business_address,
      });
      providerMsgId = (
        await sendEmail({
          to: recipient,
          subject: email.subject,
          text: email.text,
          html: email.html,
          fromName: inv.tenant_name,
          replyTo: replyAddressFor(inv.id),
          tag: "dunning-reminder",
          metadata: { tenant_id: inv.tenant_id, invoice_id: inv.id, step: String(index) },
          track: true,
        })
      ).providerMsgId;
    }
  } catch (err) {
    // ── 3b. RECORD FAILURE ──────────────────────────────────────────────
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    const permanent = isPermanent(err);
    const gaveUp = permanent || claim.attempts >= MAX_SEND_ATTEMPTS;
    await transaction(async (c) => {
      await c.query(
        `UPDATE messages SET status = 'failed', last_error = $4,
                reserved_until = now() + ($5 * interval '10 minutes'),
                attempts = CASE WHEN $6 THEN GREATEST(attempts, $7) ELSE attempts END
          WHERE tenant_id = $1 AND invoice_id = $2 AND step_index = $3`,
        [inv.tenant_id, inv.id, index, message, claim.attempts, permanent, MAX_SEND_ATTEMPTS],
      );
      await refundCredit(c, inv.tenant_id, "dunning_send_failed", inv.id);
      if (gaveUp) {
        // Needs a human: bad address, opted out, or provider kept failing.
        await c.query(`UPDATE invoices SET status = 'paused', updated_at = now() WHERE id = $1 AND status = 'open'`, [inv.id]);
      } else {
        await c.query(`UPDATE invoices SET next_step_due_at = now() + ($2 * interval '10 minutes'), updated_at = now() WHERE id = $1`, [
          inv.id,
          claim.attempts,
        ]);
      }
      await audit(
        inv.tenant_id,
        gaveUp ? "dunning_send_gave_up_invoice_paused" : "dunning_send_failed",
        { invoice_id: inv.id, step_index: index, channel, attempts: claim.attempts, permanent, error: message.slice(0, 300) },
        c,
      );
    });
    if (force) throw new ApiError(502, "SEND_FAILED", `Reminder not sent: ${message.slice(0, 300)}`);
    return "failed";
  }

  // ── 3a. RECORD SUCCESS ──────────────────────────────────────────────────
  const nextDue = nextDueAfterSend(inv, steps, index, now);
  await transaction(async (c) => {
    await c.query(
      `UPDATE messages SET provider_msg_id = $1, status = 'sent', sent_at = now(), reserved_until = NULL, last_error = NULL
        WHERE tenant_id = $2 AND invoice_id = $3 AND step_index = $4`,
      [providerMsgId, inv.tenant_id, inv.id, index],
    );
    await c.query(
      `UPDATE invoices SET next_step_index = $2, next_step_due_at = $3, updated_at = now() WHERE id = $1`,
      [inv.id, nextDue ? index + 1 : 9999, nextDue?.toISOString() ?? null],
    );
    await audit(
      inv.tenant_id,
      "dunning_sent",
      { invoice_id: inv.id, step_index: index, channel, provider_msg_id: providerMsgId, manual: force },
      c,
    );
  });
  return "sent";
}

class ClaimConflict extends Error {}

export type DunningRunResult = { sent: number; processed: number; failed: number; durationMs: number; skippedLease: boolean };

/**
 * Evaluate open invoices whose next action is due, in batches, until the time
 * budget is spent. Invoices whose next step is in the future are never loaded
 * (indexed on next_step_due_at). Failures are isolated per invoice.
 */
export async function runDunningDetailed(now = new Date()): Promise<DunningRunResult> {
  const started = Date.now();
  if (!(await acquireJobLease("dunning"))) return { sent: 0, processed: 0, failed: 0, durationMs: 0, skippedLease: true };
  const ctx = new RunContext();
  const seen = new Set<string>();
  const budget = Math.min(config.dunningTimeBudgetMs, 100_000); // stays well under the 120s lease
  let sent = 0;
  let failed = 0;

  try {
    while (Date.now() - started < budget) {
      const batch = await servicePool.query<InvoiceForEngine>(
        `${INVOICE_SELECT}
          WHERE i.status = 'open' AND i.next_step_index < 9999 AND t.status = 'active'
            AND (i.next_step_due_at IS NULL OR i.next_step_due_at <= $1)
            AND EXISTS (
              SELECT 1 FROM workflows w
               WHERE w.tenant_id = i.tenant_id AND w.enabled
                 AND (w.id = i.workflow_id OR (i.workflow_id IS NULL AND w.is_default))
            )
          ORDER BY i.next_step_due_at NULLS FIRST, i.id
          LIMIT $2`,
        [now.toISOString(), config.dunningBatchSize],
      );
      const fresh = batch.rows.filter((r) => !seen.has(r.id));
      if (fresh.length === 0) break;

      for (const inv of fresh) {
        if (Date.now() - started >= budget) break;
        seen.add(inv.id);
        try {
          const result = await processOne(inv, now, false, ctx);
          if (result === "sent") sent += 1;
          if (result === "failed") failed += 1;
        } catch (err) {
          failed += 1;
          await audit(inv.tenant_id, "dunning_error", { invoice_id: inv.id, error: err instanceof Error ? err.message : String(err) });
          await deferInvoice(inv.id, new Date(now.getTime() + 15 * 60_000)).catch(() => {});
        }
      }
      if (batch.rows.length < config.dunningBatchSize) break;
    }
    return { sent, processed: seen.size, failed, durationMs: Date.now() - started, skippedLease: false };
  } finally {
    await releaseJobLease("dunning").catch(() => {});
  }
}

/** Back-compat: number of reminders sent. */
export async function runDunning(now = new Date()): Promise<number> {
  return (await runDunningDetailed(now)).sent;
}

/** Manual "Send now" for a single invoice (admin-triggered). */
export async function sendNowForInvoice(tenantId: string, invoiceId: string): Promise<{ sent: boolean; result: ProcessResult }> {
  const r = await servicePool.query<InvoiceForEngine>(`${INVOICE_SELECT} WHERE i.id = $1 AND i.tenant_id = $2`, [invoiceId, tenantId]);
  const inv = r.rows[0];
  if (!inv) throw notFound("Invoice not found");
  const result = await processOne(inv, new Date(), true, new RunContext());
  return { sent: result === "sent", result };
}
