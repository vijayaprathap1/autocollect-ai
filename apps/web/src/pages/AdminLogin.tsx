import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { adminLogin, verifyTwoFactor } from "@/lib/api";
import { Button } from "@/components/ui";
import { Alert, AuthLayout, Field, PasswordField } from "@/components/auth";

export function AdminLogin() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (challenge) {
        await verifyTwoFactor(challenge, code);
      } else {
        const result = await adminLogin(email.trim(), password);
        if (result.twoFactorRequired && result.challengeToken) {
          setChallenge(result.challengeToken);
          setLoading(false);
          return;
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      navigate("/admin", { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setPassword("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Platform admin" subtitle="Restricted access. All actions are audited.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        {challenge ? (
          <Field label="Authentication code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus required />
        ) : (
          <>
            <Field label="Admin email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
            <PasswordField value={password} onChange={setPassword} />
          </>
        )}
        <Button type="submit" className="w-full" disabled={loading || (challenge ? code.trim().length < 6 : !email || !password)}>
          {loading ? "Signing in…" : challenge ? "Verify" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
