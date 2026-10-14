import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation, Link } from "react-router-dom";
import { ApiClientError, fetchMe, logout } from "@/lib/api";
import { MeProvider } from "@/lib/me";
import { Layout } from "@/components/Layout";
import { Spinner } from "@/components/ui";
import { NoWorkspace } from "@/pages/NoWorkspace";

function FullPage({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-bg p-6">{children}</div>;
}

function useMeQuery() {
  return useQuery({ queryKey: ["me"], queryFn: fetchMe, retry: false, staleTime: 30_000 });
}

/** Signed-in workspace area. */
export function Shell() {
  const location = useLocation();
  const { data, error, isLoading, refetch } = useMeQuery();

  if (isLoading) {
    return (
      <FullPage>
        <Spinner label="Loading workspace…" />
      </FullPage>
    );
  }

  if (error instanceof ApiClientError) {
    if (error.status === 401) {
      const next = `${location.pathname}${location.search}`;
      return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
    }
    if (error.code === "TENANT_SUSPENDED") {
      return (
        <FullPage>
          <div className="max-w-md rounded-xl border border-slate-200 bg-surface p-6 text-center shadow-sm">
            <h1 className="text-lg font-semibold">Workspace suspended</h1>
            <p className="mt-2 text-sm text-muted">This workspace has been suspended. Contact support to restore access.</p>
            <button className="mt-4 text-sm font-medium text-primary hover:underline" onClick={() => logout().finally(() => window.location.assign("/login"))}>
              Sign out
            </button>
          </div>
        </FullPage>
      );
    }
  }

  if (error || !data) {
    return (
      <FullPage>
        <div className="text-center text-sm">
          <p className="text-danger">We couldn't load your workspace.</p>
          <button className="mt-3 font-medium text-primary hover:underline" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      </FullPage>
    );
  }

  if (data.user.sessionType === "admin") return <Navigate to="/admin" replace />;
  if (!data.tenant) return <NoWorkspace me={data} />;

  return (
    <MeProvider value={data}>
      <Layout />
    </MeProvider>
  );
}

/** Pages for signed-out users only (login, signup, forgot password). */
export function PublicRoute() {
  const { data, isLoading } = useMeQuery();
  const location = useLocation();
  if (isLoading) {
    return (
      <FullPage>
        <Spinner label="Loading…" />
      </FullPage>
    );
  }
  if (data?.user) {
    const next = new URLSearchParams(location.search).get("next");
    const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : null;
    return <Navigate to={data.user.sessionType === "admin" ? "/admin" : (safeNext ?? "/dashboard")} replace />;
  }
  return <Outlet />;
}

export function AdminShell() {
  const { data, error, isLoading } = useMeQuery();
  if (isLoading) {
    return (
      <FullPage>
        <Spinner label="Loading admin console…" />
      </FullPage>
    );
  }
  if (error instanceof ApiClientError && error.status === 401) return <Navigate to="/admin/login" replace />;
  if (error || !data) return <FullPage><p className="text-sm text-danger">Failed to load the admin console.</p></FullPage>;
  if (data.user.sessionType !== "admin" || !data.user.isSuperAdmin) return <Navigate to="/dashboard" replace />;
  return (
    <div className="min-h-screen bg-[#f5f7fb]">
      <header className="flex h-16 items-center justify-between bg-[#091525] px-4 text-white sm:px-8">
        <span className="font-semibold">
          AutoCollect AI <span className="ml-2 text-xs font-normal text-slate-400">Platform Admin · {data.user.email}</span>
        </span>
        <button className="text-sm text-slate-300 hover:text-white" onClick={() => logout().finally(() => window.location.assign("/admin/login"))}>
          Sign out
        </button>
      </header>
      <main className="mx-auto max-w-7xl p-4 sm:p-8 lg:p-12">
        <Outlet />
      </main>
    </div>
  );
}

export function NotFound() {
  return (
    <FullPage>
      <div className="text-center">
        <p className="text-sm font-semibold text-primary">404</p>
        <h1 className="mt-1 text-2xl font-bold">Page not found</h1>
        <p className="mt-2 text-sm text-muted">The page you're looking for doesn't exist or was moved.</p>
        <Link to="/dashboard" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
          Back to dashboard
        </Link>
      </div>
    </FullPage>
  );
}
