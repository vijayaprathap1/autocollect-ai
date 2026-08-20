import { Link } from "react-router-dom";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, EmptyState, Input, PageHeader, Spinner } from "@/components/ui";
import { getCustomers } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useMe } from "@/lib/me";

export function Customers() {
  const me = useMe();
  const [q, setQ] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["customers", q],
    queryFn: () => getCustomers({ q: q || undefined }),
    enabled: Boolean(me.tenant?.invoiceCount),
  });

  if (!me.tenant?.invoiceCount) {
    return (
      <div>
        <PageHeader title="Customers" subtitle="Clients with outstanding balances." />
        <EmptyState
          title="No customers yet"
          description="Customers appear here once you connect an invoicing source."
          action={
            <Link to="/settings">
              <Button>Connect a source</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const customers = data?.customers ?? [];

  return (
    <div>
      <PageHeader title="Customers" subtitle="Clients with outstanding balances." />
      <Input
        placeholder="Search customer…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="mb-4 max-w-xs"
      />

      {isLoading ? (
        <Card>
          <Spinner label="Loading customers…" />
        </Card>
      ) : customers.length === 0 ? (
        <EmptyState
          title={q ? "No customers match" : "No customers yet"}
          description={q ? "Try adjusting your search." : "Connect a source to pull in your customers."}
        />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Open invoices</th>
                <th className="px-4 py-3 font-medium">Outstanding</th>
                <th className="px-4 py-3 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{c.name ?? "Unknown customer"}</div>
                    {c.email && <div className="text-xs text-muted">{c.email}</div>}
                  </td>
                  <td className="px-4 py-3">{c.openCount}</td>
                  <td className="px-4 py-3 font-semibold">{formatMoney(c.openTotal)}</td>
                  <td className="px-4 py-3 capitalize text-muted">{c.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}