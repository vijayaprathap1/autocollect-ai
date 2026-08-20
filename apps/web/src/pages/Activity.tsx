import { useQuery } from "@tanstack/react-query";
import { Badge, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { getActivity } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useMe } from "@/lib/me";

const ACTION_LABELS: Record<string, string> = {
  dunning_sent: "Reminder sent",
  template_approved: "Template approved",
  templates_drafted: "Templates drafted",
  workflow_update: "Workflow updated",
  invoice_paid: "Invoice marked paid",
  reply_received: "Reply received",
};

export function Activity() {
  const me = useMe();
  const { data, isLoading } = useQuery({ queryKey: ["activity"], queryFn: getActivity });

  if (!me.tenant?.invoiceCount) {
    return (
      <div>
        <PageHeader title="Activity" subtitle="Every reminder sent and every payment received." />
        <EmptyState
          title="Nothing here yet"
          description="Connect a source to get started — reminders and payments will appear here."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Activity" subtitle="Every reminder sent and every payment received." />
      {isLoading ? (
        <Card>
          <Spinner label="Loading activity…" />
        </Card>
      ) : data && (data.messages.length > 0 || data.audit.length > 0 || data.replies.length > 0) ? (
        <div className="grid max-w-3xl gap-6">
          {data.replies.length > 0 && (
            <Card>
              <h2 className="mb-3 text-lg font-semibold">Reply inbox</h2>
              <ul className="divide-y divide-slate-100">
                {data.replies.map((r) => (
                  <li key={r.id} className="py-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2">
                        <Badge tone={r.classification}>{r.classification}</Badge>
                        <span className="font-medium">
                          {r.customerName ?? "Client"} · {r.invoiceNumber ?? "invoice"}
                        </span>
                      </span>
                      <span className="text-xs text-muted">{timeAgo(r.createdAt)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-muted">{r.content}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.messages.length > 0 && (
            <Card>
              <h2 className="mb-3 text-lg font-semibold">Recent reminders</h2>
              <ul className="divide-y divide-slate-100">
                {data.messages.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge tone={m.channel}>{m.channel}</Badge>
                      <span className="font-medium">
                        {m.customerName ?? "Client"} · {m.invoiceNumber ?? "invoice"}
                      </span>
                    </div>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-muted">
                        step {m.stepIndex + 1} · {timeAgo(m.sentAt)}
                      </span>
                      <Badge tone={m.status}>{m.status}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.audit.length > 0 && (
            <Card>
              <h2 className="mb-3 text-lg font-semibold">Activity log</h2>
              <ul className="divide-y divide-slate-100">
                {data.audit.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                    <span className="font-medium">{ACTION_LABELS[a.action] ?? a.action}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-muted">
                        {a.actor} · {timeAgo(a.createdAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      ) : (
        <Card>
          <p className="text-sm text-muted">No activity yet. It appears as your sequence runs.</p>
        </Card>
      )}
    </div>
  );
}