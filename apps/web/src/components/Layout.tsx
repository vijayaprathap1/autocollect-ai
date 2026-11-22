import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMe } from "@/lib/me";
import { cn } from "@/components/ui";
import { hexToRgbTriple } from "@/lib/format";
import { getOrganizations, logout, switchOrganization } from "@/lib/api";
import { useToast } from "@/components/Toast";

const navItems = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/invoices", label: "Invoices" },
  { to: "/worklist", label: "Worklist" },
  { to: "/customers", label: "Customers" },
  { to: "/disputes", label: "Disputes" },
  { to: "/promises", label: "Promises" },
  { to: "/workflows", label: "Workflows" },
  { to: "/templates", label: "Templates" },
  { to: "/replies", label: "Replies" },
  { to: "/activity", label: "Activity" },
  { to: "/settings", label: "Settings" },
];

function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    try {
      await logout();
    } finally {
      queryClient.clear(); // drop every cached response from this session
      navigate("/login", { replace: true });
    }
  };
}

function WorkspaceSwitcher({ onSwitched }: { onSwitched?: () => void }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { data } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
    enabled: me.user.organizationCount > 1,
    staleTime: 60_000,
  });
  if (me.user.organizationCount <= 1 || !data) {
    return <div className="mt-1 truncate text-[11px] tracking-wide text-muted">{me.tenant?.name ?? "Your workspace"}</div>;
  }
  return (
    <select
      aria-label="Switch workspace"
      className="mt-2 w-full rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
      value={me.tenant?.id}
      onChange={async (e) => {
        try {
          await switchOrganization(e.target.value);
          queryClient.clear();
          navigate("/dashboard", { replace: true });
          onSwitched?.();
        } catch (err) {
          showToast((err as Error).message, "error");
        }
      }}
    >
      {data.organizations.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  return (
    <button
      type="button"
      aria-pressed={dark}
      onClick={() => {
        const next = !document.documentElement.classList.contains("dark");
        document.documentElement.classList.toggle("dark", next);
        localStorage.setItem("ac-theme", next ? "dark" : "light");
        setDark(next);
      }}
      className="rounded-full border border-line px-3 py-1 text-[11px] font-medium text-ink hover:bg-bg"
    >
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const me = useMe();
  const signOut = useSignOut();
  const branding = me.tenant?.branding ?? {};
  const appName = branding.appName || "AutoCollect AI";

  return (
    <>
      <div className="border-b border-line px-5 py-5">
        {branding.logoUrl ? (
          <img src={branding.logoUrl} alt={appName} className="h-7 w-auto max-w-[180px]" />
        ) : (
          <div className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-bold text-white">A</span>
            <span className="truncate">{appName}</span>
          </div>
        )}
        <WorkspaceSwitcher onSwitched={onNavigate} />
      </div>
      <nav className="flex flex-col gap-0.5 px-3 py-4" aria-label="Primary navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                isActive ? "bg-primary/10 text-primary" : "text-muted hover:bg-bg hover:text-ink",
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto space-y-2 border-t border-line px-5 py-4 text-xs text-muted">
        <ThemeToggle />
        <div className="truncate font-medium text-ink" title={me.user.email}>
          {me.user.displayName || me.user.email}
        </div>
        <div className="truncate">{me.user.displayName ? me.user.email : null}</div>
        <div className="capitalize">{me.user.role}</div>
        <div className="flex gap-3 pt-1">
          <NavLink to="/settings?tab=account" onClick={onNavigate} className="hover:text-ink hover:underline">
            Account
          </NavLink>
          <button onClick={signOut} className="cursor-pointer hover:text-ink hover:underline">
            Sign out
          </button>
        </div>
      </div>
    </>
  );
}

export function Layout() {
  const me = useMe();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const needsSetup = me.tenant && (me.tenant.hasUnapprovedTemplates || !me.tenant.workflowEnabled);
  const isAdmin = me.user.role === "owner" || me.user.role === "admin";
  const rgb = hexToRgbTriple(me.tenant?.branding?.primaryColor);
  const lowCredits = me.tenant && me.tenant.creditBalance <= Math.max(5, Math.floor(me.tenant.creditsPerMonth * 0.1));

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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMobileNavOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);

  return (
    <div className="min-h-screen bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[232px] shrink-0 flex-col border-r border-line bg-surface/80 text-ink backdrop-blur-xl lg:flex">
        <SidebarContent />
      </aside>

      <header className="flex h-14 items-center justify-between border-b border-line bg-surface/80 px-4 backdrop-blur-xl lg:hidden">
        <div className="truncate text-[15px] font-semibold">{me.tenant?.branding?.appName || "AutoCollect AI"}</div>
        <button
          type="button"
          aria-controls="mobile-navigation"
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((o) => !o)}
          className="ml-4 rounded-full border border-line px-3 py-2 text-xs font-semibold text-ink hover:bg-bg"
        >
          {mobileNavOpen ? "Close" : "Menu"}
        </button>
      </header>

      {mobileNavOpen && (
        <>
          <button type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} className="fixed inset-0 z-30 bg-black/40 lg:hidden" />
          <aside id="mobile-navigation" className="fixed inset-y-0 left-0 z-40 flex w-[min(84vw,300px)] flex-col border-r border-line bg-surface text-ink shadow-card lg:hidden">
            <SidebarContent onNavigate={() => setMobileNavOpen(false)} />
          </aside>
        </>
      )}

      <main id="main" className="min-h-screen lg:ml-[232px]">
        {needsSetup && isAdmin && (
          <div className="flex min-h-[38px] flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-4 py-2 text-[12px] text-ink sm:px-7">
            <span className="font-medium">Finish setup to start collecting automatically:</span>
            <span className="text-muted">{me.tenant!.hasUnapprovedTemplates ? "approve your reminder templates." : "turn on your reminder workflow."}</span>
            <NavLink
              to={me.tenant!.hasUnapprovedTemplates ? "/templates" : "/workflows"}
              className="rounded-full border border-line px-4 py-1 text-[11px] font-medium hover:bg-bg sm:ml-auto"
            >
              Complete setup
            </NavLink>
          </div>
        )}
        {lowCredits && !needsSetup && (
          <div className="flex flex-wrap items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-[12px] text-warning sm:px-7">
            <span>
              {me.tenant!.creditBalance === 0 ? "You're out of reminder credits — reminders are paused." : `Only ${me.tenant!.creditBalance} reminder credits left.`}
            </span>
            {isAdmin && (
              <NavLink to="/settings?tab=billing" className="font-semibold underline sm:ml-auto">
                Upgrade plan
              </NavLink>
            )}
          </div>
        )}
        <div className="p-4 sm:p-8 lg:p-12">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
