import { logger } from './logger.js';

/**
 * Optional Sentry error tracking (Item 2).
 *
 * Enabled only when SENTRY_DSN is set. The package is imported dynamically so
 * that when the DSN is unset it is never loaded — Sentry is not a hard
 * dependency and the app runs identically without it. captureException is a
 * no-op until init succeeds.
 */

let sentry: typeof import('@sentry/node') | null = null;

export async function initSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info('Sentry disabled (SENTRY_DSN not set)');
    return;
  }
  try {
    const S = await import('@sentry/node');
    S.init({ dsn, tracesSampleRate: 0 });
    sentry = S;
    logger.info('Sentry initialised');
  } catch (err) {
    logger.warn({ err }, 'Sentry init failed; continuing without it');
  }
}

export function captureException(err: unknown): void {
  if (!sentry) return;
  try {
    sentry.captureException(err);
  } catch {
    /* never let error reporting throw */
  }
}
