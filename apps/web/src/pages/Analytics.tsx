import { useQuery } from "@tanstack/react-query";
import { Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { getProcessAnalytics } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useMe } from "@/lib/me";

export function Analytics() {
  const me = useMe();
  const currency = me.tenant?.currency ?? "usd";
  const data = useQuery({ queryKey: ["process-analytics"], queryFn: getProcessAnalytics });
  if (data.isLoading) return <Card><Spinner label="Loading analytics…" /></Card>;
  if (data.isError || !data.data) return <EmptyState title="Analytics unavailable" description={data.error instanceof Error ? data.error.message : "Try again in a moment."} />;
  const { funnel, collectors, steps, bottlenecks } = data.data;
  return (
    <div className="grid gap-6">
      <PageHeader title="Process analytics" subtitle="Where cash sits, who is collecting it, and which reminder steps get a response." />
      <div className="grid gap-4 sm:grid-cols-4">
        {bottlenecks.map((item) => (
          <Card key={item.kind}><div className="text-sm text-muted">{item.kind.replaceAll("_", " ")}</div><div className="text-2xl font-semibold">{item.count}</div></Card>
        ))}
      </div>
      <Card>
        <h2 className="mb-3 text-lg font-semibold">Aging movement</h2>
        {funnel.length === 0 ? <p className="text-sm text-muted">No open invoices.</p> : (
          <ul className="space-y-2 text-sm">{funnel.map((b) => <li key={b.bucket} className="flex justify-between"><span>{b.bucket}</span><span>{b.count} · {formatMoney(Number(b.amount), currency)}</span></li>)}</ul>
        )}
      </Card>
      <Card>
        <h2 className="mb-3 text-lg font-semibold">Collector productivity (30 days)</h2>
        <ul className="space-y-2 text-sm">{collectors.map((c) => <li key={c.email ?? "unassigned"} className="flex justify-between"><span>{c.email ?? "Unassigned"}</span><span>{c.accounts} accounts · {formatMoney(Number(c.collected), currency)}</span></li>)}</ul>
      </Card>
      <Card>
        <h2 className="mb-3 text-lg font-semibold">Reminder effectiveness</h2>
        {steps.length === 0 ? <p className="text-sm text-muted">No reminders in the last 90 days.</p> : (
          <ul className="space-y-2 text-sm">{steps.map((s) => <li key={`${s.channel}-${s.step_index}`} className="flex justify-between"><span>{s.channel} step {s.step_index}</span><span>{s.sent} sent · {s.engaged} opened or clicked</span></li>)}</ul>
        )}
      </Card>
    </div>
  );
}
