import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { acceptInvitation, previewInvitation, type ApiClientError } from "@/lib/api";
import { Button, Spinner } from "@/components/ui";
import { Alert, AuthLayout, Field, PasswordField, passwordIssues } from "@/components/auth";

export function AcceptInvite() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = params.get("id") ?? "";
  const token = params.get("token") ?? "";
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = useQuery({
    queryKey: ["invite-preview", id, token],
    queryFn: () => previewInvitation(id, token),
    enabled: Boolean(id && token),
    retry: false,
  });

  async function accept(e?: FormEvent) {
    e?.preventDefault();
    const inv = preview.data;
    if (!inv) return;
    if (!inv.accountExists) {
      const issues = passwordIssues(password);
      if (!displayName.trim()) return setError("Enter your name.");
      if (issues.length) return setError(`Password needs ${issues.join(", ")}.`);
    }
    setError(null);
    setBusy(true);
    try {
      await acceptInvitation(id, token, inv.accountExists ? undefined : { displayName: displayName.trim(), password });
      await queryClient.invalidateQueries();
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError((err as ApiClientError).message);
    } finally {
      setBusy(false);
    }
  }

  if (!id || !token || preview.isError) {
    return (
      <AuthLayout title="Invitation unavailable" footer={<Link to="/login" className="font-medium text-primary hover:underline">Go to sign in</Link>}>
        <p className="text-sm text-muted">
          {preview.error ? (preview.error as Error).message : "This invitation link is incomplete."} Ask the person who invited you to send a new
          invitation.
        </p>
      </AuthLayout>
    );
  }
  if (preview.isLoading || !preview.data) {
    return (
      <AuthLayout title="Loading invitation">
        <Spinner label="Checking your invitation…" />
      </AuthLayout>
    );
  }

  const inv = preview.data;
  return (
    <AuthLayout title={`Join ${inv.organizationName}`} subtitle={`You've been invited as ${inv.role === "admin" ? "an admin" : "a team member"}.`}>
      <form onSubmit={accept} className="space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Email" value={inv.email} readOnly disabled />
        {inv.accountExists ? (
          <p className="text-sm text-muted">You already have an AutoCollect account with this email. Accepting adds this workspace to it.</p>
        ) : (
          <>
            <Field label="Your name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" autoFocus required maxLength={100} />
            <PasswordField label="Create a password" value={password} onChange={setPassword} autoComplete="new-password" showStrength />
          </>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Joining…" : "Accept invitation"}
        </Button>
      </form>
    </AuthLayout>
  );
}
