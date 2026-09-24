import { pool } from './db.js';
import { isDbUnavailable } from './dbErrors.js';
import { logger } from './logger.js';

/**
 * Named timezones must actually resolve, or every streak is silently wrong.
 *
 * Streak boundaries are per-student local days, computed in SQL with
 * CONVERT_TZ(..., '+00:00', 'Asia/Kolkata'). For a NAMED zone that function
 * returns NULL unless MySQL's mysql.time_zone* tables are populated — and a
 * fresh MySQL install ships them EMPTY. Nothing errors: the streak simply
 * computes as nothing, for everybody, until somebody notices months later.
 *
 * So it is checked at boot, against the zones actually in use, and a failure is
 * a refusal to start with the command that fixes it. Loading them is part of
 * setting a database up (infra/mysql-init/00-timezones.sh does it for the
 * compose stack; `npm run db:timezones` does it anywhere else).
 */

export const DEFAULT_ZONE = 'Asia/Kolkata';

/** Every named zone the data actually uses, plus the default. */
export async function zonesInUse(): Promise<string[]> {
  const zones = new Set<string>([DEFAULT_ZONE]);
  try {
    const [rows] = await pool.query<any[]>(`SELECT DISTINCT timezone FROM students WHERE timezone IS NOT NULL`);
    for (const r of rows) if (typeof r.timezone === 'string' && r.timezone.includes('/')) zones.add(r.timezone);
  } catch (err) {
    // An unreachable database is the caller's to handle (see below). A missing
    // students table is not: a database mid-setup still has a default zone.
    if (isDbUnavailable(err)) throw err;
  }
  return [...zones];
}

/** Zones that do NOT resolve on this server. */
export async function unresolvableZones(): Promise<string[]> {
  const bad: string[] = [];
  for (const zone of await zonesInUse()) {
    const [[row]] = await pool.query<any[]>(`SELECT CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?) AS converted`, [zone]);
    if (row?.converted == null) bad.push(zone);
  }
  return bad;
}

/**
 * Refuse to start on a database where named zones do not resolve. The same
 * fail-closed rule as the rest of the boot checks: a silent wrong answer for
 * every student is worse than a loud refusal for one operator.
 *
 * A database that cannot be REACHED is a different thing entirely, and must not
 * become a boot refusal: /healthz is deliberately about the process, so the api
 * still starts and reports its own health during an outage (and /readyz says the
 * database is the reason). Nothing can be concluded about the timezone tables
 * from a server that did not answer, so the check is skipped and says so; the
 * next restart, when the database is back, does it properly.
 */
export async function assertNamedTimezones(): Promise<void> {
  let bad: string[];
  try {
    bad = await unresolvableZones();
  } catch (err) {
    if (isDbUnavailable(err)) {
      logger.warn(
        { err },
        'could not check named timezones: the database is unreachable — the check will run on the next start'
      );
      return;
    }
    throw err;
  }
  if (bad.length === 0) return;
  throw new Error(
    `this MySQL server cannot resolve the named timezone(s) ${bad.join(', ')}: mysql.time_zone* is empty, ` +
      `so CONVERT_TZ returns NULL and every streak would silently compute as nothing. ` +
      `Load them once with:  npm run db:timezones   ` +
      `(the compose stack does it when the database is created — infra/mysql-init/00-timezones.sh)`
  );
}
