import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { isUuid } from "./errors.js";

/**
 * Reply routing for customer emails.
 *
 * Reminders set `Reply-To: <local>+<invoiceId>.<sig>@<domain>` using the
 * Postmark inbound address. Postmark hands us the part after "+" as
 * MailboxHash, which we verify before attaching the reply to an invoice —
 * so nobody can forge replies (and pause invoices) by guessing ids.
 */

function secret(): string {
  return config.stateSecret || "dev-reply-routing-secret";
}

function sign(invoiceId: string): string {
  return createHmac("sha256", secret()).update(`reply:${invoiceId}`).digest("base64url").slice(0, 16);
}

export function replyAddressFor(invoiceId: string): string | undefined {
  const addr = config.inboundReplyAddress;
  const at = addr.lastIndexOf("@");
  if (!addr || at <= 0) return undefined;
  const local = addr.slice(0, at).split("+")[0];
  return `${local}+${invoiceId}.${sign(invoiceId)}@${addr.slice(at + 1)}`;
}

/** Returns the invoice id when the mailbox hash carries a valid signature. */
export function invoiceIdFromMailboxHash(hash: string | undefined | null): string | null {
  if (!hash) return null;
  const [invoiceId, sig] = hash.trim().split(".");
  if (!isUuid(invoiceId) || !sig) return null;
  const expected = Buffer.from(sign(invoiceId));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given) ? invoiceId : null;
}
