import type { Template } from "@autocollect/shared";

export type RenderContext = {
  clientName: string | null;
  companyName: string | null;
  amountCents: number;
  currency: string;
  dueDate: string | null;
  payLink: string | null;
  invoiceNumber: string | null;
  tone: string;
};

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function fmtDate(date: string | null): string {
  if (!date) return "the due date";
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function renderTemplate(template: Pick<Template, "subject" | "body">, ctx: RenderContext): {
  subject: string;
  body: string;
} {
  const vars: Record<string, string> = {
    client_name: ctx.clientName ?? "there",
    company_name: ctx.companyName ?? "our team",
    amount: money(ctx.amountCents, ctx.currency),
    due_date: fmtDate(ctx.dueDate),
    pay_link: ctx.payLink ?? "",
    invoice_number: ctx.invoiceNumber ?? "",
    tone: ctx.tone,
  };

  const sub = (s: string) =>
    s.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? vars[k] : `{${k}}`));

  return { subject: sub(template.subject), body: sub(template.body) };
}