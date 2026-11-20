/** Pure helpers for the send engine (unit-tested). */

export const SMS_MAX_CHARS = 320; // two GSM-7 segments
export const SMS_STOP_TEXT = "Reply STOP to opt out.";
export const MAX_SEND_ATTEMPTS = 3;

/**
 * Build an SMS body that never loses the pay link or the opt-out notice:
 * only the message text is truncated to fit the length budget.
 */
export function buildSmsBody(text: string, payLink: string | null, maxChars = SMS_MAX_CHARS): string {
  const link = payLink?.trim() ?? "";
  let clean = text.replace(/\s+/g, " ").trim();
  // The template usually embeds the link already; keep a single copy at the end.
  if (link) clean = clean.split(link).join("").replace(/\s+/g, " ").trim();

  const tail = [link ? `Pay: ${link}` : "", SMS_STOP_TEXT].filter(Boolean).join(" ");
  const budget = maxChars - tail.length - 1;
  if (budget <= 0) return tail.slice(0, maxChars);

  const body = clean.length > budget ? `${clean.slice(0, Math.max(0, budget - 1)).trimEnd()}…` : clean;
  return body ? `${body} ${tail}` : tail;
}

/** Plain-text email footer with the unsubscribe link. */
export function withUnsubscribeFooter(text: string, url: string): string {
  return `${text.trimEnd()}\n\n--\nDon't want these reminders? Unsubscribe: ${url}`;
}

/** Twilio error 21610: the recipient replied STOP and has unsubscribed. */
export function isSmsUnsubscribedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b21610\b/.test(msg);
}

/**
 * Message-ID references from email headers, plus their local parts. Postmark
 * threads carry `<MessageID@mtasv.net>` while we store the bare MessageID.
 */
export function referenceIdCandidates(headerValues: string[]): string[] {
  const ids = headerValues.flatMap((v) => v.match(/<([^>]+)>/g) ?? []).map((m) => m.slice(1, -1).trim());
  const out = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    out.add(id);
    const at = id.indexOf("@");
    if (at > 0) out.add(id.slice(0, at));
  }
  return [...out];
}

/** Lower-cased domain of an email address, or null. */
export function emailDomain(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf("@") ?? -1;
  if (!email || at < 1) return null;
  return email.slice(at + 1).trim().toLowerCase() || null;
}
