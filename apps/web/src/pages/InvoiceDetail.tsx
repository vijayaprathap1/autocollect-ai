import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Card, PageHeader, Spinner } from "@/components/ui";
import { getInvoice } from "@/lib/api";
import { daysUntil, formatDate, formatMoney, timeAgo } from "@/lib/format";

export function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["invoice", id],
    queryFn: () => getInvoice(id!),
    enabled: Boolean(id),
  });

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
        <p className="text-sm text-muted">Could not load this invoice.</p>
        <Link to="/invoices" className="mt-3 inline-block">
          <Button variant="secondary">Back to invoices</Button>
        </Link>
      </Card>
    );
  }

  const inv = data.invoice;
  const due = daysUntil(inv.dueDate);
  const overdue = inv.status === "open" && due !== null && due < 0;

  return (
    <div>
      <PageHeader
        title={inv.customerName ?? "Invoice"}
        subtitle={inv.customerEmail ?? inv.externalId ?? undefined}
        actions={
          <Link to="/invoices">
            <Button variant="secondary">Back</Button>
          </Link>
        }
      />

      <div className="grid max-w-3xl gap-6">
        <Card>
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm text-muted">Amount due</div>
              <div className="mt-1 text-3xl font-bold">{formatMoney(inv.amountDue, inv.currency)}</div>
            </div>
            <Badge tone={overdue ? "overdue" : inv.status}>{overdue ? "overdue" : inv.status}</Badge>
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted">Issued</dt>
              <dd className="font-medium">{formatDate(inv.issueDate)}</dd>
            </div>
            <div>
              <dt className="text-muted">Due</dt>
              <dd className={"font-medium " + (overdue ? "text-danger" : "")}>
                {formatDate(inv.dueDate)}
                {due !== null && inv.status === "open" ? (
                  <span className="ml-1 text-xs text-muted">({due < 0 ? `${Math.abs(due)}d overdue` : `${due}d`})</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Source</dt>
              <dd className="font-medium capitalize">{inv.source}</dd>
            </div>
          </dl>
          {inv.paymentLink ? (
            <a
              href={inv.paymentLink}
              target="_blank"
              rel="noreferrer"
              className="mt-5 inline-block"
            >
              <Button>Open payment link</Button>
            </a>
          ) : null}
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
          <h2 className="mb-3 text-lg font-semibold">Reminder timeline</h2>
          {data.timeline.length === 0 ? (
            <p className="text-sm text-muted">
              No reminders or replies yet. The dunning engine sends reminders automatically.
            </p>
          ) : (
            <ul className="space-y-3">
              {data.timeline.map((m) => (
                <li key={m.id} className="text-sm">
                  {m.kind === "reply" ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          <Badge tone={m.classification ?? "junk"}>{m.classification}</Badge>
                          <span className="text-xs text-muted">
                            {timeAgo(m.sentAt)} · reply
                            {m.promiseDate ? ` · pays by ${formatDate(m.promiseDate)}` : ""}
                          </span>
                        </span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-slate-700">{m.content}</p>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <Badge tone={m.channel}>{m.channel}</Badge>
                        <span className="text-muted">Step {m.stepIndex! + 1}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge tone={m.status}>{m.status}</Badge>
                        <span className="text-xs text-muted">{timeAgo(m.sentAt)}</span>
                      </span>
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