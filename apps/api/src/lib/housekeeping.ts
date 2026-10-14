import { servicePool } from "./db.js";

/**
 * Data retention / cleanup. Safe to run often (idempotent, bounded deletes).
 * Keeps failed webhook events for inspection; drops processed ones after 30 days.
 */
export async function runHousekeeping(): Promise<Record<string, number>> {
  const jobs: [string, string][] = [
    ["sessions", `DELETE FROM sessions WHERE expires_at < now()`],
    ["passwordResetTokens", `DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '7 days'`],
    ["verificationTokens", `DELETE FROM email_verification_tokens WHERE expires_at < now() - interval '7 days'`],
    ["oauthStates", `DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day'`],
    ["webhookEvents", `DELETE FROM webhook_events WHERE status = 'processed' AND processed_at < now() - interval '30 days'`],
    ["invitations", `UPDATE invitations SET status = 'revoked' WHERE status = 'pending' AND expires_at < now() - interval '30 days'`],
    ["jobQueue", `DELETE FROM job_queue WHERE created_at < now() - interval '7 days'`],
    ["expiredLocks", `UPDATE users SET locked_until = NULL WHERE locked_until IS NOT NULL AND locked_until < now()`],
  ];
  const out: Record<string, number> = {};
  for (const [name, sql] of jobs) {
    try {
      const r = await servicePool.query(sql);
      out[name] = r.rowCount ?? 0;
    } catch {
      out[name] = -1;
    }
  }
  return out;
}
