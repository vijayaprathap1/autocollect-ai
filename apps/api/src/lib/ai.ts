import { config } from "../config.js";
import type { ReplyClassification, TenantTone } from "@autocollect/shared";

/** AI drafting (Anthropic). Falls back to deterministic mock drafts when no key is set. */
export const aiEnabled = Boolean(config.anthropicApiKey);

export type Draft = { stepKey: string; subject: string; body: string };

const STEP_KEYS = ["reminder_pre", "reminder_1d", "reminder_7d", "reminder_14d"] as const;

const TONE_COPY: Record<TenantTone, { greeting: string; pre: string; mid: string; firm: string }> = {
  friendly: {
    greeting: "Hi",
    pre: "Just a friendly heads-up",
    mid: "A gentle reminder",
    firm: "We need your help with",
  },
  professional: {
    greeting: "Hello",
    pre: "A courtesy notice",
    mid: "A reminder",
    firm: "Action required",
  },
  firm: {
    greeting: "Hello",
    pre: "Notice",
    mid: "Reminder",
    firm: "Immediate attention required",
  },
};

function mockDrafts(tone: TenantTone): Draft[] {
  const t = TONE_COPY[tone];
  return [
    {
      stepKey: "reminder_pre",
      subject: `${t.pre}: invoice {amount} coming due`,
      body:
        `${t.greeting} {client_name},\n\n${t.pre} that invoice {amount} for {company_name} is due {due_date}. ` +
        `You can pay in one click here: {pay_link}\n\nThanks for your business!\n{company_name}`,
    },
    {
      stepKey: "reminder_1d",
      subject: `${t.mid}: invoice {amount} is now due`,
      body:
        `${t.greeting} {client_name},\n\n${t.mid} that invoice {amount} is now due. ` +
        `You can settle it here: {pay_link}\n\nLet us know if anything looks off.\n{company_name}`,
    },
    {
      stepKey: "reminder_7d",
      subject: `Reminder: invoice {amount} is past due`,
      body:
        `${t.greeting} {client_name},\n\nThis is a reminder that invoice {amount} is past due. ` +
        `Please arrange payment at your earliest convenience: {pay_link}\n\nIf you have questions, just reply.\n{company_name}`,
    },
    {
      stepKey: "reminder_14d",
      subject: `${t.firm}: invoice {amount} remains unpaid`,
      body:
        `${t.greeting} {client_name},\n\nInvoice {amount} remains unpaid and is now overdue. ` +
        `Please make payment promptly here: {pay_link}\n\nWe value the relationship — reach out if there's an issue we can resolve.\n{company_name}`,
    },
  ];
}

async function anthropicDrafts(tone: TenantTone): Promise<Draft[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 1500,
      system:
        "You write short, professional B2B invoice reminder emails for a SaaS called AutoCollect AI. " +
        "Use the exact placeholders {client_name}, {amount}, {due_date}, {pay_link}, {company_name}. " +
        "Return ONLY a JSON array with 4 objects, each {stepKey, subject, body}. " +
        "stepKey must be exactly: reminder_pre, reminder_1d, reminder_7d, reminder_14d.",
      messages: [
        {
          role: "user",
          content: `Write a 4-step dunning sequence in a "${tone}" tone: 1) reminder_pre = pre-due courtesy at -2 days, 2) reminder_1d = due today at +1 day, 3) reminder_7d = past due at +7 days, 4) reminder_14d = firm overdue at +14 days. Each body should be 3-5 sentences, polite, include the payment link placeholder, and end with {company_name}.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };
  const text = data.content?.find((c) => c.type === "text")?.text ?? "";
  const parsed = JSON.parse(text) as unknown;

  if (!Array.isArray(parsed)) throw new Error("AI returned invalid draft format");
  const drafts = parsed.filter(
    (d): d is Draft =>
      typeof d === "object" &&
      d !== null &&
      typeof (d as Draft).stepKey === "string" &&
      typeof (d as Draft).subject === "string" &&
      typeof (d as Draft).body === "string",
  );
  if (drafts.length === 0) throw new Error("AI returned no drafts");
  return drafts;
}

export async function draftReminderTemplates(tone: TenantTone): Promise<Draft[]> {
  if (!aiEnabled) return mockDrafts(tone);
  return anthropicDrafts(tone);
}

export { STEP_KEYS };

export type ReplyClassificationResult = {
  classification: ReplyClassification;
  promiseDate: string | null; // ISO date
  confidence: number;
};

const NEXT_WEEKDAY: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function nextWeekdayIso(day: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (day - today.getDay() + 7) % 7 || 7;
  return new Date(today.getTime() + diff * 86400000).toISOString().slice(0, 10);
}

/** Deterministic keyword-based classifier for mock mode (no Anthropic key). */
function mockClassify(text: string): ReplyClassificationResult {
  const lower = text.toLowerCase();

  if (/(dispute|wrong|mistake|error|incorrect|never received|not received|didn'?t receive|refus|issue with|not correct|never got)/.test(lower)) {
    return { classification: "dispute", promiseDate: null, confidence: 0.94 };
  }
  if (/(paying|will pay|to pay|pay on|pay by|settle|transfer|send payment|friday|tomorrow|monday|tuesday|wednesday|thursday|saturday|sunday|next week|end of (the )?month|this week)/.test(lower)) {
    const iso = lower.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ?? null;
    const weekday = Object.entries(NEXT_WEEKDAY).find(([name]) => lower.includes(name))?.[1];
    const promiseDate = iso ?? (weekday !== undefined ? nextWeekdayIso(weekday) : null);
    return { classification: "promise", promiseDate, confidence: 0.9 };
  }
  if (lower.includes("?")) {
    return { classification: "question", promiseDate: null, confidence: 0.85 };
  }
  return { classification: "junk", promiseDate: null, confidence: 0.8 };
}

async function anthropicClassify(text: string): Promise<ReplyClassificationResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 200,
      system:
        "You classify customer replies about unpaid invoices. " +
        "Return ONLY JSON: {classification: dispute|promise|question|junk, promise_date: date|null, confidence: number}.",
      messages: [
        {
          role: "user",
          content:
            "dispute = the customer contests the charge or says it is wrong/unreceived. " +
            "promise = the customer commits to pay on a date. " +
            "question = the customer asks for clarification. " +
            `junk = anything else (auto-replies, spam, OOO).\nReply text: "${text}"`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const raw = data.content?.find((c) => c.type === "text")?.text ?? "";
  const parsed = JSON.parse(raw) as {
    classification?: ReplyClassification;
    promise_date?: string | null;
    confidence?: number;
  };
  const valid: ReplyClassification[] = ["dispute", "promise", "question", "junk"];
  if (!parsed.classification || !valid.includes(parsed.classification)) {
    throw new Error("AI returned invalid classification");
  }
  return {
    classification: parsed.classification,
    promiseDate: parsed.promise_date ?? null,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.9,
  };
}

/** Classify an inbound customer reply. Falls back to keyword matching in mock mode. */
export async function classifyReply(text: string): Promise<ReplyClassificationResult> {
  if (!aiEnabled) return mockClassify(text);
  try {
    return await anthropicClassify(text);
  } catch {
    return mockClassify(text);
  }
}

export type ReplySuggestionInput = {
  classification: ReplyClassification;
  replyText: string;
  clientName: string | null;
  amountCents: number;
  currency: string;
  dueDate: string | null;
  payLink: string | null;
  invoiceNumber: string | null;
};

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (currency ?? "usd").toUpperCase(),
    }).format((cents ?? 0) / 100);
  } catch {
    return `$${((cents ?? 0) / 100).toFixed(2)}`;
  }
}

function mockSuggestReply(input: ReplySuggestionInput): { subject: string; body: string } | null {
  const name = input.clientName ?? "there";
  const due = input.dueDate ? ` (due ${input.dueDate})` : "";
  const link = input.payLink ? ` You can pay securely here: ${input.payLink}` : "";
  const inv = input.invoiceNumber ? ` #${input.invoiceNumber}` : "";
  const amount = money(input.amountCents, input.currency);

  switch (input.classification) {
    case "dispute":
      return {
        subject: `Re: invoice${inv}`,
        body:
          `Hi ${name}, I'm sorry about this — we absolutely want to make it right. ` +
          `Could you share which part of the invoice doesn't look correct? ` +
          `We've paused the automatic reminders while we sort it out together.`,
      };
    case "promise":
      return {
        subject: `Re: invoice${inv}`,
        body:
          `Thanks ${name}, that's noted! We'll keep reminders quiet and see the payment come through.` +
          `${link} If anything changes, just reply here.`,
      };
    case "question":
      return {
        subject: `Re: invoice${inv}`,
        body:
          `Hi ${name}, happy to help. Your invoice${inv} for ${amount}${due} is the outstanding amount.` +
          `${link} What would you like to know?`,
      };
    case "junk":
      return null;
  }
}

async function anthropicSuggestReply(input: ReplySuggestionInput): Promise<{ subject: string; body: string } | null> {
  if (input.classification === "junk") return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 300,
      system:
        "You write short, professional replies for a small business owner to send to a customer about an invoice. " +
        "Return ONLY JSON: {subject, body}. 2-4 sentences, polite, no legal threats. " +
        "Inject real values only from the data given; never invent amounts or dates.",
      messages: [
        {
          role: "user",
          content:
            `Customer reply classified as ${input.classification}: "${input.replyText}"\n` +
            `Invoice context: client "${input.clientName ?? "unknown"}", amount ${money(
              input.amountCents,
              input.currency,
            )}, due ${input.dueDate ?? "unknown"}, ` +
            `pay link ${input.payLink ?? "none"}, invoice number ${input.invoiceNumber ?? "unknown"}.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const raw = data.content?.find((c) => c.type === "text")?.text ?? "";
  const parsed = JSON.parse(raw) as { subject?: string; body?: string };
  if (typeof parsed.subject !== "string" || typeof parsed.body !== "string") {
    throw new Error("AI returned invalid reply format");
  }
  return { subject: parsed.subject, body: parsed.body };
}

/** Suggest a reply to an inbound customer message. Returns null for junk. */
export async function suggestReply(
  input: ReplySuggestionInput,
): Promise<{ subject: string; body: string } | null> {
  if (!aiEnabled) return mockSuggestReply(input);
  try {
    return await anthropicSuggestReply(input);
  } catch {
    return mockSuggestReply(input);
  }
}