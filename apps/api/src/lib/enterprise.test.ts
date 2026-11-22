import { describe, expect, it } from "vitest";
import { suggestApplications } from "./cash-match.js";
import { creditStanding } from "./credit.js";
import { forecastCollections } from "./forecast.js";

describe("cash matching", () => {
  const invoices = [
    { id: "a", customerId: "c", amountDue: 5000, dueDate: "2026-01-01", externalId: "1" },
    { id: "b", customerId: "c", amountDue: 3000, dueDate: "2026-02-01", externalId: "2" },
    { id: "other", customerId: "z", amountDue: 5000, dueDate: "2026-01-01", externalId: "3" },
  ];

  it("matches an exact amount on the same customer", () => {
    const lines = suggestApplications(5000, "c", invoices);
    expect(lines).toEqual([expect.objectContaining({ invoiceId: "a", method: "exact", amount: 5000 })]);
  });

  it("splits a receipt across two invoices when the sum matches", () => {
    const lines = suggestApplications(8000, "c", invoices);
    expect(lines.map((l) => l.invoiceId).sort()).toEqual(["a", "b"]);
    expect(lines.every((l) => l.method === "multi")).toBe(true);
  });

  it("applies a smaller receipt to the oldest invoice as a partial", () => {
    const lines = suggestApplications(2000, "c", invoices);
    expect(lines[0]).toMatchObject({ invoiceId: "a", amount: 2000, method: "partial" });
  });
});

describe("credit standing", () => {
  it("holds an account over its limit", () => {
    expect(creditStanding({ limitCents: 1000, exposureCents: 1500, risk: 10, brokenPromises: 0, openDisputes: 0 }).status).toBe("hold");
  });

  it("asks for review when a dispute is open", () => {
    expect(creditStanding({ limitCents: null, exposureCents: 100, risk: 20, brokenPromises: 0, openDisputes: 1 }).status).toBe("review");
  });
});

describe("forecast", () => {
  it("groups by promise date and scales by keep rate", () => {
    const rows = forecastCollections(
      [{ amountDue: 10000, dueDate: "2026-03-20", promiseDate: "2026-03-02" }],
      "month",
      0.5,
    );
    expect(rows).toEqual([{ period: "2026-03", expectedCents: 5000, invoiceCount: 1 }]);
  });
});
