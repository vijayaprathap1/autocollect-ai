/**
 * SUPERSEDED — safe to delete.
 *
 * The production-path checks that lived here (signed Stripe webhooks,
 * out-of-order/replayed events, scheduler sends, Postmark auth) are now
 * automated, repeatable tests that run in CI:
 *
 *   apps/api/test/integration/stripe-webhooks.test.ts   signed webhooks (Connect + billing secrets)
 *   apps/api/test/integration/api.test.ts               auth, isolation, invites, credits, dunning
 *   e2e/*.spec.ts                                       browser flows (Playwright)
 *   scripts/e2e-flow.sh                                 post-deploy smoke test
 *
 * Run them with:  npm test   and   npm run test:e2e
 */
console.log("This script was replaced by the automated test suites — see the header of this file.");
