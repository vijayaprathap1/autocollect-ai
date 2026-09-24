import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "./app.js";
import { validateProductionConfig } from "./config.js";

/**
 * Vercel serverless entrypoint for the Fastify API.
 * The SPA calls `/api/*`; Vercel routes those requests here and we hand them
 * to Fastify via `app.inject` (no socket needed).
 *
 * NOTE: Vercel serverless functions are ephemeral, so the in-process dunning
 * scheduler does NOT run here. Production deployments should trigger dunning
 * via the `/cron/dunning` route (see vercel.json crons).
 */

let app: ReturnType<typeof buildApp> | null = null;

async function getApp() {
  if (!app) {
    validateProductionConfig();
    app = buildApp();
    await app.ready();
  }
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const fastify = await getApp();

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const rawBody = Buffer.concat(chunks);

  // Strip the SPA's `/api` prefix so Fastify sees its real routes.
  const url = (req.url ?? "/").replace(/^\/api/, "") || "/";

  const response = await fastify.inject({
    method: (req.method ?? "GET") as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    url,
    headers: req.headers as Record<string, string>,
    payload: rawBody,
  });

  res.statusCode = response.statusCode;
  for (const [key, value] of Object.entries(response.headers)) {
    // Arrays matter: the session cookie is sent as a Set-Cookie array.
    if (value === undefined) continue;
    res.setHeader(key, Array.isArray(value) ? value.map(String) : value);
  }
  res.end(response.payload);
}