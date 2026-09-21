import { isProduction } from './testHooks.js';

/**
 * Guard for commands that truncate or drop data (db:seed, migrate down, ...).
 *
 * Under NODE_ENV=production they refuse to run — exiting non-zero BEFORE any
 * statement reaches the database — unless the operator passes this flag, which
 * is deliberately long and specific so nobody sets it by accident or by habit.
 * The shell scripts (scripts/restore.sh, demo-reset.sh) implement the same rule
 * with the same flag.
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
