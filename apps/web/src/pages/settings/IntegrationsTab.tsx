import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, Spinner } from "@/components/ui";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { Alert } from "@/components/auth";
import { useToast } from "@/components/Toast";
import { getIntegrations, importCsv, qboConnect, qboSync, stripeConnect, stripeDisconnect, type CsvImportResult } from "@/lib/api";
import { timeAgo } from "@/lib/format";

function CsvCard() {
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [dateFormat, setDateFormat] = useState<"mdy" | "dmy">("mdy");
  const [result, setResult] = useState<CsvImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await importCsv(file, { dateFormat }));
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const sample =
    "data:text/csv;charset=utf-8," +
    encodeURIComponent("invoice_number,client_name,client_email,amount,due_date,currency\nINV-1001,Acme Ltd,billing@acme.example,1250.00,2026-10-30,usd\n");

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-medium">CSV upload</div>
          <p className="mt-1 text-sm text-muted">
            Import invoices from any accounting tool. Columns are detected automatically; re-uploading updates existing invoices.{" "}
            <a href={sample} download="autocollect-invoices-template.csv" className="text-primary hover:underline">
              Download a template
            </a>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select aria-label="Date format" className="rounded-md border border-slate-300 px-2 py-2 text-xs" value={dateFormat} onChange={(e) => setDateFormat(e.target.value as "mdy" | "dmy")}>
            <option value="mdy">MM/DD/YYYY</option>
            <option value="dmy">DD/MM/YYYY</option>
          </select>
          <input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          <Button variant="secondary" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? "Importing…" : "Choose CSV"}
          </Button>
        </div>
      </div>
      {result && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="font-medium">
            Imported {result.imported} of {result.total} invoices{result.failed > 0 ? ` · ${result.failed} skipped` : ""}
          </div>
          {result.errors.length > 0 && (
            <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted">
              {result.errors.slice(0, 10).map((e) => (
                <li key={e.row}>
                  Row {e.row}: {e.error}
                </li>
              ))}
              {result.errors.length > 10 && <li>…and {result.errors.length - 10} more</li>}
            </ul>
          )}
        </div>
      )}
      {error && <div className="mt-3 text-sm text-danger">{error}</div>}
    </div>
  );
}

export function IntegrationsTab() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { open, close, setLoading, ConfirmDialog } = useConfirmDialog();
  const { data, isLoading } = useQuery({ queryKey: ["integrations"], queryFn: getIntegrations });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stripe = data?.integrations.find((i) => i.source === "stripe" && i.status === "active");
  const qbo = data?.integrations.find((i) => i.source === "qbo");

  async function redirect(key: string, fn: () => Promise<{ url: string }>) {
    setBusy(key);
    setError(null);
    try {
      window.location.assign((await fn()).url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  async function syncQbo() {
    setBusy("qbo-sync");
    try {
      const r = await qboSync();
      showToast(`Synced ${r.synced} invoice${r.synced === 1 ? "" : "s"}${r.mock ? " (demo data)" : ""}`, "success");
      await queryClient.invalidateQueries();
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4">
      <ConfirmDialog />
      {error && <Alert>{error}</Alert>}
      {isLoading && <Spinner label="Loading integrations…" />}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-medium">
              Stripe
              {stripe && <Badge tone="paid">connected</Badge>}
              {data?.stripe.mode === "test" && <Badge tone="overdue">test mode</Badge>}
              {data?.stripe.mode === "mock" && <Badge tone="delivered">demo</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted">
              {stripe
                ? `Account ${stripe.accountId}. Open invoices sync automatically and reminders stop the moment one is paid.`
                : "Import open Stripe invoices and stop reminders automatically when customers pay. Takes 30 seconds."}
            </p>
            {stripe && stripe.importComplete === false && <p className="mt-1 text-xs text-amber-700">Importing existing invoices in the background…</p>}
          </div>
          {stripe ? (
            <Button
              variant="secondary"
              onClick={() =>
                open(
                  "Disconnect Stripe",
                  "New Stripe invoices will stop syncing and payments won't be detected automatically. Existing invoices and history stay.",
                  async () => {
                    setLoading(true);
                    try {
                      await stripeDisconnect();
                      await queryClient.invalidateQueries();
                      showToast("Stripe disconnected", "success");
                    } catch (err) {
                      showToast((err as Error).message, "error");
                    } finally {
                      setLoading(false);
                      close();
                    }
                  },
                  { confirmText: "Disconnect" },
                )
              }
            >
              Disconnect
            </Button>
          ) : (
            <Button onClick={() => redirect("stripe", stripeConnect)} disabled={busy !== null}>
              {busy === "stripe" ? "Redirecting…" : "Connect Stripe"}
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-medium">
              QuickBooks Online
              {qbo && <Badge tone={qbo.status === "active" ? "paid" : "failed"}>{qbo.status === "error" ? "reconnect needed" : qbo.status}</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted">
              {qbo ? `Syncs every 15 minutes${qbo.lastSyncAt ? ` · last sync ${timeAgo(qbo.lastSyncAt)}` : ""}.` : "Pull open invoices from QuickBooks Online automatically."}
            </p>
          </div>
          <div className="flex gap-2">
            {qbo?.status === "active" && (
              <Button variant="secondary" onClick={syncQbo} disabled={busy !== null}>
                {busy === "qbo-sync" ? "Syncing…" : "Sync now"}
              </Button>
            )}
            {(!qbo || qbo.status !== "active") && (
              <Button onClick={() => redirect("qbo", qboConnect)} disabled={busy !== null}>
                {busy === "qbo" ? "Redirecting…" : qbo ? "Reconnect" : "Connect QuickBooks"}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <CsvCard />
      </Card>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-medium">
              SMS reminders <Badge tone={data?.sms.enabled ? "paid" : "delivered"}>{data?.sms.enabled ? "available" : "not configured"}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted">
              {data?.sms.enabled
                ? `Texts are sent from ${data.sms.fromNumber}. Add an SMS step to your workflow.`
                : "SMS isn't enabled on this server yet. Email reminders work without it."}
            </p>
          </div>
          <Link to="/workflows">
            <Button variant="secondary">Open workflows</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
