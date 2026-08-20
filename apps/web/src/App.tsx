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

  return (
    <MeProvider value={data}>
      <Layout />
    </MeProvider>
  );
}

export function PublicOutlet() {
  return <Outlet />;
}