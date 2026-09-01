import type { PoolConnection } from 'mysql2/promise';
import { pool } from './db.js';
import { logAttempt } from './tracking.js';

export interface FillResult {
  weekSlotId: number;
  assignmentId: number | null;
  missionId: number | null;
  targetLevel: number;
  relaxations: string[];   // ordered log of each relaxation applied
  gap: boolean;            // true = no mission available, coverage gap recorded
}

interface Candidate {
  mission_id: number;
  mission_version: number;
  difficulty: number;
  overlap: number;
}

/**
 * fillSlot — pick a mission for a slot that has just OPENED, and create the
 * assignment. Called by weekPublisher (slot 1 / weekly slots) and slotUnlock
 * (the next slot after a submission). Never before a slot opens.
 *
 * Target level = student.current_level + template slot level_offset, clamped to
 * the segment's [min_level, max_level].
 *
 * HARD filters (base): status='live', subject match, age in range, mission_type
 * matches the slot, time_band matches the slot, difficulty = target level, and
 * NEVER a mission the student already had.
 *
 * If no candidates, relax in THIS ORDER, logging each:
 *   a. widen difficulty to target ±1
 *   b. drop the tag-interest ranking (rank randomly)
 *   c. widen time_band to the next band up
 * mission_type is NEVER relaxed. Already-served missions are NEVER served.
 *
 * If still nothing: leave the slot open with assignment_id NULL and record a
 * coverage gap (selection_log with chosen_mission NULL).
 */
const TIME_BANDS = ['short', 'medium', 'long', 'heavy'];

export async function fillSlot(weekSlotId: number): Promise<FillResult> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Slot + week + template slot + student, all in one read.
    const [slotRows] = await conn.query<any[]>(
      `SELECT ws.id            AS week_slot_id,
              ws.mission_type  AS mission_type,
              ws.time_band     AS time_band,
              ws.assignment_id AS assignment_id,
              sw.student_id    AS student_id,
              sw.template_id   AS template_id,
              ws.slot_index    AS slot_index,
              s.age            AS age,
              s.subject        AS subject,
              s.current_level  AS current_level,
              s.segment_id     AS segment_id,
              COALESCE(seg.min_level, 0) AS min_level,
              COALESCE(seg.max_level, 4) AS max_level
         FROM week_slots ws
         JOIN student_weeks sw ON sw.id = ws.student_week_id
         JOIN students s ON s.id = sw.student_id
         LEFT JOIN segments seg ON seg.id = s.segment_id
        WHERE ws.id = ?
        FOR UPDATE`,
      [weekSlotId]
    );
    if (slotRows.length === 0) throw new Error(`week_slot ${weekSlotId} not found`);
    const slot = slotRows[0];

    // Idempotency: already filled.
    if (slot.assignment_id != null) {
      await conn.commit();
      return {
        weekSlotId,
        assignmentId: Number(slot.assignment_id),
        missionId: null,
        targetLevel: Number(slot.current_level),
        relaxations: ['already_filled'],
        gap: false,
      };
    }

    // level_offset for this slot from the template.
    const [tsRows] = await conn.query<any[]>(
      `SELECT level_offset FROM week_template_slots
        WHERE template_id = ? AND slot_index = ?`,
      [slot.template_id, slot.slot_index]
    );
    const levelOffset = tsRows.length ? Number(tsRows[0].level_offset) : 0;

    const minLevel = Number(slot.min_level);
    const maxLevel = Number(slot.max_level);
    const rawTarget = Number(slot.current_level) + levelOffset;
    const targetLevel = Math.max(minLevel, Math.min(rawTarget, maxLevel));

    const studentId = Number(slot.student_id);
    const relaxations: string[] = [];

    // Attempt the base filters, then relax step by step.
    let chosen: Candidate | null = null;

    // Base: exact difficulty, tag-ranked, exact time_band.
    chosen = await queryCandidates(conn, {
      studentId,
      subject: slot.subject,
      age: slot.age,
      missionType: slot.mission_type,
      timeBands: [slot.time_band],
      minDiff: targetLevel,
      maxDiff: targetLevel,
      rankByTags: true,
    });

    // a. widen difficulty to target ±1
    if (!chosen) {
      relaxations.push('widen_difficulty_pm1');
      console.log(`[slotFiller] slot ${weekSlotId}: relax (a) widen difficulty to ${targetLevel}±1`);
      chosen = await queryCandidates(conn, {
        studentId,
        subject: slot.subject,
        age: slot.age,
        missionType: slot.mission_type,
        timeBands: [slot.time_band],
        minDiff: Math.max(minLevel, targetLevel - 1),
        maxDiff: Math.min(maxLevel, targetLevel + 1),
        rankByTags: true,
      });
    }

    // b. drop tag-interest ranking (rank randomly)
    if (!chosen) {
      relaxations.push('drop_tag_ranking');
      console.log(`[slotFiller] slot ${weekSlotId}: relax (b) drop tag-interest ranking (random)`);
      chosen = await queryCandidates(conn, {
        studentId,
        subject: slot.subject,
        age: slot.age,
        missionType: slot.mission_type,
        timeBands: [slot.time_band],
        minDiff: Math.max(minLevel, targetLevel - 1),
        maxDiff: Math.min(maxLevel, targetLevel + 1),
        rankByTags: false,
      });
    }

    // c. widen time_band to the next band up
    if (!chosen) {
      const idx = TIME_BANDS.indexOf(String(slot.time_band));
      const widened = idx >= 0 ? TIME_BANDS.slice(idx) : [String(slot.time_band)];
      relaxations.push(`widen_time_band_to:${widened.join('|')}`);
      console.log(`[slotFiller] slot ${weekSlotId}: relax (c) widen time_band to [${widened.join(', ')}]`);
      chosen = await queryCandidates(conn, {
        studentId,
        subject: slot.subject,
        age: slot.age,
        missionType: slot.mission_type,   // NEVER relaxed
        timeBands: widened,
        minDiff: Math.max(minLevel, targetLevel - 1),
        maxDiff: Math.min(maxLevel, targetLevel + 1),
        rankByTags: false,
      });
    }

    const filters = {
      mission_type: slot.mission_type,
      time_band: slot.time_band,
      target_level: targetLevel,
      relaxations,
    };

    // Still nothing -> coverage gap. Slot stays open, assignment_id NULL.
    if (!chosen) {
      await conn.query(
        `INSERT INTO selection_log (student_id, chosen_mission, candidates, filters_applied)
         VALUES (?, NULL, ?, ?)`,
        [studentId, JSON.stringify([]), JSON.stringify(filters)]
      );
      await conn.commit();
      console.warn(`[slotFiller] slot ${weekSlotId}: NO mission available — coverage gap recorded.`);
      return { weekSlotId, assignmentId: null, missionId: null, targetLevel, relaxations, gap: true };
    }

    // Create the assignment (mission_version pinned) and link it to the slot.
    const [ins] = await conn.query<any>(
      `INSERT INTO assignments
         (student_id, mission_id, mission_version, level_at_assign, status)
       VALUES (?, ?, ?, ?, 'open')`,
      [studentId, chosen.mission_id, chosen.mission_version, Number(slot.current_level)]
    );
    const assignmentId = Number(ins.insertId);

    await conn.query(`UPDATE week_slots SET assignment_id = ? WHERE id = ?`, [assignmentId, weekSlotId]);

    // Audit: the assignment now exists ('opened' = surfaced to the student).
    await logAttempt(assignmentId, studentId, 'opened', { weekSlotId, targetLevel }, conn);

    await conn.query(
      `INSERT INTO selection_log (student_id, chosen_mission, candidates, filters_applied)
       VALUES (?, ?, ?, ?)`,
      [studentId, chosen.mission_id, JSON.stringify([chosen]), JSON.stringify(filters)]
    );

    await conn.commit();
    return {
      weekSlotId,
      assignmentId,
      missionId: chosen.mission_id,
      targetLevel,
      relaxations,
      gap: false,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

interface QueryArgs {
  studentId: number;
  subject: string;
  age: number;
  missionType: string;
  timeBands: string[];
  minDiff: number;
  maxDiff: number;
  rankByTags: boolean;
}

/** Returns the single best candidate, or null. Never returns an already-served mission. */
async function queryCandidates(conn: PoolConnection, a: QueryArgs): Promise<Candidate | null> {
  const bandPlaceholders = a.timeBands.map(() => '?').join(', ');
  const order = a.rankByTags ? 'ORDER BY overlap DESC, RAND()' : 'ORDER BY RAND()';

  const [rows] = await conn.query<any[]>(
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
        AND m.mission_type = ?
        AND m.time_band IN (${bandPlaceholders})
        AND m.difficulty BETWEEN ? AND ?
        AND ? BETWEEN m.age_min AND m.age_max
        AND NOT EXISTS (
              SELECT 1 FROM assignments asg
               WHERE asg.student_id = ? AND asg.mission_id = m.id
            )
      GROUP BY m.id, m.version, m.difficulty
      ${order}
      LIMIT 1`,
    [
      a.studentId,
      a.subject,
      a.missionType,
      ...a.timeBands,
      a.minDiff,
      a.maxDiff,
      a.age,
      a.studentId,
    ]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    mission_id: Number(r.mission_id),
    mission_version: Number(r.mission_version),
    difficulty: Number(r.difficulty),
    overlap: Number(r.overlap),
  };
}
