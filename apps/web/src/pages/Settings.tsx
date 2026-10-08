import { useSearchParams } from "react-router-dom";
import { PageHeader, cn } from "@/components/ui";
import { Alert } from "@/components/auth";
import { useMe } from "@/lib/me";
import { WorkspaceTab } from "./settings/WorkspaceTab";
import { TeamTab } from "./settings/TeamTab";
import { BillingTab } from "./settings/BillingTab";
import { IntegrationsTab } from "./settings/IntegrationsTab";
import { BrandingTab } from "./settings/BrandingTab";
import { AccountTab } from "./settings/AccountTab";

const TABS = [
  { key: "workspace", label: "Workspace", adminOnly: false },
  { key: "integrations", label: "Integrations", adminOnly: true },
  { key: "team", label: "Team", adminOnly: false },
  { key: "billing", label: "Billing", adminOnly: true },
  { key: "branding", label: "Branding", adminOnly: true },
  { key: "account", label: "Your account", adminOnly: false },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const STRIPE_ERRORS: Record<string, string> = {
  cancelled: "Stripe connection was cancelled.",
  account_in_use: "That Stripe account is already connected to another AutoCollect workspace.",
  expired: "The connection link expired. Please try again.",
  signed_out: "You were signed out during the connection. Sign in and try again.",
  exchange_failed: "Stripe didn't complete the connection. Please try again.",
};

/** One-time banners after returning from Stripe / QuickBooks / Checkout. */
function ReturnBanners() {
  const [params, setParams] = useSearchParams();
  const stripe = params.get("stripe");
  const qbo = params.get("qbo");
  const billing = params.get("billing");
  if (!stripe && !qbo && !billing) return null;
  const dismiss = () => {
    const next = new URLSearchParams(params);
    ["stripe", "qbo", "billing", "reason", "imported", "failed", "importing", "plan"].forEach((k) => next.delete(k));
    setParams(next, { replace: true });
  };
  const imported = params.get("imported");
  return (
    <div className="mb-6 space-y-2">
      {stripe === "connected" && (
        <Alert tone="success">
          Stripe connected.{" "}
          {imported ? `${imported} open invoice${imported === "1" ? "" : "s"} imported.` : ""}{" "}
          {params.get("importing") ? "We're still importing the rest in the background." : ""}{" "}
          {params.get("failed") ? `${params.get("failed")} couldn't be imported (plan limit).` : ""}{" "}
          New invoices sync automatically.
        </Alert>
      )}
      {stripe === "error" && <Alert>{STRIPE_ERRORS[params.get("reason") ?? ""] ?? "Stripe connection wasn't completed. Please try again."}</Alert>}
      {qbo === "connected" && <Alert tone="success">QuickBooks connected. Invoices sync every 15 minutes, or click “Sync now”.</Alert>}
      {qbo === "error" && <Alert>QuickBooks connection wasn't completed. Please try again.</Alert>}
      {billing === "success" && <Alert tone="success">Thanks! Your plan is active — new credits are available now.</Alert>}
      {billing === "cancelled" && <Alert tone="info">Checkout cancelled. Your plan hasn't changed.</Alert>}
      {billing === "error" && <Alert>Checkout couldn't be completed. Your plan hasn't changed.</Alert>}
      <button className="text-xs text-muted underline" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}

export function Settings() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const isAdmin = me.user.role === "owner" || me.user.role === "admin";
  const visible = TABS.filter((t) => isAdmin || !t.adminOnly);
  const requested = params.get("tab") as TabKey | null;
  const active: TabKey = visible.some((t) => t.key === requested) ? requested! : "workspace";

  return (
    <div>
      <PageHeader title="Settings" subtitle="Workspace, team, billing and integrations." />
      <ReturnBanners />
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist" aria-label="Settings sections">
        {visible.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={active === t.key}
            onClick={() => setParams({ tab: t.key }, { replace: true })}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors",
              active === t.key ? "border-primary text-primary" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="max-w-3xl" role="tabpanel">
        {active === "workspace" && <WorkspaceTab />}
        {active === "integrations" && <IntegrationsTab />}
        {active === "team" && <TeamTab />}
        {active === "billing" && <BillingTab />}
        {active === "branding" && <BrandingTab />}
        {active === "account" && <AccountTab />}
      </div>
    </div>
  );
}
