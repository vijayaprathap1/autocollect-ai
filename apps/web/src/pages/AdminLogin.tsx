import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { adminLogin } from "@/lib/api";
import { Button } from "@/components/ui";
import { Alert, AuthLayout, Field, PasswordField } from "@/components/auth";

export function AdminLogin() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await adminLogin(email.trim(), password);
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
        <Field label="Admin email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
        <PasswordField value={password} onChange={setPassword} />
        <Button type="submit" className="w-full" disabled={loading || !email || !password}>
          {loading ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
