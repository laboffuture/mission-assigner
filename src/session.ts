import cookieSession from 'cookie-session';
import type { RequestHandler } from 'express';
import { logger } from './logger.js';

/**
 * Staff session cookie.
 *
 * Staff (sme/qc/admin/instructor) sign in with a username + password and are
 * issued a signed session cookie carrying only their user id. Students never use
 * this — they arrive via Moodle SSO (LTI launch), which will mint the same
 * cookie server-side after validating the launch token.
 *
 * The cookie is signed (not encrypted) with SESSION_SECRET; it holds no secret,
 * only `{ uid }`. httpOnly keeps it away from page scripts; sameSite=lax is the
 * safe default for a form login; secure is on in production (HTTPS only).
 */

const DEV_SECRET = 'dev-insecure-session-secret-change-me';

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length > 0) return s;
  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    // env validation already blocks this; belt-and-braces so we never sign with
    // the known dev key in production.
    throw new Error('SESSION_SECRET is required in production');
  }
  return DEV_SECRET;
}

export function sessionMiddleware(): RequestHandler {
  const secret = sessionSecret();
  if (secret === DEV_SECRET) {
    logger.warn(
      { insecure: true },
      'SESSION_SECRET is unset — signing staff sessions with a known dev key. Set SESSION_SECRET before shipping.'
    );
  }
  return cookieSession({
    name: 'mh_session',
    keys: [secret],
    httpOnly: true,
    sameSite: 'lax',
    secure: (process.env.NODE_ENV ?? 'development') === 'production',
    maxAge: 12 * 60 * 60 * 1000, // 12 hours
  });
}

// cookie-session augments req.session; declare the shape we store.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace CookieSessionInterfaces {
    interface CookieSessionObject {
      uid?: number;
    }
  }
}
