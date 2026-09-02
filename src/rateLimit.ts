/**
 * Login rate limiter.
 *
 * Caps failed sign-in attempts at MAX_FAILURES per username per WINDOW. Keyed on
 * the SUBMITTED username (normalised), counted identically whether or not that
 * user exists — so a 429 never reveals account existence. A successful login
 * clears the bucket, so a legitimate user who eventually types the right
 * password is not left locked out.
 *
 * Storage is in-process: correct for a single instance (our current deploy). A
 * horizontally-scaled deployment would need a shared store (e.g. Redis) so the
 * count is global; this module is the single place to swap that in.
 *
 * NOTE: per-username limiting means an attacker can lock a known username out
 * for the window (targeted DoS). That is an accepted trade-off of the requested
 * design; revisit with a combined per-IP limit if it becomes a problem.
 */

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILURES = 5;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function keyFor(username: string): string {
  return username.trim().toLowerCase();
}

function liveBucket(key: string, now: number): Bucket | null {
  const b = buckets.get(key);
  if (!b) return null;
  if (now >= b.resetAt) {
    buckets.delete(key);
    return null;
  }
  return b;
}

/** True if this username has already used up its attempts for the window. */
export function isRateLimited(username: string, now = Date.now()): boolean {
  const b = liveBucket(keyFor(username), now);
  return b != null && b.count >= MAX_FAILURES;
}

/** Seconds until the window resets (for a Retry-After header). 0 if not limited. */
export function retryAfterSeconds(username: string, now = Date.now()): number {
  const b = liveBucket(keyFor(username), now);
  if (!b || b.count < MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
}

/** Record one failed attempt, starting or extending the window. */
export function recordFailure(username: string, now = Date.now()): void {
  const key = keyFor(username);
  const b = liveBucket(key, now);
  if (!b) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    b.count += 1;
  }
}

/** Clear a username's bucket (call on successful login). */
export function clearAttempts(username: string): void {
  buckets.delete(keyFor(username));
}

/** Test hook: wipe all buckets (or one username) for deterministic tests. */
export function resetRateLimiter(username?: string): void {
  if (username) buckets.delete(keyFor(username));
  else buckets.clear();
}

export const RATE_LIMIT = { WINDOW_MS, MAX_FAILURES } as const;
