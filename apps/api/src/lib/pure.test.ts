import { describe, expect, it } from "vitest";
import { renderTemplate, formatCalendarDate, unknownPlaceholders, money } from "../modules/workflows/render.js";
import { mapHeaders, parseCalendarDate, toCents } from "../modules/integrations/csv.controller.js";
import { replyAddressFor, invoiceIdFromMailboxHash } from "./reply-address.js";
import { invoiceSubscriptionId, planForSubscription } from "./subscriptions.js";
import { referenceMessageIds } from "../modules/inbound/inbound.service.js";
import { statusFor } from "../modules/email/postmark.controller.js";
import { escapeHtml, reminderEmail } from "./email-templates.js";
import { config } from "../config.js";

describe("template rendering", () => {
  const ctx = {
    clientName: "Ada",
    companyName: "Acme",
    amountCents: 125050,
    currency: "usd",
    dueDate: "2026-09-30",
    payLink: "https://pay.example/x",
    invoiceNumber: "INV-7",
    tone: "friendly",
  };

  it("formats calendar dates without timezone drift", () => {
    expect(formatCalendarDate("2026-09-30")).toBe("Sep 30, 2026");
    expect(formatCalendarDate(null)).toBe("the due date");
  });

  it("substitutes known placeholders and leaves unknown ones", () => {
    const r = renderTemplate({ subject: "Invoice {invoice_number} for {amount}", body: "Hi {client_name}, due {due_date}. {oops}" }, ctx);
    expect(r.subject).toBe("Invoice INV-7 for $1,250.50");
    expect(r.body).toBe("Hi Ada, due Sep 30, 2026. {oops}");
  });

  it("strips newlines from subjects (header injection)", () => {
    const r = renderTemplate({ subject: "Hi {client_name}", body: "" }, { ...ctx, clientName: "Eve\r\nBcc: victim@example.com" });
    expect(r.subject).not.toMatch(/[\r\n]/);
  });

  it("reports unknown placeholders", () => {
    expect(unknownPlaceholders("{client_name} {clientname} {amount} {due}")).toEqual(["clientname", "due"]);
  });

  it("formats money in any ISO currency", () => {
    expect(money(1000, "eur")).toContain("10.00");
  });
});

describe("email HTML safety", () => {
  it("escapes user content in reminder bodies", () => {
    const html = reminderEmail({ subject: "s", body: "<script>alert(1)</script> pay https://pay.example/a?b=1&c=2", payLink: null, companyName: "<b>Acme</b>", hideBranding: true }).html;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(html).toContain('href="https://pay.example/a?b=1&amp;c=2"');
  });

  it("escapeHtml covers quotes", () => {
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });
});

describe("CSV parsing", () => {
  it("parses money in common formats", () => {
    expect(toCents("1,250.50")).toBe(125050);
    expect(toCents("$99")).toBe(9900);
    expect(toCents("1.234,56 €")).toBe(123456);
    expect(toCents("-5")).toBeNull();
    expect(toCents("")).toBeNull();
    expect(toCents("abc")).toBeNull();
  });

  it("parses calendar dates without timezone shifts", () => {
    expect(parseCalendarDate("2026-09-30")).toBe("2026-09-30");
    expect(parseCalendarDate("31/12/2026")).toBe("2026-12-31"); // unambiguous day-first
    expect(parseCalendarDate("12/31/2026")).toBe("2026-12-31"); // unambiguous month-first
    expect(parseCalendarDate("03/04/2026")).toBe("2026-03-04"); // ambiguous -> M/D by default
    expect(parseCalendarDate("03/04/2026", true)).toBe("2026-04-03");
    expect(parseCalendarDate("2026-02-30")).toBeNull();
    expect(parseCalendarDate("soon")).toBeNull();
  });

  it("maps messy headers", () => {
    expect(mapHeaders(["Invoice No", "Client", "E-mail Address", "Balance Due", "Due Date"])).toMatchObject({
      invoiceNumber: "Invoice No",
      name: "Client",
      amount: "Balance Due",
      dueDate: "Due Date",
    });
  });
});

describe("reply routing", () => {
  it("round-trips a signed reply address", () => {
    const prev = config.inboundReplyAddress;
    (config as { inboundReplyAddress: string }).inboundReplyAddress = "abc@inbound.postmarkapp.com";
    try {
      const id = "3f1c9a4e-7a51-4b6f-9d37-2d5c2c1f0a11";
      const addr = replyAddressFor(id)!;
      expect(addr).toMatch(/^abc\+3f1c9a4e-7a51-4b6f-9d37-2d5c2c1f0a11\.[\w-]{16}@inbound\.postmarkapp\.com$/);
      const hash = addr.slice(addr.indexOf("+") + 1, addr.indexOf("@"));
      expect(invoiceIdFromMailboxHash(hash)).toBe(id);
      expect(invoiceIdFromMailboxHash(`${id}.forgedsignature00`)).toBeNull();
      expect(invoiceIdFromMailboxHash(id)).toBeNull();
    } finally {
      (config as { inboundReplyAddress: string }).inboundReplyAddress = prev;
    }
  });

  it("matches Postmark message ids with or without the domain part", () => {
    const ids = referenceMessageIds({ Headers: [{ Name: "In-Reply-To", Value: "<abc-123@mtasv.net>" }] });
    expect(ids).toContain("abc-123");
    expect(ids).toContain("abc-123@mtasv.net");
  });
});

describe("Stripe payload compatibility", () => {
  it("reads the subscription id from old and new invoice shapes", () => {
    expect(invoiceSubscriptionId({ subscription: "sub_old" })).toBe("sub_old");
    expect(invoiceSubscriptionId({ parent: { subscription_details: { subscription: "sub_new" } } })).toBe("sub_new");
    expect(invoiceSubscriptionId({})).toBeNull();
  });

  it("falls back to metadata when the price isn't mapped", () => {
    expect(planForSubscription({ items: { data: [{ price: { id: "price_unknown" } }] }, metadata: { plan: "pro" } })).toBe("pro");
    expect(planForSubscription({ items: { data: [] } })).toBeNull();
  });
});

describe("Postmark event mapping", () => {
  it("treats hard bounces, complaints and unsubscribes as bounced", () => {
    expect(statusFor({ RecordType: "Bounce", Type: "HardBounce" })).toBe("bounced");
    expect(statusFor({ RecordType: "Bounce", Type: "SoftBounce" })).toBeNull();
    expect(statusFor({ RecordType: "SpamComplaint" })).toBe("bounced");
    expect(statusFor({ RecordType: "SubscriptionChange", SuppressSending: true })).toBe("bounced");
    expect(statusFor({ RecordType: "Delivery" })).toBe("delivered");
  });
});
