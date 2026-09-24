import { logger } from './logger.js';

/**
 * Retrying the database failures that are worth retrying.
 *
 * Two MySQL failures are not bugs and not outages — they are the normal cost of
 * concurrent writes, and the transaction that hit one can simply be run again:
 *
 *   ER_LOCK_DEADLOCK (1213)     InnoDB picked this transaction as the victim and
 *                               rolled it back. The work is untouched.
 *   ER_LOCK_WAIT_TIMEOUT (1205) Another transaction held the row longer than the
 *                               wait timeout. The statement failed; nothing wrote.
 *
 * Both reached the student as "something went wrong" on a submit they will now
 * repeat by hand. Also retried: a connection dropped underneath us (a database
 * restart, a network blip), where nothing can have committed either.
 *
 * ONLY safe around a whole transaction that rolls back on failure. Anything
 * partially applied must not come through here — the retry would repeat the
 * applied part. src/grading.ts's submitAndGrade owns its transaction end to end,
 * which is exactly why it is the call that gets wrapped.
 */

const TRANSIENT_CODES = new Set([
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
]);
const TRANSIENT_ERRNOS = new Set([1213, 1205]);

export function isTransientDbError(err: unknown): boolean {
  const e = err as { code?: unknown; errno?: unknown } | null;
  if (!e) return false;
  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) return true;
  if (typeof e.errno === 'number' && TRANSIENT_ERRNOS.has(e.errno)) return true;
  return false;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying only the transient failures above. Backs off a little
 * between attempts — two transactions that deadlocked and retried in lockstep
 * would just deadlock again — and gives up with the ORIGINAL error so the caller
 * still sees what actually failed.
 */
export async function withDbRetry<T>(
  label: string,
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 60 }: RetryOptions = {}
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientDbError(err) || attempt === attempts) throw err;
      const delay = baseDelayMs * attempt + Math.floor(Math.random() * baseDelayMs);
      logger.warn(
        { label, attempt, attempts, delay, code: (err as { code?: string })?.code },
        'transient database failure — retrying'
      );
      await sleep(delay);
    }
  }
  throw lastError;
}
