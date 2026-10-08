import { config, isProduction } from "../config.js";
import { fetchWithTimeout } from "./http.js";

/**
 * Twilio SMS (minimal REST client).
 * Development without TWILIO_* runs in mock mode (logged, not sent).
 * Production NEVER fakes a send: an SMS step without Twilio fails permanently
 * (and workflow saves reject SMS steps when SMS isn't configured).
 */
export const smsEnabled = Boolean(config.twilioAccountSid && config.twilioAuthToken && config.twilioFromNumber);

export class PermanentSmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentSmsError";
  }
}

export type SendSmsInput = { to: string; body: string };

const E164 = /^\+[1-9]\d{6,14}$/;

export async function sendSms(input: SendSmsInput): Promise<{ providerMsgId: string }> {
  const to = input.to.replace(/[\s()-]/g, "");
  if (!E164.test(to)) throw new PermanentSmsError(`Phone number must be in international format (+15551234567): ${input.to}`);

  if (!smsEnabled) {
    if (isProduction) throw new PermanentSmsError("SMS is not configured on this server");
    console.log(`[sms:mock] to=${to} body=${input.body}`);
    return { providerMsgId: `sms-dev-${Date.now().toString(36)}` };
  }

  const auth = "Basic " + Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64");
  const res = await fetchWithTimeout(
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`,
    {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: config.twilioFromNumber, Body: input.body }).toString(),
    },
    config.providerTimeoutMs,
  );
  const body = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
  if (!res.ok) {
    const detail = `Twilio ${res.status}/${body.code ?? "?"}: ${body.message ?? "request failed"}`.slice(0, 400);
    // 21211 invalid number, 21610 recipient opted out (STOP), 21614 not a mobile number
    if ([21211, 21610, 21614].includes(body.code ?? -1) || res.status === 400) throw new PermanentSmsError(detail);
    throw new Error(detail);
  }
  return { providerMsgId: body.sid ?? "unknown" };
}
