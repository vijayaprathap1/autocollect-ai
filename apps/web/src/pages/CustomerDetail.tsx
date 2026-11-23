import { Link, useParams } from "react-router-dom";
import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, PageHeader, Spinner } from "@/components/ui";
import { Field } from "@/components/auth";
import { useToast } from "@/components/Toast";
import { addContact, createDispute, createTask, deleteContact, getCustomer, getWorkflows, updateCustomer, updateTask, assignStrategy } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";
import { useMe } from "@/lib/me";

const SEGMENTS = [
  { value: "", label: "No segment" },
  { value: "strategic", label: "Strategic" },
  { value: "standard", label: "Standard" },
  { value: "high_risk", label: "High risk" },
  { value: "smb", label: "SMB" },
];

export function CustomerDetail() {
  const { id = "" } = useParams();
  const me = useMe();
  const currency = me.tenant?.currency ?? "usd";
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const customer = useQuery({ queryKey: ["customer", id], queryFn: () => getCustomer(id), enabled: Boolean(id) });
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: getWorkflows });
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [disputeInvoice, setDisputeInvoice] = useState("");
  const [disputeSummary, setDisputeSummary] = useState("");

  if (customer.isLoading) return <Card><Spinner label="Loading customer…" /></Card>;
  if (!customer.data) return <Card>Customer not found.</Card>;
  const data = customer.data;
  const c = data.customer;

  async function saveSegment(segment: string) {
    try {
      await updateCustomer(id, { segment: segment || null });
      await queryClient.invalidateQueries({ queryKey: ["customer", id] });
      showToast("Segment saved", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    }
  }

  async function saveStrategy(workflowId: string) {
    try {
      await assignStrategy(id, workflowId || null);
      showToast(workflowId ? "Strategy assigned to open invoices" : "Open invoices follow the matching strategy again", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    }
  }

  async function addTask(e: FormEvent) {
    e.preventDefault();
    try {
      await createTask({ title: taskTitle.trim(), dueOn: taskDue || undefined, customerId: id });
      setTaskTitle("");
      setTaskDue("");
      await queryClient.invalidateQueries({ queryKey: ["customer", id] });
      showToast("Task added", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title={c.name ?? "Customer"}
        subtitle={[
          [c.company, c.email, c.phone].filter(Boolean).join(" · ") || "No contact details yet",
          c.creditStatus === "hold" ? "Credit hold — reminders and new payment links are paused" : "",
        ].filter(Boolean).join(" · ")}
        actions={<Link to="/worklist" className="text-sm font-medium text-primary hover:underline">Back to worklist</Link>}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-sm text-muted">Risk</div>
          <div className="text-2xl font-bold">{c.riskScore}</div>
        </Card>
        <Card>
          <label className="text-sm text-muted" htmlFor="segment">Segment</label>
          <select id="segment" className="mt-2 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm" value={c.segment ?? ""} onChange={(e) => void saveSegment(e.target.value)}>
            {SEGMENTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </Card>
        <Card>
          <label className="text-sm text-muted" htmlFor="strategy">Collection strategy</label>
          <select id="strategy" className="mt-2 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm" defaultValue="" onChange={(e) => void saveStrategy(e.target.value)}>
            <option value="">Match segment and risk</option>
            {(workflows.data?.workflows ?? []).map((w) => (
              <option key={w.id} value={w.id}>{w.name}{w.segment ? ` · ${w.segment}` : ""}</option>
            ))}
          </select>
        </Card>
      </div>

      <Section title="Invoices">
        <SimpleTable
          empty="No invoices."
          rows={data.invoices.map((inv) => [
            <Link key="l" to={`/invoices/${inv.id}`} className="text-primary hover:underline">{inv.external_id ?? inv.id.slice(0, 8)}</Link>,
            formatMoney(inv.amount_due, inv.currency || currency),
            inv.status,
            inv.due_date ? formatDate(inv.due_date) : "—",
            inv.payment_link ? "link" : "—",
          ])}
          headers={["Invoice", "Amount", "Status", "Due", "Pay link"]}
        />
      </Section>
      <Section title="Contacts">
        {data.contacts.length === 0 ? <p className="text-sm text-muted">No extra contacts.</p> : (
          <ul className="text-sm">{data.contacts.map((ct) => (
            <li key={ct.id} className="flex items-center justify-between gap-2">
              <span>{ct.name ?? ct.email ?? ct.phone} · {ct.role}{ct.is_primary ? " · primary" : ""}</span>
              <button type="button" className="text-xs text-muted hover:text-danger" onClick={() => deleteContact(id, ct.id).then(() => queryClient.invalidateQueries({ queryKey: ["customer", id] })).catch((err) => showToast((err as Error).message, "error"))}>Remove</button>
            </li>
          ))}</ul>
        )}
        <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); addContact(id, { email: contactEmail }).then(() => { setContactEmail(""); void queryClient.invalidateQueries({ queryKey: ["customer", id] }); }).catch((err) => showToast((err as Error).message, "error")); }}>
          <Field label="Contact email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} required />
          <Button type="submit" variant="secondary" disabled={!contactEmail.trim()}>Add contact</Button>
        </form>
      </Section>
      <Section title="Communications">
        {data.communications.length === 0 ? <p className="text-sm text-muted">No reminders sent yet.</p> : (
          <ul className="space-y-1 text-sm">{data.communications.map((m) => <li key={m.id}>{m.channel} · {m.status} · {m.external_id ?? ""} {m.sent_at ? formatDate(m.sent_at) : ""}</li>)}</ul>
        )}
      </Section>
      <Section title="Replies">
        {data.replies.length === 0 ? <p className="text-sm text-muted">No replies.</p> : (
          <ul className="space-y-2 text-sm">{data.replies.map((r) => <li key={r.id}><span className="font-medium">{r.classification}</span>{r.promise_date ? ` · promised ${formatDate(r.promise_date)}` : ""} — {r.content.slice(0, 180)}</li>)}</ul>
        )}
      </Section>
      <Section title="Disputes">
        {data.disputes.length === 0 ? <p className="text-sm text-muted">No disputes.</p> : (
          <ul className="text-sm">{data.disputes.map((d) => <li key={d.id}><Link className="text-primary hover:underline" to={`/disputes/${d.id}`}>{d.reason_code}</Link> · {d.status}</li>)}</ul>
        )}
        <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); createDispute({ invoiceId: disputeInvoice, summary: disputeSummary || undefined }).then(() => { setDisputeSummary(""); showToast("Dispute opened", "success"); void queryClient.invalidateQueries({ queryKey: ["customer", id] }); }).catch((err) => showToast((err as Error).message, "error")); }}>
          <label className="text-sm">Invoice
            <select aria-label="Invoice to dispute" className="mt-1 block rounded-xl border border-line bg-surface px-3 py-2" value={disputeInvoice} onChange={(e) => setDisputeInvoice(e.target.value)} required>
              <option value="">Choose</option>
              {data.invoices.filter((inv) => inv.status === "open" || inv.status === "paused").map((inv) => <option key={inv.id} value={inv.id}>{inv.external_id ?? inv.id.slice(0, 8)}</option>)}
            </select>
          </label>
          <Field label="Summary" value={disputeSummary} onChange={(e) => setDisputeSummary(e.target.value)} />
          <Button type="submit" variant="secondary" disabled={!disputeInvoice}>Open dispute</Button>
        </form>
      </Section>
      <Section title="Promises to pay">
        {data.promises.length === 0 ? <p className="text-sm text-muted">No promises.</p> : (
          <ul className="text-sm">{data.promises.map((p) => <li key={p.id}>{formatMoney(p.amount, p.currency)} on {formatDate(p.promise_date)} · {p.status}</li>)}</ul>
        )}
      </Section>
      <Section title="Payments">
        {data.payments.length === 0 ? <p className="text-sm text-muted">No payments recorded.</p> : (
          <ul className="text-sm">{data.payments.map((p) => <li key={p.id}>{p.external_id ?? p.source} · {formatMoney(p.amount, p.currency)}{p.invoice_external_id ? ` · ${p.invoice_external_id}` : ""}</li>)}</ul>
        )}
      </Section>
      <Section title="Tasks">
        <ul className="mb-3 space-y-1 text-sm">
          {data.tasks.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2">
              <span>{t.title} · {t.status}{t.due_on ? ` · due ${formatDate(t.due_on)}` : ""} · {t.source}</span>
              {t.status === "open" && <Button type="button" variant="secondary" onClick={() => updateTask(t.id, { status: "done" }).then(() => queryClient.invalidateQueries({ queryKey: ["customer", id] })).catch((err) => showToast((err as Error).message, "error"))}>Complete</Button>}
            </li>
          ))}
          {data.tasks.length === 0 && <li className="text-muted">No tasks.</li>}
        </ul>
        <form onSubmit={addTask} className="flex flex-wrap items-end gap-3">
          <Field label="New task" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} required />
          <Field label="Due" type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
          <Button type="submit" disabled={!taskTitle.trim()}>Add</Button>
        </form>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

function SimpleTable({ headers, rows, empty }: { headers: string[]; rows: ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs uppercase text-muted">{headers.map((h) => <th key={h} className="py-2 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>{rows.map((cells, i) => <tr key={i} className="border-t border-line">{cells.map((cell, j) => <td key={j} className="py-2 pr-3">{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
