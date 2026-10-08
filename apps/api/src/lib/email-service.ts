import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { config, isProduction } from "../config.js";
import { fetchWithTimeout } from "./http.js";

/**
 * Email service with pluggable providers:
 *  - postmark: production (POSTMARK_SERVER_TOKEN + verified sender domain)
 *  - smtp:     production alternative (SMTP_HOST/USER/PASS); no bounce webhooks or inbound replies
 *  - ethereal: free SMTP sandbox for manual testing (preview URLs in the log)
 *  - mock:     development default — logs the message (incl. links) to the console
 * EMAIL_PROVIDER=auto picks Postmark when a token is set, then SMTP, otherwise mock.
 * Production refuses to start unless Postmark or SMTP is configured (config.ts).
 */

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Postmark tag (analytics grouping). */
  tag?: string;
  /** Display name for the From header; the address is always the verified sender. */
  fromName?: string;
  replyTo?: string;
  /** Extra headers, e.g. In-Reply-To / References for threading. */
  headers?: Record<string, string>;
  /** Provider metadata echoed back on webhooks (tenant_id, invoice_id, …). */
  metadata?: Record<string, string>;
  /** Open/click tracking (customer reminders only). */
  track?: boolean;
};

export type SendEmailOutput = { providerMsgId: string; previewUrl?: string };

/** A failure that will not succeed on retry (bad/inactive address, rejected content). */
export class PermanentEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentEmailError";
  }
}

interface EmailProvider {
  name: string;
  /** True when messages actually reach inboxes. */
  delivers: boolean;
  init?(): Promise<void>;
  send(input: SendEmailInput): Promise<SendEmailOutput>;
}

function formatFrom(name: string | undefined, address: string): string {
  const clean = (name ?? config.emailFromName).replace(/["\r\n<>]/g, "").trim().slice(0, 70);
  return clean ? `"${clean}" <${address}>` : address;
}

function smtpConfigured(): boolean {
  return Boolean(config.smtpHost && config.smtpUser && config.smtpPass);
}

function selectProvider(): EmailProvider {
  const mode = config.emailProvider;
  if (mode === "postmark" || (mode === "auto" && config.postmarkServerToken)) return new PostmarkProvider();
  if (mode === "smtp" || (mode === "auto" && smtpConfigured())) return new SmtpProvider();
  if (isProduction) {
    // validateProductionConfig() should have stopped us already; never fall back silently.
    throw new Error("No production email provider configured (set POSTMARK_SERVER_TOKEN or SMTP_*)");
  }
  if (mode === "ethereal") return new EtherealProvider();
  return new MockProvider();
}

let providerPromise: Promise<EmailProvider> | null = null;

export async function getEmailProvider(): Promise<EmailProvider> {
  providerPromise ??= (async () => {
    const p = selectProvider();
    await p.init?.();
    console.log(JSON.stringify({ level: "info", msg: `[email] provider: ${p.name}` }));
    return p;
  })().catch((err) => {
    providerPromise = null;
    throw err;
  });
  return providerPromise;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailOutput> {
  if (!input.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) {
    throw new PermanentEmailError(`Invalid recipient address: ${input.to || "(empty)"}`);
  }
  const provider = await getEmailProvider();
  return provider.send(input);
}

/** Whether configured email actually reaches inboxes (drives dev-only link logging). */
export function isEmailProviderConfigured(): boolean {
  return Boolean(config.postmarkServerToken) || smtpConfigured() || config.emailProvider === "ethereal";
}

// ─── Providers ──────────────────────────────────────────────────────────────

class PostmarkProvider implements EmailProvider {
  name = "Postmark";
  delivers = true;

  async send(input: SendEmailInput): Promise<SendEmailOutput> {
    if (!config.postmarkServerToken) throw new Error("POSTMARK_SERVER_TOKEN is required for Postmark");
    const res = await fetchWithTimeout(
      "https://api.postmarkapp.com/email",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Postmark-Server-Token": config.postmarkServerToken,
        },
        body: JSON.stringify({
          From: formatFrom(input.fromName, config.postmarkFromEmail),
          To: input.to,
          ReplyTo: input.replyTo,
          Subject: input.subject.slice(0, 2000),
          TextBody: input.text,
          HtmlBody: input.html,
          MessageStream: config.postmarkMessageStream,
          Tag: input.tag?.slice(0, 1000),
          Headers: Object.entries(input.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
          Metadata: input.metadata,
          TrackOpens: input.track ?? false,
          TrackLinks: input.track ? "HtmlOnly" : "None",
        }),
      },
      config.providerTimeoutMs,
    );

    const body = (await res.json().catch(() => ({}))) as { MessageID?: string; ErrorCode?: number; Message?: string };
    if (!res.ok || (body.ErrorCode && body.ErrorCode !== 0)) {
      const detail = `Postmark ${res.status}/${body.ErrorCode ?? "?"}: ${body.Message ?? "request failed"}`.slice(0, 400);
      // 300 invalid email, 406 inactive recipient (bounced/unsubscribed/spam), 422 validation.
      if ([300, 406].includes(body.ErrorCode ?? -1) || res.status === 422) throw new PermanentEmailError(detail);
      throw new Error(detail);
    }
    return { providerMsgId: body.MessageID ?? "unknown" };
  }
}

class SmtpProvider implements EmailProvider {
  name = "SMTP";
  delivers = true;
  private transporter: Transporter | null = null;

  async init(): Promise<void> {
    if (!smtpConfigured()) throw new Error("SMTP_HOST, SMTP_USER and SMTP_PASS are required for SMTP");
    this.transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465, // implicit TLS on 465, STARTTLS otherwise
      requireTLS: config.smtpPort !== 465,
      auth: { user: config.smtpUser, pass: config.smtpPass },
      connectionTimeout: config.providerTimeoutMs,
      socketTimeout: config.providerTimeoutMs,
    });
  }

  async send(input: SendEmailInput): Promise<SendEmailOutput> {
    if (!this.transporter) throw new Error("SMTP transporter not initialised");
    try {
      const info = await this.transporter.sendMail({
        from: formatFrom(input.fromName, config.postmarkFromEmail),
        to: input.to,
        replyTo: input.replyTo,
        subject: input.subject.slice(0, 2000),
        text: input.text,
        html: input.html,
        headers: input.headers,
      });
      return { providerMsgId: String(info.messageId ?? `smtp-${Date.now()}`).replace(/^<|>$/g, "") };
    } catch (err) {
      const e = err as { responseCode?: number; message?: string };
      const detail = `SMTP ${e.responseCode ?? "?"}: ${e.message ?? "send failed"}`.slice(0, 400);
      // 550/551/553: mailbox does not exist or is not allowed — retrying cannot help.
      if ([550, 551, 553].includes(e.responseCode ?? 0)) throw new PermanentEmailError(detail);
      throw new Error(detail);
    }
  }
}

class EtherealProvider implements EmailProvider {
  name = "Ethereal (test SMTP)";
  delivers = false;
  private transporter: Transporter | null = null;

  async init(): Promise<void> {
    const account = await nodemailer.createTestAccount();
    this.transporter = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass },
    });
    console.log(`[email] Ethereal inbox: https://ethereal.email (user ${account.user})`);
  }

  async send(input: SendEmailInput): Promise<SendEmailOutput> {
    if (!this.transporter) throw new Error("Ethereal transporter not initialised");
    const info = await this.transporter.sendMail({
      from: formatFrom(input.fromName, config.postmarkFromEmail),
      to: input.to,
      replyTo: input.replyTo,
      subject: input.subject,
      text: input.text,
      html: input.html,
      headers: input.headers,
    });
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) console.log(`[email] sent to ${input.to}; preview: ${previewUrl}`);
    return {
      providerMsgId: String(info.messageId ?? `ethereal-${Date.now()}`).replace(/^<|>$/g, ""),
      previewUrl: typeof previewUrl === "string" ? previewUrl : undefined,
    };
  }
}

class MockProvider implements EmailProvider {
  name = "Mock (development — messages are logged, not sent)";
  delivers = false;

  async send(input: SendEmailInput): Promise<SendEmailOutput> {
    console.log(
      `\n[email:mock] to=${input.to}${input.replyTo ? ` reply-to=${input.replyTo}` : ""}\n  subject: ${input.subject}\n  ${input.text
        .split("\n")
        .join("\n  ")}\n`,
    );
    return { providerMsgId: `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
  }
}
