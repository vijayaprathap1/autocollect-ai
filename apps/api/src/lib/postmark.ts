import { config } from "../config.js";
import { fetchWithTimeout } from "./http.js";

/**
 * Postmark client (minimal, via HTTP).
 * When POSTMARK_SERVER_TOKEN is unset the app runs in mock mode:
 * sends are logged to messages as 'sent' with a fake provider id,
 * so the full dunning flow can be exercised without email access.
 */
export const postmarkEnabled = Boolean(config.postmarkServerToken);

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  tag?: string;
  replyTo?: string;
  headers?: { Name: string; Value: string }[];
};

/**
 * Reply-To address that routes a customer's reply back to its invoice
 * (`local+<invoiceId>@domain`, surfaced by Postmark as MailboxHash).
 */
export function replyToForInvoice(invoiceId: string): string | undefined {
  const inbound = config.postmarkInboundAddress;
  const at = inbound.lastIndexOf("@");
  if (!inbound || at < 1) return undefined;
  const local = inbound.slice(0, at).split("+")[0];
  return `${local}+${invoiceId}@${inbound.slice(at + 1)}`;
}

export async function sendEmail(input: SendEmailInput): Promise<{ providerMsgId: string }> {
  if (!postmarkEnabled) {
    return { providerMsgId: `dev-${Math.random().toString(36).slice(2, 10)}` };
  }

  const res = await fetchWithTimeout("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Postmark-Server-Token": config.postmarkServerToken,
    },
    body: JSON.stringify({
      From: config.postmarkFromEmail,
      To: input.to,
      Subject: input.subject,
      TextBody: input.text,
      HtmlBody: input.html,
      MessageStream: "outbound",
      Tag: input.tag,
      ...(input.replyTo ? { ReplyTo: input.replyTo } : {}),
      ...(input.headers?.length ? { Headers: input.headers } : {}),
    }),
  }, config.providerTimeoutMs);

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Postmark error ${res.status}: ${detail.slice(0, 300)}`);
  }

  const body = (await res.json()) as { MessageID?: string; ErrorCode?: number };
  if (body.ErrorCode && body.ErrorCode !== 0) {
    throw new Error(`Postmark error ${body.ErrorCode}`);
  }
  return { providerMsgId: body.MessageID ?? "unknown" };
}