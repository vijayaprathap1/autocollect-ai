import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card } from "@/components/ui";
import { Alert, Field } from "@/components/auth";
import { useToast } from "@/components/Toast";
import { useMe } from "@/lib/me";
import { updateBranding } from "@/lib/api";

export function BrandingTab() {
  const me = useMe();
  const plan = me.tenant!.plan;
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const initial = me.tenant!.branding ?? {};
  const [appName, setAppName] = useState(initial.appName ?? "");
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl ?? "");
  const [primaryColor, setPrimaryColor] = useState(initial.primaryColor ?? "");
  const [hideBranding, setHideBranding] = useState(initial.hideBranding ?? false);
  const [businessAddress, setBusinessAddress] = useState(initial.businessAddress ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateBranding({ appName, logoUrl, primaryColor, businessAddress, ...(plan === "agency" ? { hideBranding } : {}) });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      showToast("Branding saved", "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Branding</h2>
        <Badge tone={plan === "agency" ? "paid" : "delivered"}>{plan}</Badge>
      </div>
      <div className="grid gap-4">
        {error && <Alert>{error}</Alert>}
        <Field label="App name" value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="AutoCollect AI" maxLength={60} hint="Shown in the sidebar for your team." />
        <Field label="Logo URL" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://example.com/logo.png" hint="HTTPS image, about 28px tall." />
        <div>
          <label className="mb-1 block text-sm font-medium">Primary color</label>
          <div className="flex items-center gap-2">
            <input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} placeholder="#2563EB" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input type="color" aria-label="Pick color" value={/^#[0-9a-f]{6}$/i.test(primaryColor) ? primaryColor : "#2563eb"} onChange={(e) => setPrimaryColor(e.target.value)} className="h-9 w-9 rounded border border-slate-300" />
          </div>
        </div>
        <Field
          label="Business address"
          value={businessAddress}
          onChange={(e) => setBusinessAddress(e.target.value)}
          placeholder="123 Main St, Springfield, IL 62701, USA"
          maxLength={300}
          hint="Shown in the footer of reminder emails so customers know who is contacting them."
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hideBranding} disabled={plan !== "agency"} onChange={(e) => setHideBranding(e.target.checked)} />
          <span>
            Remove “Sent with AutoCollect AI” from customer emails {plan !== "agency" && <span className="text-muted">(Agency plan)</span>}
          </span>
        </label>
        <div>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save branding"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
