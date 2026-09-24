import mysql from 'mysql2/promise';
import type { Connection } from 'mysql2/promise';
import { dbPort } from './dbConfig.js';

/**
 * One api process per database — enforced, not assumed.
 *
 * Two pieces of state live in this process rather than in MySQL: the login rate
 * limiter's buckets and the feedback-question cache. A second api process would
 * keep its own copy of both, so six failed sign-ins could become twelve and a
 * question change could be visible to half the students. INSTANCE_COUNT in
 * .env.production DECLARES the intent; this claims it.
 *
 * The claim is a MySQL named lock held on a dedicated connection for the life of
 * the process. A second process reaching the same database cannot take it and
 * refuses to boot, naming what is already running — which is what a
 * `docker compose up --scale api=2`, or a redeploy that leaves the old container
 * running, actually looks like. An environment variable could not have caught
 * either: neither of them changes it.
 *
 * Scoped to the database name, so a scratch or restored database is a different
 * instance and test harnesses do not fight each other.
 *
 * Production only. Development runs servers side by side on purpose (a harness
 * boots one while the dev server runs), and a lock there would break that for no
 * safety gain — nothing in development is protecting a student's session.
 */

const LOCK_TIMEOUT_SECONDS = 0; // fail immediately; do not queue behind the other process

export interface InstanceClaim {
  lockName: string;
  release(): Promise<void>;
}

let held: InstanceClaim | null = null;

export function lockNameFor(database: string): string {
  // MySQL truncates lock names at 64 characters; the database name is the only
  // variable part, so keep the prefix short and the name whole.
  return `mission_hub_instance:${database}`.slice(0, 64);
}

/**
 * Claim this database for this process. Throws with a message meant for an
 * operator reading a crashed container's logs.
 */
export async function claimSingleInstance(): Promise<InstanceClaim> {
  const database = process.env.DB_NAME ?? 'mission_demo';
  const declared = process.env.INSTANCE_COUNT;
  if (declared !== undefined && declared !== '' && Number(declared) !== 1) {
    throw new Error(
      `INSTANCE_COUNT=${declared} is not supported: the login rate limiter and the feedback-question ` +
        `cache live in this process, so a second instance would keep its own copy of both and the two ` +
        `would disagree. Run exactly one api container (INSTANCE_COUNT=1), or move that state to a ` +
        `shared store first (src/rateLimit.ts is the single place to swap it in).`
    );
  }

  const lockName = lockNameFor(database);
  const conn: Connection = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASS ?? '',
    port: dbPort(),
    timezone: 'Z',
  });

  let got: unknown;
  try {
    const [rows] = await conn.query<any[]>('SELECT GET_LOCK(?, ?) AS ok', [lockName, LOCK_TIMEOUT_SECONDS]);
    got = rows?.[0]?.ok;
  } catch (err) {
    await conn.end().catch(() => {});
    throw err;
  }

  if (Number(got) !== 1) {
    await conn.end().catch(() => {});
    throw new Error(
      `another api process is already running against the database "${database}" (lock ${lockName} is held). ` +
        `This process is refusing to start rather than run a second copy of the login rate limiter and the ` +
        `feedback-question cache. Stop the other container, or check that a previous deploy actually exited.`
    );
  }

  // The lock lives on THIS connection only; when it closes, MySQL releases it,
  // which is exactly the behaviour wanted if this process dies.
  const claim: InstanceClaim = {
    lockName,
    async release() {
      held = null;
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
      } catch {
        // The connection may already be gone (that releases the lock too).
      }
      await conn.end().catch(() => {});
    },
  };
  held = claim;
  return claim;
}

/** The claim this process holds, if any — released by the shutdown handler. */
export function currentClaim(): InstanceClaim | null {
  return held;
}
