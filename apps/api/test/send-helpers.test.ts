import { describe, expect, it } from "vitest";
import {
  SMS_MAX_CHARS,
  SMS_STOP_TEXT,
  buildSmsBody,
  emailDomain,
  isSmsUnsubscribedError,
  referenceIdCandidates,
  withUnsubscribeFooter,
} from "../src/modules/workflows/send-helpers.js";

const PAY_LINK = "https://pay.stripe.com/test_abc123";

describe("buildSmsBody", () => {
  it("keeps the pay link and STOP notice when the text is long", () => {
    const longText = `Hi Alex, ${"this invoice is overdue and needs attention. ".repeat(20)} Pay here: ${PAY_LINK}`;
    const body = buildSmsBody(longText, PAY_LINK);
    expect(body.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(body).toContain(`Pay: ${PAY_LINK}`);
    expect(body.endsWith(SMS_STOP_TEXT)).toBe(true);
    expect(body).toContain("…");
  });

  it("includes the pay link only once even if the template embeds it", () => {
    const body = buildSmsBody(`Please pay ${PAY_LINK} today`, PAY_LINK);
    expect(body.split(PAY_LINK)).toHaveLength(2);
    expect(body).toBe(`Please pay today Pay: ${PAY_LINK} ${SMS_STOP_TEXT}`);
  });

  it("works without a pay link and collapses whitespace", () => {
    expect(buildSmsBody("Hello\n\n  there", null)).toBe(`Hello there ${SMS_STOP_TEXT}`);
  });
});

describe("withUnsubscribeFooter", () => {
  it("appends the unsubscribe URL", () => {
    const out = withUnsubscribeFooter("Body text\n\n", "https://api.example.com/unsubscribe?c=1&s=x");
    expect(out).toBe("Body text\n\n--\nDon't want these reminders? Unsubscribe: https://api.example.com/unsubscribe?c=1&s=x");
  });
});

describe("referenceIdCandidates", () => {
  it("extracts ids and their local parts from References headers", () => {
    const ids = referenceIdCandidates([
      "<b7bc2f4a-e38e-4336-af7d-e6c392c2f817@mtasv.net>",
      "<abc@example.com> <dev-123>",
    ]);
    expect(ids).toEqual(
      expect.arrayContaining([
        "b7bc2f4a-e38e-4336-af7d-e6c392c2f817@mtasv.net",
        "b7bc2f4a-e38e-4336-af7d-e6c392c2f817",
        "abc@example.com",
        "abc",
        "dev-123",
      ]),
    );
  });

  it("returns nothing for headers without message ids", () => {
    expect(referenceIdCandidates(["", "no brackets here"])).toEqual([]);
  });
});

describe("emailDomain", () => {
  it("normalises the domain", () => {
    expect(emailDomain("Ap@Acme.COM ")).toBe("acme.com");
    expect(emailDomain("not-an-email")).toBeNull();
    expect(emailDomain(null)).toBeNull();
  });
});

describe("isSmsUnsubscribedError", () => {
  it("detects Twilio error 21610", () => {
    expect(isSmsUnsubscribedError(new Error('Twilio error 400: {"code":21610}'))).toBe(true);
    expect(isSmsUnsubscribedError(new Error("Twilio error 500"))).toBe(false);
  });
});
