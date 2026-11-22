import type { Queryable } from "./db.js";
import { servicePool } from "./db.js";
import { hashToken, generateToken, verifyPassword } from "./auth.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { base32Encode, generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from "./totp.js";
import { badRequest, unauthorized } from "./errors.js";
import { timingSafeEqual } from "node:crypto";

const CHALLENGE_TTL_MS = 5 * 60_000;

export type ChallengeRecord = {
  user_id: string;
  session_type: "tenant" | "admin";
  tenant_id: string | null;
  remember_me: boolean;
};

type TotpRow = { secret_enc: string; enabled_at: string | null; recovery_hashes: string[] };

async function loadTotp(client: Queryable, userId: string): Promise<TotpRow | null> {
  const row = await client.query<TotpRow>(
    `SELECT secret_enc, enabled_at, recovery_hashes FROM user_totp WHERE user_id = $1`,
    [userId],
  );
  return row.rows[0] ?? null;
}

export async function twoFactorEnabled(userId: string): Promise<boolean> {
  const row = await servicePool.query<{ on: boolean }>(
    `SELECT enabled_at IS NOT NULL AS on FROM user_totp WHERE user_id = $1`,
    [userId],
  );
  return Boolean(row.rows[0]?.on);
}

function secretBuffer(stored: string): Buffer {
  return Buffer.from(decryptSecret(stored), "base64url");
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Returns a one-time challenge token when 2FA is on, otherwise null (caller may open a session). */
export async function createTwoFactorChallenge(
  client: Queryable,
  userId: string,
  opts: { sessionType?: "tenant" | "admin"; tenantId?: string | null; rememberMe?: boolean },
): Promise<string | null> {
  const row = await loadTotp(client, userId);
  if (!row?.enabled_at) return null;
  const token = generateToken();
  await client.query(`DELETE FROM two_factor_challenges WHERE user_id = $1 OR expires_at < now()`, [userId]);
  await client.query(
    `INSERT INTO two_factor_challenges (user_id, token_hash, session_type, tenant_id, remember_me, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      hashToken(token),
      opts.sessionType ?? "tenant",
      opts.tenantId ?? null,
      opts.rememberMe !== false,
      new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    ],
  );
  return token;
}

/** Consume a challenge. Throws when the token is missing or expired. */
export async function consumeTwoFactorChallenge(token: string): Promise<ChallengeRecord> {
  const res = await servicePool.query<ChallengeRecord>(
    `DELETE FROM two_factor_challenges
      WHERE token_hash = $1 AND expires_at > now()
      RETURNING user_id, session_type, tenant_id, remember_me`,
    [hashToken(token)],
  );
  const row = res.rows[0];
  if (!row) throw unauthorized("That sign-in challenge expired. Enter your password again.", "CHALLENGE_EXPIRED");
  return row;
}

export async function beginTotpSetup(userId: string, email: string): Promise<{ secret: string; otpauthUrl: string }> {
  const existing = await loadTotp(servicePool, userId);
  if (existing?.enabled_at) throw badRequest("Two-factor authentication is already on.", "TOTP_ENABLED");
  const secret = generateTotpSecret();
  const stored = encryptSecret(secret.toString("base64url"));
  await servicePool.query(
    `INSERT INTO user_totp (user_id, secret_enc, enabled_at, recovery_hashes)
     VALUES ($1, $2, NULL, '{}')
     ON CONFLICT (user_id) DO UPDATE
       SET secret_enc = EXCLUDED.secret_enc, enabled_at = NULL, recovery_hashes = '{}', updated_at = now()`,
    [userId, stored],
  );
  return { secret: base32Encode(secret), otpauthUrl: otpauthUrl(email, secret) };
}

export async function enableTotp(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const row = await loadTotp(servicePool, userId);
  if (!row) throw badRequest("Start setup before confirming a code.", "TOTP_NOT_STARTED");
  if (row.enabled_at) throw badRequest("Two-factor authentication is already on.", "TOTP_ENABLED");
  if (!verifyTotp(secretBuffer(row.secret_enc), code)) {
    throw unauthorized("That code didn't match. Check the time on your phone and try again.", "INVALID_TOTP");
  }
  const recoveryCodes = generateRecoveryCodes();
  const hashes = recoveryCodes.map((c) => hashToken(normalizeRecoveryCode(c)));
  await servicePool.query(
    `UPDATE user_totp SET enabled_at = now(), recovery_hashes = $2, updated_at = now() WHERE user_id = $1`,
    [userId, hashes],
  );
  return { recoveryCodes };
}

async function consumeCode(userId: string, code: string): Promise<boolean> {
  const row = await loadTotp(servicePool, userId);
  if (!row?.enabled_at) return false;
  if (verifyTotp(secretBuffer(row.secret_enc), code)) return true;
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length < 8) return false;
  const digest = hashToken(normalized);
  const idx = row.recovery_hashes.findIndex((h) => hashesEqual(h, digest));
  if (idx === -1) return false;
  const next = row.recovery_hashes.filter((_, i) => i !== idx);
  await servicePool.query(`UPDATE user_totp SET recovery_hashes = $2, updated_at = now() WHERE user_id = $1`, [userId, next]);
  return true;
}

export async function assertSecondFactor(userId: string, code: string): Promise<void> {
  if (!(await consumeCode(userId, code))) {
    throw unauthorized("That authentication code is not valid.", "INVALID_TOTP");
  }
}

export async function disableTotp(userId: string, passwordHash: string | null, password: string, code: string): Promise<void> {
  if (!(await verifyPassword(passwordHash, password))) throw unauthorized("Incorrect password", "INVALID_CREDENTIALS");
  await assertSecondFactor(userId, code);
  await servicePool.query(`DELETE FROM user_totp WHERE user_id = $1`, [userId]);
  await servicePool.query(`DELETE FROM two_factor_challenges WHERE user_id = $1`, [userId]);
}

export async function regenerateRecoveryCodes(userId: string, code: string): Promise<string[]> {
  await assertSecondFactor(userId, code);
  const recoveryCodes = generateRecoveryCodes();
  const hashes = recoveryCodes.map((c) => hashToken(normalizeRecoveryCode(c)));
  await servicePool.query(`UPDATE user_totp SET recovery_hashes = $2, updated_at = now() WHERE user_id = $1`, [userId, hashes]);
  return recoveryCodes;
}
