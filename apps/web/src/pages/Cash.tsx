import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { Field } from "@/components/auth";
import { useToast } from "@/components/Toast";
import { applyCash, cashSuggestions, dismissCash, getCashPayments, importCashCsv, recordCash } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useMe } from "@/lib/me";

export function Cash() {
  const me = useMe();
  const currency = me.tenant?.currency ?? "usd";
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const payments = useQuery({ queryKey: ["cash"], queryFn: getCashPayments });
  const [externalId, setExternalId] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState<{ paymentId: string; lines: { invoiceId: string; label: string; due: number; amount: string }[] } | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      await recordCash({ externalId: externalId.trim(), amount: Math.round(Number(amount) * 100), currency });
      setExternalId("");
      setAmount("");
      await queryClient.invalidateQueries({ queryKey: ["cash"] });
      showToast("Receipt added to the unapplied queue", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    }
  }

  async function accept(id: string) {
    setBusy(id);
    try {
      const suggestion = await cashSuggestions(id);
      if (!suggestion.suggestions.length) {
        showToast("No open invoice matches this receipt", "error");
        return;
      }
      await applyCash(id, suggestion.suggestions.map((line) => ({ invoiceId: line.invoiceId, amount: line.amount })), true);
      await queryClient.invalidateQueries({ queryKey: ["cash"] });
      showToast("Cash applied", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function openManual(id: string) {
    const suggestion = await cashSuggestions(id);
    setManual({
      paymentId: id,
      lines: suggestion.invoices.map((inv) => ({
        invoiceId: inv.id,
        label: inv.externalId ?? inv.id.slice(0, 8),
        due: inv.amountDue,
        amount: "",
      })),
    });
  }

  async function applyManual(e: React.FormEvent) {
    e.preventDefault();
    if (!manual) return;
    const lines = manual.lines
      .map((line) => ({ invoiceId: line.invoiceId, amount: Math.round(Number(line.amount) * 100) }))
      .filter((line) => line.amount > 0);
    if (!lines.length) {
      showToast("Enter an amount on at least one invoice", "error");
      return;
    }
    setBusy(manual.paymentId);
    try {
      await applyCash(manual.paymentId, lines, false);
      setManual(null);
      await queryClient.invalidateQueries({ queryKey: ["cash"] });
      showToast("Cash applied", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  const rows = payments.data?.payments ?? [];
  return (
    <div className="grid gap-6">
      <PageHeader title="Cash application" subtitle="Match Stripe, QuickBooks, CSV and manual receipts to open invoices. Exact, partial and multi-invoice suggestions stay in the unapplied queue until you accept them." />
      <Card>
        <form onSubmit={add} className="flex flex-wrap items-end gap-3">
          <Field label="Reference" value={externalId} onChange={(e) => setExternalId(e.target.value)} required />
          <Field label="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
          <Button type="submit" disabled={!externalId.trim() || !amount}>Record receipt</Button>
        </form>
        <form className="mt-4 flex flex-wrap items-center gap-3" onSubmit={(e) => {
          e.preventDefault();
          const file = (e.currentTarget.elements.namedItem("file") as HTMLInputElement).files?.[0];
          if (!file) return;
          importCashCsv(file).then(async (res) => {
            await queryClient.invalidateQueries({ queryKey: ["cash"] });
            showToast(`Imported ${res.imported} receipts`, res.failed ? "error" : "success");
          }).catch((err) => showToast((err as Error).message, "error"));
        }}>
          <label className="text-sm text-muted">CSV payments<input name="file" type="file" accept=".csv,text/csv" className="ml-2 text-sm" /></label>
          <Button type="submit" variant="secondary">Import</Button>
        </form>
      </Card>
      {payments.isError ? <EmptyState title="Cash could not load" description={(payments.error as Error).message} /> : payments.isLoading ? <Card><Spinner label="Loading unapplied cash…" /></Card> : rows.length === 0 ? (
        <EmptyState title="No unapplied cash" description="Stripe payments that name an invoice apply themselves. Everything else waits here." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3">Customer</th><th className="px-4 py-3">Source</th><th className="px-4 py-3">Unapplied</th><th className="px-4 py-3">Reference</th><th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-line">
                  <td className="px-4 py-3">{p.customer_name ?? "Unassigned"}</td>
                  <td className="px-4 py-3">{p.source}</td>
                  <td className="px-4 py-3">{formatMoney(p.unapplied, p.currency || currency)}</td>
                  <td className="px-4 py-3">{p.external_id}</td>
                  <td className="px-4 py-3 text-right">
                    <Button type="button" disabled={busy === p.id} onClick={() => void accept(p.id)}>{busy === p.id ? "Applying…" : "Apply suggestion"}</Button>
                    <Button type="button" variant="secondary" className="ml-2" onClick={() => void openManual(p.id)}>Choose invoices</Button>
                    <Button type="button" variant="secondary" className="ml-2" onClick={() => dismissCash(p.id).then(() => queryClient.invalidateQueries({ queryKey: ["cash"] })).catch((err) => showToast((err as Error).message, "error"))}>Dismiss</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {manual && (
            <form onSubmit={applyManual} className="grid gap-2 border-t border-line p-4">
              <p className="text-sm font-medium">Apply specific amounts</p>
              {manual.lines.length === 0 ? <p className="text-sm text-muted">No open invoices for this receipt.</p> : manual.lines.map((line) => (
                <label key={line.invoiceId} className="flex items-center justify-between gap-3 text-sm">
                  <span>{line.label} · due {formatMoney(line.due, currency)}</span>
                  <input aria-label={`Amount for ${line.label}`} className="w-28 rounded-lg border border-line bg-bg px-2 py-1" inputMode="decimal" value={line.amount} onChange={(e) => setManual({ ...manual, lines: manual.lines.map((item) => item.invoiceId === line.invoiceId ? { ...item, amount: e.target.value } : item) })} />
                </label>
              ))}
              <Button type="submit" disabled={busy === manual.paymentId}>Apply selected</Button>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
