import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createOrganization, logout, type MeResponse } from "@/lib/api";
import { Button } from "@/components/ui";
import { Alert, AuthLayout, Field } from "@/components/auth";

/** Signed in, but not a member of any workspace (e.g. removed from their team). */
export function NoWorkspace({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createOrganization(name.trim());
      await queryClient.invalidateQueries();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Create a workspace"
      subtitle={`You're signed in as ${me.user.email} but aren't part of a workspace yet.`}
      footer={
        <button className="font-medium text-primary hover:underline" onClick={() => logout().finally(() => window.location.assign("/login"))}>
          Sign out
        </button>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Company name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={120} />
        <Button type="submit" className="w-full" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create workspace"}
        </Button>
        <p className="text-center text-xs text-muted">Waiting for an invitation instead? Open the link from your email.</p>
      </form>
    </AuthLayout>
  );
}
