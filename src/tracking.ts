import type { PoolConnection } from 'mysql2/promise';
import { pool } from './db.js';
import { computeStreaks } from './streaks.js';

export type AttemptEvent = 'opened' | 'viewed' | 'submitted' | 'graded' | 'feedback_submitted';

/**
 * logAttempt — the single audit-trail helper, called from slot open, mission
 * view, submit, grade and feedback submit. Pass a `conn` to write inside an
 * existing transaction (so the log commits atomically with the action);
 * otherwise it writes on its own pooled connection.
 */
export async function logAttempt(
  assignmentId: number,
  studentId: number,
  event: AttemptEvent,
  detail: unknown = null,
  conn?: PoolConnection
): Promise<void> {
  const runner = conn ?? pool;
  await runner.query(
    `INSERT INTO attempt_logs (assignment_id, student_id, event, detail)
     VALUES (?, ?, ?, ?)`,
    [assignmentId, studentId, event, detail == null ? null : JSON.stringify(detail)]
  );
}

// ---------------------------------------------------------------------------
// getStudentProgress
// ---------------------------------------------------------------------------
export interface StudentProgress {
  student_id: number;
  display_name: string;
  current_level: number;
  segment_name: string | null;
  total_xp: number;
  attempted: number;
  submitted: number;
  correct: number;
  current_streak: number;
  longest_streak: number;
  feedback_completion_rate: number; // 0..1
  level_history: any[];
  xp_history: any[];
}

export async function getStudentProgress(studentId: number): Promise<StudentProgress | null> {
  const [studentRows] = await pool.query<any[]>(
    `SELECT s.id, s.display_name, s.current_level, s.total_xp, seg.name AS segment_name
       FROM students s
       LEFT JOIN segments seg ON seg.id = s.segment_id
      WHERE s.id = ?`,
    [studentId]
  );
  if (studentRows.length === 0) return null;
  const s = studentRows[0];

  const [[counts]] = await pool.query<any[]>(
    `SELECT
        COUNT(*)                                                        AS attempted,
        SUM(status = 'graded')                                          AS submitted,
        SUM(score_band IN ('pass','pass_strong'))                       AS correct,
        SUM(status = 'graded' AND feedback_status <> 'not_required')    AS feedback_eligible,
        SUM(feedback_status = 'complete')                               AS feedback_complete
       FROM assignments
      WHERE student_id = ?`,
    [studentId]
  );

  const streaks = await computeStreaks(studentId);

  const [levelHistory] = await pool.query<any[]>(
    `SELECT from_level, to_level, reason, created_at
       FROM level_events
      WHERE student_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 10`,
    [studentId]
  );

  const [xpHistory] = await pool.query<any[]>(
    `SELECT assignment_id, event_type, difficulty, points, created_at
       FROM xp_events
      WHERE student_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 20`,
    [studentId]
  );

  const eligible = Number(counts.feedback_eligible ?? 0);
  const complete = Number(counts.feedback_complete ?? 0);

  return {
    student_id: Number(s.id),
    display_name: s.display_name,
    current_level: Number(s.current_level),
    segment_name: s.segment_name ?? null,
    total_xp: Number(s.total_xp),
    attempted: Number(counts.attempted ?? 0),
    submitted: Number(counts.submitted ?? 0),
    correct: Number(counts.correct ?? 0),
    current_streak: streaks.current,
    longest_streak: streaks.longest,
    feedback_completion_rate: eligible === 0 ? 0 : complete / eligible,
    level_history: levelHistory,
    xp_history: xpHistory,
  };
}

// ---------------------------------------------------------------------------
// getSubmissionLog — paginated, newest first
// ---------------------------------------------------------------------------
export async function getSubmissionLog(studentId: number, limit = 20, offset = 0) {
  const lim = Math.min(Math.max(1, Number(limit) || 20), 100);
  const off = Math.max(0, Number(offset) || 0);

  const [[{ total }]] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total FROM assignments WHERE student_id = ? AND status = 'graded'`,
    [studentId]
  );

  const [rows] = await pool.query<any[]>(
    `SELECT a.id AS assignment_id, m.title, m.difficulty,
            a.submitted_at, a.score_band, a.time_to_submit_seconds, a.feedback_status
       FROM assignments a
       JOIN missions m ON m.id = a.mission_id
      WHERE a.student_id = ? AND a.status = 'graded'
      ORDER BY a.submitted_at DESC, a.id DESC
      LIMIT ? OFFSET ?`,
    [studentId, lim, off]
  );

  return { total: Number(total), limit: lim, offset: off, rows };
}

// ---------------------------------------------------------------------------
// getMissionQuality — the SME report. THE most valuable output of feedback.
// ---------------------------------------------------------------------------
export interface MissionQualityRow {
  mission_id: number;
  title: string;
  tagged_difficulty: number;
  observed_difficulty: number;
  attempts: number;
  passes: number;
  pass_rate: number;
  median_perceived_difficulty: string | null;
  median_time_to_submit_seconds: number | null;
  mismatch: boolean;
}

const MIN_ATTEMPTS = 5;

/** Map a pass rate to an observed difficulty band (see spec). */
export function observedDifficulty(passRate: number): number {
  if (passRate >= 0.9) return 0;
  if (passRate >= 0.75) return 1;
  if (passRate >= 0.55) return 2;
  if (passRate >= 0.35) return 3;
  return 4;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function getMissionQuality(missionId?: number): Promise<MissionQualityRow[]> {
  // Missions with at least MIN_ATTEMPTS graded attempts.
  const params: any[] = [];
  let missionFilter = '';
  if (missionId != null) {
    missionFilter = 'AND m.id = ?';
    params.push(missionId);
  }
  const [missions] = await pool.query<any[]>(
    `SELECT m.id, m.title, m.difficulty AS tagged,
            COUNT(a.id) AS attempts,
            SUM(a.score_band IN ('pass','pass_strong')) AS passes
       FROM missions m
       JOIN assignments a ON a.mission_id = m.id AND a.status = 'graded'
      WHERE 1 = 1 ${missionFilter}
      GROUP BY m.id, m.title, m.difficulty
     HAVING attempts >= ?
      ORDER BY m.id`,
    [...params, MIN_ATTEMPTS]
  );

  const report: MissionQualityRow[] = [];
  for (const m of missions) {
    const attempts = Number(m.attempts);
    const passes = Number(m.passes);
    const passRate = attempts === 0 ? 0 : passes / attempts;
    const observed = observedDifficulty(passRate);
    const tagged = Number(m.tagged);

    // Median perceived_difficulty from feedback (map the single_select labels to
    // an ordinal, take the median, map back to a label).
    const [perceivedRows] = await pool.query<any[]>(
      `SELECT fr.answer_value AS v
         FROM feedback_responses fr
         JOIN assignments a ON a.id = fr.assignment_id
        WHERE a.mission_id = ? AND fr.question_key = 'perceived_difficulty'`,
      [m.id]
    );
    const ordinalMap: Record<string, number> = { 'Too easy': 0, 'About right': 1, 'Too hard': 2 };
    const ordinalLabels = ['Too easy', 'About right', 'Too hard'];
    const ordinals = perceivedRows
      .map((r) => ordinalMap[String(r.v)])
      .filter((n) => n != null);
    const medOrdinal = median(ordinals);
    const medianPerceived = medOrdinal == null ? null : ordinalLabels[Math.round(medOrdinal)];

    // Median time_to_submit_seconds.
    const [timeRows] = await pool.query<any[]>(
      `SELECT time_to_submit_seconds AS t
         FROM assignments
        WHERE mission_id = ? AND status = 'graded' AND time_to_submit_seconds IS NOT NULL`,
      [m.id]
    );
    const medTime = median(timeRows.map((r) => Number(r.t)));

    report.push({
      mission_id: Number(m.id),
      title: m.title,
      tagged_difficulty: tagged,
      observed_difficulty: observed,
      attempts,
      passes,
      pass_rate: Number(passRate.toFixed(3)),
      median_perceived_difficulty: medianPerceived,
      median_time_to_submit_seconds: medTime,
      mismatch: Math.abs(observed - tagged) >= 2,
    });
  }
  return report;
}
