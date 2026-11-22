import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { getForecast } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useMe } from "@/lib/me";

export function Forecast() {
  const me = useMe();
  const [grain, setGrain] = useState<"week" | "month">("week");
  const forecast = useQuery({ queryKey: ["forecast", grain], queryFn: () => getForecast(grain) });
  const buckets = forecast.data?.buckets ?? [];
  const max = Math.max(...buckets.map((b) => b.expectedCents), 1);
  return (
    <div>
      <PageHeader
        title="Cash forecast"
        subtitle={`Expected collections from due dates and promises, scaled by a ${(Math.round((forecast.data?.keepRate ?? 0.85) * 100))}% keep rate.`}
        actions={
          <select aria-label="Forecast grain" className="rounded-full border border-line bg-surface px-3 py-2 text-sm" value={grain} onChange={(e) => setGrain(e.target.value as "week" | "month")}>
            <option value="week">By week</option>
            <option value="month">By month</option>
          </select>
        }
      />
      {forecast.isError ? <EmptyState title="Forecast unavailable" description={(forecast.error as Error).message} /> : forecast.isLoading ? <Card><Spinner label="Building the forecast…" /></Card> : buckets.length === 0 ? (
        <EmptyState title="Nothing to forecast" description="Open invoices with a due date or a promise appear here." />
      ) : (
        <Card className="grid gap-3">
          {buckets.map((bucket) => (
            <div key={bucket.period}>
              <div className="mb-1 flex justify-between text-sm">
                <span>{bucket.period}</span>
                <span>{formatMoney(bucket.expectedCents, me.tenant?.currency ?? "usd")} · {bucket.invoiceCount}</span>
              </div>
              <div className="h-2 rounded-full bg-bg"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(4, (bucket.expectedCents / max) * 100)}%` }} /></div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
