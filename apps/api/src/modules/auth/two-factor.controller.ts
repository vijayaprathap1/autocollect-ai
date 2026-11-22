import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { servicePool } from "../../lib/db.js";
import {
  createSession,
  findUserByEmail,
  hashToken,
  recordLoginSuccess,
  setSessionCookie,
} from "../../lib/auth.js";
import { badRequest } from "../../lib/errors.js";
import {
  assertSecondFactor,
  beginTotpSetup,
  consumeTwoFactorChallenge,
  disableTotp,
  enableTotp,
  regenerateRecoveryCodes,
  twoFactorEnabled,
} from "../../lib/two-factor.js";

const CODE = z.string().trim().min(6).max(32);

async function openSession(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  opts: { sessionType?: "tenant" | "admin"; tenantId?: string | null; persistent?: boolean },
): Promise<void> {
  const token = await createSession(servicePool, userId, {
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    sessionType: opts.sessionType ?? "tenant",
    tenantId: opts.tenantId ?? null,
  });
  if (opts.persistent === false) {
    await servicePool.query(`UPDATE sessions SET expires_at = now() + interval '12 hours' WHERE token_hash = $1`, [hashToken(token)]);
  }
  setSessionCookie(reply, token, opts.persistent !== false);
}

export async function twoFactorRoutes(app: FastifyInstance) {
  app.get("/auth/2fa", async (req) => ({ enabled: await twoFactorEnabled(req.user.userId) }));

  app.post("/auth/2fa/setup", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const user = await findUserByEmail(servicePool, req.user.email);
    if (!user?.password_hash) {
      throw badRequest("Set a password before turning on two-factor authentication.", "PASSWORD_REQUIRED");
    }
    return beginTotpSetup(req.user.userId, req.user.email);
  });

  app.post("/auth/2fa/enable", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (req) => {
    const { code } = z.object({ code: CODE }).parse(req.body ?? {});
    const { recoveryCodes } = await enableTotp(req.user.userId, code);
    return { ok: true, recoveryCodes };
  });

  app.post("/auth/2fa/disable", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({ password: z.string().min(1).max(128), code: CODE }).parse(req.body ?? {});
    const user = await findUserByEmail(servicePool, req.user.email);
    await disableTotp(req.user.userId, user?.password_hash ?? null, body.password, body.code);
    return { ok: true };
  });

  app.post("/auth/2fa/recovery", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const { code } = z.object({ code: CODE }).parse(req.body ?? {});
    const recoveryCodes = await regenerateRecoveryCodes(req.user.userId, code);
    return { ok: true, recoveryCodes };
  });

  app.post("/auth/2fa/verify", { config: { public: true, rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ challengeToken: z.string().min(20).max(200), code: CODE }).parse(req.body ?? {});
    const challenge = await consumeTwoFactorChallenge(body.challengeToken);
    await assertSecondFactor(challenge.user_id, body.code);
    await recordLoginSuccess(challenge.user_id);
    await openSession(req, reply, challenge.user_id, {
      sessionType: challenge.session_type,
      tenantId: challenge.tenant_id,
      persistent: challenge.remember_me,
    });
    return { ok: true, twoFactorRequired: false };
  });
}
