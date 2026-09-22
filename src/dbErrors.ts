/**
 * Is this error "the database is unreachable" rather than a bug or a bad request?
 *
 * A database outage must be reported as what it is — 503 service_unavailable,
 * logged as a database error — never as an authentication failure (audit #39:
 * every outage used to surface as 500 "authentication failed", because the
 * first query of any request is the identity lookup).
 *
 * mysql2 reports connection-level failures with a network/protocol `code` and
 * `fatal: true`; Node may wrap a refused dual-stack connect in an AggregateError
 * whose own code is empty, so nested `errors` / `cause` are checked too.
 */
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_CON_COUNT_ERROR',
  'ER_TOO_MANY_USER_CONNECTIONS',
  'ER_SERVER_SHUTDOWN',
  'ER_ACCESS_DENIED_ERROR',
  'POOL_CLOSED',
]);

export function isDbUnavailable(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 3) return false;
  const e = err as { code?: unknown; fatal?: unknown; errors?: unknown; cause?: unknown };
  if (typeof e.code === 'string' && UNAVAILABLE_CODES.has(e.code)) return true;
  if (e.fatal === true) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => isDbUnavailable(x, depth + 1))) return true;
  return isDbUnavailable(e.cause, depth + 1);
}

/** What a student (or anyone) is told during an outage. Deliberately says
 *  nothing about authentication, and nothing about the database's internals. */
export const UNAVAILABLE_MESSAGE = 'The service is temporarily unavailable. Please try again in a moment';
