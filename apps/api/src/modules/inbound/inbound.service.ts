import { servicePool } from "../../lib/db.js";
import { classifyReply, suggestReply } from "../../lib/ai.js";
import type { ReplyClassification } from "@autocollect/shared";
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from "../../lib/webhook-events.js";
import { invoiceIdFromMailboxHash } from "../../lib/reply-address.js";
import { sendEmail } from "../../lib/postmark.js";
import { replyNotificationEmail } from "../../lib/email-templates.js";
import { config } from "../../config.js";

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

/**
 * Message ids referenced by the reply's threading headers. Postmark's outbound
 * `Message-ID` header is `<{MessageID}@mtasv.net>` while we store the bare
 * MessageID, so both the full id and its local part are candidates.
 */
export function referenceMessageIds(payload: PostmarkInboundPayload): string[] {
  const names = new Set(["in-reply-to", "references"]);
  const values = (payload.Headers ?? []).filter((h) => h.Name && names.has(h.Name.toLowerCase())).map((h) => h.Value ?? "");
  const ids = values.flatMap((v) => v.match(/<([^>]+)>/g) ?? []).map((m) => m.slice(1, -1));
  const candidates = new Set<string>();
  for (const id of ids) {
    candidates.add(id);
    if (id.includes("@")) candidates.add(id.split("@")[0]);
  }
  return [...candidates].slice(0, 50);
}

export type InboundResult = {
  matched: boolean;
  classification?: ReplyClassification;
  promiseDate?: string | null;
  invoiceId?: string;
};

async function notifyTeam(tenantId: string, invoiceId: string, classification: string, excerpt: string, fromName: string | null) {
  const t = await servicePool.query<{ name: string; reply_notifications: boolean; external_id: string | null; customer_name: string | null }>(
    `SELECT t.name, t.reply_notifications, i.external_id, c.name AS customer_name
       FROM tenants t JOIN invoices i ON i.tenant_id = t.id LEFT JOIN customers c ON c.id = i.customer_id
      WHERE t.id = $1 AND i.id = $2`,
    [tenantId, invoiceId],
  );
  const row = t.rows[0];
  if (!row?.reply_notifications || classification === "junk") return;
  const admins = await servicePool.query<{ email: string }>(
    `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.status = 'active' AND m.role IN ('owner','admin') AND u.status = 'active'
      LIMIT 10`,
    [tenantId],
  );
  const tmpl = replyNotificationEmail({
    orgName: row.name,
    customerName: row.customer_name ?? fromName,
    invoiceNumber: row.external_id,
    classification,
    excerpt: excerpt.slice(0, 1200),
    inboxUrl: `${config.webOrigin.split(",")[0]}/replies`,
  });
  await Promise.allSettled(
    admins.rows.map((a) => sendEmail({ to: a.email, subject: tmpl.subject, text: tmpl.text, html: tmpl.html, tag: "reply-notification" })),
  );
}

/**
 * Process a Postmark inbound webhook: resolve the invoice (signed reply
 * address first, then email threading headers), classify with AI, persist,
 * apply dunning effects (dispute -> pause, promise -> snooze until the date),
 * and notify the workspace admins.
 */
export async function processInboundEmail(payload: PostmarkInboundPayload): Promise<InboundResult> {
  const messageId = payload.MessageID;
  if (messageId && !(await claimWebhookEvent(`pm-in:${messageId}`, "postmark"))) return { matched: false };
  const finish = async (r: InboundResult) => {
    if (messageId) await completeWebhookEvent(`pm-in:${messageId}`);
    return r;
  };

  try {
    const content = (payload.StrippedTextReply || payload.TextBody || "").trim();
    if (!content) return finish({ matched: false });

    let resolved: { tenant_id: string; invoice_id: string } | null = null;

    const signedInvoice = invoiceIdFromMailboxHash(payload.MailboxHash);
    if (signedInvoice) {
      const row = await servicePool.query<{ tenant_id: string }>(`SELECT tenant_id FROM invoices WHERE id = $1`, [signedInvoice]);
      if (row.rows[0]) resolved = { tenant_id: row.rows[0].tenant_id, invoice_id: signedInvoice };
    }
    if (!resolved) {
      const refs = referenceMessageIds(payload);
      if (refs.length) {
        const row = await servicePool.query<{ tenant_id: string; invoice_id: string }>(
          `SELECT m.tenant_id, m.invoice_id FROM messages m
            WHERE m.provider_msg_id = ANY($1::text[]) AND m.invoice_id IS NOT NULL
            ORDER BY m.created_at DESC LIMIT 1`,
          [refs],
        );
        resolved = row.rows[0] ?? null;
      }
    }
    if (!resolved) return finish({ matched: false });

    const from = firstNameField(payload.FromFull);
    const classification = await classifyReply(content);

    const invCtx = await servicePool.query<{
      amount_due: number; currency: string; due_date: string | null; payment_link: string | null; external_id: string | null;
    }>(`SELECT amount_due, currency, due_date::text AS due_date, payment_link, external_id FROM invoices WHERE id = $1`, [resolved.invoice_id]);
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
    }).catch(() => null);

    await servicePool.query(
      `INSERT INTO replies (tenant_id, invoice_id, channel, content, classification, promise_date, suggested_body)
       VALUES ($1, $2, 'email', $3, $4, $5, $6)`,
      [resolved.tenant_id, resolved.invoice_id, content.slice(0, 5000), classification.classification, classification.promiseDate, suggestion?.body ?? null],
    );
    await servicePool.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'reply_received', $3::jsonb)`, [
      resolved.tenant_id,
      from.Email ?? "customer",
      JSON.stringify({
        invoice_id: resolved.invoice_id,
        classification: classification.classification,
        promise_date: classification.promiseDate,
        confidence: classification.confidence,
      }),
    ]);

    if (classification.classification === "dispute") {
      await servicePool.query(`UPDATE invoices SET status = 'paused', updated_at = now() WHERE id = $1 AND status = 'open'`, [resolved.invoice_id]);
    } else if (classification.classification === "promise" && classification.promiseDate) {
      // Stay quiet until the day after the promised date, then resume if still unpaid.
      await servicePool.query(
        `UPDATE invoices SET snoozed_until = ($2::date + interval '1 day'), next_step_due_at = ($2::date + interval '1 day'), updated_at = now()
          WHERE id = $1 AND status = 'open'`,
        [resolved.invoice_id, classification.promiseDate],
      );
    }

    await notifyTeam(resolved.tenant_id, resolved.invoice_id, classification.classification, content, from.Name ?? null).catch(() => {});

    return finish({
      matched: true,
      classification: classification.classification,
      promiseDate: classification.promiseDate,
      invoiceId: resolved.invoice_id,
    });
  } catch (err) {
    if (messageId) await failWebhookEvent(`pm-in:${messageId}`, err).catch(() => {});
    throw err;
  }
}
