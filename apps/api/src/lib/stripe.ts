import Stripe from "stripe";
import { config } from "../config.js";

/**
 * Stripe client for the platform (Connect).
 * When STRIPE_SECRET_KEY is unset the app runs in Stripe-mock mode:
 * OAuth and webhooks operate against fake accounts so the whole flow
 * can be exercised locally without real keys (mirrors dev-auth).
 */
export const stripeEnabled = Boolean(config.stripeSecretKey);

export const stripe: Stripe | null = stripeEnabled
  ? new Stripe(config.stripeSecretKey)
  : null;

export function stripeOrThrow(): Stripe {
  if (!stripe) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  return stripe;
}

/** Root URL for the connect callback, used to build OAuth state/redirects. */
export function stripeOAuthRedirectUri(): string {
  return `${config.appUrl}/integrations/stripe/callback`;
}