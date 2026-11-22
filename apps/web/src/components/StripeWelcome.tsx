import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@/components/ui";
import { ApiClientError, getIntegrations, startReminders } from "@/lib/api";
import { useMe } from "@/lib/me";

/**
 * Shown on the dashboard right after "Continue with Stripe" (?welcome=stripe):
 * how many invoices were imported, whether the import is still running, and a
 * single button that approves the default reminders and turns them on.
 */
export function StripeWelcome() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const active = params.get("welcome") === "stripe";

  const importing = params.get("importing") === "1";
  const integrations = useQuery({
    queryKey: ["integrations"],
    queryFn: getIntegrations,
    enabled: active,
    // While the background import finishes, poll until Stripe reports complete.
    refetchInterval: (q) => {
      const stripe = q.state.data?.integrations.find((i) => i.source === "stripe");
      return importing && !stripe?.importComplete ? 5_000 : false;
    },
  });

  const start = useMutation({
    mutationFn: startReminders,
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err) => setError(err instanceof ApiClientError ? err.message : "Couldn't start reminders. Please try again."),
  });

  if (!active || !me.tenant) return null;

  const imported = Number(params.get("imported") ?? 0);
  const failed = Number(params.get("failed") ?? 0);
  const stripe = integrations.data?.integrations.find((i) => i.source === "stripe");
  const stillImporting = importing && !stripe?.importComplete;
  const running = me.tenant.workflowEnabled && !me.tenant.hasUnapprovedTemplates;

  const dismiss = () => {
    const next = new URLSearchParams(params);
    for (const k of ["welcome", "imported", "failed", "importing"]) next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <Card className="mb-6 border-primary/25 bg-primary/5" role="status">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 className="text-lg font-semibold text-ink">Your Stripe account is connected</h2>
          <p className="mt-1 text-sm text-muted">
            {imported > 0
              ? `We imported ${imported} open invoice${imported === 1 ? "" : "s"}${stillImporting ? " so far — the rest are still importing" : ""}.`
              : stillImporting
                ? "We're importing your open invoices now."
                : "You have no open invoices in Stripe right now. New ones will appear here automatically."}{" "}
            New and paid invoices stay in sync automatically.
          </p>
          {failed > 0 && (
            <p className="mt-1 text-sm text-warning">
              {failed} invoice{failed === 1 ? "" : "s"} couldn't be imported (usually your plan's invoice limit).{" "}
              <Link to="/settings?tab=billing" className="font-medium underline">Upgrade to import the rest</Link>.
            </p>
          )}
          {running ? (
            <p className="mt-3 text-sm font-medium text-success">Reminders are on. AutoCollect will chase overdue invoices for you.</p>
          ) : (
            <p className="mt-3 text-sm text-ink">
              Last step: approve the default 4-step reminder sequence (before due, on the due date, +7 and +14 days).{" "}
              <Link to="/templates" className="text-primary hover:underline">Review the wording</Link> first if you like.
            </p>
          )}
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
          {!running && (
            <Button onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? "Starting…" : "Approve default reminders & start"}
            </Button>
          )}
          <Button variant="secondary" onClick={dismiss}>
            {running ? "Done" : "Later"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
