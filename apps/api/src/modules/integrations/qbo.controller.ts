import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { requireRole } from "../../plugins/tenant.js";
import { servicePool } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import { decodeState, encodeState } from "../../lib/oauth.js";
import { extractCookieToken } from "../../lib/auth.js";
import { encryptSecret } from "../../lib/crypto.js";
import { qboAuthorizeUrl, qboEnabled, qboExchangeCode, type QboTokens } from "../../lib/qbo.js";
import { syncQuickBooksForTenant } from "./qbo.sync.service.js";

const MOCK_REALM_ID = "realm_dev_mock";

export async function qboRoutes(app: FastifyInstance) {
  /**
   * Begin QuickBooks OAuth onboarding. Returns `{ url }`.
   */
  app.post(
    "/integrations/qbo/connect",
    { preHandler: requireRole("admin") },
    async (req) => {
      const sessionToken = extractCookieToken(req);
      if (!sessionToken) throw badRequest("Missing session cookie");
      const state = await encodeState(req.user.tenantId, "qbo", sessionToken);
      const url = qboEnabled
        ? qboAuthorizeUrl(state)
        : `${config.appUrl}/integrations/qbo/callback?state=${encodeURIComponent(
            state,
          )}&code=dev_qbo_code&realmId=${MOCK_REALM_ID}`;
      return { url };
    },
  );

  /**
   * QuickBooks OAuth redirect target. Exchanges the code, stores tokens,
   * redirects back to the SPA.
   */
  app.get(
    "/integrations/qbo/callback",
    { config: { public: true } },
    async (req, reply) => {
      const q = req.query as { code?: string; state?: string; realmId?: string; error?: string };

      if (q.error) {
        return reply.redirect(`${config.webOrigin}/settings?qbo=error`);
      }
      if (!q.code || !q.state || !q.realmId) throw badRequest("Missing code, state or realmId");

      const sessionToken = extractCookieToken(req);
      if (!sessionToken) throw badRequest("Missing session cookie");
      const tenantId = await decodeState(q.state, "qbo", sessionToken);
      const realmId = q.realmId;

      let tokens: { accessToken: string; refreshToken: string; expiresAt: string } | null = null;
      if (qboEnabled) {
        tokens = await qboExchangeCode(q.code);
      } else if (q.code !== "dev_qbo_code") {
        throw badRequest("Invalid dev OAuth code");
      }

      const client = await servicePool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
const devTokens: QboTokens = { accessToken: "dev_token", refreshToken: "dev_refresh", expiresAt: new Date(Date.now() + 3600000).toISOString() };
      const raw = tokens ?? devTokens;
      await client.query(
        `INSERT INTO integrations (tenant_id, source, status, credentials)
         VALUES ($1, 'qbo', 'active', $2::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          JSON.stringify({
            realm_id: realmId,
            access_token: encryptSecret(raw.accessToken),
            refresh_token: encryptSecret(raw.refreshToken),
            expires_at: raw.expiresAt,
          }),
        ],
      );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return reply.redirect(`${config.webOrigin}/settings?qbo=connected`);
    },
  );

  /**
   * Trigger a manual sync of QuickBooks invoices for the tenant.
   */
  app.post(
    "/integrations/qbo/sync",
    { preHandler: requireRole("admin") },
    async (req) => {
      try {
        const result = await syncQuickBooksForTenant(req.user.tenantId);
        return { ...result, lastSyncAt: new Date().toISOString() };
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : "Sync failed");
      }
    },
  );
}