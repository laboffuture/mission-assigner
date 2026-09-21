import cookieSession from 'cookie-session';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
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
 * only `{ uid, iat }`.
 *
 * Expiry is enforced on the SERVER. `iat` (issued-at, epoch seconds) is written
 * by issueSession() and checked on every request by enforceSessionAge(): a
 * session with no iat, an iat in the future, or one older than SESSION_MAX_AGE
 * is dropped, so the request is unauthenticated. The cookie's own Max-Age is
 * only a hint to the browser — a copied cookie replayed later carries no expiry
 * of its own, which is why the age has to live inside the signed payload.
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

/** Absolute session lifetime in seconds (SESSION_MAX_AGE, default 12h). */
export function sessionMaxAgeSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SESSION_MAX_AGE);
  return Number.isInteger(n) && n > 0 ? n : 12 * 60 * 60;
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
    // Kept in step with the server-side limit so the browser forgets the cookie
    // at about the time the server would refuse it anyway.
    maxAge: sessionMaxAgeSeconds(env) * 1000,
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

const nowSeconds = () => Math.floor(Date.now() / 1000);
/** Tolerated clock difference for an iat slightly ahead of this server. */
const CLOCK_SKEW_SECONDS = 60;

/** Start a session for `uid`. The ONLY way a session should be created. */
export function issueSession(req: Request, uid: number): void {
  req.session = { uid, iat: nowSeconds() };
}

/**
 * Drop any session the server would not accept as issued by it within the
 * limit: no iat (a legacy `{uid}` cookie), an iat in the future, or older than
 * SESSION_MAX_AGE. The request then proceeds unauthenticated, so requireAuth
 * answers 401.
 */
export function enforceSessionAge(req: Request, _res: Response, next: NextFunction): void {
  const s = req.session;
  if (s && s.uid != null) {
    const iat = s.iat;
    const now = nowSeconds();
    let reason: string | null = null;
    if (typeof iat !== 'number' || !Number.isInteger(iat)) reason = 'no issue time';
    else if (iat > now + CLOCK_SKEW_SECONDS) reason = 'issued in the future';
    else if (now - iat > sessionMaxAgeSeconds()) reason = 'expired';
    if (reason) {
      ((req as any).log ?? logger).info({ uid: s.uid, reason }, 'session rejected');
      req.session = null;
    }
  }
  next();
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
  const cookie = cookieSession({ name: 'mh_session', keys: [secret], ...flags });
  // Decode the signed cookie, then enforce its age before anything reads it.
  return (req, res, next) => cookie(req, res, (err?: unknown) => (err ? next(err) : enforceSessionAge(req, res, next)));
}

// cookie-session augments req.session; declare the shape we store.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace CookieSessionInterfaces {
    interface CookieSessionObject {
      uid?: number;
      /** Issued-at, epoch seconds. Sessions without one are rejected. */
      iat?: number;
    }
  }
}
