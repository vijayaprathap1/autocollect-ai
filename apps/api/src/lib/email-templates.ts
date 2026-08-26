/**
 * Transactional email templates (HTML).
 * Each template is a function returning { subject, html, text }.
 */

const BRAND_COLOR = "#2563eb";
const APP_NAME = "AutoCollect AI";

function wrap(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 0; background: #f5f7fa; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1e293b; }
    .container { max-width: 560px; margin: 0 auto; padding: 40px 24px; }
    .card { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .logo { font-size: 20px; font-weight: 700; color: ${BRAND_COLOR}; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 700; margin: 0 0 16px; }
    p { font-size: 15px; line-height: 1.6; margin: 0 0 16px; color: #475569; }
    .btn { display: inline-block; background: ${BRAND_COLOR}; color: #fff !important; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; }
    .btn:hover { background: #1d4ed8; }
    .link { color: ${BRAND_COLOR}; word-break: break-all; }
    .footer { font-size: 13px; color: #94a3b8; margin-top: 32px; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">${APP_NAME}</div>
    <div class="card">
      ${bodyHtml}
    </div>
    <div class="footer">
      This email was sent to you because of activity on your ${APP_NAME} account.<br/>
      &copy; ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.
    </div>
  </div>
</body>
</html>`;
}

function textWrap(title: string, bodyText: string): string {
  return `${title}\n\n${bodyText}\n\n— ${APP_NAME}`;
}

export function passwordResetEmail(resetUrl: string, userName: string) {
  const html = wrap("Reset your password", `
    <h1>Reset your password</h1>
    <p>Hi ${userName},</p>
    <p>We received a request to reset the password for your ${APP_NAME} account.</p>
    <p style="text-align:center;margin:24px 0">
      <a href="${resetUrl}" class="btn">Reset password</a>
    </p>
    <p>This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>
    <p style="font-size:13px;color:#94a3b8">If the button doesn't work, copy and paste this URL into your browser:<br/>
      <span class="link">${resetUrl}</span>
    </p>
  `);

  const text = textWrap("Reset your password", [
    `Hi ${userName},`,
    "",
    "We received a request to reset the password for your AutoCollect AI account.",
    "",
    `Reset your password: ${resetUrl}`,
    "",
    "This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.",
  ].join("\n"));

  return { subject: `Reset your ${APP_NAME} password`, html, text };
}

export function emailVerificationEmail(verifyUrl: string, userName: string) {
  const html = wrap("Verify your email", `
    <h1>Verify your email</h1>
    <p>Hi ${userName},</p>
    <p>Thanks for signing up for ${APP_NAME}. Please verify your email address to get started.</p>
    <p style="text-align:center;margin:24px 0">
      <a href="${verifyUrl}" class="btn">Verify email</a>
    </p>
    <p>This link expires in 24 hours.</p>
    <p style="font-size:13px;color:#94a3b8">If the button doesn't work, copy and paste this URL into your browser:<br/>
      <span class="link">${verifyUrl}</span>
    </p>
  `);

  const text = textWrap("Verify your email", [
    `Hi ${userName},`,
    "",
    "Thanks for signing up for AutoCollect AI. Please verify your email address to get started.",
    "",
    `Verify your email: ${verifyUrl}`,
    "",
    "This link expires in 24 hours.",
  ].join("\n"));

  return { subject: `Verify your ${APP_NAME} email`, html, text };
}

export function teamInviteEmail(inviteUrl: string, inviterName: string, orgName: string) {
  const html = wrap("You've been invited", `
    <h1>You've been invited to join a team</h1>
    <p><strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> on ${APP_NAME}.</p>
    <p style="text-align:center;margin:24px 0">
      <a href="${inviteUrl}" class="btn">Accept invitation</a>
    </p>
    <p>This invitation expires in 7 days.</p>
    <p style="font-size:13px;color:#94a3b8">If you weren't expecting this invitation, you can safely ignore this email.</p>
  `);

  const text = textWrap("You've been invited", [
    `${inviterName} has invited you to join ${orgName} on AutoCollect AI.`,
    "",
    `Accept invitation: ${inviteUrl}`,
    "",
    "This invitation expires in 7 days.",
    "If you weren't expecting this invitation, you can safely ignore this email.",
  ].join("\n"));

  return { subject: `${inviterName} invited you to ${orgName} on ${APP_NAME}`, html, text };
}
