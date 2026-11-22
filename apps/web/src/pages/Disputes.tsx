import { Link } from "react-router-dom";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { getDisputes } from "@/lib/api";
import { formatMoney } from "@/lib/format";

const STATUSES = ["", "open", "investigating", "pending_customer", "resolved", "rejected"];

export function Disputes() {
  const [status, setStatus] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["disputes", status], queryFn: () => getDisputes(status || undefined) });
  const rows = data?.disputes ?? [];
  return (
    <div>
      <PageHeader title="Disputes" subtitle="Cases opened from a customer reply, or created by a collector. Resolving one resumes reminders." />
      <label className="mb-4 block max-w-xs text-sm">
        <span className="mb-1 block text-muted">Status</span>
        <select className="w-full rounded-md border border-slate-300 bg-white px-2 py-2" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || "All"}</option>)}
        </select>
      </label>
      {isLoading ? <Card><Spinner label="Loading disputes…" /></Card> : rows.length === 0 ? (
        <EmptyState title="No disputes" description="A reply classified as a dispute opens a case here and pauses that invoice." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Invoice</th>
                <th className="px-4 py-3 font-medium">Reason</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">{d.customer_id ? <Link className="text-primary hover:underline" to={`/customers/${d.customer_id}`}>{d.customer_name ?? "Customer"}</Link> : "—"}</td>
                  <td className="px-4 py-3">{d.invoice_id ? <Link className="hover:underline" to={`/invoices/${d.invoice_id}`}>{d.external_id ?? "Invoice"}</Link> : "—"}</td>
                  <td className="px-4 py-3"><Link className="font-medium text-primary hover:underline" to={`/disputes/${d.id}`}>{d.reason_code}</Link></td>
                  <td className="px-4 py-3">{d.status}</td>
                  <td className="px-4 py-3">{d.amount_due != null ? formatMoney(d.amount_due, d.currency ?? "usd") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
