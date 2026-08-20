import { config } from "../config.js";

/**
 * Twilio SMS client (minimal, via HTTP).
 * When TWILIO_* are unset the app runs in SMS-mock mode:
 * sends are logged to messages as 'sent' with a fake provider id,
 * mirroring the Postmark mock so the flow works without a carrier.
 */
export const smsEnabled = Boolean(
  config.twilioAccountSid && config.twilioAuthToken && config.twilioFromNumber,
);

export type SendSmsInput = {
  to: string;
  body: string;
};

export async function sendSms(input: SendSmsInput): Promise<{ providerMsgId: string }> {
  if (!smsEnabled) {
    return { providerMsgId: `sms-dev-${Math.random().toString(36).slice(2, 10)}` };
  }

  const auth = "Basic " + Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: input.to,
        From: config.twilioFromNumber,
        Body: input.body,
      }).toString(),
    },
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Twilio error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { sid?: string };
  return { providerMsgId: body.sid ?? "unknown" };
}