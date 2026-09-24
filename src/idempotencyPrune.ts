import type { Pool } from 'mysql2/promise';
import { pool } from './db.js';
import { logger } from './logger.js';

/**
 * Retention for the idempotency store.
 *
 * Every submit writes a row to idempotency_keys and nothing ever removed one.
 * The rows exist to answer "has this exact submit already been graded?" for a
 * student who retried — a question that is only ever asked seconds after the
 * original, and never days later. They are not a record of anything: the graded
 * result lives in attempts, and the assignment row carries the outcome. Keeping
 * them forever grows a table (and its unique index) for no reader.
 *
 * So they expire. IDEMPOTENCY_TTL_DAYS defaults to 7, which is far longer than
 * any retry and short enough that the table stays flat. Deleting is safe even if
 * a client retried after the window: without a stored key the submit is graded
 * on its merits, and the slot's own "already answered" rule still stops a second
 * grade — replay protection degrades to the normal path, never to a double grade.
 *
 * Deletes in bounded batches so a first sweep on a large table cannot hold a long
 * lock against students who are submitting.
 */

const BATCH = 500;
const MAX_BATCHES = 200; // 100k rows in one sweep, then wait for the next tick
const INTERVAL_MS = 60 * 60 * 1000; // hourly

export function ttlDays(): number {
  const raw = Number(process.env.IDEMPOTENCY_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7;
}

/** Delete expired rows. Returns how many went. */
export async function pruneIdempotencyKeys(p: Pool = pool, days: number = ttlDays()): Promise<number> {
  let removed = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const [res] = await p.query<any>(
      `DELETE FROM idempotency_keys
        WHERE created_at < (UTC_TIMESTAMP() - INTERVAL ? DAY)
        ORDER BY created_at
        LIMIT ${BATCH}`,
      [days]
    );
    const n = Number(res?.affectedRows ?? 0);
    removed += n;
    if (n < BATCH) break;
  }
  return removed;
}

/**
 * Sweep on a timer. One api process owns the database (src/singleInstance.ts),
 * so an in-process timer is the whole mechanism — no cron, no second scheduler.
 * The timer is unref'd: a pending sweep never holds the process open during a
 * deploy.
 */
export function startIdempotencyPruner(): NodeJS.Timeout {
  const days = ttlDays();
  const sweep = () => {
    pruneIdempotencyKeys(pool, days)
      .then((removed) => {
        if (removed > 0) logger.info({ removed, ttlDays: days }, 'idempotency keys pruned');
      })
      .catch((err) => logger.warn({ err }, 'idempotency prune failed'));
  };
  sweep();
  const timer = setInterval(sweep, INTERVAL_MS);
  timer.unref();
  return timer;
}
