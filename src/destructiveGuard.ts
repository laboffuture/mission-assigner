import { isProduction } from './testHooks.js';

/**
 * Guard for commands that truncate or drop data (db:seed, migrate down, ...).
 *
 * TWO refusals, same override flag:
 *
 *  - NODE_ENV=production. They exit non-zero BEFORE any statement reaches the
 *    database, unless the operator passes the flag below, which is deliberately
 *    long and specific so nobody sets it by accident or by habit. The shell
 *    scripts (scripts/restore.sh, demo-reset.sh) implement the same rule with the
 *    same flag.
 *  - A PROTECTED database, whatever NODE_ENV says. `db:seed` truncates `tracks`,
 *    so running it against the database that holds real pilot curriculum deletes
 *    that curriculum — which is exactly how Tesla's Track disappeared from the
 *    dev database while the audit harness reseeded it sixteen times a run. The
 *    pilot content now lives in its own database and nothing that truncates will
 *    touch it by name.
 */
export const DESTRUCTIVE_OVERRIDE_FLAG = '--i-understand-this-destroys-production-data';

export function refuseDestructiveInProduction(
  action: string,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!isProduction(env)) return;
  if (argv.includes(DESTRUCTIVE_OVERRIDE_FLAG)) {
    process.stderr.write(`\nWARNING: ${action} under NODE_ENV=production — override flag given, proceeding.\n\n`);
    return;
  }
  process.stderr.write(
    `\nFATAL: refusing to ${action}: NODE_ENV=production and this destroys data.\n` +
      `Nothing has been changed. If you really intend it, re-run with ${DESTRUCTIVE_OVERRIDE_FLAG}\n\n`
  );
  process.exit(2);
}

/**
 * Databases holding real content rather than fixtures. Override with
 * PROTECTED_DB_NAMES (comma separated) — the default protects the pilot database
 * with no configuration at all, because a guard you have to remember to switch on
 * is not a guard.
 */
export const DEFAULT_PROTECTED_DB_NAMES = ['mission_pilot'] as const;

export function protectedDbNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PROTECTED_DB_NAMES;
  if (raw === undefined) return [...DEFAULT_PROTECTED_DB_NAMES];
  return raw
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
}

/**
 * Refuse a destructive command against a protected database. Reads DB_NAME, so
 * it catches the way this actually goes wrong: the right command run with the
 * wrong database selected.
 */
export function refuseDestructiveOnProtectedDatabase(
  action: string,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): void {
  const dbName = (env.DB_NAME ?? 'mission_demo').trim();
  if (!protectedDbNames(env).includes(dbName)) return;
  if (argv.includes(DESTRUCTIVE_OVERRIDE_FLAG)) {
    process.stderr.write(`\nWARNING: ${action} against protected database '${dbName}' — override flag given.\n\n`);
    return;
  }
  process.stderr.write(
    `\nFATAL: refusing to ${action}: DB_NAME='${dbName}' is a protected database — it holds real\n` +
      `content, not fixtures, and this destroys data. Nothing has been changed.\n` +
      `Point DB_NAME at the test database (mission_demo) instead. If you really intend it,\n` +
      `re-run with ${DESTRUCTIVE_OVERRIDE_FLAG}\n\n`
  );
  process.exit(2);
}
