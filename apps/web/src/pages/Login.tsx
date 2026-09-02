import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Button, Input } from "../components/ui";

export function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.post<{
        ok: boolean; userId: string; tenantId: string; role: string;
        isSuperAdmin: boolean; tenantSlug: string; sessionType: "tenant";
      }>("/auth/login", { email: email.trim(), password });
      navigate("/dashboard", { replace: true });
      window.location.reload();
    } catch (err: unknown) {
      const apiErr = err as { message?: string };
      setError(apiErr.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  }

  const handleGoogleLogin = () => {
    const googleAuthUrl = import.meta.env.VITE_API_URL?.startsWith("http")
      ? new URL("/auth/google", import.meta.env.VITE_API_URL).toString()
      : "/api/auth/google";
    window.location.assign(googleAuthUrl);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-2xl font-bold text-primary">AutoCollect AI</div>
          <p className="mt-1 text-sm text-muted">
            Sign in to your workspace
          </p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-200 bg-surface p-6 shadow-sm">
          {error && (
            <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
          <div className="flex items-center justify-center mt-4">
            <Button 
              variant="secondary"
              onClick={handleGoogleLogin}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700"
            >
              SIGN IN WITH GOOGLE (TEST VERSION)
            </Button>
          </div>
          <div className="text-sm">
            <Link to="/forgot-password" className="text-primary hover:underline">
              Forgot password?
            </Link>
          </div>
          <p className="text-center text-sm text-muted">
            New to AutoCollect AI?{" "}
            <Link to="/signup" className="text-primary hover:underline">Start your free trial</Link>
          </p>
        </form>
      </div>
    </div>
  );
}