import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, PageHeader, Spinner } from "@/components/ui";
import { Alert } from "@/components/auth";
import { useToast } from "@/components/Toast";
import { getTemplates, getWorkflows, updateWorkflow, type TemplateDto, type WorkflowDto, type WorkflowStepDto } from "@/lib/api";
import { useMe } from "@/lib/me";

function stepLabel(delayDays: number): string {
  if (delayDays < 0) return `${Math.abs(delayDays)} day${delayDays === -1 ? "" : "s"} before due`;
  if (delayDays === 0) return "On the due date";
  return `${delayDays} day${delayDays === 1 ? "" : "s"} after due`;
}

function templateName(t: TemplateDto | undefined): string {
  if (!t) return "Missing template";
  return t.subject.length > 50 ? `${t.subject.slice(0, 50)}…` : t.subject;
}

function StepEditor({
  workflow,
  templates,
  smsAvailable,
  onDone,
}: {
  workflow: WorkflowDto;
  templates: TemplateDto[];
  smsAvailable: boolean;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [steps, setSteps] = useState<WorkflowStepDto[]>(workflow.steps.map((s) => ({ ...s })));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const update = (i: number, patch: Partial<WorkflowStepDto>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateWorkflow(workflow.id, { steps: steps.map((s, i) => ({ ...s, order: i })) });
      await queryClient.invalidateQueries({ queryKey: ["workflows"] });
      showToast("Sequence saved", "success");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      {steps.map((step, i) => (
        <div key={i} className="grid gap-2 rounded-lg border border-slate-200 p-3 text-sm sm:grid-cols-[110px_110px_1fr_auto] sm:items-center">
          <label className="flex items-center gap-2">
            <input
              type="number"
              className="w-16 rounded-md border border-slate-300 px-2 py-1"
              value={step.delayDays}
              min={-60}
              max={365}
              onChange={(e) => update(i, { delayDays: Number(e.target.value) })}
              aria-label="Days relative to due date"
            />
            <span className="text-xs text-muted">days</span>
          </label>
          <select className="rounded-md border border-slate-300 px-2 py-1" value={step.channel} onChange={(e) => update(i, { channel: e.target.value })} aria-label="Channel">
            <option value="email">Email</option>
            {(smsAvailable || step.channel === "sms") && <option value="sms">SMS</option>}
          </select>
          <select className="min-w-0 rounded-md border border-slate-300 px-2 py-1" value={step.templateId ?? ""} onChange={(e) => update(i, { templateId: e.target.value || null })} aria-label="Template">
            <option value="">Choose a template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {templateName(t)}
                {t.approved ? "" : " (not approved)"}
              </option>
            ))}
          </select>
          <button className="text-xs text-red-600 hover:underline" onClick={() => setSteps((s) => s.filter((_, j) => j !== i))} disabled={steps.length <= 1}>
            Remove
          </button>
          <p className="text-xs text-muted sm:col-span-4">{stepLabel(step.delayDays)} (negative = before the due date)</p>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={steps.length >= 20}
          onClick={() => setSteps((s) => [...s, { order: s.length, delayDays: (s.at(-1)?.delayDays ?? 0) + 7, channel: "email", templateId: s.at(-1)?.templateId ?? null }])}
        >
          Add step
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save sequence"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted">Steps are sent in timing order, at your workspace's send hour, and never less than a day apart.</p>
    </div>
  );
}

function WorkflowCard({ workflow, templates, smsAvailable, canEdit, gated }: { workflow: WorkflowDto; templates: TemplateDto[]; smsAvailable: boolean; canEdit: boolean; gated: boolean }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const byId = new Map(templates.map((t) => [t.id, t]));

  async function toggle() {
    setBusy(true);
    try {
      await updateWorkflow(workflow.id, { enabled: !workflow.enabled });
      await queryClient.invalidateQueries({ queryKey: ["workflows"] });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      showToast(workflow.enabled ? "Reminders paused" : "Reminders are live", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{workflow.name}</h2>
            {workflow.isDefault && <Badge tone="delivered">default</Badge>}
            <Badge tone={workflow.enabled ? "paid" : "paused"}>{workflow.enabled ? "active" : "paused"}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">{workflow.enabled ? "Reminders send automatically on schedule." : "No reminders will send until you enable this."}</p>
        </div>
        {canEdit && !editing && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit steps
            </Button>
            <Button variant={workflow.enabled ? "secondary" : "primary"} onClick={toggle} disabled={busy || (gated && !workflow.enabled)}>
              {busy ? "Saving…" : workflow.enabled ? "Pause" : "Enable"}
            </Button>
          </div>
        )}
      </div>

      {editing ? (
        <StepEditor workflow={workflow} templates={templates} smsAvailable={smsAvailable} onDone={() => setEditing(false)} />
      ) : (
        <ol className="space-y-2">
          {workflow.steps.map((step, i) => {
            const t = step.templateId ? byId.get(step.templateId) : undefined;
            return (
              <li key={i} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-2 text-sm">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">{i + 1}</span>
                <span className="font-medium">{stepLabel(step.delayDays)}</span>
                <span className="uppercase text-xs text-muted">{step.channel}</span>
                <span className="min-w-0 truncate text-muted">{templateName(t)}</span>
                <span className={`ml-auto text-xs ${t?.approved ? "text-green-700" : "text-amber-700"}`}>{t?.approved ? "approved" : "needs approval"}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

export function Workflows() {
  const me = useMe();
  const canEdit = me.user.role === "owner" || me.user.role === "admin";
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: getWorkflows });
  const templates = useQuery({ queryKey: ["templates"], queryFn: getTemplates });
  const unapproved = Boolean(me.tenant?.hasUnapprovedTemplates);

  return (
    <div>
      <PageHeader
        title="Workflows"
        subtitle="When and how customers are reminded. Payment stops the sequence automatically."
        actions={
          unapproved ? (
            <Link to="/templates">
              <Button variant="secondary">Approve templates</Button>
            </Link>
          ) : undefined
        }
      />
      {unapproved && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Nothing is sent until you approve your templates — you stay in control of every word your customers see.
        </div>
      )}
      {workflows.isLoading || templates.isLoading ? (
        <Card>
          <Spinner label="Loading workflows…" />
        </Card>
      ) : workflows.data && workflows.data.workflows.length > 0 ? (
        <div className="grid max-w-3xl gap-6">
          {workflows.data.workflows.map((wf) => (
            <WorkflowCard
              key={wf.id}
              workflow={wf}
              templates={templates.data?.templates ?? []}
              smsAvailable={workflows.data!.smsAvailable}
              canEdit={canEdit}
              gated={unapproved}
            />
          ))}
        </div>
      ) : (
        <Card>
          <p className="text-sm text-muted">No workflow yet.</p>
        </Card>
      )}
    </div>
  );
}
