import crypto from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { cookieFlags } from './session.js';
import { sendError } from './httpError.js';

/**
 * Double-submit CSRF protection.
 *
 * Why now, enforced later: today the session cookie is SameSite=Lax, which the
 * browser already refuses to send on cross-site POSTs — so CSRF is not yet
 * exploitable. But the LTI launch will force SameSite=None (cross-site POST in a
 * Moodle iframe), which removes that protection. Rather than retrofit CSRF
 * across every call site at that point, we wire the mechanism in now and gate
 * ENFORCEMENT behind CSRF_ENFORCED (default false). When we flip SameSite=None
 * for LTI we flip CSRF_ENFORCED=true in the same change — the client layer
 * already sends the header, so nothing else moves.
 *
 * Mechanism (double-submit): a readable (NOT HttpOnly) `mh_csrf` cookie is
 * issued to every client; the client echoes its value in the `X-CSRF-Token`
 * header on each mutation. An attacker's cross-site page can trigger a request
 * that carries the victim's cookies but cannot READ the cookie to set the
 * matching header (same-origin policy), so the header/cookie comparison fails.
 */

export const CSRF_COOKIE = 'mh_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** CSRF_ENFORCED (default false) — read at request time so tests can toggle it. */
export function csrfEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CSRF_ENFORCED ?? 'false').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** Read one cookie value from the raw Cookie header (no cookie-parser dependency). */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** Set the readable CSRF cookie, matching the session cookie's SameSite/Secure. */
function issueCookie(res: Response, token: string): void {
  const f = cookieFlags();
  const sameSite = f.sameSite.charAt(0).toUpperCase() + f.sameSite.slice(1); // Lax|Strict|None
  const attrs = [`${CSRF_COOKIE}=${token}`, 'Path=/', `SameSite=${sameSite}`];
  if (f.secure) attrs.push('Secure'); // NOT HttpOnly — the client must read it
  res.append('Set-Cookie', attrs.join('; '));
}

export function csrfMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Ensure the client has a token cookie to echo. Issue one if missing.
    let token = readCookie(req, CSRF_COOKIE);
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      issueCookie(res, token);
    }
    (req as Request & { csrfToken?: string }).csrfToken = token;

    // Never gate safe methods or the dev-only test hooks.
    if (SAFE_METHODS.has(req.method)) return next();
    if ((req.path ?? '').startsWith('/api/test/')) return next();
    if (!csrfEnforced()) return next();

    const sent = req.header(CSRF_HEADER);
    if (!sent || sent !== token) {
      return sendError(req, res, 403, 'csrf_failed', 'missing or invalid CSRF token');
    }
    return next();
  };
}
