import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { signup, resendVerification } from "@/lib/api";
import { Button } from "@/components/ui";
import { Alert, AuthLayout, Field, GoogleButton, PasswordField, passwordIssues } from "@/components/auth";

export function SignUp() {
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [resent, setResent] = useState(false);

  const pwIssues = passwordIssues(password);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pwIssues.length) {
      setError(`Password needs ${pwIssues.join(", ")}.`);
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await signup({
        name: name.trim(),
        email: email.trim(),
        password,
        organizationName: organizationName.trim() || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setSent(true);
    } catch (err) {
      setError((err as Error).message ?? "Sign-up failed");
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <AuthLayout title="Check your email" footer={<Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>}>
        <div className="space-y-4 text-sm text-muted">
          <p>
            We sent a confirmation link to <strong className="text-ink">{email}</strong>. Click it to activate your workspace — the link
            expires in 24 hours.
          </p>
          <p>Can't find it? Check your spam folder.</p>
          {resent ? (
            <Alert tone="success">A new link is on its way.</Alert>
          ) : (
            <Button
              variant="secondary"
              className="w-full"
              onClick={async () => {
                await resendVerification(email).catch(() => undefined);
                setResent(true);
              }}
            >
              Resend confirmation email
            </Button>
          )}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Start getting paid faster"
      subtitle="Free plan · no credit card required"
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Jane Smith" autoFocus required maxLength={100} />
        <Field
          label="Company"
          value={organizationName}
          onChange={(e) => setOrganizationName(e.target.value)}
          autoComplete="organization"
          placeholder="Acme Studio"
          hint="Shown to your customers in reminder emails. You can change it later."
          maxLength={120}
        />
        <Field label="Work email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="jane@company.com" required />
        <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="new-password" showStrength />
        <Button type="submit" className="w-full" disabled={loading || !name.trim() || !email.trim() || !password}>
          {loading ? "Creating your workspace…" : "Create account"}
        </Button>
        <p className="text-center text-xs text-muted">
          By creating an account you agree to the{" "}
          <Link to="/terms" className="font-medium text-primary hover:underline">Terms of Service</Link> and{" "}
          <Link to="/privacy" className="font-medium text-primary hover:underline">Privacy Policy</Link>.
        </p>
      </form>
      <GoogleButton label="Sign up with Google" />
    </AuthLayout>
  );
}
