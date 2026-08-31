import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db.js';
import { selectMission } from './selection.js';
import { submitAndGrade } from './grading.js';
import { fillSlot } from './slotFiller.js';
import { unlockNext } from './slotUnlock.js';
import { awardXp } from './xp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

/** GET /api/students */
app.get('/api/students', async (_req, res) => {
  try {
    const [rows] = await pool.query<any[]>(
      `SELECT id, display_name, current_level, consecutive_wrong, total_xp, segment_id
         FROM students
        ORDER BY id`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to load students' });
  }
});

/**
 * GET /api/current/:studentId  (Stage 1 free-play — unchanged behaviour)
 */
app.get('/api/current/:studentId', async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(studentId)) {
    return res.status(400).json({ error: 'invalid studentId' });
  }
  try {
    const [openRows] = await pool.query<any[]>(
      `SELECT id AS assignment_id, mission_id
         FROM assignments
        WHERE student_id = ? AND status = 'open'
        ORDER BY assigned_at ASC
        LIMIT 1`,
      [studentId]
    );

    let assignmentId: number;
    let missionId: number;

    if (openRows.length > 0) {
      assignmentId = Number(openRows[0].assignment_id);
      missionId = Number(openRows[0].mission_id);
    } else {
      const sel = await selectMission(studentId);
      if (!sel) return res.json({ empty: true });
      assignmentId = sel.assignmentId;
      missionId = sel.missionId;
    }

    const mission = await loadMissionContent(missionId);
    res.json({ assignment_id: assignmentId, ...mission });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to load current mission' });
  }
});

/**
 * GET /api/week/:studentId — the current (latest) week with all slots.
 *
 * SECURITY: mission content (body/options) is fetched ONLY for slots whose
 * status is not 'locked'. Locked slots return metadata only. This is enforced
 * in the SQL below (the content query filters `status <> 'locked'`), never in
 * the UI, so a crafted client cannot read locked questions.
 */
app.get('/api/week/:studentId', async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(studentId)) return res.status(400).json({ error: 'invalid studentId' });
  try {
    const [weekRows] = await pool.query<any[]>(
      `SELECT id, template_id, week_start, status
         FROM student_weeks
        WHERE student_id = ?
        ORDER BY week_start DESC, id DESC
        LIMIT 1`,
      [studentId]
    );
    if (weekRows.length === 0) return res.json({ empty: true });
    const week = weekRows[0];

    const [slotRows] = await pool.query<any[]>(
      `SELECT id, slot_index, day_label, mission_type, time_band, status, assignment_id
         FROM week_slots
        WHERE student_week_id = ?
        ORDER BY slot_index ASC`,
      [week.id]
    );

    // Mission content ONLY for non-locked, filled slots. Locked rows are
    // structurally excluded here — they can never carry body/options.
    const [contentRows] = await pool.query<any[]>(
      `SELECT ws.id AS week_slot_id, m.id AS mission_id, m.title, m.body, m.difficulty
         FROM week_slots ws
         JOIN assignments a ON a.id = ws.assignment_id
         JOIN missions m ON m.id = a.mission_id
        WHERE ws.student_week_id = ?
          AND ws.status <> 'locked'
          AND ws.assignment_id IS NOT NULL`,
      [week.id]
    );
    const contentBySlot = new Map<number, any>();
    for (const c of contentRows) contentBySlot.set(Number(c.week_slot_id), c);

    // Options for the same visible missions only.
    const missionIds = contentRows.map((c) => Number(c.mission_id));
    const optionsByMission = new Map<number, any[]>();
    if (missionIds.length > 0) {
      const ph = missionIds.map(() => '?').join(', ');
      const [optRows] = await pool.query<any[]>(
        `SELECT mission_id, option_key, option_text
           FROM mission_options
          WHERE mission_id IN (${ph})
          ORDER BY mission_id, option_key ASC`,
        missionIds
      );
      for (const o of optRows) {
        const list = optionsByMission.get(Number(o.mission_id)) ?? [];
        list.push({ option_key: o.option_key, option_text: o.option_text });
        optionsByMission.set(Number(o.mission_id), list);
      }
    }

    const slots = slotRows.map((s) => {
      const base = {
        slot_id: Number(s.id),
        slot_index: Number(s.slot_index),
        day_label: s.day_label,
        mission_type: s.mission_type,
        time_band: s.time_band,
        status: s.status,
        assignment_id: s.assignment_id != null ? Number(s.assignment_id) : null,
      };
      if (s.status === 'locked') return base; // metadata only — NEVER content
      const content = contentBySlot.get(Number(s.id));
      if (!content) return { ...base, mission: null }; // open but unfilled (gap)
      return {
        ...base,
        mission: {
          mission_id: Number(content.mission_id),
          title: content.title,
          body: content.body,
          difficulty: Number(content.difficulty),
          options: optionsByMission.get(Number(content.mission_id)) ?? [],
        },
      };
    });

    res.json({
      student_week_id: Number(week.id),
      week_start: week.week_start,
      status: week.status,
      slots,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to load week' });
  }
});

/**
 * POST /api/slot/:slotId/open — the student opens a slot to view its mission.
 * Fills the slot lazily if needed (slot 1 / weekly slots are opened at publish
 * but filled on first view), awards 'attempt' XP once per assignment, and
 * returns the mission. Refuses locked slots.
 */
app.post('/api/slot/:slotId/open', async (req, res) => {
  const slotId = Number(req.params.slotId);
  if (!Number.isFinite(slotId)) return res.status(400).json({ error: 'invalid slotId' });
  try {
    const [slotRows] = await pool.query<any[]>(
      `SELECT ws.id, ws.status, ws.assignment_id, sw.student_id
         FROM week_slots ws
         JOIN student_weeks sw ON sw.id = ws.student_week_id
        WHERE ws.id = ?`,
      [slotId]
    );
    if (slotRows.length === 0) return res.status(404).json({ error: 'slot not found' });
    const slot = slotRows[0];

    if (slot.status === 'locked') {
      return res.status(403).json({ error: 'slot is locked' });
    }

    // Lazy fill on first view.
    let assignmentId = slot.assignment_id != null ? Number(slot.assignment_id) : null;
    if (assignmentId == null) {
      const fill = await fillSlot(slotId);
      if (fill.gap || fill.assignmentId == null) {
        return res.json({ empty: true, message: 'no mission available — please contact your instructor.' });
      }
      assignmentId = fill.assignmentId;
    }

    // Load mission + difficulty for the attempt award.
    const [aRows] = await pool.query<any[]>(
      `SELECT a.mission_id, m.difficulty
         FROM assignments a JOIN missions m ON m.id = a.mission_id
        WHERE a.id = ?`,
      [assignmentId]
    );
    const missionId = Number(aRows[0].mission_id);
    const difficulty = Number(aRows[0].difficulty);

    // Award 'attempt' XP — once per assignment (guarded inside awardXp).
    const xp = await awardXp(Number(slot.student_id), assignmentId, 'attempt', difficulty);

    const mission = await loadMissionContent(missionId);
    res.json({ assignment_id: assignmentId, ...mission, xp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to open slot' });
  }
});

/**
 * POST /api/submit  body { assignmentId, selected }
 * Grades (Stage 1), awards 'submit' + (if correct) 'correct' XP, and unlocks the
 * next slot when the assignment belongs to a week.
 */
app.post('/api/submit', async (req, res) => {
  const { assignmentId, selected } = req.body ?? {};
  if (!Number.isFinite(Number(assignmentId)) || typeof selected !== 'string') {
    return res.status(400).json({ error: 'assignmentId and selected are required' });
  }
  try {
    const result = await submitAndGrade(Number(assignmentId), selected);

    // XP: submit always; correct only if correct, scaled by difficulty.
    const submitXp = await awardXp(result.studentId, result.assignmentId, 'submit', result.difficulty);
    let correctXp = null;
    if (result.correct) {
      correctXp = await awardXp(result.studentId, result.assignmentId, 'correct', result.difficulty);
    }

    // Unlock the next slot (no-op for Stage 1 free-play assignments).
    const unlock = await unlockNext(result.assignmentId);

    // Fresh XP total for the header.
    const [xpRow] = await pool.query<any[]>(`SELECT total_xp FROM students WHERE id = ?`, [result.studentId]);
    const totalXp = xpRow.length ? Number(xpRow[0].total_xp) : 0;

    const pointsEarned = (submitXp.awarded ? submitXp.points : 0) + (correctXp?.awarded ? correctXp.points : 0);

    res.json({ ...result, xp: { submit: submitXp, correct: correctXp, pointsEarned, totalXp }, unlock });
  } catch (err: any) {
    console.error(err);
    res.status(400).json({ error: err?.message ?? 'submit failed' });
  }
});

/** GET /api/xp/:studentId — total and the last 20 events. */
app.get('/api/xp/:studentId', async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(studentId)) return res.status(400).json({ error: 'invalid studentId' });
  try {
    const [[totalRow]] = await pool.query<any[]>(`SELECT total_xp FROM students WHERE id = ?`, [studentId]);
    const [events] = await pool.query<any[]>(
      `SELECT id, assignment_id, event_type, difficulty, points, created_at
         FROM xp_events
        WHERE student_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 20`,
      [studentId]
    );
    res.json({ total_xp: totalRow ? Number(totalRow.total_xp) : 0, events });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to load xp' });
  }
});

/** GET /api/segment/:studentId — the student's segment and placement reason. */
app.get('/api/segment/:studentId', async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(studentId)) return res.status(400).json({ error: 'invalid studentId' });
  try {
    const [rows] = await pool.query<any[]>(
      `SELECT s.id AS student_id, s.age, s.subject, s.current_level, s.placement_status,
              seg.id AS segment_id, seg.name AS segment_name,
              seg.start_level, seg.min_level, seg.max_level, seg.description
         FROM students s
         LEFT JOIN segments seg ON seg.id = s.segment_id
        WHERE s.id = ?`,
      [studentId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'student not found' });
    const r = rows[0];

    // Explain qualification against the segment's prerequisites.
    let prerequisites: Array<{ course_ref: string; completed: boolean }> = [];
    if (r.segment_id != null) {
      const [prereqRows] = await pool.query<any[]>(
        `SELECT sp.course_ref,
                (sc.course_ref IS NOT NULL) AS completed
           FROM segment_prerequisites sp
           LEFT JOIN student_courses sc
                  ON sc.student_id = ? AND sc.course_ref = sp.course_ref
          WHERE sp.segment_id = ?`,
        [studentId, r.segment_id]
      );
      prerequisites = prereqRows.map((p) => ({ course_ref: p.course_ref, completed: Boolean(p.completed) }));
    }

    res.json({
      student_id: Number(r.student_id),
      age: Number(r.age),
      subject: r.subject,
      current_level: Number(r.current_level),
      placement_status: r.placement_status,
      segment: r.segment_id == null ? null : {
        id: Number(r.segment_id),
        name: r.segment_name,
        start_level: Number(r.start_level),
        min_level: Number(r.min_level),
        max_level: Number(r.max_level),
        description: r.description,
      },
      why: r.segment_id == null
        ? 'No segment assigned yet.'
        : `Age ${r.age} within range and prerequisites ${prerequisites.every((p) => p.completed) ? 'met' : 'partially met'}; ` +
          `placed at start_level ${r.start_level}.`,
      prerequisites,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to load segment' });
  }
});

/** GET /api/assistance — open assistance events (future instructor view). */
app.get('/api/assistance', async (_req, res) => {
  try {
    const [rows] = await pool.query<any[]>(
      `SELECT ae.id, ae.student_id, s.display_name, ae.trigger_reason,
              ae.level_at_trigger, ae.context, ae.status, ae.created_at
         FROM assistance_events ae
         JOIN students s ON s.id = ae.student_id
        WHERE ae.status = 'open'
        ORDER BY ae.created_at DESC, ae.id DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to load assistance events' });
  }
});

/** GET /api/history/:studentId — last 5 level events, newest first. */
app.get('/api/history/:studentId', async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(studentId)) return res.status(400).json({ error: 'invalid studentId' });
  try {
    const [rows] = await pool.query<any[]>(
      `SELECT from_level, to_level, reason, created_at
         FROM level_events
        WHERE student_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 5`,
      [studentId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to load history' });
  }
});

/** Shared: mission content (title/body/difficulty + options). */
async function loadMissionContent(missionId: number) {
  const [missionRows] = await pool.query<any[]>(
    `SELECT id, title, body, difficulty FROM missions WHERE id = ?`,
    [missionId]
  );
  const mission = missionRows[0];
  const [options] = await pool.query<any[]>(
    `SELECT option_key, option_text FROM mission_options WHERE mission_id = ? ORDER BY option_key ASC`,
    [missionId]
  );
  return {
    title: mission.title,
    body: mission.body,
    difficulty: Number(mission.difficulty),
    options,
  };
}

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Mission demo listening on http://localhost:${PORT}`);
});
