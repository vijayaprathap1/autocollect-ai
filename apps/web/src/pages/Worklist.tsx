import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { getWorklist } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";
import { useMe } from "@/lib/me";

export function Worklist() {
  const me = useMe();
  const currency = me.tenant?.currency ?? "usd";
  const { data, isLoading } = useQuery({ queryKey: ["worklist"], queryFn: getWorklist });
  const rows = data?.worklist ?? [];

  return (
    <div>
      <PageHeader title="Worklist" subtitle="Accounts ranked by how overdue they are, how much they owe, and whether a promise or dispute is already open." />
      {isLoading ? (
        <Card><Spinner label="Loading worklist…" /></Card>
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing to collect" description="Open invoices, disputes and tasks show up here, highest priority first." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">Priority</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Open</th>
                <th className="px-4 py-3 font-medium">Days overdue</th>
                <th className="px-4 py-3 font-medium">Disputes</th>
                <th className="px-4 py-3 font-medium">Broken promises</th>
                <th className="px-4 py-3 font-medium">Next task</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3 font-semibold tabular-nums">{row.riskScore}</td>
                  <td className="px-4 py-3">
                    <Link to={`/customers/${row.id}`} className="font-medium text-primary hover:underline">{row.name ?? "Unknown"}</Link>
                    <div className="text-xs text-muted">{row.segment ?? "no segment"}{row.email ? ` · ${row.email}` : ""}</div>
                  </td>
                  <td className="px-4 py-3">{formatMoney(row.openTotal, currency)} <span className="text-muted">({row.openCount})</span></td>
                  <td className="px-4 py-3">{row.daysOverdue}</td>
                  <td className="px-4 py-3">{row.openDisputes}</td>
                  <td className="px-4 py-3">{row.brokenPromises}</td>
                  <td className="px-4 py-3">{row.nextTaskOn ? formatDate(row.nextTaskOn) : row.openTasks ? `${row.openTasks} open` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
