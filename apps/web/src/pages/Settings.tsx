import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, PageHeader, Spinner } from "@/components/ui";
import { getBilling, billingCheckout, getIntegrations, importCsv, qboConnect, qboSync, stripeConnect, getMembers, addMember, updateBranding } from "@/lib/api";
import { useMe } from "@/lib/me";

function CsvCard() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; failed: number; total: number; errors: { row: number; error: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await importCsv(file);
      setResult(res);
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-medium">CSV upload</div>
          <p className="mt-1 text-sm text-muted">
            Upload a spreadsheet of invoices. We auto-detect client, amount, and due-date columns.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button variant="secondary" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? "Importing…" : "Choose CSV"}
          </Button>
        </div>
      </div>

      {result && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="font-medium">
            Imported {result.imported} of {result.total} invoices
            {result.failed > 0 ? ` · ${result.failed} failed` : ""}
          </div>
          {result.errors.length > 0 && (
            <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted">
              {result.errors.slice(0, 10).map((e, i) => (
                <li key={i}>
                  Row {e.row}: {e.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <div className="mt-3 text-sm text-danger">{error}</div>}
    </div>
  );
}

export function Settings() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qboConnecting, setQboConnecting] = useState(false);
  const [qboBusy, setQboBusy] = useState(false);
  const [qboResult, setQboResult] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberMsg, setMemberMsg] = useState<string | null>(null);
  const [branding, setBranding] = useState(me.tenant?.branding ?? {});
  const [brandingBusy, setBrandingBusy] = useState(false);
  const [brandingMsg, setBrandingMsg] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["integrations"],
    queryFn: getIntegrations,
  });

  const { data: billing } = useQuery({ queryKey: ["billing"], queryFn: getBilling });
  const { data: membersData, refetch: refetchMembers } = useQuery({ queryKey: ["members"], queryFn: getMembers });

  const connected = searchParams.get("stripe") === "connected";
  const connectFailed = searchParams.get("stripe") === "error";
  const stripe = data?.integrations.find((i) => i.source === "stripe");
  const qbo = data?.integrations.find((i) => i.source === "qbo");
  const qboConnected = searchParams.get("qbo") === "connected";
  const qboFailed = searchParams.get("qbo") === "error";

  async function connectStripe() {
    setConnecting(true);
    setError(null);
    try {
      const { url } = await stripeConnect();
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Stripe connection");
      setConnecting(false);
    }
  }

  async function connectQbo() {
    setQboConnecting(true);
    setError(null);
    try {
      const { url } = await qboConnect();
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start QuickBooks connection");
      setQboConnecting(false);
    }
  }

  async function syncQbo() {
    setQboBusy(true);
    setQboResult(null);
    try {
      const res = await qboSync();
      setQboResult(`Synced ${res.synced} invoice${res.synced === 1 ? "" : "s"}${res.mock ? " (demo mode)" : ""}.`);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      await queryClient.invalidateQueries({ queryKey: ["integrations"] });
    } catch (err) {
      setQboResult(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setQboBusy(false);
    }
  }

  async function checkoutPlan(plan: string) {
    setUpgrading(true);
    setError(null);
    try {
      const { url } = await billingCheckout(plan);
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start checkout");
      setUpgrading(false);
    }
  }

  async function inviteMember() {
    setMemberBusy(true);
    setMemberMsg(null);
    try {
      await addMember(memberEmail);
      setMemberEmail("");
      setMemberMsg("Invited.");
      await refetchMembers();
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setMemberMsg(err instanceof Error ? err.message : "Failed to invite member");
    } finally {
      setMemberBusy(false);
    }
  }

  async function saveBranding() {
    setBrandingBusy(true);
    setBrandingMsg(null);
    try {
      const res = await updateBranding(branding);
      setBranding(res.branding);
      setBrandingMsg("Saved.");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setBrandingMsg(err instanceof Error ? err.message : "Failed to save branding");
    } finally {
      setBrandingBusy(false);
    }
  }

  const plan = me.tenant?.plan ?? "starter";
  const seatLimit = me.tenant?.seatLimit ?? 0;
  const seatsUsed = me.tenant?.seatsUsed ?? 0;
  const plans = [
    { key: "growth", name: "Growth", price: "$29", desc: "3 seats, unlimited invoices", cta: "Upgrade to Growth" },
    { key: "pro", name: "Pro", price: "$59", desc: "Unlimited seats + reply inbox", cta: "Upgrade to Pro" },
    { key: "agency", name: "Agency", price: "$199", desc: "White-label branding", cta: "Upgrade to Agency" },
  ];

  return (
    <div>
      <PageHeader title="Settings" subtitle="Workspace, members, billing, and integrations." />

      {connected && (
        <div className="mb-6 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Stripe connected. Your invoices will appear automatically.
        </div>
      )}
      {connectFailed && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Stripe connection was not completed. Try again.
        </div>
      )}

      {qboConnected && (
        <div className="mb-6 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          QuickBooks connected. Sync invoices to pull them in.
        </div>
      )}
      {qboFailed && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          QuickBooks connection was not completed. Try again.
        </div>
      )}

      {searchParams.get("billing") === "success" && (
        <div className="mb-6 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          You're on Growth — unlimited invoices, AI drafting, and reply inbox.
        </div>
      )}
      {searchParams.get("billing") === "error" && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Checkout was not completed. Your plan is unchanged.
        </div>
      )}

      <div className="grid max-w-3xl gap-6">
        <Card>
          <h2 className="mb-3 text-lg font-semibold">Organization</h2>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted">Name</dt>
              <dd className="font-medium">{me.tenant?.name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted">Slug</dt>
              <dd className="font-medium">{me.tenant?.slug ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted">Email domain</dt>
              <dd className="font-medium">{me.tenant?.emailDomain ?? "Not configured"}</dd>
            </div>
            <div>
              <dt className="text-muted">Invoices in system</dt>
              <dd className="font-medium">{me.tenant?.invoiceCount ?? 0}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Integrations</h2>
            {isLoading && <Spinner label="Loading…" />}
          </div>

          <div className="flex items-center justify-between rounded-lg border border-slate-200 p-4">
            <div>
              <div className="flex items-center gap-2 font-medium">
                Stripe
                {stripe && <Badge tone={stripe.status === "active" ? "open" : "failed"}>{stripe.status}</Badge>}
              </div>
              <p className="mt-1 text-sm text-muted">
                {stripe
                  ? "Connected. New invoices sync automatically via webhooks."
                  : "Connect your Stripe account to auto-import invoices."}
              </p>
            </div>
            {stripe ? (
              <span className="text-sm font-medium text-green-700">Connected</span>
            ) : (
              <Button onClick={connectStripe} disabled={connecting}>
                {connecting ? "Redirecting…" : "Connect Stripe"}
              </Button>
            )}
          </div>

          <div className="mt-3 rounded-lg border border-slate-200 p-4">
            <div>
              <div className="flex items-center gap-2 font-medium">
                QuickBooks
                {qbo && <Badge tone={qbo.status === "active" ? "open" : "failed"}>{qbo.status}</Badge>}
              </div>
              <p className="mt-1 text-sm text-muted">
                {qbo
                  ? "Connected. Pull invoices from QuickBooks Online on demand."
                  : "Sync invoices from QuickBooks Online (bill-by-mail, no payment links)."}
              </p>
            </div>
            <div className="mt-2 flex items-center gap-2">
              {qbo ? (
                <>
                  <Button variant="secondary" onClick={syncQbo} disabled={qboBusy}>
                    {qboBusy ? "Syncing…" : "Sync now"}
                  </Button>
                  <span className="text-sm font-medium text-green-700">Connected</span>
                </>
              ) : (
                <Button onClick={connectQbo} disabled={qboConnecting}>
                  {qboConnecting ? "Redirecting…" : "Connect QuickBooks"}
                </Button>
              )}
            </div>
            {qboResult && <div className="mt-3 text-sm text-muted">{qboResult}</div>}
          </div>

          <div className="mt-3 rounded-lg border border-slate-200 p-4">
            <div>
              <div className="flex items-center gap-2 font-medium">
                SMS reminders
                <Badge tone={data?.sms.enabled ? "open" : "delivered"}>
                  {data?.sms.mock ? "demo mode" : "connected"}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted">
                {data?.sms.mock
                  ? "Twilio not configured — SMS sends are recorded as demo messages. Add an SMS step to any workflow."
                  : `Sending from ${data?.sms.fromNumber ?? "configured number"} via Twilio.`}
              </p>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Link to="/workflows">
                <Button variant="secondary">Open workflows</Button>
              </Link>
            </div>
          </div>
          <CsvCard />

          {error && <div className="mt-3 text-sm text-danger">{error}</div>}
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Members</h2>
            <span className="text-sm text-muted">
              {seatsUsed}{seatLimit > 0 ? ` / ${seatLimit}` : ""} seats
            </span>
          </div>
          <ul className="divide-y divide-slate-100">
            {(membersData?.members ?? []).map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <div className="font-medium">{m.email ?? m.id}</div>
                  <div className="text-xs text-muted">{m.role}</div>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <input
              value={memberEmail}
              onChange={(e) => setMemberEmail(e.target.value)}
              placeholder="teammate@company.com"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <Button onClick={inviteMember} disabled={memberBusy || !memberEmail.trim()}>
              {memberBusy ? "Adding…" : "Invite"}
            </Button>
          </div>
          {memberMsg && <div className="mt-2 text-sm text-muted">{memberMsg}</div>}
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Branding</h2>
            <Badge tone={plan === "agency" ? "open" : "delivered"}>{plan}</Badge>
          </div>
          <div className="grid gap-3 text-sm">
            <label className="block">
              <span className="text-muted">App name</span>
              <input
                value={branding.appName ?? ""}
                onChange={(e) => setBranding({ ...branding, appName: e.target.value })}
                placeholder="AutoCollect AI"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="text-muted">Logo URL</span>
              <input
                value={branding.logoUrl ?? ""}
                onChange={(e) => setBranding({ ...branding, logoUrl: e.target.value })}
                placeholder="https://example.com/logo.png"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="text-muted">Primary color</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  value={branding.primaryColor ?? ""}
                  onChange={(e) => setBranding({ ...branding, primaryColor: e.target.value })}
                  placeholder="#2563EB"
                  className="w-full rounded-md border border-slate-300 px-3 py-2"
                />
                <input
                  type="color"
                  value={branding.primaryColor ?? "#2563EB"}
                  onChange={(e) => setBranding({ ...branding, primaryColor: e.target.value })}
                  className="h-9 w-9 rounded border border-slate-300"
                />
              </div>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={branding.hideBranding ?? false}
                disabled={plan !== "agency"}
                onChange={(e) => setBranding({ ...branding, hideBranding: e.target.checked })}
              />
              <span>Hide “AutoCollect AI” branding {plan !== "agency" && <span className="text-muted">(Agency plan)</span>}</span>
            </label>
            <div>
              <Button onClick={saveBranding} disabled={brandingBusy}>
                {brandingBusy ? "Saving…" : "Save branding"}
              </Button>
            </div>
          </div>
          {brandingMsg && <div className="mt-2 text-sm text-muted">{brandingMsg}</div>}
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Billing</h2>
            <Badge tone={billing?.plan === "starter" ? "delivered" : "open"}>{billing?.plan ?? "—"}</Badge>
          </div>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted">Plan</dt>
              <dd className="font-medium capitalize">{billing?.plan ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted">Invoice usage</dt>
              <dd className="font-medium">
                {billing ? `${billing.invoicesUsed}${billing.invoiceLimit ? ` / ${billing.invoiceLimit}` : ""}` : "—"}
              </dd>
            </div>
          </dl>
          <div className="mt-4 space-y-3">
            {plans.map((p) => (
              <div key={p.key} className="flex items-center justify-between rounded-lg border border-slate-200 p-4">
                <div>
                  <div className="font-medium">
                    {p.name} <span className="text-muted">· {p.price}/mo</span>
                  </div>
                  <p className="mt-1 text-sm text-muted">{p.desc}</p>
                </div>
                {billing?.plan === p.key ? (
                  <span className="text-sm font-medium text-green-700">Current plan</span>
                ) : (
                  <Button onClick={() => checkoutPlan(p.key)} disabled={upgrading}>
                    {upgrading ? "Starting checkout…" : p.cta}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}