import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { logger } from './logger.js';

/**
 * Set (or reset) a staff user's password.
 *
 *   npm run set-password -- <username> <newpassword>
 *
 * Bcrypt-hashes the password and writes it to the matching staff row. Refuses to
 * target a student (students authenticate via Moodle SSO, not a local password).
 */
async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    process.stderr.write('usage: npm run set-password -- <username> <newpassword>\n');
    process.exit(2);
  }
  if (password.length < 8) {
    process.stderr.write('password must be at least 8 characters\n');
    process.exit(2);
  }
  try {
    const [rows] = await pool.query<any[]>(`SELECT id, role FROM students WHERE username = ? LIMIT 1`, [username]);
    const user = rows[0];
    if (!user) {
      process.stderr.write(`no user with username "${username}"\n`);
      process.exit(1);
    }
    if (user.role === 'student') {
      process.stderr.write('refusing to set a password on a student (students use Moodle SSO)\n');
      process.exit(1);
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.query(`UPDATE students SET password_hash = ? WHERE id = ?`, [hash, user.id]);
    logger.info({ username, role: user.role }, 'password updated');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error({ err }, 'set-password failed');
  process.exit(1);
});
