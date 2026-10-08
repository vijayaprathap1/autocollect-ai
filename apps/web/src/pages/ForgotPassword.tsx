import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { forgotPassword } from "@/lib/api";
import { Button } from "@/components/ui";
import { Alert, AuthLayout, Field } from "@/components/auth";

export function ForgotPassword() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle={sent ? undefined : "We'll email you a secure link to choose a new one."}
      footer={<Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>}
    >
      {sent ? (
        <div className="space-y-3 text-sm text-muted">
          <Alert tone="success">If an account exists for {email}, a reset link is on its way.</Alert>
          <p>The link expires in 1 hour and can be used once. Check your spam folder if it doesn't arrive in a few minutes.</p>
          <Button variant="secondary" className="w-full" onClick={() => setSent(false)}>
            Use a different email
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error && <Alert>{error}</Alert>}
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
          <Button type="submit" className="w-full" disabled={loading || !email.trim()}>
            {loading ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
