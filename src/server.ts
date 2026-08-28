import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db.js';
import { selectMission } from './selection.js';
import { submitAndGrade } from './grading.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

/** GET /api/students */
app.get('/api/students', async (_req, res) => {
  try {
    const [rows] = await pool.query<any[]>(
      `SELECT id, display_name, current_level, consecutive_wrong
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
 * GET /api/current/:studentId
 * Uses the student's open assignment if one exists; otherwise selects a new
 * mission. Returns { empty: true } when no missions remain at this level.
 */
app.get('/api/current/:studentId', async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(studentId)) {
    return res.status(400).json({ error: 'invalid studentId' });
  }
  try {
    // Existing open assignment?
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
      if (!sel) {
        return res.json({ empty: true });
      }
      assignmentId = sel.assignmentId;
      missionId = sel.missionId;
    }

    const [missionRows] = await pool.query<any[]>(
      `SELECT id, title, body, difficulty
         FROM missions
        WHERE id = ?`,
      [missionId]
    );
    const mission = missionRows[0];

    const [options] = await pool.query<any[]>(
      `SELECT option_key, option_text
         FROM mission_options
        WHERE mission_id = ?
        ORDER BY option_key ASC`,
      [missionId]
    );

    res.json({
      assignment_id: assignmentId,
      title: mission.title,
      body: mission.body,
      difficulty: Number(mission.difficulty),
      options,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to load current mission' });
  }
});

/** POST /api/submit  body { assignmentId, selected } */
app.post('/api/submit', async (req, res) => {
  const { assignmentId, selected } = req.body ?? {};
  if (!Number.isFinite(Number(assignmentId)) || typeof selected !== 'string') {
    return res.status(400).json({ error: 'assignmentId and selected are required' });
  }
  try {
    const result = await submitAndGrade(Number(assignmentId), selected);
    res.json(result);
  } catch (err: any) {
    console.error(err);
    res.status(400).json({ error: err?.message ?? 'submit failed' });
  }
});

/** GET /api/history/:studentId — last 5 level events, newest first. */
app.get('/api/history/:studentId', async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (!Number.isFinite(studentId)) {
    return res.status(400).json({ error: 'invalid studentId' });
  }
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

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Mission demo listening on http://localhost:${PORT}`);
});
