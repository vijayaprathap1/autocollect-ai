import { servicePool } from "./db.js";
import { ciphertextVersion, decryptWithRing, encryptWithRing, loadKeyRing, reencryptJson, type KeyRing } from "./crypto.js";

export type RotationReport = {
  writeVersion: number;
  integrations: number;
  totpSecrets: number;
  skipped: number;
};

/**
 * Rewrite stored ciphertext to the current write key.
 * Plaintext rows (local dev, no key configured) are left untouched.
 * Safe to run more than once.
 */
export async function rotateStoredSecrets(ring: KeyRing = loadKeyRing()): Promise<RotationReport> {
  if (ring.writeVersion < 1) {
    return { writeVersion: 0, integrations: 0, totpSecrets: 0, skipped: 0 };
  }

  let integrations = 0;
  let skipped = 0;
  const rows = await servicePool.query<{ id: string; credentials: unknown }>(
    `SELECT id, credentials FROM integrations WHERE credentials IS NOT NULL`,
  );
  for (const row of rows.rows) {
    const next = reencryptJson(row.credentials, ring);
    if (!next.changed) {
      skipped += 1;
      continue;
    }
    await servicePool.query(`UPDATE integrations SET credentials = $2::jsonb WHERE id = $1`, [
      row.id,
      JSON.stringify(next.value),
    ]);
    integrations += 1;
  }

  let totpSecrets = 0;
  const totp = await servicePool.query<{ user_id: string; secret_enc: string }>(`SELECT user_id, secret_enc FROM user_totp`);
  for (const row of totp.rows) {
    if (ciphertextVersion(row.secret_enc) === ring.writeVersion) continue;
    if (!row.secret_enc.startsWith("enc:v")) continue;
    const next = encryptWithRing(decryptWithRing(row.secret_enc, ring), ring);
    await servicePool.query(`UPDATE user_totp SET secret_enc = $2, updated_at = now() WHERE user_id = $1`, [row.user_id, next]);
    totpSecrets += 1;
  }

  return { writeVersion: ring.writeVersion, integrations, totpSecrets, skipped };
}
