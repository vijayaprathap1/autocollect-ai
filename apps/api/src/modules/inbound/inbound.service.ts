import { servicePool } from "../../lib/db.js";
import { classifyReply, suggestReply } from "../../lib/ai.js";
import type { ReplyClassification } from "@autocollect/shared";
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from "../../lib/webhook-events.js";

export type PostmarkInboundPayload = {
  MessageID?: string;
  FromFull?: { Email?: string; Name?: string } | { Email?: string; Name?: string }[];
  MailboxHash?: string;
  Subject?: string;
  TextBody?: string;
  StrippedTextReply?: string;
  Headers?: { Name?: string; Value?: string }[];
};

function firstNameField(
  field: { Email?: string; Name?: string } | { Email?: string; Name?: string }[] | undefined,
): { Email?: string; Name?: string } {
  if (Array.isArray(field)) return field[0] ?? {};
  return field ?? {};
}

function referenceMessageIds(payload: PostmarkInboundPayload): string[] {
  const names = new Set(["In-Reply-To", "References", "Message-ID"]);
  const values = (payload.Headers ?? [])
    .filter((h) => h.Name && names.has(h.Name))
    .map((h) => h.Value ?? "");
  const ids = values
    .flatMap((v) => v.match(/<([^>]+)>/g) ?? [])
    .map((m) => m.slice(1, -1));
  return [...new Set(ids)];
}

export type InboundResult = {
  matched: boolean;
  classification?: ReplyClassification;
  promiseDate?: string | null;
  invoiceId?: string;
};

/**
 * Process a Postmark inbound webhook: resolve the original invoice from the
 * email thread, classify the reply with AI, persist it, and apply dunning
 * effects (dispute -> pause, promise -> schedule resume).
 */
export async function processInboundEmail(payload: PostmarkInboundPayload): Promise<InboundResult> {
  const messageId = payload.MessageID;
  if (messageId) {
    if (!(await claimWebhookEvent(messageId, "postmark"))) return { matched: false };
  }

  try {

  const content = payload.StrippedTextReply || payload.TextBody || "";
  if (!content.trim()) return { matched: false };

  // Resolve tenant + invoice from the email thread (references our outbound MessageID).
  const refs = referenceMessageIds(payload);
  let resolved: { tenant_id: string; invoice_id: string } | null = null;

  if (refs.length > 0) {
    const row = await servicePool.query<{ tenant_id: string; invoice_id: string }>(
      `SELECT m.tenant_id, m.invoice_id
         FROM messages m
        WHERE m.provider_msg_id = ANY($1::text[]) AND m.invoice_id IS NOT NULL
        ORDER BY m.created_at DESC
        LIMIT 1`,
      [refs],
    );
    resolved = row.rows[0] ?? null;
  }

  // Fallback: tagged subaddress `invoices+<invoiceId>@...` (MailboxHash).
  if (!resolved && payload.MailboxHash && /^[0-9a-f-]{36}$/i.test(payload.MailboxHash)) {
    const row = await servicePool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM invoices WHERE id = $1`,
      [payload.MailboxHash],
    );
    if (row.rows[0]) resolved = { tenant_id: row.rows[0].tenant_id, invoice_id: payload.MailboxHash };
  }

  if (!resolved) return { matched: false };

  const from = firstNameField(payload.FromFull);
  const classification = await classifyReply(content);

  // Gather invoice context for a suggested reply (amount, due date, pay link).
  const invCtx = await servicePool.query<{
    amount_due: number;
    currency: string;
    due_date: string | null;
    payment_link: string | null;
    external_id: string | null;
  }>(`SELECT amount_due, currency, due_date::text AS due_date, payment_link, external_id
       FROM invoices WHERE id = $1`, [resolved.invoice_id]);
  const inv = invCtx.rows[0];

  const suggestion = await suggestReply({
    classification: classification.classification,
    replyText: content,
    clientName: from.Name ?? null,
    amountCents: inv?.amount_due ?? 0,
    currency: inv?.currency ?? "usd",
    dueDate: inv?.due_date ?? null,
    payLink: inv?.payment_link ?? null,
    invoiceNumber: inv?.external_id ?? null,
  });

  await servicePool.query(
    `INSERT INTO replies (tenant_id, invoice_id, channel, content, classification, promise_date, suggested_body)
     VALUES ($1, $2, 'email', $3, $4, $5, $6)`,
    [
      resolved.tenant_id,
      resolved.invoice_id,
      content.slice(0, 5000),
      classification.classification,
      classification.promiseDate,
      suggestion?.body ?? null,
    ],
  );

  await servicePool.query(
    `INSERT INTO audit_log (tenant_id, actor, action, detail)
     VALUES ($1, $2, 'reply_received', $3::jsonb)`,
    [
      resolved.tenant_id,
      from.Email ?? "customer",
      JSON.stringify({
        invoice_id: resolved.invoice_id,
        classification: classification.classification,
        promise_date: classification.promiseDate,
        confidence: classification.confidence,
      }),
    ],
  );

  if (classification.classification === "dispute") {
    await servicePool.query(
      `UPDATE invoices SET status = 'paused', updated_at = now()
       WHERE id = $1 AND status = 'open'`,
      [resolved.invoice_id],
    );
  } else if (classification.classification === "promise" && classification.promiseDate) {
    await servicePool.query(
      `UPDATE invoices SET next_step_due_at = $2, updated_at = now()
       WHERE id = $1 AND status = 'open'`,
      [resolved.invoice_id, classification.promiseDate],
    );
  }

  const result = {
    matched: true,
    classification: classification.classification,
    promiseDate: classification.promiseDate,
    invoiceId: resolved.invoice_id,
  };
  if (messageId) await completeWebhookEvent(messageId);
  return result;
  } catch (err) {
    if (messageId) await failWebhookEvent(messageId, err).catch(() => {});
    throw err;
  }
}
