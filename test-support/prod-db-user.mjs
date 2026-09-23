import { randomBytes } from 'node:crypto';

/**
 * A throwaway MySQL user with a real password, for harnesses that boot the app
 * with NODE_ENV=production.
 *
 * Production refuses to start when a secret still looks like a placeholder or a
 * shipped default — and the local database password IS such a default
 * ('devpass'). A harness that simulates production therefore cannot use it.
 * Rather than weaken that check to suit the tests, each harness creates a user
 * of its own here, boots as that user, and drops it afterwards.
 *
 *   const dbUser = await createProdDbUser(pool, 'failclosed');
 *   ... boot with { ...dbUser.env }
 *   await dbUser.drop();
 */
export async function createProdDbUser(pool, tag, { databases } = {}) {
  const user = `mh_${tag}`.slice(0, 30);
  const pass = `pw-${randomBytes(12).toString('hex')}`;
  // Every database the harness will point the booted app at — a harness that
  // boots against a scratch database needs rights there, not on the live one.
  const grants = databases ?? [process.env.DB_NAME ?? 'mission_demo'];
  await pool.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [user, pass]);
  await pool.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [user, pass]);
  for (const db of grants) await pool.query(`GRANT ALL PRIVILEGES ON \`${db}\`.* TO ?@'%'`, [user]);
  await pool.query(`FLUSH PRIVILEGES`);
  return {
    user,
    pass,
    env: { DB_USER: user, DB_PASS: pass },
    drop: () => pool.query(`DROP USER IF EXISTS ?@'%'`, [user]).catch(() => {}),
  };
}
