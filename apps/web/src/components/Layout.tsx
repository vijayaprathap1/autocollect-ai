import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useMe } from "@/lib/me";
import { cn } from "@/components/ui";
import { hexToRgbTriple } from "@/lib/format";
import { api } from "@/lib/api";

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
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
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

  useEffect(() => {
    if (!mobileNavOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mobileNavOpen]);

  const signOut = async () => {
    await api.post("/auth/logout");
    navigate("/login", { replace: true });
    window.location.reload();
  };

  return (
    <div className="min-h-screen bg-bg">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[195px] shrink-0 flex-col bg-[#091525] text-white lg:flex">
        <div className="border-b border-white/10 px-6 py-5">
          {logo ? (
            <img src={logo} alt={appName} className="h-7 w-auto" />
          ) : (
            <div className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
              <span className="flex h-6 w-6 items-center justify-center rounded-sm bg-[#0e4ab8] text-xs font-bold">A</span>
              {appName}
            </div>
          )}
          <div className="mt-1 truncate pl-8 text-[10px] uppercase tracking-[0.16em] text-slate-400">{me.tenant?.name ?? "Your workspace"}</div>
        </div>
        <nav className="flex flex-col gap-1 px-3 py-8">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "rounded-lg border-l-2 border-transparent px-3 py-2 text-[12px] font-medium transition-colors",
                  isActive ? "border-[#1769e0] bg-[#102344] text-white" : "text-slate-400 hover:bg-white/5 hover:text-white",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-2 border-t border-white/10 px-5 py-5 text-xs text-slate-400">
          <div className="truncate" title={me.user.email}>{me.user.email}</div>
          <div className="capitalize">{me.user.role}</div>
          {me.user.isSuperAdmin && (
              <NavLink to="/admin" className="block text-blue-300 hover:underline">
              Admin Console
            </NavLink>
          )}
          <button
            onClick={signOut}
            className="block w-full cursor-pointer text-left text-slate-400 hover:text-white hover:underline"
          >
            Sign out
          </button>
        </div>
      </aside>

      <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-surface px-4 lg:hidden">
        <div className="min-w-0">
          {logo ? (
            <img src={logo} alt={appName} className="h-6 w-auto max-w-[180px]" />
          ) : (
            <div className="flex items-center gap-2 truncate text-[15px] font-semibold tracking-tight">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-[#0e4ab8] text-xs font-bold text-white">A</span>
              <span className="truncate">{appName}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          aria-controls="mobile-navigation"
          aria-expanded={mobileNavOpen}
          aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
          onClick={() => setMobileNavOpen((isOpen) => !isOpen)}
          className="ml-4 shrink-0 rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-ink transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          {mobileNavOpen ? "Close" : "Menu"}
        </button>
      </header>

      {mobileNavOpen && (
        <>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
            className="fixed inset-0 z-30 bg-[#091525]/50 lg:hidden"
          />
          <aside
            id="mobile-navigation"
            aria-label="Mobile navigation"
            className="fixed inset-y-0 left-0 z-40 flex w-[min(84vw,300px)] flex-col bg-[#091525] text-white shadow-xl lg:hidden"
          >
            <div className="flex items-start justify-between border-b border-white/10 px-5 py-5">
              <div className="min-w-0">
                {logo ? (
                  <img src={logo} alt={appName} className="h-7 w-auto max-w-[210px]" />
                ) : (
                  <div className="flex items-center gap-2 truncate text-[15px] font-semibold tracking-tight">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-[#0e4ab8] text-xs font-bold">A</span>
                    <span className="truncate">{appName}</span>
                  </div>
                )}
                <div className="mt-1 truncate pl-8 text-[10px] uppercase tracking-[0.16em] text-slate-400">{me.tenant?.name ?? "Your workspace"}</div>
              </div>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setMobileNavOpen(false)}
                className="ml-3 shrink-0 rounded-md px-2 py-1 text-xs text-slate-300 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/40"
              >
                Close
              </button>
            </div>
            <nav className="flex flex-col gap-1 px-3 py-6" aria-label="Primary navigation">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileNavOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      "rounded-lg border-l-2 border-transparent px-3 py-3 text-[13px] font-medium transition-colors",
                      isActive ? "border-[#1769e0] bg-[#102344] text-white" : "text-slate-400 hover:bg-white/5 hover:text-white",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="mt-auto space-y-2 border-t border-white/10 px-5 py-5 text-xs text-slate-400">
              <div className="truncate" title={me.user.email}>{me.user.email}</div>
              <div className="capitalize">{me.user.role}</div>
              {me.user.isSuperAdmin && <NavLink to="/admin" onClick={() => setMobileNavOpen(false)} className="block text-blue-300 hover:underline">Admin Console</NavLink>}
              <button onClick={signOut} className="block w-full cursor-pointer text-left text-slate-400 hover:text-white hover:underline">Sign out</button>
            </div>
          </aside>
        </>
      )}

      <main className="min-h-screen overflow-y-auto lg:ml-[195px]">
        {needsSetup && (
          <div className="flex min-h-[38px] flex-wrap items-center gap-x-3 gap-y-2 bg-[#18253a] px-4 py-2 text-[12px] text-white sm:px-7">
            <span className="font-bold text-amber-300">!</span>
            <span className="font-medium">Urgent Setup Required: Finish setup to start automating.</span>
            <span className="text-slate-300">
              {me.tenant!.hasUnapprovedTemplates
                ? "Approve your reminder templates."
                : "Enable your dunning workflow."}
            </span>
            <NavLink to={me.tenant!.hasUnapprovedTemplates ? "/templates" : "/workflows"} className="rounded-full border border-white/25 px-4 py-1 text-[11px] font-medium hover:bg-white/10 sm:ml-auto">
              Complete Setup
            </NavLink>
          </div>
        )}
        <div className="p-4 sm:p-8 lg:p-12"><Outlet /></div>
      </main>
    </div>
  );
}