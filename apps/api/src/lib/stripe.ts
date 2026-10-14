import Stripe from "stripe";
import { config } from "../config.js";

/**
 * Platform Stripe client (Connect + Billing).
 * Without STRIPE_SECRET_KEY the app runs in Stripe-mock mode (development only):
 * OAuth, checkout and webhooks are simulated so every flow works offline.
 */
export const stripeEnabled = Boolean(config.stripeSecretKey);

export const stripe: Stripe | null = stripeEnabled
  ? new Stripe(config.stripeSecretKey, {
      maxNetworkRetries: 2,
      timeout: config.providerTimeoutMs,
      appInfo: { name: "AutoCollect AI", version: config.version },
    })
  : null;

export function stripeOrThrow(): Stripe {
  if (!stripe) throw new Error("STRIPE_SECRET_KEY is not configured");
  return stripe;
}

export function stripeOAuthRedirectUri(): string {
  return `${config.appUrl}/integrations/stripe/callback`;
}

/**
 * Verify a webhook against every configured signing secret. Stripe issues one
 * secret per endpoint, and Connect + platform-billing events arrive on separate
 * endpoints (possibly the same URL), so a single secret isn't enough.
 */
export function constructWebhookEvent(payload: Buffer | string, signature: string): Stripe.Event {
  if (!stripe) throw new Error("Stripe is not configured");
  let lastErr: unknown = new Error("No webhook secrets configured");
  for (const secret of config.stripeWebhookSecrets) {
    try {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
