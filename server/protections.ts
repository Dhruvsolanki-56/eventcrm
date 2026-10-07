import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const positive = (value: string | undefined, fallback: number) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

/** Headers every response carries beyond what helmet already sets. */
export const securityHeaders: RequestHandler = (req, res, next) => {
  // The app uses the camera and microphone on its own pages and nothing else.
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
  // Answers from the API hold private records; browsers and shared caches must not keep them.
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
};

/** A request that has not finished after this long is answered with a clear message instead of hanging. */
function requestTimeout(limitMs: number): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) res.status(503).json({ code: 'request_timeout', message: 'This took too long. Try again in a moment.', requestId: res.locals.requestId });
    }, limitMs);
    timer.unref();
    res.on('close', () => clearTimeout(timer));
    next();
  };
}

function sessionKey(req: Request, cookieName: string) {
  const entry = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
  // Only a hash is used as the key; the session value itself is never stored.
  return entry ? `session:${createHash('sha256').update(entry.slice(cookieName.length + 1)).digest('hex').slice(0, 32)}` : ipKeyGenerator(req.ip ?? '');
}

/**
 * Limits on the whole API, ahead of everything else:
 *  - per address, generous because a whole booth or office can share one address
 *  - per signed-in session, so one runaway tab or script cannot starve the rest
 * More specific limits (sign-in, exports, AI, sending) sit on their own routes.
 */
export function apiProtection(options: { isProduction: boolean; sessionCookie: string }): RequestHandler[] {
  const perAddress = options.isProduction ? positive(process.env.API_LIMIT_PER_ADDRESS_PER_MINUTE, 1500) : positive(process.env.API_LIMIT_PER_ADDRESS_PER_MINUTE, 1_000_000);
  const perSession = options.isProduction ? positive(process.env.API_LIMIT_PER_SESSION_PER_MINUTE, 600) : positive(process.env.API_LIMIT_PER_SESSION_PER_MINUTE, 1_000_000);
  const common = { windowMs: 60_000, standardHeaders: 'draft-8' as const, legacyHeaders: false, skip: (req: Request) => req.path === '/health' };
  return [
    requestTimeout(positive(process.env.API_REQUEST_TIMEOUT_MS, 60_000)),
    rateLimit({ ...common, limit: perAddress, keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''), message: { code: 'rate_limit', message: 'Too many requests from this network. Wait a minute and try again.' } }),
    rateLimit({ ...common, limit: perSession, keyGenerator: (req) => sessionKey(req, options.sessionCookie), message: { code: 'rate_limit', message: 'You are going too fast. Wait a minute and try again.' } }),
  ];
}

/** Slow or stalled connections are closed instead of holding a socket open. */
export function applyServerTimeouts(server: Server) {
  // Longer than a typical load balancer's idle timeout, so the balancer closes first and never reuses a closed socket.
  server.keepAliveTimeout = positive(process.env.KEEP_ALIVE_TIMEOUT_MS, 65_000);
  server.headersTimeout = server.keepAliveTimeout + 5_000;
  // A whole request, including a photo or voice note on a slow connection.
  server.requestTimeout = positive(process.env.REQUEST_TIMEOUT_MS, 120_000);
}
