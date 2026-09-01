import { pool } from './db.js';
import { logger } from './logger.js';

export interface SegmentDecision {
  studentId: number;
  segmentId: number | null;
  segmentName: string | null;
  reason: 'best_qualified' | 'fallback_lowest' | 'no_segments_for_subject';
  candidatesConsidered: Array<{ id: number; name: string; start_level: number; qualified: boolean; why: string }>;
}

/**
 * assignSegment — pure, rules-only placement (no AI).
 *
 *  1. Read the student's age, subject and completed courses.
 *  2. Find active segments where subject matches, age is in [age_min, age_max],
 *     and EVERY prerequisite course_ref is in the student's completed courses.
 *  3. If several match, pick the highest start_level (most advanced qualified).
 *  4. If none match, assign the lowest start_level segment for the subject and
 *     log a warning naming the student.
 *  5. Write segment_id to the student and log the decision with candidates.
 *
 * Re-run whenever a student's completed courses change.
 */
export async function assignSegment(studentId: number): Promise<SegmentDecision> {
  const conn = await pool.getConnection();
  try {
    const [studentRows] = await conn.query<any[]>(`SELECT id, display_name, age, subject FROM students WHERE id = ?`, [
      studentId,
    ]);
    if (studentRows.length === 0) throw new Error(`Student ${studentId} not found`);
    const student = studentRows[0];

    const [completedRows] = await conn.query<any[]>(`SELECT course_ref FROM student_courses WHERE student_id = ?`, [
      studentId,
    ]);
    const completed = new Set<string>(completedRows.map((r) => String(r.course_ref)));

    // All active segments for the subject, with their prerequisites.
    const [segments] = await conn.query<any[]>(
      `SELECT id, name, subject, age_min, age_max, start_level
         FROM segments
        WHERE active = TRUE AND subject = ?
        ORDER BY start_level DESC, id ASC`,
      [student.subject]
    );

    const [prereqRows] = await conn.query<any[]>(
      `SELECT sp.segment_id, sp.course_ref
         FROM segment_prerequisites sp
         JOIN segments s ON s.id = sp.segment_id
        WHERE s.active = TRUE AND s.subject = ?`,
      [student.subject]
    );
    const prereqsBySegment = new Map<number, string[]>();
    for (const r of prereqRows) {
      const list = prereqsBySegment.get(Number(r.segment_id)) ?? [];
      list.push(String(r.course_ref));
      prereqsBySegment.set(Number(r.segment_id), list);
    }

    const candidates: SegmentDecision['candidatesConsidered'] = [];
    const qualified: any[] = [];

    for (const seg of segments) {
      const ageOk = student.age >= seg.age_min && student.age <= seg.age_max;
      const prereqs = prereqsBySegment.get(Number(seg.id)) ?? [];
      const missingPrereqs = prereqs.filter((c) => !completed.has(c));
      const isQualified = ageOk && missingPrereqs.length === 0;

      let why = '';
      if (!ageOk) why = `age ${student.age} not in [${seg.age_min},${seg.age_max}]`;
      else if (missingPrereqs.length > 0) why = `missing prerequisites: ${missingPrereqs.join(', ')}`;
      else why = 'qualifies';

      candidates.push({
        id: Number(seg.id),
        name: seg.name,
        start_level: Number(seg.start_level),
        qualified: isQualified,
        why,
      });
      if (isQualified) qualified.push(seg);
    }

    let chosen: any = null;
    let reason: SegmentDecision['reason'];

    if (qualified.length > 0) {
      // Highest start_level among qualified (segments already ordered desc).
      chosen = qualified.reduce(
        (best, s) => (Number(s.start_level) > Number(best.start_level) ? s : best),
        qualified[0]
      );
      reason = 'best_qualified';
    } else if (segments.length > 0) {
      // Fallback: lowest start_level segment for the subject.
      chosen = segments.reduce((low, s) => (Number(s.start_level) < Number(low.start_level) ? s : low), segments[0]);
      reason = 'fallback_lowest';
      logger.warn(
        { studentId, displayName: student.display_name, fallbackSegment: chosen.name, startLevel: chosen.start_level },
        'student qualified for NO segment; falling back to lowest start_level segment'
      );
    } else {
      reason = 'no_segments_for_subject';
      logger.warn(
        { studentId, displayName: student.display_name, subject: student.subject },
        'no segments exist for subject'
      );
    }

    const segmentId = chosen ? Number(chosen.id) : null;

    if (segmentId !== null) {
      await conn.query(`UPDATE students SET segment_id = ? WHERE id = ?`, [segmentId, studentId]);
    }

    logger.info(
      { studentId, segmentId, segmentName: chosen ? chosen.name : null, reason, candidates },
      'segment assigned'
    );

    return {
      studentId,
      segmentId,
      segmentName: chosen ? chosen.name : null,
      reason,
      candidatesConsidered: candidates,
    };
  } finally {
    conn.release();
  }
}
