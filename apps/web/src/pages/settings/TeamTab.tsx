import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Card, Spinner } from "@/components/ui";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { Alert, Field } from "@/components/auth";
import { useToast } from "@/components/Toast";
import { useMe } from "@/lib/me";
import { timeAgo } from "@/lib/format";
import {
  changeMemberRole,
  getInvitations,
  getMembers,
  leaveWorkspace,
  removeMember,
  resendInvitation,
  revokeInvitation,
  sendInvitation,
  type Role,
} from "@/lib/api";

export function TeamTab() {
  const me = useMe();
  const t = me.tenant!;
  const isOwner = me.user.role === "owner";
  const isAdmin = isOwner || me.user.role === "admin";
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { open, close, setLoading, ConfirmDialog } = useConfirmDialog();

  const members = useQuery({ queryKey: ["members"], queryFn: getMembers });
  const invitations = useQuery({ queryKey: ["invitations"], queryFn: getInvitations, enabled: isAdmin });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["members"] }),
      queryClient.invalidateQueries({ queryKey: ["invitations"] }),
      queryClient.invalidateQueries({ queryKey: ["me"] }),
    ]);
  };

  const run = (fn: () => Promise<unknown>, success: string) => async () => {
    setLoading(true);
    try {
      await fn();
      await refresh();
      showToast(success, "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      setLoading(false);
      close();
    }
  };

  async function invite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendInvitation(email.trim(), role);
      setEmail("");
      await refresh();
      showToast(`Invitation sent to ${email.trim()}`, "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const seatsFull = t.seatLimit !== null && t.seatsUsed + (invitations.data?.invitations.length ?? 0) >= t.seatLimit;

  return (
    <div className="grid gap-6">
      <ConfirmDialog />
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Members</h2>
          <span className="text-sm text-muted">
            {t.seatsUsed}
            {t.seatLimit ? ` of ${t.seatLimit}` : ""} seats
          </span>
        </div>
        {members.isLoading ? (
          <Spinner label="Loading…" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {(members.data?.members ?? []).map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {m.displayName || m.email} {m.isYou && <span className="text-muted">(you)</span>}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {m.email} · {m.lastLoginAt ? `active ${timeAgo(m.lastLoginAt)}` : "never signed in"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isOwner && !m.isYou ? (
                    <select
                      aria-label={`Role for ${m.email}`}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                      value={m.role}
                      onChange={(e) =>
                        open("Change role", `Make ${m.email} ${e.target.value === "admin" ? "an admin" : `a ${e.target.value}`}?`, run(() => changeMemberRole(m.id, e.target.value as Role), "Role updated"), {
                          variant: "primary",
                          confirmText: "Change role",
                        })
                      }
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Owner</option>
                    </select>
                  ) : (
                    <Badge tone={m.role === "owner" ? "paid" : m.role === "admin" ? "open" : "delivered"}>{m.role}</Badge>
                  )}
                  {isAdmin && !m.isYou && (m.role !== "owner" || isOwner) && (
                    <button
                      className="text-xs text-red-600 hover:underline"
                      onClick={() =>
                        open("Remove member", `Remove ${m.email} from ${t.name}? They'll be signed out of this workspace immediately.`, run(() => removeMember(m.id), "Member removed"), {
                          confirmText: "Remove",
                        })
                      }
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {isAdmin && (
        <Card>
          <h2 className="mb-1 text-lg font-semibold">Invite a teammate</h2>
          <p className="mb-4 text-sm text-muted">They'll get an email link to join. Invitations expire after 7 days.</p>
          {seatsFull ? (
            <Alert tone="info">
              All seats are in use.{" "}
              <button className="font-medium underline" onClick={() => navigate("/settings?tab=billing")}>
                Upgrade your plan
              </button>{" "}
              to add more teammates.
            </Alert>
          ) : (
            <form onSubmit={invite} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" required error={error} />
              <div>
                <label className="mb-1 block text-sm font-medium">Role</label>
                <select className="rounded-lg border border-slate-300 px-3 py-2 text-sm" value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
                  <option value="member">Member</option>
                  {isOwner && <option value="admin">Admin</option>}
                </select>
              </div>
              <Button type="submit" disabled={busy || !email.trim()}>
                {busy ? "Sending…" : "Send invite"}
              </Button>
            </form>
          )}
          <p className="mt-3 text-xs text-muted">Members can view invoices and replies. Admins can also change settings, send reminders and manage the team.</p>

          {(invitations.data?.invitations.length ?? 0) > 0 && (
            <>
              <h3 className="mb-1 mt-6 text-xs font-medium uppercase tracking-wider text-muted">Pending invitations</h3>
              <ul className="divide-y divide-slate-100">
                {invitations.data!.invitations.map((inv) => (
                  <li key={inv.id} className="flex items-center justify-between py-2 text-sm">
                    <div>
                      <div className="font-medium">{inv.email}</div>
                      <div className="text-xs text-muted">
                        {inv.role} · expires {timeAgo(inv.expiresAt).replace(" ago", "")}
                      </div>
                    </div>
                    <div className="flex gap-3 text-xs">
                      <button className="text-primary hover:underline" onClick={run(() => resendInvitation(inv.id), "Invitation re-sent")}>
                        Resend
                      </button>
                      <button className="text-red-600 hover:underline" onClick={run(() => revokeInvitation(inv.id), "Invitation revoked")}>
                        Revoke
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}

      <Card>
        <h2 className="mb-1 text-lg font-semibold">Leave workspace</h2>
        <p className="mb-3 text-sm text-muted">You'll lose access to {t.name}. {isOwner ? "Owners must hand ownership to someone else first." : ""}</p>
        <Button
          variant="secondary"
          onClick={() =>
            open("Leave workspace", `Leave ${t.name}? You'll need a new invitation to come back.`, async () => {
              setLoading(true);
              try {
                await leaveWorkspace();
                queryClient.clear();
                navigate("/dashboard", { replace: true });
              } catch (err) {
                showToast((err as Error).message, "error");
              } finally {
                setLoading(false);
                close();
              }
            }, { confirmText: "Leave" })
          }
        >
          Leave {t.name}
        </Button>
      </Card>
    </div>
  );
}
