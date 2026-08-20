import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

const ALGO = "aes-256-gcm";

/**
 * Secrets at rest (e.g. OAuth tokens in `integrations.credentials`).
 * When CREDENTIALS_ENCRYPTION_KEY is unset the value is stored in plaintext,
 * which is acceptable for local dev but MUST be set in production.
 */
export function encryptSecret(plain: string): string {
  if (!config.credentialsEncryptionKey) return plain;
  const key = Buffer.from(config.credentialsEncryptionKey, "utf8");
  if (key.length !== 32) throw new Error("CREDENTIALS_ENCRYPTION_KEY must be exactly 32 characters");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith("enc:v1:")) return stored; // dev plaintext
  if (!config.credentialsEncryptionKey) {
    throw new Error("Encrypted credential found but CREDENTIALS_ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(config.credentialsEncryptionKey, "utf8");
  if (key.length !== 32) throw new Error("CREDENTIALS_ENCRYPTION_KEY must be exactly 32 characters");
  const [ivB64, tagB64, dataB64] = stored.slice("enc:v1:".length).split(":");
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}