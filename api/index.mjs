// Vercel function entrypoint. All `/api/*` requests are rewritten here (see
// vercel.json) and handed to the compiled Fastify app, which `npm run build:vercel`
// emits before Vercel traces this file's imports.
export { default } from "../apps/api/dist/serverless.js";
