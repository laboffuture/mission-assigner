import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import { pool } from './db.js';
import { currentClaim } from './singleInstance.js';
import { MIGRATION_NAMES } from './migrator.js';
import { logger } from './logger.js';

/**
 * Liveness, readiness and shutdown — what an orchestrator needs to run this
 * process without dropping a student's work.
 *
 * The two probes answer different questions, which is why there are two:
 *   /healthz  is this PROCESS alive? No dependencies, no queries, always fast.
 *             A failing /healthz means restart me.
 *   /readyz   can I SERVE? The database answers and its schema matches this
 *             build. A failing /readyz means send traffic elsewhere (or, during
 *             a deploy, not yet) — but do not restart me.
 *
 * Neither reveals the version, the schema, the database host or an error
 * string: they are reachable without authentication, so they say only as much
 * as an operator needs.
 */

let shuttingDown = false;

/** GET /healthz — the process is up and the event loop is turning. */
export function healthz(_req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  // Once shutting down, stop claiming to be healthy so nothing new arrives.
  res.status(shuttingDown ? 503 : 200).json({ status: shuttingDown ? 'shutting_down' : 'ok' });
}

/** GET /readyz — the database answers and the schema is the one this build expects. */
export async function readyz(_req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  try {
    const [rows] = await pool.query<any[]>(`SELECT name FROM schema_migrations`);
    const applied = new Set(rows.map((r) => r.name));
    const pending = MIGRATION_NAMES.filter((n) => !applied.has(n));
    if (pending.length > 0) {
      // Count, not names: the reason is for us in the logs, not for the caller.
      logger.warn({ pending }, 'not ready: migrations pending');
      return res.status(503).json({ status: 'not_ready', reason: 'schema' });
    }
    return res.status(200).json({ status: 'ready' });
  } catch (err) {
    logger.warn({ err }, 'not ready: database unreachable');
    return res.status(503).json({ status: 'not_ready', reason: 'database' });
  }
}

/**
 * Stop cleanly on SIGTERM (what `docker stop` and a compose redeploy send).
 *
 * Order matters: stop accepting new connections FIRST, let the requests already
 * in flight finish — a student's submit is mid-transaction and must not be cut
 * off — then close the pool and exit 0. A hard deadline stops a stuck request
 * from holding the deploy open forever.
 */
export function installShutdownHandlers(server: Server, { timeoutMs = 20_000 } = {}) {
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown: draining in-flight requests');

    const forced = setTimeout(() => {
      logger.warn({ timeoutMs }, 'shutdown: deadline reached, exiting with requests still in flight');
      pool.end().finally(() => process.exit(0));
    }, timeoutMs);
    forced.unref();

    server.close(async () => {
      clearTimeout(forced);
      try {
        // Hand the database back before the pool goes: the next container can
        // then claim it immediately instead of waiting for MySQL to notice a
        // dropped connection.
        await currentClaim()?.release();
      } catch (err) {
        logger.warn({ err }, 'shutdown: releasing the instance lock failed');
      }
      try {
        await pool.end();
      } catch (err) {
        logger.warn({ err }, 'shutdown: closing the pool failed');
      }
      logger.info('shutdown: complete');
      process.exit(0);
    });
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => shutdown(signal));
}

/** Test seam: whether this process has begun shutting down. */
export const isShuttingDown = () => shuttingDown;
