export type MatchInvoice = {
  id: string;
  customerId: string | null;
  amountDue: number;
  dueDate: string | null;
  externalId: string | null;
};

export type SuggestedLine = {
  invoiceId: string;
  amount: number;
  method: "exact" | "partial" | "multi";
  confidence: number;
  reason: string;
};

/** Suggest how to apply one receipt to a customer's open invoices. Pure and deterministic. */
export function suggestApplications(amount: number, customerId: string | null, invoices: MatchInvoice[]): SuggestedLine[] {
  if (amount <= 0) return [];
  const open = invoices
    .filter((inv) => inv.amountDue > 0 && (customerId == null || inv.customerId === customerId))
    .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  if (!open.length) return [];

  const exact = open.find((inv) => inv.amountDue === amount);
  if (exact) {
    return [{ invoiceId: exact.id, amount, method: "exact", confidence: 0.98, reason: "Amount matches one open invoice" }];
  }

  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < Math.min(open.length, i + 8); j++) {
      if (open[i].amountDue + open[j].amountDue === amount) {
        return [
          { invoiceId: open[i].id, amount: open[i].amountDue, method: "multi", confidence: 0.9, reason: "Amount matches two open invoices" },
          { invoiceId: open[j].id, amount: open[j].amountDue, method: "multi", confidence: 0.9, reason: "Amount matches two open invoices" },
        ];
      }
    }
  }

  const lines: SuggestedLine[] = [];
  let left = amount;
  for (const inv of open) {
    if (left <= 0) break;
    const take = Math.min(inv.amountDue, left);
    lines.push({
      invoiceId: inv.id,
      amount: take,
      method: take === inv.amountDue ? "multi" : "partial",
      confidence: 0.6,
      reason: "Applied oldest invoices first",
    });
    left -= take;
    if (lines.length >= 12) break;
  }
  return lines;
}
