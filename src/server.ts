import 'dotenv/config';
import express from 'express';
import pinoHttp from 'pino-http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db.js';
import { logger, getTestLogs, newRequestId } from './logger.js';
import { initSentry, captureException } from './sentry.js';
import { selectMission } from './selection.js';
import { submitAndGrade } from './grading.js';
import { fillSlot } from './slotFiller.js';
import { unlockNext } from './slotUnlock.js';
import { awardXp } from './xp.js';
import { getQuestions, submitFeedback, FeedbackError } from './feedback.js';
import { getStudentProgress, getSubmissionLog, getMissionQuality, logAttempt } from './tracking.js';
import { feedbackGatesUnlock, setFeedbackGatesUnlock } from './config.js';
import {
  requireAuth,
  requireRole,
  resolveOwnedStudent,
  warnIfInsecureAuth,
  getAuthProvider,
  STAFF_ROLES,
} from './auth.js';
import { validate } from './validate.js';
import { sendError } from './httpError.js';
import { validateEnv } from './env.js';
import {
  studentIdParams,
  slotIdParams,
  missionIdParams,
  assignmentIdParams,
  submitBody,
  feedbackBody,
  listQuery,
} from './schemas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Refuse to start half-configured — validate every env var first (Item 6).
validateEnv();

const app = express();

/** Per-request logger accessor (pino-http attaches req.log; fall back to base). */
const rlog = (req: express.Request) => (req as any).log ?? logger;

// Structured request logging FIRST: assign/propagate a request id (returned as
// X-Request-Id), then log method/path/status/duration/userId per request. Each
// handler gets a req.log child carrying the request id.
const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && incoming ? incoming : newRequestId();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customProps: (req) => ({ requestId: (req as any).id, userId: (req as any).auth?.userId }),
  autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/api/test/logs') },
});
app.use(httpLogger);
app.use((req, _res, next) => {
  (req as any).log = (req as any).log.child({ requestId: (req as any).id });
  next();
});

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Dev-only login roster. Logging in is inherently pre-auth (you can't pick who
// to be if you must already be authenticated), so this is the ONLY unauthed API
// route and it exists ONLY when AUTH_MODE=dev. In LTI mode identity comes from
// the launch token and this route is not registered.
// ---------------------------------------------------------------------------
if (getAuthProvider().mode === 'dev') {
  app.get('/api/dev/users', async (req, res) => {
    try {
      const [rows] = await pool.query<any[]>(
        `SELECT id, display_name, role FROM students ORDER BY FIELD(role,'student') DESC, id`
      );
      res.json(rows);
    } catch (err) {
      rlog(req).error({ err }, 'request failed');
      sendError(req, res, 500, 'internal_error', 'failed to load users');
    }
  });
}

/** GET /api/students — staff roster (list every user). Never students. */
app.get('/api/students', requireAuth, requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const [rows] = await pool.query<any[]>(
      `SELECT id, display_name, role, current_level, consecutive_wrong, total_xp, segment_id
         FROM students
        ORDER BY id`
    );
    res.json(rows);
  } catch (err) {
    rlog(req).error({ err }, 'request failed');
    sendError(req, res, 500, 'internal_error', 'failed to load students');
  }
});

/**
 * GET /api/current/:studentId  (Stage 1 free-play — unchanged behaviour)
 * Student-only, own data.
 */
app.get(
  '/api/current/:studentId',
  requireAuth,
  requireRole('student'),
  validate({ params: studentIdParams }),
  async (req, res) => {
    const studentId = resolveOwnedStudent(req, res, req.valid!.params.studentId);
    if (studentId == null) return;
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
      rlog(req).error({ err }, 'request failed');
      sendError(req, res, 500, 'internal_error', 'failed to load current mission');
    }
  }
);

/**
 * GET /api/week/:studentId — the current (latest) week with all slots.
 *
 * SECURITY: mission content (body/options) is fetched ONLY for slots whose
 * status is not 'locked'. Locked slots return metadata only. This is enforced
 * in the SQL below (the content query filters `status <> 'locked'`), never in
 * the UI, so a crafted client cannot read locked questions. Ownership: the
 * week query is keyed to the authenticated student id.
 */
app.get('/api/week/:studentId', requireAuth, validate({ params: studentIdParams }), async (req, res) => {
  const studentId = resolveOwnedStudent(req, res, req.valid!.params.studentId);
  if (studentId == null) return;
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
    rlog(req).error({ err }, 'request failed');
    sendError(req, res, 500, 'internal_error', 'failed to load week');
  }
});

/**
 * POST /api/slot/:slotId/open — the student opens a slot to view its mission.
 * Student-only. The slot must belong to the authenticated student (checked
 * against the loaded slot's owner, since the slot is keyed by slot id, not
 * student id).
 */
app.post(
  '/api/slot/:slotId/open',
  requireAuth,
  requireRole('student'),
  validate({ params: slotIdParams }),
  async (req, res) => {
    const slotId = req.valid!.params.slotId;
    try {
      const [slotRows] = await pool.query<any[]>(
        `SELECT ws.id, ws.status, ws.assignment_id, sw.student_id
           FROM week_slots ws
           JOIN student_weeks sw ON sw.id = ws.student_week_id
          WHERE ws.id = ?`,
        [slotId]
      );
      if (slotRows.length === 0) return sendError(req, res, 404, 'not_found', 'slot not found');
      const slot = slotRows[0];

      // Ownership: a student may only open their own slot.
      if (Number(slot.student_id) !== req.auth!.userId) {
        return sendError(req, res, 403, 'forbidden', 'not your slot');
      }

      if (slot.status === 'locked') {
        return sendError(req, res, 403, 'forbidden', 'slot is locked');
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

      // Stamp opened_at on first view — anchors time_to_submit_seconds at grade
      // time. Only the first open sets it (COALESCE keeps any earlier value).
      await pool.query(
        `UPDATE assignments SET opened_at = COALESCE(opened_at, NOW()) WHERE id = ?`,
        [assignmentId]
      );

      // Award 'attempt' XP — once per assignment (guarded inside awardXp).
      const xp = await awardXp(req.auth!.userId, assignmentId, 'attempt', difficulty);

      // Audit: the student viewed the mission.
      await logAttempt(assignmentId, req.auth!.userId, 'viewed', { slotId });

      const mission = await loadMissionContent(missionId);
      res.json({ assignment_id: assignmentId, ...mission, xp });
    } catch (err) {
      rlog(req).error({ err }, 'request failed');
      sendError(req, res, 500, 'internal_error', 'failed to open slot');
    }
  }
);

/**
 * POST /api/submit  body { assignmentId, selected }
 * Student-only. The assignment must belong to the authenticated student — the
 * ownership check is a query keyed to the authenticated id, so a student can
 * never submit against another student's assignment.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The submit business step: grade (row-level FOR UPDATE inside submitAndGrade),
 * award submit/correct XP, unlock the next slot, and build the response. Because
 * grading takes a FOR UPDATE lock and only proceeds when the assignment is still
 * 'open', concurrent submits are serialised: exactly one grades (and therefore
 * runs the XP award + unlock, each additionally guarded); the loser throws
 * 'not open' before touching XP or slots.
 */
async function runSubmit(assignmentId: number, selected: string) {
  const result = await submitAndGrade(assignmentId, selected);
  const submitXp = await awardXp(result.studentId, result.assignmentId, 'submit', result.difficulty);
  let correctXp = null;
  if (result.correct) {
    correctXp = await awardXp(result.studentId, result.assignmentId, 'correct', result.difficulty);
  }
  const unlock = await unlockNext(result.assignmentId);

  const [[fbRow]] = await pool.query<any[]>(`SELECT feedback_status FROM assignments WHERE id = ?`, [result.assignmentId]);
  const feedbackStatus = fbRow ? fbRow.feedback_status : 'pending';
  const [xpRow] = await pool.query<any[]>(`SELECT total_xp FROM students WHERE id = ?`, [result.studentId]);
  const totalXp = xpRow.length ? Number(xpRow[0].total_xp) : 0;
  const pointsEarned = (submitXp.awarded ? submitXp.points : 0) + (correctXp?.awarded ? correctXp.points : 0);

  return {
    ...result,
    xp: { submit: submitXp, correct: correctXp, pointsEarned, totalXp },
    unlock,
    feedback: {
      required: feedbackStatus !== 'not_required' && feedbackStatus !== 'complete',
      status: feedbackStatus,
      gates_unlock: feedbackGatesUnlock(),
    },
  };
}

/** Poll for a concurrent request's cached idempotent result. */
async function waitForIdempotentResult(key: string, assignmentId: number): Promise<any | null> {
  for (let i = 0; i < 100; i++) {
    const [[row]] = await pool.query<any[]>(
      `SELECT response FROM idempotency_keys WHERE idempotency_key = ? AND assignment_id = ?`,
      [key, assignmentId]
    );
    if (!row) return null; // the in-flight request failed and released the claim
    if (row.response != null) {
      return typeof row.response === 'string' ? JSON.parse(row.response) : row.response;
    }
    await sleep(100);
  }
  return null;
}

/**
 * POST /api/submit  body { assignmentId, selected }   header (optional): Idempotency-Key
 * Student-only, own assignment. Idempotent: a retried submit carrying the same
 * Idempotency-Key returns the ORIGINAL result rather than erroring or
 * re-grading. Concurrency-safe even without a key (grading's FOR UPDATE lets
 * only one request grade).
 */
app.post(
  '/api/submit',
  requireAuth,
  requireRole('student'),
  validate({ body: submitBody }),
  async (req, res) => {
    const { assignmentId, selected } = req.valid!.body;
    const idemKey = req.header('idempotency-key');
    try {
      // Ownership enforced in SQL: no row unless this assignment is the caller's.
      const [own] = await pool.query<any[]>(
        `SELECT 1 FROM assignments WHERE id = ? AND student_id = ?`,
        [assignmentId, req.auth!.userId]
      );
      if (own.length === 0) {
        return sendError(req, res, 403, 'forbidden', 'not your assignment');
      }

      if (idemKey) {
        // Claim the key. The UNIQUE(idempotency_key, assignment_id) makes exactly
        // one concurrent request the "owner"; the rest wait for its result.
        try {
          await pool.query(
            `INSERT INTO idempotency_keys (idempotency_key, assignment_id) VALUES (?, ?)`,
            [idemKey, assignmentId]
          );
        } catch (e: any) {
          if (e && e.code === 'ER_DUP_ENTRY') {
            const cached = await waitForIdempotentResult(idemKey, assignmentId);
            if (cached) return res.json({ ...cached, idempotent_replay: true });
            return sendError(req, res, 409, 'conflict', 'a request with this Idempotency-Key is still processing');
          }
          throw e;
        }
        try {
          const result = await runSubmit(assignmentId, selected);
          await pool.query(
            `UPDATE idempotency_keys SET response = ? WHERE idempotency_key = ? AND assignment_id = ?`,
            [JSON.stringify(result), idemKey, assignmentId]
          );
          return res.json(result);
        } catch (err) {
          // Release the claim so a genuine retry can proceed.
          await pool.query(
            `DELETE FROM idempotency_keys WHERE idempotency_key = ? AND assignment_id = ?`,
            [idemKey, assignmentId]
          ).catch(() => {});
          throw err;
        }
      }

      const result = await runSubmit(assignmentId, selected);
      res.json(result);
    } catch (err: any) {
      // Business-rule errors from grading (e.g. assignment not open) are safe to
      // surface as 400; unexpected ones are logged and surfaced generically.
      rlog(req).error({ err }, 'submit failed');
      sendError(req, res, 400, 'bad_request', err?.message ?? 'submit failed');
    }
  }
);

/** GET /api/xp/:studentId — total and the last 20 events. Own data only. */
app.get('/api/xp/:studentId', requireAuth, validate({ params: studentIdParams }), async (req, res) => {
  const studentId = resolveOwnedStudent(req, res, req.valid!.params.studentId);
  if (studentId == null) return;
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
    rlog(req).error({ err }, 'request failed');
    sendError(req, res, 500, 'internal_error', 'failed to load xp');
  }
});

/** GET /api/segment/:studentId — the student's segment and placement reason. */
app.get('/api/segment/:studentId', requireAuth, validate({ params: studentIdParams }), async (req, res) => {
  const studentId = resolveOwnedStudent(req, res, req.valid!.params.studentId);
  if (studentId == null) return;
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
    if (rows.length === 0) return sendError(req, res, 404, 'not_found', 'student not found');
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
    rlog(req).error({ err }, 'request failed');
    sendError(req, res, 500, 'internal_error', 'failed to load segment');
  }
});

/** GET /api/assistance — open assistance events (instructor/admin view). */
app.get('/api/assistance', requireAuth, requireRole('instructor', 'admin', 'sme', 'qc'), async (req, res) => {
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
    rlog(req).error({ err }, 'request failed');
    sendError(req, res, 500, 'internal_error', 'failed to load assistance events');
  }
});

/** GET /api/history/:studentId — last 5 level events, newest first. Own data only. */
app.get('/api/history/:studentId', requireAuth, validate({ params: studentIdParams }), async (req, res) => {
  const studentId = resolveOwnedStudent(req, res, req.valid!.params.studentId);
  if (studentId == null) return;
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
    rlog(req).error({ err }, 'request failed');
    sendError(req, res, 500, 'internal_error', 'failed to load history');
  }
});

// ===========================================================================
// Stage 5 — feedback + tracking
// ===========================================================================

/** GET /api/feedback/questions — active questions, ordered. Any authenticated user. */
app.get('/api/feedback/questions', requireAuth, async (req, res) => {
  try {
    const questions = await getQuestions();
    res.json(questions);
  } catch (err) {
    rlog(req).error({ err }, 'request failed');
    sendError(req, res, 500, 'internal_error', 'failed to load feedback questions');
  }
});

/**
 * POST /api/feedback/:assignmentId  body { answers: [{ question_key, value }] }
 * Student-only. Identity is the authenticated user; submitFeedback re-checks
 * that the assignment belongs to them (business rule, kept in the service).
 */
app.post(
  '/api/feedback/:assignmentId',
  requireAuth,
  requireRole('student'),
  validate({ params: assignmentIdParams, body: feedbackBody }),
  async (req, res) => {
    const assignmentId = req.valid!.params.assignmentId;
    const answers = req.valid!.body.answers;
    try {
      const studentId = req.auth!.userId;
      const result = await submitFeedback(assignmentId, studentId, answers);

      // Release the gated next slot only on the FIRST completion, and only when
      // feedback actually gates unlocking (otherwise the grade-time unlock already
      // advanced the week and re-running would skip a slot).
      let unlock = null;
      if (!result.alreadyComplete && feedbackGatesUnlock()) {
        unlock = await unlockNext(assignmentId);
      }

      res.json({ ...result, unlock });
    } catch (err: any) {
      if (err instanceof FeedbackError) {
        return sendError(req, res, err.status, 'feedback_error', err.message);
      }
      rlog(req).error({ err }, 'request failed');
      sendError(req, res, 500, 'internal_error', 'failed to submit feedback');
    }
  }
);

/** GET /api/progress/:studentId — the student's own progress panel. */
app.get('/api/progress/:studentId', requireAuth, validate({ params: studentIdParams }), async (req, res) => {
  const studentId = resolveOwnedStudent(req, res, req.valid!.params.studentId);
  if (studentId == null) return;
  try {
    const progress = await getStudentProgress(studentId);
    if (!progress) return sendError(req, res, 404, 'not_found', 'student not found');
    res.json(progress);
  } catch (err) {
    rlog(req).error({ err }, 'request failed');
    sendError(req, res, 500, 'internal_error', 'failed to load progress');
  }
});

/** GET /api/submissions/:studentId?limit=&offset=&cursor= — paginated submission log. Own data only. */
app.get(
  '/api/submissions/:studentId',
  requireAuth,
  validate({ params: studentIdParams, query: listQuery }),
  async (req, res) => {
    const studentId = resolveOwnedStudent(req, res, req.valid!.params.studentId);
    if (studentId == null) return;
    try {
      const limit = req.valid!.query.limit ?? 20;
      const offset = req.valid!.query.offset ?? 0;
      const log = await getSubmissionLog(studentId, limit, offset);
      res.json(log);
    } catch (err) {
      rlog(req).error({ err }, 'request failed');
      sendError(req, res, 500, 'internal_error', 'failed to load submissions');
    }
  }
);

/** GET /api/mission-quality — SME report. SME/QC/admin only. */
app.get(
  '/api/mission-quality',
  requireAuth,
  requireRole('sme', 'qc', 'admin'),
  async (req, res) => {
    try {
      const report = await getMissionQuality();
      res.json(report);
    } catch (err) {
      rlog(req).error({ err }, 'request failed');
      sendError(req, res, 500, 'internal_error', 'failed to build mission-quality report');
    }
  }
);

/** GET /api/mission-quality/:missionId — single mission detail. SME/QC/admin only. */
app.get(
  '/api/mission-quality/:missionId',
  requireAuth,
  requireRole('sme', 'qc', 'admin'),
  validate({ params: missionIdParams }),
  async (req, res) => {
    const missionId = req.valid!.params.missionId;
    try {
      const report = await getMissionQuality(missionId);
      res.json(report[0] ?? { mission_id: missionId, insufficient_data: true });
    } catch (err) {
      rlog(req).error({ err }, 'request failed');
      sendError(req, res, 500, 'internal_error', 'failed to build mission-quality report');
    }
  }
);

/**
 * GET /api/attempts/:assignmentId — the audit trail for one assignment.
 * A student may only read attempts for their OWN assignment. The owner is looked
 * up by assignment id (the resource key), and a mismatch is a 403 (not an empty
 * 200); the attempt query is then keyed to that authorised student id.
 */
app.get('/api/attempts/:assignmentId', requireAuth, validate({ params: assignmentIdParams }), async (req, res) => {
  const assignmentId = req.valid!.params.assignmentId;
  try {
    const [[asg]] = await pool.query<any[]>(
      `SELECT student_id FROM assignments WHERE id = ?`,
      [assignmentId]
    );
    if (!asg) return sendError(req, res, 404, 'not_found', 'assignment not found');
    if (req.auth!.role === 'student' && Number(asg.student_id) !== req.auth!.userId) {
      return sendError(req, res, 403, 'forbidden', "cannot access another user's data");
    }
    const ownerId = Number(asg.student_id);

    const [rows] = await pool.query<any[]>(
      `SELECT id, event, detail, created_at
         FROM attempt_logs
        WHERE assignment_id = ? AND student_id = ?
        ORDER BY created_at ASC, id ASC`,
      [assignmentId, ownerId]
    );
    res.json(rows);
  } catch (err) {
    rlog(req).error({ err }, 'request failed');
    sendError(req, res, 500, 'internal_error', 'failed to load attempt log');
  }
});

/** GET /quality — the internal SME mission-quality view (HTML shell). The
 *  sensitive data it renders comes from /api/mission-quality, which is
 *  SME/QC/admin only; the shell itself carries nothing secret. */
app.get('/quality', (_req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'quality.html'));
});

/**
 * POST /api/test/feedback-gating  body { enabled: boolean | null }
 * Test hook (ENABLE_TEST_HOOKS only): inject FEEDBACK_GATES_UNLOCK at runtime so
 * an HTTP-driven harness can set the server's behaviour for its own run.
 */
app.post('/api/test/feedback-gating', (req, res) => {
  if (!process.env.ENABLE_TEST_HOOKS) {
    return sendError(req, res, 403, 'forbidden', 'test hooks disabled');
  }
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean' && enabled !== null) {
    return sendError(req, res, 400, 'validation_error', 'enabled must be boolean or null');
  }
  setFeedbackGatesUnlock(enabled);
  res.json({ feedbackGatesUnlock: feedbackGatesUnlock() });
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

// Test-only routes (ENABLE_TEST_HOOKS): a synthetic error to exercise the
// central error handler, and a peek at the in-memory log ring for the logging
// test. Never registered in production.
if (process.env.ENABLE_TEST_HOOKS) {
  app.get('/api/test/boom', () => {
    throw new Error('boom: synthetic error to exercise the central error handler');
  });
  app.get('/api/test/logs', (req, res) => {
    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : undefined;
    res.json(getTestLogs(requestId));
  });
}

/**
 * Central error handler — LAST middleware. Catches anything thrown or passed to
 * next(err), logs it with stack + requestId, reports it to Sentry (if enabled),
 * and returns the consistent JSON shape. A stack trace is NEVER sent to the client.
 */
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  rlog(req).error({ err }, 'unhandled error');
  captureException(err);
  if (res.headersSent) return;
  const status = Number.isInteger(err?.status) ? err.status : 500;
  const message = status >= 500 ? 'internal server error' : String(err?.message ?? 'error');
  sendError(req, res, status, err?.code ?? 'internal_error', message);
});

const PORT = Number(process.env.PORT) || 3000;
initSentry().finally(() => {
  app.listen(PORT, () => {
    logger.info({ port: PORT, authMode: getAuthProvider().mode }, `Mission demo listening on http://localhost:${PORT}`);
    warnIfInsecureAuth();
    if (process.env.ENABLE_TEST_HOOKS) {
      logger.warn(
        { testHooks: true },
        'ENABLE_TEST_HOOKS is set — test-only routes (/api/test/*) are exposed and feedback gating is runtime-injectable. NEVER enable this in production.'
      );
    }
  });
});
