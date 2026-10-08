import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Spinner } from "@/components/ui";
import { Alert, Field, PasswordField, passwordIssues } from "@/components/auth";
import { useToast } from "@/components/Toast";
import { useMe } from "@/lib/me";
import { changePassword, getSessions, revokeOtherSessions, revokeSession, updateProfile } from "@/lib/api";
import { describeUserAgent, timeAgo } from "@/lib/format";

function ProfileCard() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [name, setName] = useState(me.user.displayName ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold">Profile</h2>
      <form
        className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await updateProfile(name.trim());
            await queryClient.invalidateQueries({ queryKey: ["me"] });
            showToast("Profile updated", "success");
          } catch (err) {
            showToast((err as Error).message, "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Your name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="name" />
        <Button type="submit" disabled={busy || !name.trim() || name.trim() === me.user.displayName}>
          Save
        </Button>
      </form>
      <p className="mt-3 text-sm text-muted">Email: {me.user.email}</p>
    </Card>
  );
}

function PasswordCard() {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const issues = passwordIssues(next);
    if (issues.length) return setMsg({ tone: "error", text: `New password needs ${issues.join(", ")}.` });
    if (next !== confirm) return setMsg({ tone: "error", text: "New passwords don't match." });
    setBusy(true);
    setMsg(null);
    try {
      const r = await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ tone: "success", text: `Password changed.${r.otherSessionsSignedOut ? ` Signed out ${r.otherSessionsSignedOut} other device(s).` : ""}` });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (err) {
      setMsg({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold">Password</h2>
      <p className="mb-4 text-sm text-muted">Signed up with Google? Use “Forgot password” on the sign-in page to set one.</p>
      <form onSubmit={submit} className="grid max-w-sm gap-4">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <PasswordField label="Current password" value={current} onChange={setCurrent} />
        <PasswordField label="New password" value={next} onChange={setNext} autoComplete="new-password" showStrength />
        <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        <div>
          <Button type="submit" disabled={busy || !current || !next || !confirm}>
            {busy ? "Updating…" : "Change password"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SessionsCard() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data, isLoading } = useQuery({ queryKey: ["sessions"], queryFn: getSessions });
  const others = (data?.sessions ?? []).filter((s) => !s.current).length;

  const act = async (fn: () => Promise<unknown>, text: string) => {
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      showToast(text, "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    }
  };

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Where you're signed in</h2>
        {others > 0 && (
          <Button variant="secondary" onClick={() => act(revokeOtherSessions, "Signed out of other devices")}>
            Sign out other devices
          </Button>
        )}
      </div>
      {isLoading ? (
        <Spinner label="Loading…" />
      ) : (
        <ul className="divide-y divide-slate-100">
          {(data?.sessions ?? []).map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2 text-sm">
              <div>
                <div className="font-medium">
                  {describeUserAgent(s.userAgent)} {s.current && <span className="text-xs text-green-700">· this device</span>}
                </div>
                <div className="text-xs text-muted">
                  {s.ip ?? "unknown IP"} · active {timeAgo(s.lastSeenAt ?? s.createdAt)}
                </div>
              </div>
              {!s.current && (
                <button className="text-xs text-red-600 hover:underline" onClick={() => act(() => revokeSession(s.id), "Device signed out")}>
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function AccountTab() {
  return (
    <div className="grid gap-6">
      <ProfileCard />
      <PasswordCard />
      <SessionsCard />
    </div>
  );
}
