import { pool } from './db.js';

export interface SelectionResult {
  assignmentId: number;
  missionId: number;
}

interface Candidate {
  mission_id: number;
  mission_version: number;
  difficulty: number;
  overlap: number;
}

/**
 * Selects the next mission for a student using pure SQL (no AI, no randomness
 * except RAND() tie-breaking).
 *
 * HARD FILTERS (mission excluded if any fail):
 *   - status = 'live'
 *   - subject matches student's subject
 *   - difficulty = student's current_level exactly
 *   - student's age BETWEEN age_min AND age_max
 *   - NOT already assigned to this student (enforced also by UNIQUE KEY)
 *
 * RANK survivors by count of overlapping tags (mission_tags vs
 * student_interests) descending, tie-break RAND(), LIMIT 10.
 *
 * Returns null if there are no candidates.
 */
export async function selectMission(studentId: number): Promise<SelectionResult | null> {
  const conn = await pool.getConnection();
  try {
    // Read the student.
    const [studentRows] = await conn.query<any[]>(
      `SELECT id, age, subject, current_level
         FROM students
        WHERE id = ?`,
      [studentId]
    );
    if (studentRows.length === 0) {
      throw new Error(`Student ${studentId} not found`);
    }
    const student = studentRows[0];

    const filters = {
      status: 'live',
      subject: student.subject,
      difficulty: student.current_level,
      age: student.age,
      not_already_assigned: true,
    };

    // Candidate query — rank by tag overlap, tie-break RAND(), LIMIT 10.
    const [candidates] = await conn.query<any[]>(
      `SELECT m.id AS mission_id,
              m.version AS mission_version,
              m.difficulty AS difficulty,
              COUNT(si.tag) AS overlap
         FROM missions m
         LEFT JOIN mission_tags mt ON mt.mission_id = m.id
         LEFT JOIN student_interests si
                ON si.student_id = ? AND si.tag = mt.tag
        WHERE m.status = 'live'
          AND m.subject = ?
          AND m.difficulty = ?
          AND ? BETWEEN m.age_min AND m.age_max
          AND NOT EXISTS (
                SELECT 1 FROM assignments a
                 WHERE a.student_id = ? AND a.mission_id = m.id
              )
        GROUP BY m.id, m.version, m.difficulty
        ORDER BY overlap DESC, RAND()
        LIMIT 10`,
      [studentId, student.subject, student.current_level, student.age, studentId]
    );

    const candidateList: Candidate[] = candidates.map((c) => ({
      mission_id: Number(c.mission_id),
      mission_version: Number(c.mission_version),
      difficulty: Number(c.difficulty),
      overlap: Number(c.overlap),
    }));

    if (candidateList.length === 0) {
      // Log the empty selection so the audit trail is complete.
      await conn.query(
        `INSERT INTO selection_log
           (student_id, chosen_mission, candidates, filters_applied)
         VALUES (?, NULL, ?, ?)`,
        [studentId, JSON.stringify([]), JSON.stringify(filters)]
      );
      return null;
    }

    const top = candidateList[0];

    // 1. Create the assignment (mission_version copied from the mission).
    const [ins] = await conn.query<any>(
      `INSERT INTO assignments
         (student_id, mission_id, mission_version, level_at_assign, status)
       VALUES (?, ?, ?, ?, 'open')`,
      [studentId, top.mission_id, top.mission_version, student.current_level]
    );
    const assignmentId = ins.insertId as number;

    // 2. Log the full candidate array with scores and the filters used.
    await conn.query(
      `INSERT INTO selection_log
         (student_id, chosen_mission, candidates, filters_applied)
       VALUES (?, ?, ?, ?)`,
      [studentId, top.mission_id, JSON.stringify(candidateList), JSON.stringify(filters)]
    );

    return { assignmentId, missionId: top.mission_id };
  } finally {
    conn.release();
  }
}
