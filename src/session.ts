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
 * only `{ uid }`.
 *
 * Cookie flags (see the README "Session cookie" section):
 *  - httpOnly: always ON — the cookie is never readable by page JavaScript.
 *  - sameSite: SESSION_SAMESITE, default 'lax'. The LTI launch (a cross-site
 *    POST, usually inside a Moodle iframe) will need 'none'.
 *  - secure:   ON in production, OR whenever sameSite='none' (browsers reject a
 *    SameSite=None cookie that is not Secure). 'none' therefore requires HTTPS.
 */

const DEV_SECRET = 'dev-insecure-session-secret-change-me';

export type SameSite = 'lax' | 'strict' | 'none';

export interface CookieFlags {
  httpOnly: boolean;
  sameSite: SameSite;
  secure: boolean;
  maxAge: number;
}

/**
 * Compute the cookie flags from the environment. Pure and exported so the flag
 * policy can be asserted directly in a test. `secure` is forced on when
 * sameSite is 'none' (a SameSite=None cookie MUST be Secure or the browser
 * drops it).
 */
export function cookieFlags(env: NodeJS.ProcessEnv = process.env): CookieFlags {
  const isProd = (env.NODE_ENV ?? 'development') === 'production';
  const sameSite = (env.SESSION_SAMESITE as SameSite) ?? 'lax';
  return {
    httpOnly: true,
    sameSite,
    secure: isProd || sameSite === 'none',
    maxAge: 12 * 60 * 60 * 1000, // 12 hours
  };
}

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
  const flags = cookieFlags();
  return cookieSession({ name: 'mh_session', keys: [secret], ...flags });
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
