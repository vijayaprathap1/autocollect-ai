import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Card, EmptyState, Input, PageHeader, Spinner } from "@/components/ui";
import { getInvoices, invoiceAction, type InvoiceDto } from "@/lib/api";
import { daysUntil, formatDate, formatMoney } from "@/lib/format";
import { useMe } from "@/lib/me";

type Filter = "all" | "open" | "overdue" | "paid" | "paused" | "void" | "uncollectible";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "overdue", label: "Overdue" },
  { value: "paid", label: "Paid" },
  { value: "paused", label: "Paused" },
  { value: "void", label: "Void" },
];

export function Invoices() {
  const me = useMe();
  const [filter, setFilter] = useState<Filter>("all");
  const [source, setSource] = useState<string>("all");
  const [q, setQ] = useState("");

  const statusParam = filter === "overdue" ? "open" : filter === "all" ? undefined : filter;
  const sourceParam = source === "all" ? undefined : source;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["invoices", statusParam, sourceParam, q],
    queryFn: () => getInvoices({ status: statusParam, source: sourceParam, q: q || undefined }),
  });

  const invoices = useMemo(() => {
    const list = data?.invoices ?? [];
    if (filter === "overdue") {
      return list.filter((i) => i.status === "open" && (daysUntil(i.dueDate) ?? 0) < 0);
    }
    return list;
  }, [data, filter]);

  async function runAction(inv: InvoiceDto, action: string) {
    try {
      await invoiceAction(inv.id, action);
      await refetch();
    } catch (err) {
      console.error(err);
    }
  }

  const noSource = !me.tenant?.invoiceCount;

  return (
    <div>
      <PageHeader title="Invoices" subtitle="Track what's owed and what's on the way." />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-surface p-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (filter === f.value ? "bg-primary text-white" : "text-muted hover:text-ink")
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm"
        >
          <option value="all">All sources</option>
          <option value="stripe">Stripe</option>
          <option value="csv">CSV</option>
        </select>
        <Input
          placeholder="Search client…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs"
        />
      </div>

      {isLoading ? (
        <Card>
          <Spinner label="Loading invoices…" />
        </Card>
      ) : invoices.length === 0 ? (
        <EmptyState
          title={noSource ? "No invoices yet" : "No invoices match"}
          description={
            noSource
              ? "Connect Stripe or upload a CSV to pull in your invoices. They'll appear here in seconds."
              : "Try adjusting your filters or search."
          }
          action={
            noSource ? (
              <Link to="/settings">
                <Button>Connect a source</Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Due</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const due = daysUntil(inv.dueDate);
                const overdue = inv.status === "open" && due !== null && due < 0;
                const dueLabel =
                  inv.status !== "paid" && due !== null
                    ? due < 0
                      ? `${Math.abs(due)}d overdue`
                      : due === 0
                        ? "due today"
                        : `${due}d`
                    : inv.dueDate
                      ? formatDate(inv.dueDate)
                      : "—";
                return (
                  <tr key={inv.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link to={`/invoices/${inv.id}`} className="font-medium text-ink hover:text-primary">
                        {inv.customerName ?? "Unknown client"}
                      </Link>
                      <div className="text-xs text-muted">{inv.customerEmail ?? inv.externalId}</div>
                    </td>
                    <td className="px-4 py-3 font-semibold">
                      {formatMoney(inv.amountDue, inv.currency)}
                    </td>
                    <td className={"px-4 py-3 " + (overdue ? "font-medium text-danger" : "")}>
                      {dueLabel}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={overdue ? "overdue" : inv.status}>{overdue ? "overdue" : inv.status}</Badge>
                    </td>
                    <td className="px-4 py-3 capitalize text-muted">{inv.source}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {inv.status === "open" || inv.status === "paused" ? (
                          <>
                            <Button
                              variant="secondary"
                              className="px-2 py-1 text-xs"
                              onClick={() => runAction(inv, inv.status === "paused" ? "resume" : "pause")}
                            >
                              {inv.status === "paused" ? "Resume" : "Pause"}
                            </Button>
                            <Button
                              variant="secondary"
                              className="px-2 py-1 text-xs"
                              onClick={() => runAction(inv, "mark_paid")}
                            >
                              Mark paid
                            </Button>
                          </>
                        ) : null}
                        {inv.paymentLink ? (
                          <a
                            href={inv.paymentLink}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-blue-50"
                          >
                            Pay link
                          </a>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}