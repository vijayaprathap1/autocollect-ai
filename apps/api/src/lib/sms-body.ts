/** SMS body helpers for reminders (pure, unit-tested). */

export const SMS_MAX_CHARS = 320; // two GSM-7 segments
export const SMS_STOP_TEXT = "Reply STOP to opt out.";

/**
 * Build an SMS reminder that never loses the pay link or the opt-out notice:
 * only the message text is shortened to fit the length budget.
 */
export function buildSmsBody(text: string, payLink: string | null, maxChars = SMS_MAX_CHARS): string {
  const link = payLink?.trim() ?? "";
  let clean = text.replace(/\s+/g, " ").trim();
  // Templates usually embed the link already; keep a single copy at the end.
  if (link) clean = clean.split(link).join("").replace(/\s+/g, " ").trim();

  const tail = [link ? `Pay: ${link}` : "", SMS_STOP_TEXT].filter(Boolean).join(" ");
  const budget = maxChars - tail.length - 1;
  if (budget <= 0) return tail.slice(0, maxChars);

  const body = clean.length > budget ? `${clean.slice(0, Math.max(0, budget - 1)).trimEnd()}…` : clean;
  return body ? `${body} ${tail}` : tail;
}

/** Twilio 21610: the recipient replied STOP, so the number must not be texted again. */
export function isSmsOptOutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\/21610:/.test(msg) || /\b21610\b/.test(msg);
}
