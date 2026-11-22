import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

const ALGO = "aes-256-gcm";
const PREFIX = "enc:v";

export type EncryptionKey = { version: number; key: Buffer };

export type KeyRing = {
  keys: Map<number, Buffer>;
  /** Version used for new ciphertext. */
  writeVersion: number;
};

function assertKeyMaterial(raw: string, label: string): Buffer {
  if (raw.length !== 32) {
    throw new Error(`${label} must be exactly 32 characters`);
  }
  return Buffer.from(raw, "utf8");
}

/**
 * Build the key ring.
 *
 * `CREDENTIALS_ENCRYPTION_KEY` is version 1 (existing deployments).
 * `CREDENTIALS_ENCRYPTION_KEYS` adds or overrides versions as
 * `version:32-character-key`, comma-separated (`2:................,3:................`).
 * `CREDENTIALS_ENCRYPTION_KEY_VERSION` selects the version new secrets are written with.
 * Decryption still accepts every version in the ring, so a rotation can be rolled
 * out before old ciphertext is rewritten.
 */
export function loadKeyRing(env: {
  primary?: string;
  extras?: string;
  writeVersion?: number | null;
} = {}): KeyRing {
  const keys = new Map<number, Buffer>();
  const primary = env.primary ?? config.credentialsEncryptionKey;
  if (primary) keys.set(1, assertKeyMaterial(primary, "CREDENTIALS_ENCRYPTION_KEY"));

  const extras = env.extras ?? config.credentialsEncryptionKeys;
  for (const part of extras.split(",").map((s) => s.trim()).filter(Boolean)) {
    const sep = part.indexOf(":");
    const version = Number(part.slice(0, sep));
    const raw = part.slice(sep + 1);
    if (!Number.isInteger(version) || version < 1 || sep < 1) {
      throw new Error(`Invalid CREDENTIALS_ENCRYPTION_KEYS entry "${part.slice(0, 8)}…"`);
    }
    keys.set(version, assertKeyMaterial(raw, `CREDENTIALS_ENCRYPTION_KEYS version ${version}`));
  }

  if (keys.size === 0) return { keys, writeVersion: 0 };

  const requested = env.writeVersion === undefined ? config.credentialsEncryptionKeyVersion : env.writeVersion;
  const writeVersion = requested ?? Math.max(...keys.keys());
  if (!keys.has(writeVersion)) {
    throw new Error(`CREDENTIALS_ENCRYPTION_KEY_VERSION ${writeVersion} is not in the key ring`);
  }
  return { keys, writeVersion };
}

export function encryptionConfigured(ring = loadKeyRing()): boolean {
  return ring.keys.size > 0 && ring.writeVersion > 0;
}

/** Describe ring problems for production startup. Empty string means the ring is usable. */
export function keyRingProblem(): string {
  try {
    const ring = loadKeyRing();
    if (!encryptionConfigured(ring)) return "CREDENTIALS_ENCRYPTION_KEY (exactly 32 characters)";
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : "CREDENTIALS_ENCRYPTION_KEY";
  }
}

export function encryptWithRing(plain: string, ring: KeyRing): string {
  if (!encryptionConfigured(ring)) return plain;
  const key = ring.keys.get(ring.writeVersion);
  if (!key) throw new Error("Encryption key ring has no write key");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${ring.writeVersion}:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptWithRing(stored: string, ring: KeyRing): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const rest = stored.slice(PREFIX.length);
  const versionSep = rest.indexOf(":");
  const version = Number(rest.slice(0, versionSep));
  if (!Number.isInteger(version) || version < 1) throw new Error("Encrypted secret has no key version");
  const key = ring.keys.get(version);
  if (!key) {
    throw new Error(`Encrypted secret uses key version ${version}, which is not configured`);
  }
  const [ivB64, tagB64, dataB64] = rest.slice(versionSep + 1).split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Encrypted secret is malformed");
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function ciphertextVersion(stored: string): number | null {
  if (!stored.startsWith(PREFIX)) return null;
  const version = Number(stored.slice(PREFIX.length).split(":", 1)[0]);
  return Number.isInteger(version) ? version : null;
}

/**
 * Secrets at rest (OAuth tokens, TOTP seeds).
 * When no key is configured the value is stored in plaintext, which is
 * acceptable for local dev but refused in production.
 */
export function encryptSecret(plain: string): string {
  return encryptWithRing(plain, loadKeyRing());
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const ring = loadKeyRing();
  if (!encryptionConfigured(ring)) {
    throw new Error("Encrypted credential found but CREDENTIALS_ENCRYPTION_KEY is not set");
  }
  return decryptWithRing(stored, ring);
}

/** Rewrite every encrypted string in a JSON value to the current write key. */
export function reencryptJson(value: unknown, ring = loadKeyRing()): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    if (!value.startsWith(PREFIX)) return { value, changed: false };
    const version = ciphertextVersion(value);
    if (version === ring.writeVersion) return { value, changed: false };
    const next = encryptWithRing(decryptWithRing(value, ring), ring);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const child = reencryptJson(item, ring);
      changed ||= child.changed;
      return child.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = reencryptJson(v, ring);
      changed ||= child.changed;
      next[k] = child.value;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}
