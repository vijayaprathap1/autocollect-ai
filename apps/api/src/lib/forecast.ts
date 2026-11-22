export type ForecastInvoice = {
  amountDue: number;
  dueDate: string | null;
  promiseDate: string | null;
};

export type ForecastBucket = { period: string; expectedCents: number; invoiceCount: number };

/** Week (or month) buckets of expected cash. Promises pull the date forward; history scales confidence. */
export function forecastCollections(invoices: ForecastInvoice[], grain: "week" | "month", keepRate = 1): ForecastBucket[] {
  const rate = Math.min(1, Math.max(0, keepRate));
  const map = new Map<string, ForecastBucket>();
  for (const inv of invoices) {
    const raw = inv.promiseDate ?? inv.dueDate;
    if (!raw || inv.amountDue <= 0) continue;
    const period = grain === "month" ? raw.slice(0, 7) : weekStart(raw);
    const row = map.get(period) ?? { period, expectedCents: 0, invoiceCount: 0 };
    row.expectedCents += Math.round(inv.amountDue * rate);
    row.invoiceCount += 1;
    map.set(period, row);
  }
  return [...map.values()].sort((a, b) => a.period.localeCompare(b.period));
}

function weekStart(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}
