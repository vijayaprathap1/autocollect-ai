import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import "@fastify/cookie"; // Import for type augmentation

/**
 * CSRF protection plugin using double-submit cookie.
 * 
 * For non-safe methods (GET, HEAD, OPTIONS, TRACE) and public routes (marked with { config: { public: true } }),
 * CSRF validation is skipped. For other methods, the plugin expects a cookie named 'csrf-token' and a header
 * 'x-csrf-token' with the same value.
 * 
 * On every response, a new CSRF token is set in a cookie named 'csrf-token' for the next request.
 */
export default fp(async (app: FastifyInstance) => {
  // Helper to check if a route is public
  const isPublic = (req: FastifyRequest) => {
    return (req.routeOptions.config as { public?: boolean })?.public ?? false;
  };

  // Helper to check if a method is safe (as per RFC 7231)
  const isSafeMethod = (method: string) => {
    return ['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(method);
  };

  // Generate a random token
  const generateToken = () => {
    // Use crypto.randomUUID if available (Node.js >=14.17.0)
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback to a simple random string
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  };

  app.addHook('onRequest', (req, reply) => {
    // Skip CSRF check for public routes and safe methods
    if (isPublic(req) || isSafeMethod(req.method)) {
      return;
    }

    // Get the cookie from the request
    const cookieHeader = req.headers.cookie;
    let cookieToken = null;
    if (cookieHeader) {
      const match = cookieHeader.match(/(?:^|; )csrf-token=([^;]*)/);
      if (match) {
        cookieToken = match[1];
      }
    }

    // Get the token from the header
    const headerToken = req.headers['x-csrf-token'];

    // If either is missing or they don't match, throw an error
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      throw new Error('Invalid CSRF token');
    }
  });

  app.addHook('onResponse', (req, reply) => {
    // Set a new CSRF token in the cookie for the next request
    const token = generateToken();
    // Cookie options: path=/, httpOnly=false (so frontend can read it), secure in production, sameSite=strict
    reply.setCookie('csrf-token', token, {
      path: '/',
      httpOnly: false,
      secure: config.nodeEnv === 'production',
      sameSite: 'strict',
    });
  });
});