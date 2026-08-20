import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, PageHeader, Spinner } from "@/components/ui";
import { draftTemplates, getTemplates, updateTemplate, type TemplateDto } from "@/lib/api";

function TemplateRow({ template }: { template: TemplateDto }) {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const dirty = subject !== template.subject || body !== template.body;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateTemplate(template.id, { subject, body });
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function approve() {
    setSaving(true);
    setError(null);
    try {
      await updateTemplate(template.id, { subject, body, approved: true });
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium capitalize">{template.stepKey.replace(/_/g, " ")}</span>
          <Badge tone={template.approved ? "paid" : "paused"}>{template.approved ? "approved" : "pending"}</Badge>
        </div>
        {template.approved ? null : (
          <Button onClick={approve} disabled={saving}>
            Approve & enable
          </Button>
        )}
      </div>

      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Subject</label>
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        className="mb-3 w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
      />

      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Body</label>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        className="w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
      />

      <div className="mt-3 flex items-center gap-3">
        <Button variant="secondary" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save edits"}
        </Button>
        {saved && <span className="text-sm text-green-700">Saved</span>}
        {error && <span className="text-sm text-danger">{error}</span>}
      </div>
    </Card>
  );
}

export function Templates() {
  const queryClient = useQueryClient();
  const [drafting, setDrafting] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ["templates"], queryFn: getTemplates });

  async function generate() {
    setDrafting(true);
    try {
      await draftTemplates();
      await queryClient.invalidateQueries({ queryKey: ["templates"] });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } finally {
      setDrafting(false);
    }
  }

  const headerActions = (
    <Button variant="secondary" onClick={generate} disabled={drafting}>
      {drafting ? "Drafting…" : "Generate with AI"}
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Templates"
        subtitle="Review and approve your reminders. Nothing sends until you approve."
        actions={headerActions}
      />
      {isLoading ? (
        <Card>
          <Spinner label="Loading templates…" />
        </Card>
      ) : data && data.templates.length > 0 ? (
        <div className="grid max-w-3xl gap-6">
          {data.templates.map((t) => (
            <TemplateRow key={t.id} template={t} />
          ))}
        </div>
      ) : (
        <Card>
          <p className="text-sm text-muted">
            No templates yet. Hit “Generate with AI” to draft your sequence.
          </p>
        </Card>
      )}
    </div>
  );
}