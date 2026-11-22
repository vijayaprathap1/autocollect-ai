import { describe, expect, it } from "vitest";
import { pickStrategy, riskScore } from "./risk.js";
import { disputeReasonFromText } from "./dispute-reason.js";

describe("riskScore", () => {
  it("ranks a long-overdue disputed account above a small current one", () => {
    const quiet = riskScore({ daysOverdue: 0, openCents: 5_000, brokenPromises: 0, openDisputes: 0 });
    const hot = riskScore({ daysOverdue: 45, openCents: 250_000, brokenPromises: 1, openDisputes: 1 });
    expect(hot).toBeGreaterThan(quiet);
    expect(hot).toBeLessThanOrEqual(100);
    expect(quiet).toBeGreaterThanOrEqual(0);
  });
});

describe("pickStrategy", () => {
  const def = { id: "d", enabled: true, isDefault: true, segment: null, minRisk: null, maxRisk: null, priority: 0 };
  const high = { id: "h", enabled: true, isDefault: false, segment: "high_risk", minRisk: 60, maxRisk: null, priority: 10 };

  it("uses the segment strategy only for matching customers", () => {
    expect(pickStrategy([def, high], { segment: "high_risk", risk: 80 }, null)?.id).toBe("h");
    expect(pickStrategy([def, high], { segment: "smb", risk: 80 }, null)?.id).toBe("d");
    expect(pickStrategy([def, high], { segment: "high_risk", risk: 10 }, null)?.id).toBe("d");
  });

  it("keeps an explicit non-default assignment", () => {
    const chosen = { ...def, id: "custom", isDefault: false };
    expect(pickStrategy([def, high, chosen], { segment: "high_risk", risk: 90 }, chosen)?.id).toBe("custom");
  });
});

describe("disputeReasonFromText", () => {
  it("maps common wording", () => {
    expect(disputeReasonFromText("This invoice is a duplicate, we already paid")).toBe("duplicate");
    expect(disputeReasonFromText("The price on this invoice is wrong")).toBe("pricing");
    expect(disputeReasonFromText("We never received the shipment")).toBe("delivery");
    expect(disputeReasonFromText("Please call me")).toBe("other");
  });
});
