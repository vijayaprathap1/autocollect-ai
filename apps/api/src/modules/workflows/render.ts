export type RenderContext = {
  clientName: string | null;
  companyName: string | null;
  amountCents: number;
  currency: string;
  /** Calendar date "YYYY-MM-DD" */
  dueDate: string | null;
  payLink: string | null;
  invoiceNumber: string | null;
  tone: string;
};

/** Placeholders a template may use. Anything else is left as-is and flagged on save. */
export const TEMPLATE_VARIABLES = ["client_name", "company_name", "amount", "due_date", "pay_link", "invoice_number"] as const;

export function money(cents: number, currency: string): string {
  const code = (currency || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(Number(cents) / 100);
  } catch {
    return `${(Number(cents) / 100).toFixed(2)} ${code}`;
  }
}

export function formatCalendarDate(date: string | null): string {
  if (!date) return "the due date";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date));
  if (!m) return String(date);
  // Format the calendar date itself (UTC) — never shift it by the server timezone.
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Unknown `{placeholders}` in a template (typos like `{clientname}`). */
export function unknownPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(m[1])) found.add(m[1]);
  }
  return [...found];
}

export function renderTemplate(template: { subject: string; body: string }, ctx: RenderContext): { subject: string; body: string } {
  const vars: Record<string, string> = {
    client_name: ctx.clientName?.trim() || "there",
    company_name: ctx.companyName?.trim() || "our team",
    amount: money(ctx.amountCents, ctx.currency),
    due_date: formatCalendarDate(ctx.dueDate),
    pay_link: ctx.payLink ?? "",
    invoice_number: ctx.invoiceNumber ?? "",
    tone: ctx.tone,
  };
  const sub = (s: string) => s.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? vars[k] : whole));
  // Subjects are single-line headers: strip CR/LF so nothing can inject headers.
  return { subject: sub(template.subject).replace(/[\r\n]+/g, " ").trim().slice(0, 250), body: sub(template.body) };
}
