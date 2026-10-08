import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@/components/ui";
import { Alert, Field } from "@/components/auth";
import { useToast } from "@/components/Toast";
import { useMe } from "@/lib/me";
import { updateOrganization, type OrganizationSettings } from "@/lib/api";

const COMMON_CURRENCIES = ["usd", "eur", "gbp", "inr", "cad", "aud", "nzd", "sgd", "aed", "chf", "jpy", "zar"];

function timeZones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const all = intl.supportedValuesOf?.("timeZone");
    if (all?.length) return ["UTC", ...all.filter((z) => z !== "UTC")];
  } catch {
    /* older browsers */
  }
  return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];
}

const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });

export function WorkspaceTab() {
  const me = useMe();
  const t = me.tenant!;
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const canEdit = me.user.role === "owner" || me.user.role === "admin";
  const zones = useMemo(timeZones, []);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [form, setForm] = useState<Required<OrganizationSettings>>({
    name: t.name,
    tone: t.tone,
    currency: t.currency,
    timezone: t.timezone,
    sendHour: t.sendHour,
    skipWeekends: t.skipWeekends,
    replyNotifications: t.replyNotifications,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await updateOrganization(form);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      showToast("Workspace settings saved", "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-6">
      {error && <Alert>{error}</Alert>}
      <Card>
        <h2 className="text-lg font-semibold">Company</h2>
        <p className="mb-4 text-sm text-muted">Shown to your customers as the sender of reminders.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company name" value={form.name} onChange={(e) => set("name", e.target.value)} disabled={!canEdit} required maxLength={120} />
          <div>
            <label className="mb-1 block text-sm font-medium">Default currency</label>
            <select
              className="w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm"
              value={form.currency}
              onChange={(e) => set("currency", e.target.value)}
              disabled={!canEdit}
            >
              {[...new Set([form.currency, ...COMMON_CURRENCIES])].map((c) => (
                <option key={c} value={c}>
                  {c.toUpperCase()}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted">Used for CSV imports without a currency column.</p>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Reminder delivery</h2>
        <p className="mb-4 text-sm text-muted">Reminders arrive during your customers' working day, not at midnight.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Time zone</label>
            <select className="w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm" value={form.timezone} onChange={(e) => set("timezone", e.target.value)} disabled={!canEdit}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            {canEdit && browserZone && browserZone !== form.timezone && (
              <button type="button" className="mt-1 text-xs text-primary hover:underline" onClick={() => set("timezone", browserZone)}>
                Use my time zone ({browserZone})
              </button>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Send reminders at</label>
            <select className="w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm" value={form.sendHour} onChange={(e) => set("sendHour", Number(e.target.value))} disabled={!canEdit}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Tone</label>
            <select className="w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm" value={form.tone} onChange={(e) => set("tone", e.target.value as typeof form.tone)} disabled={!canEdit}>
              <option value="friendly">Friendly</option>
              <option value="professional">Professional</option>
              <option value="firm">Firm</option>
            </select>
            <p className="mt-1 text-xs text-muted">Used when AI drafts your templates.</p>
          </div>
          <div className="space-y-3 pt-6">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.skipWeekends} onChange={(e) => set("skipWeekends", e.target.checked)} disabled={!canEdit} />
              <span>
                Skip weekends
                <span className="block text-xs text-muted">Pre-due reminders move to Friday, overdue ones to Monday.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.replyNotifications} onChange={(e) => set("replyNotifications", e.target.checked)} disabled={!canEdit} />
              <span>
                Email admins when a customer replies
                <span className="block text-xs text-muted">Disputes, promises to pay and questions.</span>
              </span>
            </label>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-semibold">Plan & usage</h2>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted">Plan</dt>
            <dd className="font-medium">{t.planName}</dd>
          </div>
          <div>
            <dt className="text-muted">Reminder credits</dt>
            <dd className="font-medium">
              {t.creditBalance} <span className="text-muted">/ {t.creditsPerMonth} mo</span>
            </dd>
          </div>
          <div>
            <dt className="text-muted">Invoices</dt>
            <dd className="font-medium">{t.invoiceCount}</dd>
          </div>
          <div>
            <dt className="text-muted">Seats</dt>
            <dd className="font-medium">
              {t.seatsUsed}
              {t.seatLimit ? ` / ${t.seatLimit}` : ""}
            </dd>
          </div>
        </dl>
      </Card>

      {canEdit && (
        <div>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </form>
  );
}
