import type { Request, Response, NextFunction } from 'express';
import { pool } from './db.js';
import { logger } from './logger.js';
import { sendError } from './httpError.js';

/**
 * Authentication & authorisation.
 *
 * Identity is resolved by a pluggable AuthProvider selected by AUTH_MODE:
 *   - dev  (default): DevAuthProvider — reads an X-User-Id header. INSECURE; for
 *                     local development and tests only.
 *   - lti            : LtiAuthProvider — will read the LTI launch token. STUB.
 *
 * The provider returns an AuthContext ({ userId, role, subject }) which
 * `requireAuth` attaches to req.auth. `requireRole` gates by role. Ownership of
 * per-student data is enforced with the authenticated id in the SQL WHERE clause
 * (see server.ts), never by fetching a row and comparing in JS.
 */

export type Role = 'student' | 'sme' | 'qc' | 'instructor' | 'admin';

/** Non-student roles — staff who may see cross-student / internal views. */
export const STAFF_ROLES: readonly Role[] = ['sme', 'qc', 'instructor', 'admin'];

export interface AuthContext {
  userId: number;
  role: Role;
  subject: string | null;
}

export interface AuthProvider {
  readonly mode: string;
  /** Return the caller's AuthContext, or null if the request is unauthenticated. */
  authenticate(req: Request): Promise<AuthContext | null>;
}

// Augment Express.Request with the resolved auth context.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * DevAuthProvider — identity from an `X-User-Id` header (with `X-Student-Id` as a
 * backward-compatible alias). The role and subject are loaded from the users
 * (students) table. This trusts a client-supplied header and is INSECURE: it
 * exists so the demo UI and the test harnesses can act as a chosen user without
 * a real IdP. Never enable AUTH_MODE=dev in production.
 */
export class DevAuthProvider implements AuthProvider {
  readonly mode = 'dev';

  async authenticate(req: Request): Promise<AuthContext | null> {
    const raw = req.header('x-user-id') ?? req.header('x-student-id');
    if (raw == null || raw === '') return null;
    const userId = Number(raw);
    if (!Number.isInteger(userId) || userId <= 0) return null;

    const [rows] = await pool.query<any[]>(`SELECT id, role, subject FROM students WHERE id = ?`, [userId]);
    if (rows.length === 0) return null;
    return {
      userId: Number(rows[0].id),
      role: rows[0].role as Role,
      subject: rows[0].subject ?? null,
    };
  }
}

/**
 * LtiAuthProvider — will validate an LTI 1.3 launch token and map it to a user.
 * STUB: we do not have LTI access yet, so this throws. Selecting AUTH_MODE=lti
 * therefore fails loudly rather than silently allowing access.
 */
export class LtiAuthProvider implements AuthProvider {
  readonly mode = 'lti';

  async authenticate(_req: Request): Promise<AuthContext | null> {
    throw new Error(
      'LtiAuthProvider not yet implemented — LTI launch-token support is pending. ' +
        'Set AUTH_MODE=dev for local development.'
    );
  }
}

let providerSingleton: AuthProvider | null = null;

export function getAuthProvider(): AuthProvider {
  if (providerSingleton) return providerSingleton;
  const mode = (process.env.AUTH_MODE ?? 'dev').trim().toLowerCase();
  providerSingleton = mode === 'lti' ? new LtiAuthProvider() : new DevAuthProvider();
  return providerSingleton;
}

/** Test/ops hook — clear the memoised provider so the next call re-reads AUTH_MODE. */
export function resetAuthProvider(): void {
  providerSingleton = null;
}

function unauthenticated(req: Request, res: Response) {
  return sendError(req, res, 401, 'unauthenticated', 'authentication required');
}

/** Populate req.auth or reject with 401. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = await getAuthProvider().authenticate(req);
    if (!auth) {
      unauthenticated(req, res);
      return;
    }
    req.auth = auth;
    next();
  } catch (err) {
    // e.g. the LTI stub throwing. Never leak details to the client.
    const log = (req as any).log ?? logger;
    log.error({ err }, 'authentication error');
    sendError(req, res, 500, 'auth_error', 'authentication failed');
  }
}

/** Gate an endpoint to one of the given roles (requireAuth must run first). */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      unauthenticated(req, res);
      return;
    }
    if (!roles.includes(req.auth.role)) {
      sendError(req, res, 403, 'forbidden', `requires role: ${roles.join(', ')}`);
      return;
    }
    next();
  };
}

/**
 * Resolve the target student id for a per-student endpoint, enforcing ownership.
 *
 * A student may only address their OWN id: if the path id differs from the
 * authenticated id we reject with 403 (not an empty 200). Staff may address any
 * id. The returned id is what the caller must use in the query's WHERE clause,
 * so a student's queries are always keyed to their authenticated id.
 *
 * Returns null if it has already sent a 403 response.
 */
export function resolveOwnedStudent(req: Request, res: Response, pathId: number): number | null {
  const auth = req.auth!;
  if (auth.role === 'student') {
    if (pathId !== auth.userId) {
      sendError(req, res, 403, 'forbidden', "cannot access another user's data");
      return null;
    }
    return auth.userId;
  }
  return pathId; // staff may read the requested student
}

/**
 * Loud boot warning when running with insecure dev auth. Call once at startup.
 */
export function warnIfInsecureAuth(): void {
  const provider = getAuthProvider();
  if (provider.mode === 'dev') {
    logger.warn(
      { insecure: true, authMode: 'dev' },
      'SECURITY: AUTH_MODE=dev — identity comes from a client-set X-User-Id header. ' +
        'This is INSECURE and MUST NOT be used in production. Set AUTH_MODE=lti before shipping to real students.'
    );
  }
}
