import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, EmptyState, PageHeader, Spinner, OnboardingModal, shouldShowOnboarding } from "@/components/ui";
import { getDashboard, seedDemo, type DashboardRangeKey } from "@/lib/api";
import { formatDate, formatMoney, timeAgo } from "@/lib/format";
import { useMe } from "@/lib/me";

const AGING_LABELS: Record<string, string> = {
  "0-30": "0–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "90+ days",
};

export function Dashboard() {
  const me = useMe();
  const tenant = me.tenant;
  const queryClient = useQueryClient();
  const [selectedRange, setSelectedRange] = useState<DashboardRangeKey>("30d");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["dashboard", selectedRange],
    queryFn: () => getDashboard(selectedRange),
    enabled: Boolean(tenant && tenant.invoiceCount > 0),
  });
  const seedMutation = useMutation({
    mutationFn: seedDemo,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    if (tenant && shouldShowOnboarding(me)) {
      setShowOnboarding(true);
    }
  }, [tenant, me]);

  useEffect(() => {
    const handleLoadDemo = () => {
      seedMutation.mutate();
    };
    window.addEventListener("onboarding:load-demo", handleLoadDemo);
    return () => window.removeEventListener("onboarding:load-demo", handleLoadDemo);
  }, [seedMutation]);

  if (!tenant) {
    return (
      <div>
        <PageHeader title="Dashboard" />
        <EmptyState
          title="Welcome to AutoCollect AI"
          description="Connect your invoicing source to start automating collections."
          action={
            <Link to="/settings">
              <Button>Connect a source</Button>
            </Link>
          }
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div aria-busy="true">
        <PageHeader title={`Welcome back, ${tenant.name}`} subtitle="Here's where your cash stands." />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {["Outstanding", "Overdue", "Recovered (30d)", "Avg DSO", "Credits"].map((label) => (
            <Card key={label} className="min-h-[132px] animate-pulse">
              <div className="h-4 w-24 rounded bg-slate-100" />
              <div className="mt-4 h-8 w-32 rounded bg-slate-100" />
              <div className="mt-3 h-3 w-20 rounded bg-slate-100" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div>
        <PageHeader title={`Welcome back, ${tenant.name}`} subtitle="Here's where your cash stands." />
        <Card className="border-red-200 bg-red-50" role="alert">
          <h2 className="font-semibold text-red-900">Dashboard data unavailable</h2>
          <p className="mt-1 text-sm text-red-700">We couldn't load your latest collection summary. Please try again.</p>
          <Button variant="secondary" className="mt-4 border-red-200 bg-white" onClick={() => window.location.reload()}>Try again</Button>
        </Card>
      </div>
    );
  }

  if (!data) {
    const steps = [
      { label: "Connect Stripe or upload a CSV", done: tenant.invoiceCount > 0, href: "/settings" },
      { label: "Approve reminder templates", done: !tenant.hasUnapprovedTemplates, href: "/templates" },
      { label: "Enable your dunning workflow", done: tenant.workflowEnabled, href: "/workflows" },
    ];
    const doneCount = steps.filter((s) => s.done).length;
    return (
      <div>
        <PageHeader title={`Welcome back, ${tenant.name}`} subtitle="Here's where your cash stands." />
        {isLoading ? (
          <Card>
            <Spinner label="Loading…" />
          </Card>
        ) : null}
        <div className="mt-8 max-w-[730px]">
          <Card className="border-slate-200 p-6 shadow-sm lg:p-7">
            <div className="mb-5 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold">Onboarding</h2>
                <p className="mt-1 text-xs text-muted">Complete these steps to activate your dunning automation.</p>
              </div>
              <span
                className="rounded-full bg-blue-100 px-3 py-1 text-[10px] font-semibold text-blue-700"
                role="status"
                aria-label={`Onboarding ${Math.round((doneCount / steps.length) * 100)}% complete`}
              >
                {Math.round((doneCount / steps.length) * 100)}% Complete
              </span>
            </div>
            <div
              className="mb-6 h-1 overflow-hidden rounded-full bg-blue-100"
              role="progressbar"
              aria-label="Onboarding progress"
              aria-valuemin={0}
              aria-valuemax={steps.length}
              aria-valuenow={doneCount}
            >
              <div className="h-full rounded-full bg-[#0739a8] transition-all duration-500" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
            </div>
            <ol className="space-y-3">
              {steps.map((step, i) => (
                <li key={step.href} className={`flex items-center gap-3 rounded-md border px-3 py-3 ${step.done ? "border-slate-200 bg-white" : "border-blue-100 bg-[#f5f7ff]"}`}>
                  <span
                    className={
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold " +
                      (step.done ? "border-emerald-400 bg-emerald-400 text-white" : "border-[#6d7da8] bg-white text-slate-600")
                    }
                  >
                    {step.done ? "✓" : i + 1}
                  </span>
                  <Link to={step.href} className={`text-xs font-medium ${step.done ? "text-slate-500" : "text-ink hover:text-primary"}`}>{step.label}</Link>
                  {!step.done && <span className="ml-auto rounded bg-[#0739a8] px-3 py-1.5 text-[10px] font-semibold text-white">{i === 0 ? "Connect" : "Review"}</span>}
                </li>
              ))}
            </ol>
            {tenant.invoiceCount === 0 && (
              <div className="mt-6 flex items-center justify-end border-t pt-5">
                <Button
                  variant="secondary"
                  disabled={seedMutation.isPending}
                  onClick={() => seedMutation.mutate()}
                  className="text-xs"
                >
                  {seedMutation.isPending ? "Loading demo data…" : "Load demo data"}
                </Button>
              </div>
            )}
          </Card>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              { label: "Connect a source", description: "Bring invoices into your workspace", href: "/settings" },
              { label: "Review invoices", description: "Track your outstanding balance", href: "/invoices" },
              { label: "Add customers", description: "Keep your client records organized", href: "/customers" },
            ].map((item) => (
              <Link key={item.href} to={item.href} className="rounded-lg border border-slate-200 bg-white p-4 transition-colors hover:border-primary/40 hover:bg-blue-50/40">
                <div className="text-sm font-semibold text-ink">{item.label}</div>
                <div className="mt-1 text-xs text-muted">{item.description}</div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const overdueInvoiceCount = data.aging.reduce((total, bucket) => total + bucket.count, 0);
  const maxAging = Math.max(...data.aging.map((a) => a.amount), 0) || 1;
  const currency = data.currency;
  const rangeLabels: Record<DashboardRangeKey, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days" };
  const creditPeriod = data.credits.periodStart && data.credits.periodEnd
    ? `${formatDate(data.credits.periodStart)} – ${formatDate(data.credits.periodEnd)}`
    : "Current billing period";

  return (
    <>
      <div>
        <PageHeader
          title={`Welcome back, ${tenant.name}`}
          subtitle="Here's where your cash stands."
          actions={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <label className="sr-only" htmlFor="dashboard-range">Dashboard range</label>
              <select
                id="dashboard-range"
                value={selectedRange}
                onChange={(event) => setSelectedRange(event.target.value as DashboardRangeKey)}
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-ink shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="7d">7 days</option>
                <option value="30d">30 days</option>
                <option value="90d">90 days</option>
              </select>
              <Link to="/invoices">
                <Button variant="secondary">Review invoices</Button>
              </Link>
            </div>
          }
        />
        <p className="-mt-3 mb-5 text-xs text-muted" role="status">
          Showing {rangeLabels[selectedRange]} · Data as of {formatDate(data.range.asOf)} · Updated {timeAgo(data.range.lastUpdatedAt)}
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Card className="min-h-[132px]">
            <div className="text-sm font-medium text-muted">Outstanding</div>
            <div className="mt-1 text-2xl font-bold">{formatMoney(data.outstandingTotal, currency)}</div>
            <div className="mt-1 text-xs text-muted">{data.openCount} open invoices</div>
          </Card>
          <Card className="min-h-[132px]">
            <div className="text-sm font-medium text-muted">Overdue</div>
            <div className="mt-1 text-2xl font-bold text-danger">{formatMoney(data.overdueTotal, currency)}</div>
            <div className="mt-1 text-xs text-muted">{overdueInvoiceCount} invoice{overdueInvoiceCount === 1 ? "" : "s"} past due</div>
          </Card>
          <Card className="min-h-[132px]">
            <div className="text-sm font-medium text-muted">Recovered (30d)</div>
            <div className="mt-1 text-2xl font-bold text-green-700">{formatMoney(data.recovered30d, currency)}</div>
            <div className="mt-1 text-xs text-muted">{data.paidCount30d} paid invoices</div>
          </Card>
          <Card className="min-h-[132px]">
            <div className="text-sm font-medium text-muted">Avg DSO</div>
            <div className="mt-1 text-2xl font-bold">{data.avgDsoDays ?? "—"}<span className="text-sm font-normal text-muted"> days</span></div>
            <div className="mt-1 text-xs text-muted">Average days to collect</div>
          </Card>
          <Card className="min-h-[132px]">
            <div className="text-sm font-medium text-muted">Credits</div>
            <div className="mt-1 text-2xl font-bold">{data.credits.balance}</div>
            <div className="mt-1 text-xs text-muted">{data.credits.monthlyAllowance}/mo allowance</div>
            <div className="mt-1 text-[11px] text-muted">{creditPeriod}</div>
          </Card>
        </div>

        <div className="mt-8 grid gap-6">
          <Card>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Aging</h2>
                <p className="mt-1 text-xs text-muted">
                  {overdueInvoiceCount > 0
                    ? `${overdueInvoiceCount} overdue invoice${overdueInvoiceCount === 1 ? "" : "s"} · ${formatMoney(data.overdueTotal, currency)} total`
                    : "Outstanding invoices grouped by days past due."}
                </p>
              </div>
              <Link to="/invoices" className="text-sm font-medium text-primary hover:underline">View invoices</Link>
            </div>
            {data.aging.length === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-emerald-50 px-4 py-3">
                <p className="text-sm text-emerald-800">Nothing overdue right now. Nice work.</p>
                <Link to="/invoices" className="text-sm font-medium text-emerald-800 hover:underline">View open invoices</Link>
              </div>
            ) : (
              <div className="space-y-4" role="list" aria-label="Overdue invoice aging">
                {data.aging.map((a) => (
                  <div key={a.bucket} role="listitem">
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium">{AGING_LABELS[a.bucket] ?? a.bucket}</span>
                      <span className="text-right text-muted">
                        {a.count} invoice{a.count === 1 ? "" : "s"} · {formatMoney(a.amount, currency)}
                      </span>
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded-full bg-slate-100"
                      role="progressbar"
                      aria-label={`${AGING_LABELS[a.bucket] ?? a.bucket}: ${formatMoney(a.amount, currency)}`}
                      aria-valuemin={0}
                      aria-valuemax={maxAging}
                      aria-valuenow={a.amount}
                    >
                      <div
                        className="h-full rounded-full bg-amber-500"
                        style={{ width: `${Math.max((a.amount / maxAging) * 100, 4)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
      <OnboardingModal isOpen={showOnboarding} onClose={() => setShowOnboarding(false)} />
    </>
  );
}