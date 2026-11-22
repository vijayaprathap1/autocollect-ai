import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { decideCreditReview, getCredit, getCreditReviews, setCredit } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useMe } from "@/lib/me";

export function Credit() {
  const me = useMe();
  const currency = me.tenant?.currency ?? "usd";
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const credit = useQuery({ queryKey: ["credit"], queryFn: getCredit });
  const reviews = useQuery({ queryKey: ["credit-reviews"], queryFn: getCreditReviews });
  const [limits, setLimits] = useState<Record<string, string>>({});
  const canReview = me.user.role === "owner" || me.user.role === "admin" || me.user.role === "manager";

  async function decide(id: string, creditStatus: "ok" | "hold" | "review") {
    try {
      await setCredit(id, { creditStatus, holdReason: creditStatus === "ok" ? null : "Set from the credit desk" });
      await queryClient.invalidateQueries({ queryKey: ["credit"] });
      showToast("Credit decision saved", "success");
    } catch (err) {
      showToast((err as Error).message, "error");
    }
  }

  const rows = credit.data?.customers ?? [];
  return (
    <div>
      <PageHeader title="Credit" subtitle="A hold stops automatic reminders and new payment links for that customer. Existing Stripe links still work, and approving the account lets the next reminder run continue. Stripe remains the only way to take payment." />
      {credit.isError ? <EmptyState title="Credit could not load" description={(credit.error as Error).message} /> : credit.isLoading ? <Card><Spinner label="Loading credit…" /></Card> : rows.length === 0 ? (
        <EmptyState title="No customers" description="Credit profiles appear with your customers." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3">Customer</th><th className="px-4 py-3">Exposure</th><th className="px-4 py-3">Limit</th><th className="px-4 py-3">Risk</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Recommendation</th><th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line">
                  <td className="px-4 py-3">{row.name}</td>
                  <td className="px-4 py-3">{formatMoney(row.exposure, currency)}</td>
                  <td className="px-4 py-3">
                    {canReview ? (
                      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const raw = limits[row.id]; const creditLimit = raw === "" || raw == null ? null : Math.round(Number(raw) * 100); setCredit(row.id, { creditLimit: Number.isFinite(creditLimit as number) ? creditLimit : null }).then(() => { showToast("Limit saved", "success"); void queryClient.invalidateQueries({ queryKey: ["credit"] }); }).catch((err) => showToast((err as Error).message, "error")); }}>
                        <input aria-label={`Credit limit for ${row.name ?? "customer"}`} className="w-28 rounded-lg border border-line bg-bg px-2 py-1 text-sm" placeholder={row.creditLimit == null ? "No limit" : String(row.creditLimit / 100)} value={limits[row.id] ?? ""} onChange={(e) => setLimits((cur) => ({ ...cur, [row.id]: e.target.value }))} />
                        <Button type="submit" variant="secondary">Save</Button>
                      </form>
                    ) : row.creditLimit == null ? "None" : formatMoney(row.creditLimit, currency)}
                  </td>
                  <td className="px-4 py-3">{row.riskScore}</td>
                  <td className="px-4 py-3">{row.creditStatus}</td>
                  <td className="px-4 py-3">{row.recommended}{row.reason ? ` · ${row.reason}` : ""}</td>
                  <td className="px-4 py-3 text-right">
                    {canReview && (
                      <span className="flex justify-end gap-2">
                        <Button type="button" variant="secondary" onClick={() => void decide(row.id, "ok")}>Approve</Button>
                        <Button type="button" variant="danger" onClick={() => void decide(row.id, "hold")}>Hold</Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <Card className="mt-6">
        <h2 className="mb-3 text-lg font-semibold">Review queue</h2>
        {(reviews.data?.reviews ?? []).filter((r) => r.status === "open").length === 0 ? <p className="text-sm text-muted">No open reviews.</p> : (
          <ul className="space-y-3 text-sm">
            {reviews.data?.reviews.filter((r) => r.status === "open").map((review) => (
              <li key={review.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>{review.customer_name ?? "Customer"} · {review.notes ?? review.status}</span>
                {canReview && (
                  <span className="flex gap-2">
                    <Button type="button" variant="secondary" onClick={() => decideCreditReview(review.id, { status: "approved" }).then(() => { void queryClient.invalidateQueries({ queryKey: ["credit"] }); void reviews.refetch(); })}>Approve</Button>
                    <Button type="button" variant="danger" onClick={() => decideCreditReview(review.id, { status: "held" }).then(() => { void queryClient.invalidateQueries({ queryKey: ["credit"] }); void reviews.refetch(); })}>Hold</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
