import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "./app.js";
import { validateProductionConfig } from "./config.js";

/**
 * Vercel serverless entrypoint for the Fastify API.
 * The SPA calls `/api/*`; Vercel routes those requests here and we hand them
 * to Fastify via `app.inject` (no socket needed).
 *
 * Vercel functions are ephemeral, so the in-process scheduler does NOT run
 * here: Vercel Cron calls `/api/cron/dunning` (see vercel.json).
 */

type App = ReturnType<typeof buildApp>;
// Fastify instances are thenable, so wrap before returning from an async fn.
let appPromise: Promise<{ app: App }> | null = null;

function getApp(): Promise<{ app: App }> {
  appPromise ??= (async () => {
    validateProductionConfig();
    const app = buildApp();
    await app.ready();
    return { app };
  })().catch((err) => {
    appPromise = null; // allow a retry on the next invocation
    throw err;
  });
  return appPromise;
}

/**
 * The real client address. Vercel terminates the connection, so the socket
 * address is always its internal proxy; the platform sets `x-real-ip` /
 * `x-forwarded-for` itself (client-supplied values are overwritten). Without
 * this every visitor shares one address — and one rate-limit bucket.
 */
function clientIp(req: IncomingMessage): string | undefined {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();
  return first(req.headers["x-real-ip"]) || first(req.headers["x-forwarded-for"]) || req.socket?.remoteAddress;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const { app: fastify } = await getApp();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    // Strip the SPA's `/api` prefix so Fastify sees its real routes.
    const url = (req.url ?? "/").replace(/^\/api(?=\/|$)/, "") || "/";

    const response = await fastify.inject({
      method: (req.method ?? "GET") as "GET",
      url,
      headers: req.headers as Record<string, string>,
      payload: chunks.length ? Buffer.concat(chunks) : undefined,
      remoteAddress: clientIp(req),
    });

    res.statusCode = response.statusCode;
    for (const [key, value] of Object.entries(response.headers)) {
      // Arrays matter: session + OAuth cookies are sent as a Set-Cookie array.
      if (value === undefined) continue;
      res.setHeader(key, Array.isArray(value) ? value.map(String) : String(value));
    }
    res.end(response.rawPayload);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "serverless handler failure", err: (err as Error).message }));
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: "INTERNAL", message: "Service temporarily unavailable" } }));
  }
}
