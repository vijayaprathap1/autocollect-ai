import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet } from "react-router-dom";
import { ApiClientError, fetchMe } from "@/lib/api";
import { MeProvider } from "@/lib/me";
import { Layout } from "@/components/Layout";
import { Spinner } from "@/components/ui";

export function Shell() {
  const { data, error, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: fetchMe,
    retry: false,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Loading workspace…" />
      </div>
    );
  }

  if (error instanceof ApiClientError && error.status === 401) {
    return <Navigate to="/login" replace />;
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-danger">
        Failed to load workspace. Is the API running?
      </div>
    );
  }

  if (data.user.sessionType === "admin") return <Navigate to="/admin" replace />;

  return (
    <MeProvider value={data}>
      <Layout />
    </MeProvider>
  );
}

export function PublicRoute() {
  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: fetchMe,
    retry: false,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Loading…" />
      </div>
    );
  }

  // If already logged in, redirect to dashboard
  if (data?.user) {
    return <Navigate to={data.user.sessionType === "admin" ? "/admin" : "/dashboard"} replace />;
  }

  return <Outlet />;
}

export function AdminShell() {
  const { data, error, isLoading } = useQuery({ queryKey: ["me"], queryFn: fetchMe, retry: false, staleTime: 30_000 });
  if (isLoading) return <div className="flex min-h-screen items-center justify-center"><Spinner label="Loading admin console..." /></div>;
  if (error instanceof ApiClientError && error.status === 401) return <Navigate to="/admin/login" replace />;
  if (error || !data) return <div className="flex min-h-screen items-center justify-center text-sm text-danger">Failed to load admin console.</div>;
  if (data.user.sessionType !== "admin" || !data.user.isSuperAdmin) return <Navigate to="/dashboard" replace />;
  return <div className="min-h-screen bg-[#f5f7fb]"><header className="flex h-16 items-center justify-between bg-[#091525] px-8 text-white"><span className="font-semibold">AutoCollect AI <span className="ml-2 text-xs font-normal text-slate-400">Platform Admin</span></span><a href="/login" className="text-sm text-slate-300 hover:text-white">User portal</a></header><main className="mx-auto max-w-7xl p-8 lg:p-12"><Outlet /></main></div>;
}
