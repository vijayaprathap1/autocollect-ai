import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Card, Spinner, cn } from "@/components/ui";
import { Alert } from "@/components/auth";
import { billingCheckout, billingPortal, getBilling } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";

const HIGHLIGHTS: Record<string, string[]> = {
  starter: ["50 open invoices", "1 seat", "50 reminders / month"],
  growth: ["Unlimited invoices", "3 seats", "500 reminders / month"],
  pro: ["Unlimited invoices", "Unlimited seats", "2,000 reminders / month"],
  agency: ["Unlimited invoices & seats", "10,000 reminders / month", "White-label: hide AutoCollect branding"],
};

export function BillingTab() {
  const { data, isLoading, error } = useQuery({ queryKey: ["billing"], queryFn: getBilling });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function go(key: string, fn: () => Promise<{ url: string }>) {
    setBusy(key);
    setActionError(null);
    try {
      const { url } = await fn();
      window.location.assign(url);
    } catch (err) {
      setActionError((err as Error).message);
      setBusy(null);
    }
  }

  if (isLoading) return <Spinner label="Loading billing…" />;
  if (error || !data) return <Alert>{(error as Error)?.message ?? "Couldn't load billing."}</Alert>;

  const sub = data.subscription;
  const usagePct = data.invoiceLimit ? Math.min(100, Math.round((data.invoicesUsed / data.invoiceLimit) * 100)) : 0;

  return (
    <div className="grid gap-6">
      {actionError && <Alert>{actionError}</Alert>}
      {data.mode === "mock" && <Alert tone="info">Development mode: checkout is simulated — no card is charged.</Alert>}
      {sub?.status === "past_due" && <Alert tone="warning">Your last payment failed. Update your card to keep sending reminders.</Alert>}
      {sub?.cancelAtPeriodEnd && sub.currentPeriodEnd && (
        <Alert tone="info">Your plan ends on {formatDate(sub.currentPeriodEnd)} and will then move to Starter.</Alert>
      )}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{data.planName ?? data.plan} plan</h2>
              {sub && <Badge tone={sub.status === "active" || sub.status === "trialing" ? "paid" : "overdue"}>{sub.status.replace("_", " ")}</Badge>}
            </div>
            {sub?.currentPeriodEnd && !sub.cancelAtPeriodEnd && (
              <p className="mt-1 text-sm text-muted">Renews {formatDate(sub.currentPeriodEnd)}</p>
            )}
          </div>
          {data.canManageBilling && (
            <Button variant="secondary" disabled={busy !== null} onClick={() => go("portal", billingPortal)}>
              {busy === "portal" ? "Opening…" : "Manage billing & invoices"}
            </Button>
          )}
        </div>
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted">Reminder credits</dt>
            <dd className="text-xl font-semibold">{data.credits?.balance ?? 0}</dd>
            <dd className="text-xs text-muted">{data.credits?.perMonth ?? 0} per month · {data.credits?.sentLast30Days ?? 0} sent in 30 days</dd>
          </div>
          <div>
            <dt className="text-muted">Open invoices</dt>
            <dd className="text-xl font-semibold">
              {data.invoicesUsed}
              {data.invoiceLimit ? <span className="text-sm font-normal text-muted"> / {data.invoiceLimit}</span> : null}
            </dd>
            {data.invoiceLimit ? (
              <div className="mt-1 h-1.5 w-full rounded-full bg-slate-100">
                <div className={cn("h-1.5 rounded-full", usagePct >= 90 ? "bg-amber-500" : "bg-primary")} style={{ width: `${usagePct}%` }} />
              </div>
            ) : (
              <dd className="text-xs text-muted">Unlimited</dd>
            )}
          </div>
          <div>
            <dt className="text-muted">Seats</dt>
            <dd className="text-xl font-semibold">
              {data.seatsUsed ?? 1}
              {data.seatLimit ? <span className="text-sm font-normal text-muted"> / {data.seatLimit}</span> : null}
            </dd>
          </div>
        </dl>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {(data.plans ?? []).map((p) => {
          const current = p.key === data.plan;
          return (
            <div key={p.key} className={cn("rounded-xl border bg-surface p-5 shadow-sm", current ? "border-primary ring-1 ring-primary" : "border-slate-200")}>
              <div className="flex items-baseline justify-between">
                <h3 className="font-semibold">{p.name}</h3>
                <div className="text-lg font-bold">
                  {p.monthlyPriceCents ? formatMoney(p.monthlyPriceCents, "usd") : "Free"}
                  {p.monthlyPriceCents ? <span className="text-xs font-normal text-muted">/mo</span> : null}
                </div>
              </div>
              <ul className="mt-3 space-y-1 text-sm text-muted">
                {(HIGHLIGHTS[p.key] ?? []).map((h) => (
                  <li key={h}>✓ {h}</li>
                ))}
              </ul>
              <div className="mt-4">
                {current ? (
                  <span className="text-sm font-medium text-primary">Current plan</span>
                ) : p.key === "starter" ? (
                  data.canManageBilling ? (
                    <button className="text-sm text-muted hover:underline" disabled={busy !== null} onClick={() => go("portal", billingPortal)}>
                      Downgrade via billing portal
                    </button>
                  ) : null
                ) : (
                  <Button className="w-full" disabled={busy !== null || !p.available} onClick={() => go(p.key, () => billingCheckout(p.key))}>
                    {busy === p.key ? "Opening checkout…" : !p.available ? "Coming soon" : `Choose ${p.name}`}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted">Prices in USD, billed monthly. Change or cancel anytime from the billing portal. Unused credits don't roll over.</p>
    </div>
  );
}
