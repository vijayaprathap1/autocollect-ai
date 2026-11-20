import { describe, expect, it } from "vitest";
import {
  signUnsubscribe,
  unsubscribeHeaders,
  unsubscribeUrl,
  verifyUnsubscribe,
} from "../src/lib/unsubscribe.js";

const CUSTOMER = "4f9d2b8e-1c3a-4e5f-9a7b-0c1d2e3f4a5b";
const OTHER = "0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d";

describe("unsubscribe links", () => {
  it("verifies a signature for the same customer", () => {
    expect(verifyUnsubscribe(CUSTOMER, signUnsubscribe(CUSTOMER))).toBe(true);
  });

  it("rejects a signature for another customer or a tampered one", () => {
    expect(verifyUnsubscribe(OTHER, signUnsubscribe(CUSTOMER))).toBe(false);
    expect(verifyUnsubscribe(CUSTOMER, `${signUnsubscribe(CUSTOMER)}x`)).toBe(false);
    expect(verifyUnsubscribe(CUSTOMER, "")).toBe(false);
  });

  it("builds a signed URL and one-click headers", () => {
    const url = unsubscribeUrl(CUSTOMER);
    expect(url).toContain(`/unsubscribe?c=${CUSTOMER}&s=`);
    const headers = unsubscribeHeaders(CUSTOMER);
    expect(headers).toEqual([
      { Name: "List-Unsubscribe", Value: `<${url}>` },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
  });
});
