import { Link, useParams } from "react-router-dom";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, PageHeader, Spinner } from "@/components/ui";
import { Field } from "@/components/auth";
import { useToast } from "@/components/Toast";
import { addDisputeNote, getDispute, updateDispute } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";

const STATUSES = ["open", "investigating", "pending_customer", "resolved", "rejected"];

export function DisputeDetail() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const dispute = useQuery({ queryKey: ["dispute", id], queryFn: () => getDispute(id), enabled: Boolean(id) });
  const [note, setNote] = useState("");
  const [resolution, setResolution] = useState("");

  if (dispute.isLoading) return <Card><Spinner label="Loading dispute…" /></Card>;
  if (!dispute.data) return <Card>Dispute not found.</Card>;
  const d = dispute.data.dispute;

  async function setStatus(status: string) {
    try {
      await updateDispute(id, { status, resolution: resolution || undefined });
      await queryClient.invalidateQueries({ queryKey: ["dispute", id] });
      showToast("Dispute updated", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    }
  }

  async function saveNote(e: FormEvent) {
    e.preventDefault();
    try {
      await addDisputeNote(id, note.trim());
      setNote("");
      await queryClient.invalidateQueries({ queryKey: ["dispute", id] });
    } catch (err) {
      showToast((err as Error).message, "error");
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title={`${d.reason_code} dispute`}
        subtitle={d.summary ?? "No summary"}
        actions={<Link to="/disputes" className="text-sm font-medium text-primary hover:underline">All disputes</Link>}
      />
      <Card className="grid gap-3 text-sm">
        <div>Status: <strong>{d.status}</strong></div>
        <div>
          {d.customer_id && <Link className="text-primary hover:underline" to={`/customers/${d.customer_id}`}>{d.customer_name ?? "Customer"}</Link>}
          {d.invoice_id && <> · <Link className="text-primary hover:underline" to={`/invoices/${d.invoice_id}`}>{d.external_id ?? "Invoice"}</Link></>}
          {d.amount_due != null && <> · {formatMoney(d.amount_due, d.currency ?? "usd")}</>}
        </div>
        {d.resolution && <div>Resolution: {d.resolution}</div>}
        <Field label="Resolution note" value={resolution} onChange={(e) => setResolution(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((s) => (
            <Button key={s} type="button" variant={s === d.status ? "primary" : "secondary"} onClick={() => void setStatus(s)}>{s.replace("_", " ")}</Button>
          ))}
        </div>
      </Card>
      <Card>
        <h2 className="mb-3 text-lg font-semibold">Notes</h2>
        <ul className="mb-4 space-y-2 text-sm">
          {dispute.data.notes.map((n) => (
            <li key={n.id}><span className="text-muted">{formatDate(n.created_at)} · {n.display_name || n.email || "Someone"}</span> — {n.body}</li>
          ))}
          {dispute.data.notes.length === 0 && <li className="text-muted">No notes yet.</li>}
        </ul>
        <form onSubmit={saveNote} className="flex flex-wrap items-end gap-3">
          <Field label="Add a note" value={note} onChange={(e) => setNote(e.target.value)} required />
          <Button type="submit" disabled={!note.trim()}>Save note</Button>
        </form>
      </Card>
    </div>
  );
}
