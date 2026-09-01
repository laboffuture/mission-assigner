import { pool } from './db.js';

/**
 * Streaks are COMPUTED from attempt_logs, never stored as a mutable counter.
 * A stored counter drifts (double-counts, misses timezone edges, forgets to
 * decrement); a computed one cannot be wrong.
 *
 * A "submission day" is any calendar day on which the student produced at least
 * one 'submitted' attempt_logs event. The current streak counts consecutive
 * days backwards from today. Today only counts if the student has already
 * submitted today; otherwise we start from yesterday, so an in-progress day
 * with no submission yet does not break an existing streak.
 */

function toISODate(v: unknown): string {
  // mysql2 may return DATE as a JS Date or as a 'YYYY-MM-DD' string.
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** The previous calendar day for a 'YYYY-MM-DD' string, in UTC. */
function prevDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

async function submissionDates(studentId: number): Promise<Set<string>> {
  const [rows] = await pool.query<any[]>(
    `SELECT DISTINCT DATE(created_at) AS d
       FROM attempt_logs
      WHERE student_id = ? AND event = 'submitted'`,
    [studentId]
  );
  return new Set(rows.map((r) => toISODate(r.d)));
}

/** Ask the DB for its notion of "today" so streak math shares the DB's timezone. */
async function dbToday(): Promise<string> {
  const [[row]] = await pool.query<any[]>(`SELECT CURDATE() AS today`);
  return toISODate(row.today);
}

export async function computeStreak(studentId: number): Promise<number> {
  const dates = await submissionDates(studentId);
  if (dates.size === 0) return 0;
  const today = await dbToday();

  // Start at today if they've submitted today, else yesterday (don't break a
  // streak just because the current day is still in progress).
  let cursor = dates.has(today) ? today : prevDay(today);
  if (!dates.has(cursor)) return 0;

  let streak = 0;
  while (dates.has(cursor)) {
    streak++;
    cursor = prevDay(cursor);
  }
  return streak;
}

/** Longest run of consecutive submission days, all-time. */
export async function computeLongestStreak(studentId: number): Promise<number> {
  const dates = [...(await submissionDates(studentId))].sort();
  if (dates.length === 0) return 0;

  let longest = 1;
  let run = 1;
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] === prevDay(dates[i - 1]) || prevDay(dates[i]) === dates[i - 1]) {
      run++;
    } else {
      run = 1;
    }
    if (run > longest) longest = run;
  }
  return longest;
}

export async function computeStreaks(studentId: number): Promise<{ current: number; longest: number }> {
  const [current, longest] = await Promise.all([
    computeStreak(studentId),
    computeLongestStreak(studentId),
  ]);
  return { current, longest };
}
