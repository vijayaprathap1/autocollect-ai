import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { badRequest } from "./errors.js";
import { servicePool } from "./db.js";
import { generateToken, hashToken } from "./auth.js";
import { fetchWithTimeout } from "./http.js";

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
export async function encodeState(tenantId: string, provider: "stripe" | "qbo" | "google", sessionToken: string): Promise<string> {
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
export async function decodeState(state: string, provider: "stripe" | "qbo" | "google", sessionToken: string): Promise<string> {
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

// ─── Google OAuth ────────────────────────────────────────────────────────────────
export const googleEnabled = Boolean(config.googleClientId && config.googleClientSecret);

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USER_INFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_SCOPE = "openid email profile";

export function googleRedirectUri(): string {
  return `${config.appUrl}/auth/google/callback`;
}

export function googleAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    redirect_uri: googleRedirectUri(),
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type GoogleTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
  idToken: string;
};

async function requestGoogleTokens(form: URLSearchParams): Promise<GoogleTokens> {
  const res = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  }, config.providerTimeoutMs);

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google token error ${res.status}: ${detail.slice(0, 300)}`);
  }

  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };

  if (!body.access_token) throw new Error("Google token response missing access token");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? "",
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
    idToken: body.id_token ?? "",
  };
}

export async function googleExchangeCode(code: string): Promise<GoogleTokens> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: googleRedirectUri(),
  });
  return requestGoogleTokens(form);
}

export async function googleRefreshTokens(refreshToken: string): Promise<GoogleTokens> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
  });
  return requestGoogleTokens(form);
}

export async function googleGetUserInfo(accessToken: string): Promise<{
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
  locale: string;
}> {
  const res = await fetchWithTimeout(GOOGLE_USER_INFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, config.providerTimeoutMs);

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google user info error ${res.status}: ${detail.slice(0, 300)}`);
  }

  return await res.json();
}