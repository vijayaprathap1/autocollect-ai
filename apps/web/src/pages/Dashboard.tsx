import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, EmptyState, PageHeader, Spinner, OnboardingModal, shouldShowOnboarding } from "@/components/ui";
import { getDashboard, seedDemo } from "@/lib/api";
import { formatMoney } from "@/lib/format";
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
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: getDashboard,
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
        <div className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">Getting started</h2>
          <Card>
            <ol className="space-y-4">
              {steps.map((step, i) => (
                <li key={step.href} className="flex items-center gap-3">
                  <span
                    className={
                      "flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold " +
                      (step.done ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500")
                    }
                  >
                    {step.done ? "✓" : i + 1}
                  </span>
                  <Link to={step.href} className="text-sm font-medium text-ink hover:text-primary">
                    {step.label}
                  </Link>
                </li>
              ))}
            </ol>
            <div className="mt-4 text-sm text-muted">
              {doneCount}/{steps.length} steps complete
            </div>
            {tenant.invoiceCount === 0 && (
              <div className="mt-6 border-t pt-5">
                <Button
                  variant="secondary"
                  disabled={seedMutation.isPending}
                  onClick={() => seedMutation.mutate()}
                >
                  {seedMutation.isPending ? "Loading demo data…" : "Load demo data"}
                </Button>
                <p className="mt-2 text-sm text-muted">
                  Populate this workspace with sample customers, invoices across aging buckets, and
                  example replies so you can explore every screen instantly.
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>
    );
  }

  const maxAging = Math.max(...data.aging.map((a) => a.amount), 0) || 1;
  const currency = "usd";

  return (
    <>
      <div>
        <PageHeader title={`Welcome back, ${tenant.name}`} subtitle="Here's where your cash stands." />

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Card>
            <div className="text-sm text-muted">Outstanding</div>
            <div className="mt-1 text-2xl font-bold">{formatMoney(data.outstandingTotal, currency)}</div>
            <div className="mt-1 text-xs text-muted">{data.openCount} open invoices</div>
          </Card>
          <Card>
            <div className="text-sm text-muted">Overdue</div>
            <div className="mt-1 text-2xl font-bold text-danger">{formatMoney(data.overdueTotal, currency)}</div>
          </Card>
          <Card>
            <div className="text-sm text-muted">Recovered (30d)</div>
            <div className="mt-1 text-2xl font-bold text-green-700">{formatMoney(data.recovered30d, currency)}</div>
            <div className="mt-1 text-xs text-muted">{data.paidCount30d} paid invoices</div>
          </Card>
          <Card>
            <div className="text-sm text-muted">Avg DSO</div>
            <div className="mt-1 text-2xl font-bold">{data.avgDsoDays ?? "—"}<span className="text-sm font-normal text-muted"> days</span></div>
          </Card>
        </div>

        <div className="mt-8 grid max-w-3xl gap-6">
          <Card>
            <h2 className="mb-4 text-lg font-semibold">Aging</h2>
            {data.aging.length === 0 ? (
              <p className="text-sm text-muted">Nothing overdue right now. Nice work.</p>
            ) : (
              <div className="space-y-3">
                {data.aging.map((a) => (
                  <div key={a.bucket}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium">{AGING_LABELS[a.bucket] ?? a.bucket}</span>
                      <span>
                        {a.count} invoice{a.count === 1 ? "" : "s"} · {formatMoney(a.amount, currency)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
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