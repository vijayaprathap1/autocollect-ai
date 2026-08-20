import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, PageHeader, Spinner } from "@/components/ui";
import { getWorkflows, updateWorkflow, type WorkflowDto } from "@/lib/api";
import { useMe } from "@/lib/me";

function stepLabel(delayDays: number): string {
  if (delayDays < 0) return `${Math.abs(delayDays)}d before due`;
  if (delayDays === 0) return "on due date";
  return `${delayDays}d after due`;
}

function WorkflowCard({ workflow, disabled }: { workflow: WorkflowDto; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  async function toggle() {
    setBusy(true);
    try {
      await updateWorkflow(workflow.id, { enabled: !workflow.enabled });
      await queryClient.invalidateQueries({ queryKey: ["workflows"] });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={disabled && !workflow.enabled ? "opacity-70" : ""}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{workflow.name}</h2>
            {workflow.isDefault && <Badge tone="delivered">default</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            {workflow.enabled ? "Active — reminders send on schedule" : "Paused — no reminders will send"}
          </p>
        </div>
        <Button variant={workflow.enabled ? "secondary" : "primary"} onClick={toggle} disabled={busy || disabled}>
          {busy ? "Saving…" : workflow.enabled ? "Pause" : "Enable"}
        </Button>
      </div>

      <ol className="space-y-2">
        {workflow.steps.map((step, i) => (
          <li key={i} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-2 text-sm">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
              {i + 1}
            </span>
            <span className="font-medium">{stepLabel(step.delayDays)}</span>
            <span className="capitalize text-muted">{step.channel}</span>
            {step.templateId ? (
              <span className="ml-auto text-xs text-green-700">template linked</span>
            ) : (
              <span className="ml-auto text-xs text-muted">no template</span>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function Workflows() {
  const me = useMe();
  const { data, isLoading } = useQuery({ queryKey: ["workflows"], queryFn: getWorkflows });

  const unapproved = Boolean(me.tenant?.hasUnapprovedTemplates);

  return (
    <div>
      <PageHeader
        title="Workflows"
        subtitle="Your reminder sequence. Rules decide when things send."
        actions={
          !unapproved ? undefined : (
            <Link to="/templates">
              <Button variant="secondary">Approve templates first</Button>
            </Link>
          )
        }
      />

      {unapproved && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Reminders are gated on approved templates. Nothing sends until you approve them on the Templates page.
        </div>
      )}

      {isLoading ? (
        <Card>
          <Spinner label="Loading workflows…" />
        </Card>
      ) : data && data.workflows.length > 0 ? (
        <div className="grid max-w-3xl gap-6">
          {data.workflows.map((wf) => (
            <WorkflowCard key={wf.id} workflow={wf} disabled={unapproved} />
          ))}
        </div>
      ) : (
        <Card>
          <p className="text-sm text-muted">No workflow yet. One will be created when you sign in.</p>
        </Card>
      )}
    </div>
  );
}