/**
 * Email templates. Every function returns { subject, html, text }.
 * ALL interpolated values are HTML-escaped: names, organization names and
 * reminder bodies are user-controlled and are sent to third parties.
 */
import { config } from "../config.js";

const BRAND_COLOR = "#2563eb";
const APP_NAME = "AutoCollect AI";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) URLs are ever placed in href attributes. */
function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : "#";
}

function wrap(title: string, bodyHtml: string, { brand = APP_NAME, footer = true } = {}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1e293b;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="font-size:20px;font-weight:700;color:${BRAND_COLOR};margin-bottom:24px;">${escapeHtml(brand)}</div>
    <div style="background:#ffffff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.08);font-size:15px;line-height:1.6;color:#334155;">
      ${bodyHtml}
    </div>
    ${
      footer
        ? `<div style="font-size:12px;color:#94a3b8;margin-top:32px;text-align:center;">
      This email was sent because of activity on your ${APP_NAME} account.<br/>&copy; ${new Date().getFullYear()} ${APP_NAME}
    </div>`
        : ""
    }
  </div>
</body>
</html>`;
}

function button(url: string, label: string): string {
  return `<p style="text-align:center;margin:28px 0;"><a href="${safeUrl(url)}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;">${escapeHtml(label)}</a></p>`;
}

function fallbackLink(url: string): string {
  return `<p style="font-size:13px;color:#94a3b8;">If the button doesn't work, paste this link into your browser:<br/><span style="color:${BRAND_COLOR};word-break:break-all;">${escapeHtml(url)}</span></p>`;
}

function textWrap(title: string, bodyText: string): string {
  return `${title}\n\n${bodyText}\n\n— ${APP_NAME}`;
}

export type Rendered = { subject: string; html: string; text: string };

export function passwordResetEmail(resetUrl: string, userName: string): Rendered {
  const minutes = config.resetTokenTtlMinutes;
  const html = wrap("Reset your password", `
    <h1 style="font-size:22px;margin:0 0 16px;color:#0f172a;">Reset your password</h1>
    <p>Hi ${escapeHtml(userName)},</p>
    <p>We received a request to reset the password for your ${APP_NAME} account.</p>
    ${button(resetUrl, "Reset password")}
    <p>This link expires in ${minutes} minutes and can be used once. If you didn't ask for this, you can ignore this email — your password won't change.</p>
    ${fallbackLink(resetUrl)}`);
  return {
    subject: `Reset your ${APP_NAME} password`,
    html,
    text: textWrap(
      "Reset your password",
      `Hi ${userName},\n\nReset your password here (expires in ${minutes} minutes):\n${resetUrl}\n\nIf you didn't request this, ignore this email.`,
    ),
  };
}

export function accountSetupEmail(setupUrl: string, userName: string, orgName: string): Rendered {
  const html = wrap("Set up your account", `
    <h1 style="font-size:22px;margin:0 0 16px;color:#0f172a;">Your workspace is ready</h1>
    <p>Hi ${escapeHtml(userName)},</p>
    <p>A ${APP_NAME} workspace <strong>${escapeHtml(orgName)}</strong> was created for you. Choose a password to sign in.</p>
    ${button(setupUrl, "Set your password")}
    ${fallbackLink(setupUrl)}`);
  return {
    subject: `Your ${APP_NAME} workspace is ready`,
    html,
    text: textWrap("Set up your account", `Hi ${userName},\n\nSet your password for ${orgName}:\n${setupUrl}`),
  };
}

export function emailVerificationEmail(verifyUrl: string, userName: string): Rendered {
  const html = wrap("Verify your email", `
    <h1 style="font-size:22px;margin:0 0 16px;color:#0f172a;">Confirm your email</h1>
    <p>Hi ${escapeHtml(userName)},</p>
    <p>Thanks for signing up for ${APP_NAME}. Confirm your email address to activate your workspace.</p>
    ${button(verifyUrl, "Verify email")}
    <p>This link expires in ${config.verifyTokenTtlHours} hours.</p>
    ${fallbackLink(verifyUrl)}`);
  return {
    subject: `Confirm your email for ${APP_NAME}`,
    html,
    text: textWrap("Verify your email", `Hi ${userName},\n\nConfirm your email address:\n${verifyUrl}`),
  };
}

export function accountExistsEmail(loginUrl: string, resetUrl: string): Rendered {
  const html = wrap("You already have an account", `
    <h1 style="font-size:22px;margin:0 0 16px;color:#0f172a;">You already have an account</h1>
    <p>Someone (hopefully you) tried to sign up for ${APP_NAME} with this email address, but an account already exists.</p>
    ${button(loginUrl, "Sign in")}
    <p>Forgot your password? <a href="${safeUrl(resetUrl)}" style="color:${BRAND_COLOR};">Reset it here</a>. If this wasn't you, no action is needed.</p>`);
  return {
    subject: `Sign in to ${APP_NAME}`,
    html,
    text: textWrap("You already have an account", `Sign in: ${loginUrl}\nReset password: ${resetUrl}\n\nIf this wasn't you, ignore this email.`),
  };
}

export function passwordChangedEmail(userName: string, resetUrl: string): Rendered {
  const html = wrap("Your password was changed", `
    <h1 style="font-size:22px;margin:0 0 16px;color:#0f172a;">Your password was changed</h1>
    <p>Hi ${escapeHtml(userName)},</p>
    <p>The password for your ${APP_NAME} account was just changed and other devices were signed out.</p>
    <p>If this wasn't you, <a href="${safeUrl(resetUrl)}" style="color:${BRAND_COLOR};">reset your password immediately</a>.</p>`);
  return {
    subject: `Your ${APP_NAME} password was changed`,
    html,
    text: textWrap("Your password was changed", `Hi ${userName},\n\nYour password was changed. If this wasn't you, reset it now: ${resetUrl}`),
  };
}

export function teamInviteEmail(inviteUrl: string, inviterName: string, orgName: string): Rendered {
  const html = wrap("You're invited", `
    <h1 style="font-size:22px;margin:0 0 16px;color:#0f172a;">Join ${escapeHtml(orgName)} on ${APP_NAME}</h1>
    <p><strong>${escapeHtml(inviterName)}</strong> invited you to collaborate on invoice collections in the <strong>${escapeHtml(orgName)}</strong> workspace.</p>
    ${button(inviteUrl, "Accept invitation")}
    <p>This invitation expires in 7 days.</p>
    ${fallbackLink(inviteUrl)}`);
  return {
    subject: `${inviterName} invited you to ${orgName} on ${APP_NAME}`,
    html,
    text: textWrap("You're invited", `${inviterName} invited you to join ${orgName} on ${APP_NAME}.\n\nAccept: ${inviteUrl}\n\nExpires in 7 days.`),
  };
}

export function replyNotificationEmail(params: {
  orgName: string;
  customerName: string | null;
  invoiceNumber: string | null;
  classification: string;
  excerpt: string;
  inboxUrl: string;
}): Rendered {
  const who = params.customerName || "A customer";
  const label: Record<string, string> = {
    dispute: "raised a dispute — reminders are paused",
    promise: "promised to pay",
    question: "asked a question",
    junk: "replied",
  };
  const what = label[params.classification] ?? "replied";
  const inv = params.invoiceNumber ? ` on invoice ${params.invoiceNumber}` : "";
  const html = wrap("New customer reply", `
    <h1 style="font-size:20px;margin:0 0 16px;color:#0f172a;">${escapeHtml(who)} ${escapeHtml(what)}</h1>
    <p>New reply${escapeHtml(inv)} in <strong>${escapeHtml(params.orgName)}</strong>:</p>
    <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #cbd5e1;background:#f8fafc;color:#475569;white-space:pre-wrap;">${escapeHtml(params.excerpt)}</blockquote>
    ${button(params.inboxUrl, "Open reply inbox")}`);
  return {
    subject: `${who} ${what}${inv}`,
    html,
    text: textWrap("New customer reply", `${who} ${what}${inv}:\n\n${params.excerpt}\n\nOpen: ${params.inboxUrl}`),
  };
}

/**
 * Customer-facing payment reminder. The body is the tenant's approved plain-text
 * template; it is escaped and paragraphs/links are formatted safely.
 */
export function reminderEmail(params: {
  subject: string;
  body: string;
  payLink: string | null;
  companyName: string;
  hideBranding: boolean;
  businessAddress?: string | null;
}): Rendered {
  const paragraphs = params.body
    .split(/\n{2,}/)
    .map((p) =>
      `<p style="margin:0 0 16px;">${escapeHtml(p)
        .replace(/\n/g, "<br/>")
        .replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" style="color:${BRAND_COLOR};">${u}</a>`)}</p>`,
    )
    .join("");
  const cta = params.payLink ? button(params.payLink, "Pay invoice") : "";
  const poweredBy = params.hideBranding
    ? ""
    : `<div style="font-size:11px;color:#94a3b8;margin-top:24px;text-align:center;">Sent with ${APP_NAME}</div>`;
  // Sender identification + a contact route, required in every customer email
  // (also when white-labelled). Replies reach the workspace's reply inbox.
  const address = params.businessAddress?.trim() || "";
  const notice = `You're receiving this because ${params.companyName} has an outstanding invoice addressed to you. Questions, or think this was sent in error? Just reply to this email.`;
  const senderFooter = `<div style="font-size:11px;color:#94a3b8;margin-top:24px;text-align:center;line-height:1.5;">${escapeHtml(notice)}${
    address ? `<br/>${escapeHtml(params.companyName)} · ${escapeHtml(address).replace(/\n/g, ", ")}` : ""
  }</div>`;
  const html = wrap(params.subject, `${paragraphs}${cta}${senderFooter}${poweredBy}`, { brand: params.companyName, footer: false });
  const text = `${params.body}\n\n--\n${notice}${address ? `\n${params.companyName}, ${address.replace(/\n/g, ", ")}` : ""}`;
  return { subject: params.subject, html, text };
}
