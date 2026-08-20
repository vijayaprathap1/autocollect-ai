import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, PageHeader, Spinner } from "@/components/ui";
import { getReplies, replyAction, type ReplyInboxItem } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useMe } from "@/lib/me";

function ReplyCard({ reply }: { reply: ReplyInboxItem }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState(reply.suggestedBody ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "send" | "regenerate" | "resolve", sendBody?: string) {
    setBusy(action);
    setError(null);
    try {
      const res = await replyAction(reply.id, action, action === "send" ? sendBody : undefined);
      if (action === "regenerate" && res.suggestedBody !== undefined) setBody(res.suggestedBody ?? "");
      await queryClient.invalidateQueries({ queryKey: ["replies"] });
      await queryClient.invalidateQueries({ queryKey: ["activity"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <Badge tone={reply.classification}>{reply.classification}</Badge>
          <span className="font-medium">{reply.customerName ?? "Client"}</span>
          {reply.invoiceNumber ? <span className="text-xs text-muted">#{reply.invoiceNumber}</span> : null}
        </span>
        <span className="text-xs text-muted">{timeAgo(reply.createdAt)}</span>
      </div>

      <blockquote className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-muted">
        {reply.content}
      </blockquote>

      <div className="mt-3">
        <div className="mb-1 text-xs font-medium text-muted">Suggested reply</div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          placeholder={reply.suggestedBody ? "" : "No suggestion — write a reply or regenerate."}
        />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button onClick={() => void act("send", body)} disabled={busy !== null || !body.trim()}>
          {busy === "send" ? "Sending…" : "Send reply"}
        </Button>
        <Button variant="secondary" onClick={() => void act("regenerate")} disabled={busy !== null}>
          {busy === "regenerate" ? "Drafting…" : "Regenerate"}
        </Button>
        <Button variant="secondary" onClick={() => void act("resolve")} disabled={busy !== null}>
          Mark done
        </Button>
      </div>
      {error && <div className="mt-2 text-sm text-danger">{error}</div>}
    </div>
  );
}

export function Replies() {
  const me = useMe();
  const { data, isLoading } = useQuery({ queryKey: ["replies"], queryFn: getReplies });

  if (!me.tenant?.invoiceCount) {
    return (
      <div>
        <PageHeader title="Replies" subtitle="Customer replies with AI-drafted responses, ready for your approval." />
        <Card>
          <p className="text-sm text-muted">Replies appear here when customers respond to your reminders.</p>
        </Card>
      </div>
    );
  }

  const open = data?.replies.filter((r) => !r.resolved) ?? [];
  const done = data?.replies.filter((r) => r.resolved) ?? [];

  return (
    <div>
      <PageHeader
        title="Replies"
        subtitle="Customer replies with AI-drafted responses, ready for your approval."
      />

      {isLoading ? (
        <Card>
          <Spinner label="Loading replies…" />
        </Card>
      ) : (
        <div className="grid max-w-3xl gap-6">
          <Card>
            <h2 className="mb-3 text-lg font-semibold">Inbox ({open.length})</h2>
            {open.length === 0 ? (
              <p className="text-sm text-muted">No open replies. Inbound customer messages land here.</p>
            ) : (
              <div className="space-y-4">
                {open.map((r) => (
                  <ReplyCard key={r.id} reply={r} />
                ))}
              </div>
            )}
          </Card>

          {done.length > 0 && (
            <Card>
              <h2 className="mb-3 text-lg font-semibold">Resolved</h2>
              <ul className="space-y-3">
                {done.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      <Badge tone={r.classification}>{r.classification}</Badge>
                      <span className="text-muted">
                        {r.customerName ?? "Client"}
                        {r.invoiceNumber ? ` · #${r.invoiceNumber}` : ""}
                      </span>
                    </span>
                    <span className="text-xs text-muted">{timeAgo(r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}