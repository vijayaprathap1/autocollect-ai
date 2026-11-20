import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

const FALLBACK_SECRET = "dev-state-secret";

function secret(): string {
  if (!config.stateSecret && config.nodeEnv === "production") {
    throw new Error("OAUTH_STATE_SECRET must be set in production");
  }
  return config.stateSecret || FALLBACK_SECRET;
}

/** HMAC signature binding an unsubscribe link to one customer. */
export function signUnsubscribe(customerId: string): string {
  return createHmac("sha256", secret()).update(`unsubscribe:${customerId}`).digest("base64url");
}

export function verifyUnsubscribe(customerId: string, signature: string): boolean {
  if (!customerId || !signature) return false;
  const expected = Buffer.from(signUnsubscribe(customerId));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Public, signed one-click unsubscribe URL for a customer. */
export function unsubscribeUrl(customerId: string): string {
  const base = config.appUrl.replace(/\/+$/, "");
  return `${base}/unsubscribe?c=${encodeURIComponent(customerId)}&s=${signUnsubscribe(customerId)}`;
}

/** RFC 2369 / RFC 8058 headers for one-click unsubscribe. */
export function unsubscribeHeaders(customerId: string): { Name: string; Value: string }[] {
  return [
    { Name: "List-Unsubscribe", Value: `<${unsubscribeUrl(customerId)}>` },
    { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
  ];
}
