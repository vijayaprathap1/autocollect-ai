import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { badRequest } from "./errors.js";
import { servicePool } from "./db.js";
import { generateToken, hashToken } from "./auth.js";

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
export async function encodeState(tenantId: string, provider: "stripe" | "qbo", sessionToken: string): Promise<string> {
  const token = generateToken();
  const payload = Buffer.from(
    JSON.stringify({ token, exp: Date.now() + STATE_TTL_MS }),
  ).toString("base64url");
  const state = `${payload}.${sign(payload)}`;
  await servicePool.query(
    `INSERT INTO oauth_states (state_hash, tenant_id, provider, session_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [hashToken(state), tenantId, provider, hashToken(sessionToken), new Date(Date.now() + STATE_TTL_MS).toISOString()],
  );
  return state;
}

/** Verify the signature/expiry of an OAuth `state` token and return the tenant id. */
export async function decodeState(state: string, provider: "stripe" | "qbo", sessionToken: string): Promise<string> {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) throw badRequest("Invalid OAuth state");
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw badRequest("Invalid OAuth state");
  let parsed: { token?: string; exp?: number };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw badRequest("Invalid OAuth state");
  }
  if (!parsed.token || typeof parsed.exp !== "number" || parsed.exp < Date.now()) {
    throw badRequest("OAuth state expired, try again");
  }
  const claimed = await servicePool.query<{ tenant_id: string }>(
    `UPDATE oauth_states SET consumed_at = now()
     WHERE state_hash = $1 AND provider = $2 AND session_hash = $3
       AND consumed_at IS NULL AND expires_at > now()
     RETURNING tenant_id`,
    [hashToken(state), provider, hashToken(sessionToken)],
  );
  if (!claimed.rows[0]) throw badRequest("Invalid or already used OAuth state");
  return claimed.rows[0].tenant_id;
}