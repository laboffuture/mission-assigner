import 'dotenv/config';
import { pool } from './db.js';
import { publishWeek } from './weekPublisher.js';
import { logger } from './logger.js';

/**
 * Manual week publisher. In production this runs on a schedule.
 *
 *   npm run publish -- <studentId> [weekStart=YYYY-MM-DD]
 *   npm run publish -- all         [weekStart=YYYY-MM-DD]
 *
 * Idempotent: re-running for the same (student, week_start) is a no-op.
 */
function mondayOf(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const diff = (copy.getUTCDay() + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - diff);
  return copy.toISOString().slice(0, 10);
}

async function main() {
  const target = process.argv[2];
  const weekStart = process.argv[3] ?? mondayOf(new Date());
  if (!target) {
    logger.error('Usage: npm run publish -- <studentId|all> [weekStart=YYYY-MM-DD]');
    process.exit(1);
  }

  let ids: number[];
  if (target === 'all') {
    const [rows] = await pool.query<any[]>(`SELECT id FROM students ORDER BY id`);
    ids = rows.map((r) => Number(r.id));
  } else {
    ids = [Number(target)];
  }

  for (const id of ids) {
    const wk = await publishWeek(id, weekStart);
    logger.info(
      { studentId: id, weekStart, created: wk.created, slots: wk.slots.length },
      wk.created ? 'week published' : 'week already existed (no-op)'
    );
  }
  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, 'publish failed');
  process.exit(1);
});
