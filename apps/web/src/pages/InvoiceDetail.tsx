import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, PageHeader, Spinner } from "@/components/ui";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { Alert } from "@/components/auth";
import { getInvoice, createPayLink, invoiceAction, type InvoiceAction } from "@/lib/api";
import { daysUntil, formatDate, formatDateTime, formatMoney, timeAgo } from "@/lib/format";
import { useMe } from "@/lib/me";

export function InvoiceDetail() {
  // All hooks run unconditionally, before any early return (Rules of Hooks).
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const canAct = me.user.role === "owner" || me.user.role === "admin";
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { open, close, setLoading, ConfirmDialog } = useConfirmDialog();
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["invoice", id],
    queryFn: () => getInvoice(id!),
    enabled: Boolean(id),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["invoice", id] }),
      queryClient.invalidateQueries({ queryKey: ["invoices"] }),
      queryClient.invalidateQueries({ queryKey: ["me"] }),
    ]);

  async function act(action: InvoiceAction, success: string) {
    setBusy(action);
    setLoading(true);
    try {
      const r = await invoiceAction(id!, action);
      showToast(action === "send_now" && r.sent === false ? "Nothing was sent" : success, r.sent === false ? "warning" : "success");
      await refresh();
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      setBusy(null);
      setLoading(false);
      close();
    }
  }

  async function payLink() {
    setBusy("paylink");
    try {
      const { paymentLink } = await createPayLink(id!);
      await navigator.clipboard?.writeText(paymentLink).catch(() => undefined);
      showToast("Payment link created and copied", "success");
      await refresh();
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  if (isLoading) {
    return (
      <Card>
        <Spinner label="Loading invoice…" />
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card>
        <p className="text-sm text-muted">{(error as Error)?.message ?? "Could not load this invoice."}</p>
        <Link to="/invoices" className="mt-3 inline-block">
          <Button variant="secondary">Back to invoices</Button>
        </Link>
      </Card>
    );
  }

  const inv = data.invoice;
  const due = daysUntil(inv.dueDate);
  const overdue = inv.status === "open" && due !== null && due < 0;
  const label = inv.customerName ?? inv.externalId ?? "this invoice";

  return (
    <div>
      <ConfirmDialog />
      <PageHeader
        title={inv.customerName ?? "Invoice"}
        subtitle={[inv.externalId, inv.customerEmail].filter(Boolean).join(" · ") || undefined}
        actions={
          <Link to="/invoices">
            <Button variant="secondary">Back</Button>
          </Link>
        }
      />

      <div className="grid max-w-3xl gap-6">
        {inv.lastPaymentFailure && inv.status === "open" && (
          <Alert tone="warning">
            Last payment attempt failed {timeAgo(inv.lastPaymentFailure.at)}: {inv.lastPaymentFailure.reason ?? "card declined"}.
          </Alert>
        )}
        {inv.snoozedUntil && new Date(inv.snoozedUntil) > new Date() && (
          <Alert tone="info">Customer promised to pay — reminders resume {formatDate(inv.snoozedUntil.slice(0, 10))} if still unpaid.</Alert>
        )}
        {inv.status === "paused" && <Alert tone="warning">Reminders are paused for this invoice (a dispute, bounced email, or manual pause).</Alert>}

        <Card>
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm text-muted">Amount due</div>
              <div className="mt-1 text-3xl font-bold">{formatMoney(inv.amountDue, inv.currency)}</div>
            </div>
            <Badge tone={overdue ? "overdue" : inv.status}>{overdue ? "overdue" : inv.status}</Badge>
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted">Issued</dt>
              <dd className="font-medium">{formatDate(inv.issueDate)}</dd>
            </div>
            <div>
              <dt className="text-muted">Due</dt>
              <dd className={"font-medium " + (overdue ? "text-danger" : "")}>
                {formatDate(inv.dueDate)}
                {due !== null && inv.status === "open" ? (
                  <span className="ml-1 text-xs text-muted">({due < 0 ? `${Math.abs(due)}d overdue` : due === 0 ? "today" : `in ${due}d`})</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Source</dt>
              <dd className="font-medium capitalize">{inv.source}</dd>
            </div>
            <div>
              <dt className="text-muted">Next reminder</dt>
              <dd className="font-medium">{inv.status === "open" && inv.nextStepIndex < 9999 && inv.nextStepDueAt ? formatDateTime(inv.nextStepDueAt) : "—"}</dd>
            </div>
          </dl>

          <div className="mt-6 flex flex-wrap gap-2">
            {inv.paymentLink ? (
              <>
                <a href={inv.paymentLink} target="_blank" rel="noreferrer">
                  <Button variant="secondary">Open payment link</Button>
                </a>
                <Button
                  variant="ghost"
                  onClick={() => navigator.clipboard?.writeText(inv.paymentLink!).then(() => showToast("Link copied", "success"))}
                >
                  Copy link
                </Button>
              </>
            ) : (
              canAct &&
              ["open", "paused"].includes(inv.status) && (
                <Button variant="secondary" onClick={payLink} disabled={busy !== null}>
                  {busy === "paylink" ? "Creating…" : "Create payment link"}
                </Button>
              )
            )}
            {canAct && inv.status === "open" && (
              <Button
                onClick={() =>
                  open("Send reminder now", `Send the next reminder to ${inv.customerEmail ?? label} right away? This uses 1 credit.`, () => act("send_now", "Reminder sent"), {
                    variant: "primary",
                    confirmText: "Send now",
                  })
                }
                disabled={busy !== null}
              >
                Send reminder now
              </Button>
            )}
            {canAct && inv.status === "open" && (
              <Button variant="secondary" onClick={() => act("pause", "Reminders paused")} disabled={busy !== null}>
                Pause
              </Button>
            )}
            {canAct && inv.status === "paused" && (
              <Button variant="secondary" onClick={() => act("resume", "Reminders resumed")} disabled={busy !== null}>
                Resume reminders
              </Button>
            )}
            {canAct && ["open", "paused", "uncollectible"].includes(inv.status) && (
              <Button
                variant="secondary"
                onClick={() => open("Mark as paid", `Mark ${label} as paid? All future reminders stop.`, () => act("mark_paid", "Marked as paid"), { confirmText: "Mark paid" })}
                disabled={busy !== null}
              >
                Mark paid
              </Button>
            )}
            {canAct && ["open", "paused"].includes(inv.status) && (
              <Button
                variant="ghost"
                onClick={() =>
                  open("Write off", `Mark ${label} as uncollectible? Reminders stop; you can reopen it later.`, () => act("mark_uncollectible", "Marked uncollectible"), {
                    confirmText: "Write off",
                  })
                }
                disabled={busy !== null}
              >
                Write off
              </Button>
            )}
            {canAct && ["uncollectible", "void"].includes(inv.status) && (
              <Button variant="secondary" onClick={() => act("reopen", "Invoice reopened")} disabled={busy !== null}>
                Reopen
              </Button>
            )}
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 text-lg font-semibold">Line items</h2>
          {Array.isArray(inv.lineItems) && inv.lineItems.length > 0 ? (
            <ul className="divide-y divide-slate-100">
              {inv.lineItems.map((li, i) => {
                const item = li as { description?: string; quantity?: number; amount?: number };
                return (
                  <li key={i} className="flex items-center justify-between py-2 text-sm">
                    <span>
                      <span className="font-medium">{item.description ?? "Item"}</span>
                      <span className="ml-2 text-xs text-muted">×{item.quantity ?? 1}</span>
                    </span>
                    <span className="font-medium">{formatMoney(item.amount ?? 0, inv.currency)}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted">No line items recorded.</p>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-lg font-semibold">Timeline</h2>
          {data.timeline.length === 0 ? (
            <p className="text-sm text-muted">No reminders or replies yet. Reminders send automatically when each step is due.</p>
          ) : (
            <ul className="space-y-3">
              {data.timeline.map((m) => (
                <li key={m.id} className="text-sm">
                  {m.kind === "reply" ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <span className="flex items-center gap-2">
                        <Badge tone={m.classification ?? "junk"}>{m.classification}</Badge>
                        <span className="text-xs text-muted">
                          customer replied {timeAgo(m.sentAt)}
                          {m.promiseDate ? ` · pays by ${formatDate(m.promiseDate)}` : ""}
                        </span>
                      </span>
                      <p className="mt-2 whitespace-pre-wrap text-slate-700">{m.content}</p>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          <Badge tone={m.channel}>{m.channel}</Badge>
                          <span className="text-muted">{m.stepIndex === null ? "Manual reply" : `Reminder ${m.stepIndex + 1}`}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge tone={m.status}>{m.status}</Badge>
                          <span className="text-xs text-muted">{timeAgo(m.sentAt)}</span>
                        </span>
                      </div>
                      {m.status === "failed" && m.error && <p className="mt-1 text-xs text-red-700">{m.error}</p>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
