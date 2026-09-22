/**
 * The MySQL port, from DB_PORT (default 3306). Every connection — the app pool,
 * the root pool, the migrator — must use this, the same variable the backup
 * scripts use, so the app and its backups can never talk to different servers.
 * (The port used to be hardcoded to 3306 here and silently ignored DB_PORT.)
 */
export function dbPort(): number {
  const raw = process.env.DB_PORT;
  if (raw == null || raw.trim() === '') return 3306;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`DB_PORT must be a port number (got "${raw}")`);
  return n;
}
