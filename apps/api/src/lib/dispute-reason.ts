export const DISPUTE_REASONS = ["pricing", "quantity", "quality", "duplicate", "delivery", "tax", "other"] as const;
export type DisputeReasonCode = (typeof DISPUTE_REASONS)[number];

/** Best-effort reason from the customer's own words. A collector can change it. */
export function disputeReasonFromText(text: string): DisputeReasonCode {
  const t = text.toLowerCase();
  if (/duplicat|already paid|paid (this|it|already)|double charg/.test(t)) return "duplicate";
  if (/never (received|got)|not delivered|did not arrive|missing shipment|wasn't delivered|was not delivered/.test(t)) return "delivery";
  if (/quality|defect|damaged|broken|wrong item|not what we ordered/.test(t)) return "quality";
  if (/\btax\b|vat|gst|sales tax/.test(t)) return "tax";
  if (/quantity|qty|too many|short shipped|units/.test(t)) return "quantity";
  if (/pric|overcharg|too much|amount is wrong|incorrect amount|rate/.test(t)) return "pricing";
  return "other";
}
