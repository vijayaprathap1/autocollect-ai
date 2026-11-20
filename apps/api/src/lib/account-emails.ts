import type { FastifyRequest } from "fastify";
import { config } from "../config.js";
import { servicePool } from "./db.js";
import { generateToken, hashToken } from "./auth.js";
import { sendEmail } from "./postmark.js";

/** Fire-and-log: auth emails must never turn a successful action into a 500. */
export async function sendAccountEmail(
  req: FastifyRequest,
  to: string,
  tmpl: { subject: string; text: string; html: string },
  tag: string,
): Promise<void> {
  try {
    await sendEmail({ to, subject: tmpl.subject, text: tmpl.text, html: tmpl.html, tag });
  } catch (err) {
    req.log.error({ err, tag }, "failed to send account email");
  }
}

/** Replace any unused verification token for the user and return a fresh raw token. */
export async function issueVerificationToken(userId: string): Promise<string> {
  const raw = generateToken();
  await servicePool.query(`DELETE FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await servicePool.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashToken(raw), new Date(Date.now() + config.verifyTokenTtlHours * 3600_000).toISOString()],
  );
  return raw;
}
