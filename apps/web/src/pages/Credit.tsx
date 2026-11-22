import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { getCredit, setCredit } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useMe } from "@/lib/me";

export function Credit() {
  const me = useMe();
  const currency = me.tenant?.currency ?? "usd";
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const credit = useQuery({ queryKey: ["credit"], queryFn: getCredit });
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
      <PageHeader title="Credit" subtitle="Limits, risk from payment behaviour, and a review queue. A hold stops new credit; it does not take a payment method other than Stripe." />
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
                  <td className="px-4 py-3">{row.creditLimit == null ? "None" : formatMoney(row.creditLimit, currency)}</td>
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
    </div>
  );
}
