import { Link } from "react-router-dom";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { Field } from "@/components/auth";
import { useToast } from "@/components/Toast";
import { createPromise, getPromises } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";

const STATUSES = ["", "open", "kept", "broken", "cancelled"];

export function Promises() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [status, setStatus] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [date, setDate] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["promises", status], queryFn: () => getPromises(status || undefined) });
  const rows = data?.promises ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await createPromise({ invoiceId: invoiceId.trim(), promiseDate: date });
      setInvoiceId("");
      setDate("");
      await queryClient.invalidateQueries({ queryKey: ["promises"] });
      showToast("Promise recorded. Reminders wait until the day after that date.", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader title="Promises to pay" subtitle="A promise pauses reminders until the day after the date. Payment on time marks it kept. A missed date opens a follow-up task." />
      <Card>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <Field label="Invoice id" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} required />
          <Field label="Promised date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <Button type="submit" disabled={!invoiceId.trim() || !date}>Record promise</Button>
        </form>
      </Card>
      <label className="block max-w-xs text-sm">
        <span className="mb-1 block text-muted">Status</span>
        <select className="w-full rounded-md border border-line bg-surface px-2 py-2" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || "All"}</option>)}
        </select>
      </label>
      {isLoading ? <Card><Spinner label="Loading promises…" /></Card> : rows.length === 0 ? (
        <EmptyState title="No promises" description="They are created from a classified reply, or recorded here." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Invoice</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3">{p.customer_name ?? "—"}</td>
                  <td className="px-4 py-3">{p.invoice_id ? <Link className="text-primary hover:underline" to={`/invoices/${p.invoice_id}`}>{p.external_id ?? "Invoice"}</Link> : "—"}</td>
                  <td className="px-4 py-3">{formatMoney(p.amount, p.currency)}</td>
                  <td className="px-4 py-3">{formatDate(p.promise_date)}</td>
                  <td className="px-4 py-3">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
