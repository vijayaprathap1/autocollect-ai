import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { resetPassword } from "@/lib/api";
import { Button } from "@/components/ui";
import { Alert, AuthLayout, PasswordField, passwordIssues } from "@/components/auth";

export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";
  const isSetup = params.get("setup") === "1";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const issues = passwordIssues(password);
    if (issues.length) return setError(`Password needs ${issues.join(", ")}.`);
    if (password !== confirm) return setError("Passwords don't match.");
    setError(null);
    setLoading(true);
    try {
      await resetPassword(token, password);
      navigate("/login?reset=1", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout title="Invalid link" footer={<Link to="/forgot-password" className="font-medium text-primary hover:underline">Request a new link</Link>}>
        <p className="text-sm text-muted">This password link is missing its token. Request a new one.</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={isSetup ? "Set your password" : "Choose a new password"} subtitle={isSetup ? "Finish setting up your account." : undefined}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && (
          <Alert>
            {error}{" "}
            {/expired|invalid/i.test(error) && (
              <Link to="/forgot-password" className="font-medium underline">
                Get a new link
              </Link>
            )}
          </Alert>
        )}
        <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" showStrength autoFocus />
        <PasswordField label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        <Button type="submit" className="w-full" disabled={loading || !password || !confirm}>
          {loading ? "Saving…" : isSetup ? "Set password" : "Update password"}
        </Button>
        {!isSetup && <p className="text-center text-xs text-muted">For your security, you'll be signed out of all other devices.</p>}
      </form>
    </AuthLayout>
  );
}
