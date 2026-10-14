import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ApiClientError, login, resendVerification } from "@/lib/api";
import { Button } from "@/components/ui";
import { Alert, AuthLayout, Field, GoogleButton, PasswordField, oauthErrorMessage } from "@/components/auth";

export function Login() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(oauthErrorMessage(params.get("error")));
  const [needsVerification, setNeedsVerification] = useState(false);
  const [notice, setNotice] = useState<string | null>(params.get("reset") === "1" ? "Password updated — sign in with your new password." : null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setNeedsVerification(false);
    setLoading(true);
    try {
      await login(email.trim(), password, rememberMe);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      const next = params.get("next");
      navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard", { replace: true });
    } catch (err) {
      const e = err as ApiClientError;
      if (e.code === "EMAIL_NOT_VERIFIED") setNeedsVerification(true);
      if (e.code === "ADMIN_LOGIN_REQUIRED") {
        navigate("/admin/login", { replace: true });
        return;
      }
      setError(e.message ?? "Sign-in failed");
      setPassword("");
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    try {
      const r = await resendVerification(email.trim());
      setNotice(r.message);
      setError(null);
      setNeedsVerification(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <AuthLayout
      title="Sign in to your workspace"
      footer={
        <>
          New to AutoCollect AI?{" "}
          <Link to="/signup" className="font-medium text-primary hover:underline">
            Create a free account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        {needsVerification && (
          <Alert tone="warning">
            Didn't get the email?{" "}
            <button type="button" onClick={resend} className="font-medium underline">
              Send a new verification link
            </button>
          </Alert>
        )}
        {notice && <Alert tone="success">{notice}</Alert>}
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          autoFocus={!email}
          required
        />
        <PasswordField value={password} onChange={setPassword} autoFocus={Boolean(email)} />
        <div className="flex items-center justify-between text-sm">
          <label className="flex items-center gap-2 text-muted">
            <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Keep me signed in
          </label>
          <Link to={`/forgot-password${email ? `?email=${encodeURIComponent(email)}` : ""}`} className="font-medium text-primary hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" className="w-full" disabled={loading || !email || !password}>
          {loading ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <GoogleButton />
    </AuthLayout>
  );
}
