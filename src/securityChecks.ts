import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { STAFF_ROLES } from './auth.js';

/**
 * Production security gate.
 *
 * The seed gives every staff account a shared default password
 * (STAFF_DEFAULT_PASSWORD, default "changeme"). That is fine locally but must
 * never survive into production. Because we store bcrypt hashes (not the
 * plaintext), we detect a still-default account by bcrypt-comparing each staff
 * hash against the known default. Any match in production is a hard boot failure
 * that names the offending accounts.
 */

/** The default password the seed would have used (must match seed.ts). */
export function defaultStaffPassword(): string {
  return process.env.STAFF_DEFAULT_PASSWORD || 'changeme';
}

/** Usernames of staff whose password still equals the seed default. */
export async function findDefaultStaffPasswords(): Promise<string[]> {
  const roles = [...STAFF_ROLES] as string[];
  const placeholders = roles.map(() => '?').join(', ');
  const [rows] = await pool.query<any[]>(
    `SELECT username, password_hash FROM students
      WHERE role IN (${placeholders}) AND username IS NOT NULL AND password_hash IS NOT NULL`,
    roles
  );
  const def = defaultStaffPassword();
  const offenders: string[] = [];
  for (const r of rows) {
    if (await bcrypt.compare(def, r.password_hash)) offenders.push(r.username);
  }
  return offenders;
}

/**
 * Assert production-only security invariants. In any non-production environment
 * this is a no-op (the defaults are meant for local use). In production it
 * throws a fatal, account-naming error if any staff account still has the
 * default password.
 */
export async function assertProductionSecurity(): Promise<void> {
  if ((process.env.NODE_ENV ?? 'development') !== 'production') return;
  const offenders = await findDefaultStaffPasswords();
  if (offenders.length > 0) {
    throw new Error(
      `refusing to start in production: these staff accounts still have the DEFAULT password ` +
        `("${defaultStaffPassword()}"): ${offenders.join(', ')}. ` +
        `Set a real password for each with:  npm run set-password -- <username> <newpassword>`
    );
  }
}
