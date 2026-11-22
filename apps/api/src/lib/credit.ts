export type CreditInput = {
  limitCents: number | null;
  exposureCents: number;
  risk: number;
  brokenPromises: number;
  openDisputes: number;
};

export type CreditStanding = "ok" | "review" | "hold";

/** Decide whether new credit should be extended. A missing limit means no cap. */
export function creditStanding(input: CreditInput): { status: CreditStanding; reason: string | null } {
  if (input.limitCents != null && input.exposureCents > input.limitCents) {
    return { status: "hold", reason: "Open balance is over the credit limit" };
  }
  if (input.risk >= 80 || input.brokenPromises >= 2) {
    return { status: "hold", reason: "Payment behaviour is too weak for more credit" };
  }
  if (input.risk >= 55 || input.openDisputes > 0 || input.brokenPromises > 0) {
    return { status: "review", reason: "A manager should review this account" };
  }
  return { status: "ok", reason: null };
}
