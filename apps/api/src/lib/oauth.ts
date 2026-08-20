import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { badRequest } from "./errors.js";

const STATE_TTL_MS = 15 * 60 * 1000;
const FALLBACK_SECRET = "dev-state-secret";

function secret(): string {
  if (!config.stateSecret && config.nodeEnv === "production") {
    throw new Error("OAUTH_STATE_SECRET must be set in production");
  }
  return config.stateSecret || FALLBACK_SECRET;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Encode the tenant id into an opaque, signed OAuth `state` token. */
export function encodeState(tenantId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ tenantId, exp: Date.now() + STATE_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Verify the signature/expiry of an OAuth `state` token and return the tenant id. */
export function decodeState(state: string): string {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) throw badRequest("Invalid OAuth state");
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw badRequest("Invalid OAuth state");
  let parsed: { tenantId?: string; exp?: number };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw badRequest("Invalid OAuth state");
  }
  if (!parsed.tenantId) throw badRequest("Invalid OAuth state");
  if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) {
    throw badRequest("OAuth state expired, try again");
  }
  return parsed.tenantId;
}