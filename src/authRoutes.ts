import type { Express, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { logger } from './logger.js';
import { sendError } from './httpError.js';
import { requireAuth, STAFF_ROLES, type Role } from './auth.js';

/**
 * Staff authentication routes (username + password → signed session cookie).
 *
 * Only staff roles (sme/qc/admin/instructor) have local credentials; students
 * arrive via Moodle SSO and never hit /api/login. Login is deliberately generic
 * on failure (same 401 for unknown user and wrong password) so it can't be used
 * to enumerate accounts. On success we store only the user id in the session.
 */

const rlog = (req: Request) => (req as any).log ?? logger;

export function registerAuthRoutes(app: Express): void {
  // POST /api/login { username, password } → set session cookie, return the user.
  app.post('/api/login', async (req: Request, res: Response) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password) {
      return sendError(req, res, 400, 'validation_error', 'username and password are required');
    }
    try {
      const [rows] = await pool.query<any[]>(
        `SELECT id, display_name, role, password_hash FROM students WHERE username = ? LIMIT 1`,
        [username]
      );
      const user = rows[0];
      // Constant-ish path: always compare against a hash so timing doesn't reveal
      // whether the username exists.
      const hash = user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
      const ok = await bcrypt.compare(password, hash);
      const isStaff = user && (STAFF_ROLES as readonly string[]).includes(user.role);
      if (!user || !ok || !isStaff) {
        return sendError(req, res, 401, 'invalid_credentials', 'invalid username or password');
      }
      req.session = { uid: Number(user.id) };
      rlog(req).info({ userId: Number(user.id), role: user.role }, 'staff login');
      res.json({ id: Number(user.id), display_name: user.display_name, role: user.role as Role });
    } catch (err) {
      rlog(req).error({ err }, 'login failed');
      sendError(req, res, 500, 'internal_error', 'login failed');
    }
  });

  // POST /api/logout → clear the session cookie.
  app.post('/api/logout', (req: Request, res: Response) => {
    req.session = null;
    res.json({ ok: true });
  });

  // GET /api/me → the current identity (works for staff sessions AND, in dev,
  // the header-based student). 401 when unauthenticated so the UI can redirect.
  app.get('/api/me', requireAuth, async (req: Request, res: Response) => {
    const auth = req.auth!;
    try {
      const [rows] = await pool.query<any[]>(`SELECT id, display_name, role FROM students WHERE id = ?`, [auth.userId]);
      const u = rows[0];
      res.json({ id: auth.userId, role: auth.role, display_name: u?.display_name ?? null });
    } catch (err) {
      rlog(req).error({ err }, 'request failed');
      sendError(req, res, 500, 'internal_error', 'failed to load current user');
    }
  });
}
