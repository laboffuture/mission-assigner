import { pool } from './db.js';
import { logger } from './logger.js';

/**
 * Cold start: a brand-new student has no performance history.
 *
 * The strategy is chosen in exactly ONE place — resolveStrategy() — so the
 * choice is never scattered through the codebase. Configure via the
 * COLD_START_STRATEGY env var. Default: SEGMENT_START.
 *
 *   SEGMENT_START (default): level := segment.start_level, placement complete.
 *   PLACEMENT (implemented, NOT enabled by default): a fast 5-mission ladder
 *     handled by progression.ts while placement_status = 'in_progress'.
 */

export type ColdStartStrategy = 'SEGMENT_START' | 'PLACEMENT';
export const PLACEMENT_MISSION_LIMIT = 5;

export function resolveStrategy(): ColdStartStrategy {
  const raw = (process.env.COLD_START_STRATEGY ?? 'SEGMENT_START').trim().toUpperCase();
  return raw === 'PLACEMENT' ? 'PLACEMENT' : 'SEGMENT_START';
}

export interface ColdStartResult {
  studentId: number;
  strategy: ColdStartStrategy;
  startLevel: number;
  placementStatus: 'in_progress' | 'complete';
}

/**
 * applyColdStart — initialise a student's level and placement state from their
 * segment. Call once, when the student first enters the system (or is (re)placed
 * with no history). It reads the segment's start_level as the floor.
 */
export async function applyColdStart(studentId: number): Promise<ColdStartResult> {
  const strategy = resolveStrategy();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query<any[]>(
      `SELECT s.id, s.segment_id, seg.start_level
         FROM students s
         LEFT JOIN segments seg ON seg.id = s.segment_id
        WHERE s.id = ?`,
      [studentId]
    );
    if (rows.length === 0) throw new Error(`Student ${studentId} not found`);
    const row = rows[0];
    // No segment yet -> floor at 0 (segmentation should run first).
    const startLevel = row.start_level == null ? 0 : Number(row.start_level);

    const placementStatus = strategy === 'PLACEMENT' ? 'in_progress' : 'complete';

    await conn.query(
      `UPDATE students
          SET current_level = ?, placement_status = ?, stall_count = 0, consecutive_wrong = 0
        WHERE id = ?`,
      [startLevel, placementStatus, studentId]
    );

    logger.info({ studentId, strategy, startLevel, placementStatus }, 'cold start applied');

    return { studentId, strategy, startLevel, placementStatus };
  } finally {
    conn.release();
  }
}
