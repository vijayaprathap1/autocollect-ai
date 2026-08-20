import { NavLink, Outlet } from "react-router-dom";
import { useEffect } from "react";
import { useMe } from "@/lib/me";
import { cn } from "@/components/ui";
import { hexToRgbTriple } from "@/lib/format";

const navItems = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/invoices", label: "Invoices" },
  { to: "/customers", label: "Customers" },
  { to: "/workflows", label: "Workflows" },
  { to: "/templates", label: "Templates" },
  { to: "/replies", label: "Replies" },
  { to: "/activity", label: "Activity" },
  { to: "/settings", label: "Settings" },
];

export function Layout() {
  const me = useMe();
  const needsSetup =
    me.tenant && (me.tenant.hasUnapprovedTemplates || !me.tenant.workflowEnabled);

  const branding = me.tenant?.branding ?? {};
  const appName = branding.appName ?? "AutoCollect AI";
  const logo = branding.logoUrl;
  const rgb = hexToRgbTriple(branding.primaryColor);

  useEffect(() => {
    const root = document.documentElement;
    if (rgb) {
      root.style.setProperty("--color-primary", rgb);
      root.style.setProperty("--color-primary-hover", rgb);
    } else {
      root.style.removeProperty("--color-primary");
      root.style.removeProperty("--color-primary-hover");
    }
  }, [rgb]);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-surface">
        <div className="px-5 py-5">
          {logo ? (
            <img src={logo} alt={appName} className="h-7 w-auto" />
          ) : (
            <div className="text-lg font-bold text-primary">{appName}</div>
          )}
          <div className="mt-1 truncate text-xs text-muted">{me.tenant?.name ?? "Your workspace"}</div>
        </div>
        <nav className="flex flex-col gap-1 px-3">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive ? "bg-blue-50 text-primary" : "text-slate-600 hover:bg-slate-50",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-5 py-4 text-xs text-muted">
          <div>{me.user.email}</div>
          <div className="capitalize">{me.user.role}</div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-8">
        {needsSetup && (
          <div className="mb-6 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span className="font-medium">Finish setup to start automating.</span>
            <span className="text-amber-700">
              {me.tenant!.hasUnapprovedTemplates
                ? "Approve your reminder templates."
                : "Enable your dunning workflow."}
            </span>
            <NavLink to={me.tenant!.hasUnapprovedTemplates ? "/templates" : "/workflows"} className="ml-auto font-semibold underline">
              Get started →
            </NavLink>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}