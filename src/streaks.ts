import { pool } from './db.js';

/**
 * Streaks are COMPUTED from attempt_logs, never stored as a mutable counter,
 * and are bucketed by the STUDENT'S local day boundary (Item 7), not the
 * server's. Timestamps are stored UTC; the UTC->local conversion and the "what
 * day is it" question are both answered in SQL with CONVERT_TZ against the
 * student's timezone. The only JS date logic is stepping to the previous
 * calendar day of a 'YYYY-MM-DD' string, which is timezone-neutral.
 *
 * A "submission day" is any local calendar day on which the student produced at
 * least one 'submitted' attempt_logs event. The current streak counts backwards
 * from the student's local today; today only counts if they have already
 * submitted today, otherwise we start from yesterday so an in-progress day does
 * not break the streak.
 */

function toISODate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Previous calendar day for a 'YYYY-MM-DD' string (UTC math — no zone shift). */
function prevDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

async function studentTimezone(studentId: number): Promise<string> {
  const [[row]] = await pool.query<any[]>(`SELECT timezone FROM students WHERE id = ?`, [studentId]);
  return (row && row.timezone) || 'Asia/Kolkata';
}

/** Distinct LOCAL calendar dates on which the student submitted. */
async function submissionDates(studentId: number, tz: string): Promise<Set<string>> {
  const [rows] = await pool.query<any[]>(
    `SELECT DISTINCT DATE(CONVERT_TZ(created_at, '+00:00', ?)) AS d
       FROM attempt_logs
      WHERE student_id = ? AND event = 'submitted'`,
    [tz, studentId]
  );
  return new Set(rows.map((r) => toISODate(r.d)).filter((s) => s && s !== 'null'));
}

/** The student's local "today" (their zone's current calendar date). */
async function localToday(tz: string): Promise<string> {
  const [[row]] = await pool.query<any[]>(`SELECT DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?)) AS today`, [tz]);
  return toISODate(row.today);
}

export async function computeStreak(studentId: number): Promise<number> {
  const tz = await studentTimezone(studentId);
  const dates = await submissionDates(studentId, tz);
  if (dates.size === 0) return 0;
  const today = await localToday(tz);

  let cursor = dates.has(today) ? today : prevDay(today);
  if (!dates.has(cursor)) return 0;

  let streak = 0;
  while (dates.has(cursor)) {
    streak++;
    cursor = prevDay(cursor);
  }
  return streak;
}

/** Longest run of consecutive local submission days, all-time. */
export async function computeLongestStreak(studentId: number): Promise<number> {
  const tz = await studentTimezone(studentId);
  const dates = [...(await submissionDates(studentId, tz))].sort();
  if (dates.length === 0) return 0;

  let longest = 1;
  let run = 1;
  for (let i = 1; i < dates.length; i++) {
    if (prevDay(dates[i]) === dates[i - 1]) run++;
    else run = 1;
    if (run > longest) longest = run;
  }
  return longest;
}

export async function computeStreaks(studentId: number): Promise<{ current: number; longest: number }> {
  const [current, longest] = await Promise.all([computeStreak(studentId), computeLongestStreak(studentId)]);
  return { current, longest };
}
