/** 0–100 collector priority. Not a credit score: it ranks who to call first. */
export function riskScore(input: {
  daysOverdue: number;
  openCents: number;
  brokenPromises: number;
  openDisputes: number;
}): number {
  const days = Math.max(0, input.daysOverdue);
  const amount = Math.min(Math.max(0, input.openCents) / 10_000, 40);
  const raw = days * 1.2 + amount + Math.max(0, input.brokenPromises) * 12 + Math.max(0, input.openDisputes) * 8;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export type StrategyCandidate = {
  id: string;
  enabled: boolean;
  isDefault: boolean;
  segment: string | null;
  minRisk: number | null;
  maxRisk: number | null;
  priority: number;
};

/**
 * Pick the reminder sequence for a customer.
 * An explicit non-default assignment wins. Otherwise the most specific enabled
 * strategy whose segment and risk band match, then the default sequence.
 */
export function pickStrategy<T extends StrategyCandidate>(
  workflows: T[],
  customer: { segment: string | null; risk: number },
  explicit: T | null,
): T | null {
  if (explicit && explicit.enabled && !explicit.isDefault) return explicit;
  const matching = workflows.filter((w) => {
    if (!w.enabled) return false;
    if (w.segment && w.segment !== customer.segment) return false;
    if (w.minRisk != null && customer.risk < w.minRisk) return false;
    if (w.maxRisk != null && customer.risk > w.maxRisk) return false;
    return true;
  });
  matching.sort((a, b) => {
    const spec = (w: StrategyCandidate) => (w.segment ? 2 : 0) + (w.minRisk != null || w.maxRisk != null ? 1 : 0);
    return spec(b) - spec(a) || b.priority - a.priority || (a.isDefault ? 1 : 0) - (b.isDefault ? 1 : 0);
  });
  return matching[0] ?? explicit ?? null;
}
