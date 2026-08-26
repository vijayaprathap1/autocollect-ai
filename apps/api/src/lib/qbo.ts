import { config } from "../config.js";
import { fetchWithTimeout } from "./http.js";

/**
 * QuickBooks Online OAuth2 + V3 query client.
 * When QBO_CLIENT_ID/SECRET are unset the app runs in QBO-mock mode:
 * the callback accepts a dev code and sync returns generated invoices.
 */
export const qboEnabled = Boolean(config.qboClientId && config.qboClientSecret);

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";

const API_BASE =
  config.qboEnv === "production"
    ? "https://quickbooks.api.intuit.com/v3/company"
    : "https://sandbox-quickbooks.api.intuit.com/v3/company";

export function qboRedirectUri(): string {
  return `${config.appUrl}/integrations/qbo/callback`;
}

export function qboAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.qboClientId,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: qboRedirectUri(),
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export type QboTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
};

const basicAuth = () =>
  "Basic " + Buffer.from(`${config.qboClientId}:${config.qboClientSecret}`).toString("base64");

async function requestTokens(form: URLSearchParams): Promise<QboTokens> {
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  }, config.providerTimeoutMs);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`QBO token error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!body.access_token || !body.refresh_token) throw new Error("QBO token response missing tokens");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
  };
}

export async function qboExchangeCode(code: string): Promise<QboTokens> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: qboRedirectUri(),
  });
  return requestTokens(form);
}

export async function qboRefreshTokens(refreshToken: string): Promise<QboTokens> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return requestTokens(form);
}

export type QboInvoiceLike = {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: string | number;
  Balance?: string | number;
  CurrencyRef?: { value?: string };
  CustomerRef?: { value?: string; name?: string };
  BillEmail?: { Address?: string };
  Line?: { Description?: string; Amount?: string | number }[];
};

export async function qboQueryInvoices(
  accessToken: string,
  realmId: string,
  changedSince?: string,
): Promise<QboInvoiceLike[]> {
  const where = changedSince
    ? ` WHERE Metadata.LastUpdatedTime > '${changedSince}'`
    : "";
  const url = `${API_BASE}/${realmId}/query?query=${encodeURIComponent(
    `SELECT * FROM Invoice${where}`,
  )}`;

  const res = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  }, config.providerTimeoutMs);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`QBO query error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { QueryResponse?: { Invoice?: QboInvoiceLike[] } };
  return body.QueryResponse?.Invoice ?? [];
}

/** Deterministic mock invoices so the sync flow works with no Intuit credentials. */
export function qboMockInvoices(): QboInvoiceLike[] {
  return [
    {
      Id: "101",
      DocNumber: "QB-1001",
      TxnDate: "2026-07-20",
      DueDate: "2026-08-19",
      TotalAmt: 1500,
      Balance: 1500,
      CurrencyRef: { value: "USD" },
      CustomerRef: { value: "c1", name: "Kathy Client" },
      BillEmail: { Address: "kathy@example.com" },
      Line: [{ Description: "Monthly retainer", Amount: 1500 }],
    },
    {
      Id: "102",
      DocNumber: "QB-1002",
      TxnDate: "2026-07-25",
      DueDate: "2026-08-24",
      TotalAmt: 800,
      Balance: 800,
      CurrencyRef: { value: "USD" },
      CustomerRef: { value: "c2", name: "Raj Studio" },
      BillEmail: { Address: "raj@example.com" },
      Line: [{ Description: "Brand refresh phase 1", Amount: 800 }],
    },
    {
      Id: "103",
      DocNumber: "QB-1003",
      TxnDate: "2026-06-30",
      DueDate: "2026-07-30",
      TotalAmt: 3200,
      Balance: 0,
      CurrencyRef: { value: "USD" },
      CustomerRef: { value: "c3", name: "Lumen Labs" },
      BillEmail: { Address: "pay@lumen.example" },
      Line: [{ Description: "Website build", Amount: 3200 }],
    },
  ];
}