import { describe, expect, it } from "vitest";
import { SMS_MAX_CHARS, SMS_STOP_TEXT, buildSmsBody, isSmsOptOutError } from "./sms-body.js";

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
    expect(body).toBe(`Please pay today Pay: ${PAY_LINK} ${SMS_STOP_TEXT}`);
  });

  it("works without a pay link and collapses whitespace", () => {
    expect(buildSmsBody("Hello\n\n  there", null)).toBe(`Hello there ${SMS_STOP_TEXT}`);
  });
});

describe("isSmsOptOutError", () => {
  it("detects Twilio error 21610 in the sms.ts error format", () => {
    expect(isSmsOptOutError(new Error("Twilio 400/21610: Attempt to send to unsubscribed recipient"))).toBe(true);
    expect(isSmsOptOutError(new Error("Twilio 400/21211: Invalid 'To' Phone Number"))).toBe(false);
    expect(isSmsOptOutError(new Error("Twilio 500/?: request failed"))).toBe(false);
  });
});
