import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { Card, PageHeader, Spinner } from "@/components/ui";

type AdminStats = {
  tenants: number;
  users: number;
  invoices: number;
  messages: number;
  totalCredits: number;
};

type AdminTenant = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  invoiceCount: number;
  userCount: number;
  creditBalance: number;
  createdAt: string;
};

type AdminUser = {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  isSuperAdmin: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  tenantName: string | null;
  role: string | null;
};

export function AdminConsole() {
  const queryClient = useQueryClient();
  const stats = useQuery({ queryKey: ["admin", "stats"], queryFn: () => api.get<AdminStats>("/admin/stats") });
  const tenants = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => api.get<{ tenants: AdminTenant[] }>("/admin/tenants") });
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.get<{ users: AdminUser[] }>("/admin/users") });
  const [tenantName, setTenantName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [provisionError, setProvisionError] = useState("");
  const provision = useMutation({
    mutationFn: () => api.post("/admin/tenants", { name: tenantName, ownerEmail, ownerName }),
    onSuccess: async () => { setTenantName(""); setOwnerEmail(""); setOwnerName(""); setProvisionError(""); await queryClient.invalidateQueries({ queryKey: ["admin"] }); },
    onError: (error: unknown) => setProvisionError((error as { message?: string }).message ?? "Unable to create tenant"),
  });
  function createTenant(event: FormEvent) { event.preventDefault(); provision.mutate(); }

  const toggleStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.put(`/admin/tenants/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Super Admin Console"
        subtitle="System-wide overview and management"
        actions={
          <Link to="/dashboard" className="text-sm text-primary hover:underline">
            Back to Dashboard
          </Link>
        }
      />

      <Card>
        <h2 className="mb-1 text-lg font-semibold">Create tenant workspace</h2>
        <p className="mb-4 text-sm text-muted">The owner receives a secure link to set their password.</p>
        <form onSubmit={createTenant} className="grid gap-3 md:grid-cols-4">
          <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Organization name" value={tenantName} onChange={(e) => setTenantName(e.target.value)} required />
          <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Owner name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" type="email" placeholder="Owner email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} required />
          <button className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={provision.isPending}>{provision.isPending ? "Creating..." : "Create tenant"}</button>
        </form>
        {provisionError && <p className="mt-3 text-sm text-danger">{provisionError}</p>}
      </Card>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {stats.isLoading ? (
          <Spinner />
        ) : stats.data ? (
          <>
            <StatCard label="Tenants" value={stats.data.tenants} />
            <StatCard label="Users" value={stats.data.users} />
            <StatCard label="Invoices" value={stats.data.invoices} />
            <StatCard label="Messages Sent" value={stats.data.messages} />
            <StatCard label="Total Credits" value={stats.data.totalCredits} />
          </>
        ) : null}
      </div>

      {/* Tenants Table */}
      <Card>
        <h2 className="mb-3 text-lg font-semibold">Tenants</h2>
        {tenants.isLoading ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-muted">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Plan</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Invoices</th>
                  <th className="pb-2 font-medium">Users</th>
                  <th className="pb-2 font-medium">Credits</th>
                  <th className="pb-2 font-medium">Created</th>
                  <th className="pb-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tenants.data?.tenants.map((t) => (
                  <tr key={t.id} className="border-b border-slate-100">
                    <td className="py-2">
                      <div className="font-medium">{t.name}</div>
                      <div className="text-xs text-muted">{t.slug}</div>
                    </td>
                    <td className="py-2 capitalize">{t.plan}</td>
                    <td className="py-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        t.status === "active" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                      }`}>
                        {t.status}
                      </span>
                    </td>
                    <td className="py-2">{t.invoiceCount}</td>
                    <td className="py-2">{t.userCount}</td>
                    <td className="py-2">{t.creditBalance}</td>
                    <td className="py-2 text-muted">{new Date(t.createdAt).toLocaleDateString()}</td>
                    <td className="py-2">
                      <button
                        onClick={() => toggleStatus.mutate({
                          id: t.id,
                          status: t.status === "active" ? "suspended" : "active",
                        })}
                        disabled={toggleStatus.isPending}
                        className={`text-xs cursor-pointer ${
                          t.status === "active" ? "text-red-600 hover:underline" : "text-green-600 hover:underline"
                        }`}
                      >
                        {t.status === "active" ? "Suspend" : "Activate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Users Table */}
      <Card>
        <h2 className="mb-3 text-lg font-semibold">Users</h2>
        {users.isLoading ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-muted">
                  <th className="pb-2 font-medium">Email</th>
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Org</th>
                  <th className="pb-2 font-medium">Role</th>
                  <th className="pb-2 font-medium">Super Admin</th>
                  <th className="pb-2 font-medium">Last Login</th>
                  <th className="pb-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {users.data?.users.map((u) => (
                  <tr key={u.id} className="border-b border-slate-100">
                    <td className="py-2 font-medium">{u.email}</td>
                    <td className="py-2">{u.displayName ?? "-"}</td>
                    <td className="py-2 text-muted">{u.tenantName ?? "-"}</td>
                    <td className="py-2 capitalize">{u.role ?? "-"}</td>
                    <td className="py-2">{u.isSuperAdmin ? "Yes" : "No"}</td>
                    <td className="py-2 text-muted">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : "Never"}
                    </td>
                    <td className="py-2 text-muted">{new Date(u.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <div className="text-2xl font-bold text-primary">{value.toLocaleString()}</div>
      <div className="text-sm text-muted">{label}</div>
    </Card>
  );
}
