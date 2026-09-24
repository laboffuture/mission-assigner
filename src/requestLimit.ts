import type { Request, Response, NextFunction } from 'express';
import { sendError } from './httpError.js';

/**
 * A ceiling on writes, per student, per endpoint.
 *
 * Only failed sign-ins were capped. Everything a signed-in student can write —
 * opening slots, submitting answers, sending feedback — was unbounded, so a
 * stuck retry loop in a browser tab, or one curl in a loop, could sit against
 * the database as fast as it could be served, and every other student on the
 * pilot would feel it. This is not about malice; the likeliest cause is our own
 * client retrying.
 *
 * Keyed on the authenticated STUDENT, never the address: behind Caddy every
 * request carries the proxy's address, and one shared IP must never throttle a
 * whole class (the same reasoning as the login limiter, which keys on username).
 * An unauthenticated request never reaches these handlers at all.
 *
 * The caps are deliberately far above human use — a mission takes minutes, not
 * seconds — so a student who is simply quick is never told to slow down. They
 * exist to stop a runaway, not to pace anyone.
 *
 * In-process, like the login limiter, which the single-instance guard
 * (src/singleInstance.ts) makes correct. A shared store would be needed before
 * a second api process could run, and this is the second place to change.
 */

const WINDOW_MS = 60 * 1000;

/** Requests per window, per student, per scope. */
export const LIMITS: Record<string, number> = {
  submit: 120,
  open: 120,
  feedback: 120,
};

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function take(key: string, max: number, now: number): { allowed: boolean; retryAfter: number } {
  const existing = buckets.get(key);
  const live = existing && now < existing.resetAt ? existing : null;
  if (!live) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  if (live.count >= max) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((live.resetAt - now) / 1000)) };
  }
  live.count += 1;
  return { allowed: true, retryAfter: 0 };
}

/**
 * Middleware for one scope. Applied after requireAuth, so req.auth is set; a
 * request with no identity is passed through rather than sharing one bucket
 * with every other anonymous request, because it is about to be rejected by the
 * auth layer anyway.
 */
export function limitWrites(scope: keyof typeof LIMITS | string) {
  const max = LIMITS[scope] ?? 120;
  return function rateLimitWrites(req: Request, res: Response, next: NextFunction): void {
    const subject = req.auth?.userId;
    if (subject == null) return next();
    const { allowed, retryAfter } = take(`${scope}:${subject}`, max, Date.now());
    if (allowed) return next();
    res.setHeader('Retry-After', String(retryAfter));
    sendError(req, res, 429, 'too_many_requests', `too many requests — try again in ${retryAfter}s`);
  };
}

/** Test hook: clear all buckets, or one scope's. */
export function resetRequestLimiter(scope?: string): void {
  if (!scope) {
    buckets.clear();
    return;
  }
  for (const key of [...buckets.keys()]) if (key.startsWith(`${scope}:`)) buckets.delete(key);
}

export const REQUEST_LIMIT = { WINDOW_MS } as const;
