import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { Button, Input } from "@/components/ui";

export function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setLoading(true);
    try {
      await api.post("/auth/admin/login", { email: email.trim(), password });
      navigate("/admin", { replace: true }); window.location.reload();
    } catch (err: unknown) {
      setError((err as { message?: string }).message ?? "Admin login failed");
    } finally { setLoading(false); }
  }

  return <div className="flex min-h-screen items-center justify-center bg-[#091525] px-4">
    <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-700 bg-[#102344] p-7 text-white shadow-xl">
      <div><div className="text-2xl font-bold">AutoCollect AI</div><p className="mt-1 text-sm text-slate-300">Platform administration</p></div>
      {error && <div className="rounded-lg bg-red-900/50 p-3 text-sm text-red-100">{error}</div>}
      <label className="block text-sm">Admin email<Input className="mt-1 text-ink" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
      <label className="block text-sm">Password<Input className="mt-1 text-ink" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      <Button type="submit" className="w-full" disabled={loading}>{loading ? "Signing in..." : "Sign in to admin"}</Button>
    </form>
  </div>;
}