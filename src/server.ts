import 'dotenv/config';
import express from 'express';
// Named import, not default: pino-http is CommonJS whose typings are written in
// ESM syntax, so under Node's own resolution the default import is the module
// namespace and is not callable. `pinoHttp` is a real runtime export
// (module.exports.pinoHttp) and is correct under both tsconfigs.
import { pinoHttp } from 'pino-http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db.js';
import { logger, getTestLogs, newRequestId } from './logger.js';
import { initSentry, captureException } from './sentry.js';
import { selectMission } from './selection.js';
import { submitAndGrade, SubmitRejection } from './grading.js';
import { loadGradedResult } from './gradedResult.js';
import { createHash } from 'node:crypto';
import { fillSlot } from './slotFiller.js';
import { unlockNext } from './slotUnlock.js';
import { awardXp } from './xp.js';
import { getQuestions, submitFeedback, FeedbackError, clearQuestionCache } from './feedback.js';
import {
  getStudentProgress,
  getSubmissionLog,
  getXpHistory,
  getAttemptLog,
  getMissionBank,
  getMissionQuality,
  getMissionQualityPage,
  getAssignmentReview,
  logAttempt,
} from './tracking.js';
import {
  feedbackGatesUnlock,
  setFeedbackGatesUnlock,
  selectionMode,
  setSelectionMode,
  poolLookbackSessions,
  setPoolLookbackSessions,
  percentScope,
  setPercentScope,
  revisionMixPercent,
  setRevisionMixPercent,
} from './config.js';
import {
  requireAuth,
  requireRole,
  resolveOwnedStudent,
  warnIfInsecureAuth,
  getAuthProvider,
  STAFF_ROLES,
  authFromSession,
  type Role,
} from './auth.js';
import { validate } from './validate.js';
import { sendError, sendServerError } from './httpError.js';
import { isDbUnavailable } from './dbErrors.js';
import { healthz, readyz, installShutdownHandlers } from './lifecycle.js';
import { validateEnv } from './env.js';
import { issueSession, sessionMiddleware } from './session.js';
import { isProduction, testHooksEnabled } from './testHooks.js';
import { csrfMiddleware } from './csrf.js';
import { registerAuthRoutes } from './authRoutes.js';
import type { SubmitResponse } from './dto.js';
import { assertProductionSecurity } from './securityChecks.js';
import { resetRateLimiter } from './rateLimit.js';
import {
  studentIdParams,
  slotIdParams,
  missionIdParams,
  assignmentIdParams,
  submitBody,
  loginAsBody,
  feedbackBody,
  listQuery,
  idParams,
  resolveAssistanceBody,
} from './schemas.js';
import {
  listOpenAssistance,
  getAssistanceDetail,
  acknowledgeAssistance,
  resolveAssistance,
  AssistanceError,
} from './assistance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Refuse to start half-configured — validate every env var first (Item 6).
validateEnv();

const app = express();

// Behind a reverse proxy (Caddy in the deployed stack) TLS ends at the proxy and
// this process sees plain HTTP. Express then reports req.secure = false, and
// cookie-session SILENTLY refuses to set a Secure cookie — which is every
// session cookie in production, so nobody could sign in at all. Trusting the
// proxy makes Express read X-Forwarded-Proto, which Caddy sets.
//
// Off by default: trusting a forwarded header when nothing trustworthy sets it
// would let a client claim any protocol or client IP. TRUST_PROXY is the number
// of proxy hops in front of us (1 for the compose stack).
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY && TRUST_PROXY !== '0' && TRUST_PROXY !== 'false') {
  app.set('trust proxy', Number.isNaN(Number(TRUST_PROXY)) ? TRUST_PROXY : Number(TRUST_PROXY));
}

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
// Signed staff session cookie (login / LTI launch). Must precede any route that
// resolves identity from the session.
app.use(sessionMiddleware());
// Issue/verify the double-submit CSRF token. Placed after the session cookie so
// both cookies are set together; enforcement is gated by CSRF_ENFORCED.
app.use(csrfMiddleware());
app.use(express.static(join(__dirname, '..', 'public')));

// Liveness and readiness, for the container runtime and an uptime check.
// Unauthenticated on purpose, and they disclose nothing beyond up/ready.
app.get('/healthz', healthz);
app.get('/readyz', readyz);

// Staff auth: POST /api/login, POST /api/logout, GET /api/me.
registerAuthRoutes(app);

// ---------------------------------------------------------------------------
// Dev-only login roster. Logging in is inherently pre-auth (you can't pick who
// to be if you must already be authenticated), so this is the ONLY unauthed API
// route and it exists ONLY when AUTH_MODE=dev. In LTI mode identity comes from
// the launch token and this route is not registered.
// ---------------------------------------------------------------------------
if (getAuthProvider().mode === 'dev' && !isProduction()) {
  app.get('/api/dev/users', async (req, res) => {
    try {
      const [rows] = await pool.query<any[]>(
        `SELECT id, display_name, role FROM students ORDER BY FIELD(role,'student') DESC, id`
      );
      res.json({ items: rows });
    } catch (err) {
      sendServerError(req, res, err, 'failed to load users');
    }
  });

  // POST /api/dev/login-as { studentId } — set the real signed session cookie for
  // a chosen user, WITHOUT a password. This is the same session path the LTI
  // launch will use once implemented, so the frontend we build against it needs
  // no rework. Dev-only (registered only when AUTH_MODE=dev); it lets us exercise
  // the student UI end-to-end before Moodle SSO exists. NEVER available in prod.
  app.post('/api/dev/login-as', validate({ body: loginAsBody }), async (req, res) => {
    const studentId = req.valid!.body.studentId;
    try {
      const [rows] = await pool.query<any[]>(`SELECT id, display_name, role FROM students WHERE id = ?`, [studentId]);
      const u = rows[0];
      if (!u) return sendError(req, res, 404, 'not_found', 'no such user');
      issueSession(req, Number(u.id));
      rlog(req).warn({ userId: Number(u.id), role: u.role }, 'DEV login-as (no password) — insecure, dev only');
      res.json({ id: Number(u.id), display_name: u.display_name, role: u.role });
    } catch (err) {
      sendServerError(req, res, err, 'login-as failed');
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
    res.json({ items: rows });
  } catch (err) {
    sendServerError(req, res, err, 'failed to load students');
  }
});

/**
 * GET /api/current/:studentId  (Stage 1 free-play — unchanged behaviour)
 * Student-only, own data.
 *
 * @deprecated for the new (Mission Hub) UI — the week board (GET /api/week/:id +
 * POST /api/slot/:id/open) supersedes free-play. Retained only for the Stage 1
 * harness (verify.mjs). Do NOT build new UI against this endpoint.
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
      sendServerError(req, res, err, 'failed to load current mission');
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

    // is_weekly lives on the template slot; surface it so the UI can render the
    // weekly mission outside the daily sequence. LEFT JOIN keeps slots even if a
    // template row is missing (defaults to not-weekly).
    const [slotRows] = await pool.query<any[]>(
      `SELECT ws.id, ws.slot_index, ws.day_label, ws.mission_type, ws.time_band,
              ws.status, ws.assignment_id, COALESCE(wts.is_weekly, 0) AS is_weekly
         FROM week_slots ws
         LEFT JOIN week_template_slots wts
                ON wts.template_id = ? AND wts.slot_index = ws.slot_index
        WHERE ws.student_week_id = ?
        ORDER BY ws.slot_index ASC`,
      [week.template_id, week.id]
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
        is_weekly: Boolean(Number(s.is_weekly)),
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
    sendServerError(req, res, err, 'failed to load week');
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
      await pool.query(`UPDATE assignments SET opened_at = COALESCE(opened_at, NOW()) WHERE id = ?`, [assignmentId]);

      // Award 'attempt' XP — once per assignment (guarded inside awardXp).
      const xp = await awardXp(req.auth!.userId, assignmentId, 'attempt', difficulty);

      // Audit: the student viewed the mission.
      await logAttempt(assignmentId, req.auth!.userId, 'viewed', { slotId });

      const mission = await loadMissionContent(missionId);
      res.json({ assignment_id: assignmentId, ...mission, xp });
    } catch (err) {
      sendServerError(req, res, err, 'failed to open slot');
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
async function runSubmit(assignmentId: number, selected: string): Promise<SubmitResponse> {
  const result = await submitAndGrade(assignmentId, selected);
  const submitXp = await awardXp(result.studentId, result.assignmentId, 'submit', result.difficulty);
  let correctXp = null;
  // A revision repeat earns 'attempt' and 'submit' XP but never 'correct': the
  // student has already been paid for getting this mission right once.
  if (result.correct && !result.isRevision) {
    correctXp = await awardXp(result.studentId, result.assignmentId, 'correct', result.difficulty);
  }
  const unlock = await unlockNext(result.assignmentId);

  const [[fbRow]] = await pool.query<any[]>(`SELECT feedback_status FROM assignments WHERE id = ?`, [
    result.assignmentId,
  ]);
  const feedbackStatus = fbRow ? fbRow.feedback_status : 'pending';
  const [xpRow] = await pool.query<any[]>(`SELECT total_xp FROM students WHERE id = ?`, [result.studentId]);
  const totalXp = xpRow.length ? Number(xpRow[0].total_xp) : 0;
  const pointsEarned = (submitXp.awarded ? submitXp.points : 0) + (correctXp?.awarded ? correctXp.points : 0);

  // Build the pinned DTO explicitly — never spread the internal GradeResult, so
  // service-internal fields (studentId, stallCount, timings…) never leak.
  return {
    assignment_id: result.assignmentId,
    correct: result.correct,
    score_band: result.band,
    correct_option_key: result.correctAnswer,
    explanation: result.correctExplanation,
    level: { from: result.fromLevel, to: result.toLevel, reason: result.reason },
    xp: { submit: submitXp, correct: correctXp, points_earned: pointsEarned, total_xp: totalXp },
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

/** SHA-256 of the validated submit body in a fixed field order, so the same
 *  request hashes the same however its JSON keys were ordered. */
function submitRequestHash(body: { assignmentId: number; selected: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([body.assignmentId, body.selected]))
    .digest('hex');
}

/**
 * POST /api/submit  body { assignmentId, selected }   header (optional): Idempotency-Key
 * Student-only, own assignment. Idempotent: a retried submit carrying the same
 * Idempotency-Key AND the same body returns the ORIGINAL result rather than
 * erroring or re-grading. The key is bound to the body it was first used with:
 * the same key with a different body is refused with 422
 * idempotency_key_reused — replaying the first result would present it as the
 * answer to a question that was never graded. Concurrency-safe even without a
 * key (grading's FOR UPDATE lets only one request grade).
 */
app.post('/api/submit', requireAuth, requireRole('student'), validate({ body: submitBody }), async (req, res) => {
  const { assignmentId, selected } = req.valid!.body;
  const idemKey = req.header('idempotency-key');
  try {
    // Ownership enforced in SQL: no row unless this assignment is the caller's.
    const [own] = await pool.query<any[]>(`SELECT status FROM assignments WHERE id = ? AND student_id = ?`, [
      assignmentId,
      req.auth!.userId,
    ]);
    if (own.length === 0) {
      return sendError(req, res, 403, 'forbidden', 'not your assignment');
    }

    // A key already used for THIS assignment answers the request by itself —
    // checked before anything else so a reused key with a different body is
    // still refused (and never silently answered with the first result).
    const requestHash = submitRequestHash({ assignmentId, selected });
    if (idemKey) {
      const [[prior]] = await pool.query<any[]>(
        `SELECT request_hash, response FROM idempotency_keys WHERE idempotency_key = ? AND assignment_id = ?`,
        [idemKey, assignmentId]
      );
      if (prior) {
        // NULL: a key stored before request hashes existed — replay as before.
        if (prior.request_hash != null && prior.request_hash !== requestHash) {
          rlog(req).warn({ assignmentId }, 'idempotency key reused with a different body');
          return sendError(
            req,
            res,
            422,
            'idempotency_key_reused',
            'this Idempotency-Key was already used with a different request body; use a new key for a new request'
          );
        }
        const stored = prior.response != null ? prior.response : await waitForIdempotentResult(idemKey, assignmentId);
        if (stored) {
          const body = typeof stored === 'string' ? JSON.parse(stored) : stored;
          return res.json({ ...body, idempotent_replay: true });
        }
        return sendError(req, res, 409, 'conflict', 'a request with this Idempotency-Key is still processing');
      }
    }

    // Already graded — the first submit landed even if its response never
    // reached the student. Show them THAT result (with the answer they actually
    // submitted), not an error about an assignment that "is not open". Nothing
    // is re-graded and no slot is unlocked again.
    if (own[0].status === 'graded') {
      const graded = await loadGradedResult(assignmentId);
      if (graded) {
        rlog(req).info({ assignmentId }, 'submit for an already graded assignment — returning the stored result');
        if (idemKey) {
          await pool
            .query(
              `INSERT INTO idempotency_keys (idempotency_key, assignment_id, request_hash, response) VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE response = COALESCE(response, VALUES(response))`,
              [idemKey, assignmentId, requestHash, JSON.stringify(graded)]
            )
            .catch(() => {});
        }
        return res.json(graded);
      }
    }

    if (idemKey) {
      // Claim the key, recording which request it belongs to. The
      // UNIQUE(idempotency_key, assignment_id) makes exactly one concurrent
      // request the "owner"; the rest wait for its result.
      try {
        await pool.query(
          `INSERT INTO idempotency_keys (idempotency_key, assignment_id, request_hash) VALUES (?, ?, ?)`,
          [idemKey, assignmentId, requestHash]
        );
      } catch (e: any) {
        if (e && e.code === 'ER_DUP_ENTRY') {
          const [[prior]] = await pool.query<any[]>(
            `SELECT request_hash FROM idempotency_keys WHERE idempotency_key = ? AND assignment_id = ?`,
            [idemKey, assignmentId]
          );
          // NULL: a key stored before request hashes existed — replay as before.
          if (prior && prior.request_hash != null && prior.request_hash !== requestHash) {
            rlog(req).warn({ assignmentId }, 'idempotency key reused with a different body');
            return sendError(
              req,
              res,
              422,
              'idempotency_key_reused',
              'this Idempotency-Key was already used with a different request body; use a new key for a new request'
            );
          }
          const cached = await waitForIdempotentResult(idemKey, assignmentId);
          if (cached) return res.json({ ...cached, idempotent_replay: true });
          return sendError(req, res, 409, 'conflict', 'a request with this Idempotency-Key is still processing');
        }
        throw e;
      }
      try {
        const result = await runSubmit(assignmentId, selected);
        await pool.query(`UPDATE idempotency_keys SET response = ? WHERE idempotency_key = ? AND assignment_id = ?`, [
          JSON.stringify(result),
          idemKey,
          assignmentId,
        ]);
        return res.json(result);
      } catch (err) {
        // Release the claim so a genuine retry can proceed.
        await pool
          .query(`DELETE FROM idempotency_keys WHERE idempotency_key = ? AND assignment_id = ?`, [
            idemKey,
            assignmentId,
          ])
          .catch(() => {});
        throw err;
      }
    }

    const result = await runSubmit(assignmentId, selected);
    res.json(result);
  } catch (err: any) {
    // The client's error (not open, not one of the options): 400 at WARN.
    // Anything else is ours: 503 for a database outage, otherwise 500 — both at
    // ERROR. (Every failure used to be a 400 logged at ERROR.)
    if (err instanceof SubmitRejection) {
      rlog(req).warn({ assignmentId, code: err.code, reason: err.message }, 'submit rejected');
      return sendError(req, res, 400, err.code, err.message);
    }
    sendServerError(req, res, err, 'submit failed', 'submit failed');
  }
});

/** GET /api/xp/:studentId — total + cursor-paginated event history. Own data only. */
app.get(
  '/api/xp/:studentId',
  requireAuth,
  validate({ params: studentIdParams, query: listQuery }),
  async (req, res) => {
    const studentId = resolveOwnedStudent(req, res, req.valid!.params.studentId);
    if (studentId == null) return;
    try {
      const [[totalRow]] = await pool.query<any[]>(`SELECT total_xp FROM students WHERE id = ?`, [studentId]);
      const page = await getXpHistory(studentId, { limit: req.valid!.query.limit, cursor: req.valid!.query.cursor });
      res.json({ total_xp: totalRow ? Number(totalRow.total_xp) : 0, items: page.items, nextCursor: page.nextCursor });
    } catch (err) {
      sendServerError(req, res, err, 'failed to load xp');
    }
  }
);

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

    // Where the student is in the curriculum, when curriculum mode has placed
    // them: track -> credit -> project -> session. Null for a student who has
    // no position (legacy selection, or not yet placed), and the screens then
    // fall back to the segment wording below.
    const [[pos]] = await pool.query<any[]>(
      `SELECT t.name AS track_name, c.code AS credit_code, c.name AS credit_name, c.sequence AS credit_sequence,
              p.name AS project_name, p.sequence AS project_sequence, p.session_count,
              s2.title AS session_title, s2.sequence AS session_sequence, s2.credit_sequence AS session_credit_sequence,
              sp.source
         FROM student_positions sp
         JOIN tracks t ON t.id = sp.track_id AND t.active = TRUE
         JOIN sessions s2 ON s2.id = sp.session_id
         JOIN projects p ON p.id = s2.project_id
         JOIN credits c ON c.id = p.credit_id
        WHERE sp.student_id = ?
        ORDER BY (t.subject = ?) DESC, sp.updated_at DESC
        LIMIT 1`,
      [studentId, r.subject]
    );

    res.json({
      student_id: Number(r.student_id),
      age: Number(r.age),
      subject: r.subject,
      current_level: Number(r.current_level),
      placement_status: r.placement_status,
      position: pos
        ? {
            track: pos.track_name,
            credit: { code: pos.credit_code, name: pos.credit_name, sequence: Number(pos.credit_sequence) },
            project: {
              name: pos.project_name,
              sequence: Number(pos.project_sequence),
              session_count: Number(pos.session_count),
            },
            session: {
              title: pos.session_title,
              sequence: Number(pos.session_sequence),
              credit_sequence: Number(pos.session_credit_sequence),
            },
            source: pos.source,
          }
        : null,
      segment:
        r.segment_id == null
          ? null
          : {
              id: Number(r.segment_id),
              name: r.segment_name,
              start_level: Number(r.start_level),
              min_level: Number(r.min_level),
              max_level: Number(r.max_level),
              description: r.description,
            },
      why:
        r.segment_id == null
          ? 'No segment assigned yet.'
          : `Age ${r.age} within range and prerequisites ${prerequisites.every((p) => p.completed) ? 'met' : 'partially met'}; ` +
            `placed at start_level ${r.start_level}.`,
      prerequisites,
    });
  } catch (err) {
    sendServerError(req, res, err, 'failed to load segment');
  }
});

// ===========================================================================
// Instructor assistance queue — surfaces the assistance_events raised when a
// student stalls. Instructor/admin only.
// ===========================================================================

/** GET /api/assistance — open events, OLDEST first, cursor-paginated. */
app.get(
  '/api/assistance',
  requireAuth,
  requireRole('instructor', 'admin'),
  validate({ query: listQuery }),
  async (req, res) => {
    try {
      const page = await listOpenAssistance({ limit: req.valid!.query.limit, cursor: req.valid!.query.cursor });
      res.json(page);
    } catch (err) {
      sendServerError(req, res, err, 'failed to load assistance events');
    }
  }
);

/** GET /api/assistance/:id — full detail for one event. */
app.get(
  '/api/assistance/:id',
  requireAuth,
  requireRole('instructor', 'admin'),
  validate({ params: idParams }),
  async (req, res) => {
    try {
      const detail = await getAssistanceDetail(req.valid!.params.id);
      if (!detail) return sendError(req, res, 404, 'not_found', 'assistance event not found');
      res.json(detail);
    } catch (err) {
      sendServerError(req, res, err, 'failed to load assistance event');
    }
  }
);

/** POST /api/assistance/:id/acknowledge — the instructor has seen it. */
app.post(
  '/api/assistance/:id/acknowledge',
  requireAuth,
  requireRole('instructor', 'admin'),
  validate({ params: idParams }),
  async (req, res) => {
    try {
      const detail = await acknowledgeAssistance(req.valid!.params.id, req.auth!.userId);
      res.json(detail);
    } catch (err: any) {
      if (err instanceof AssistanceError) return sendError(req, res, err.status, 'assistance_error', err.message);
      sendServerError(req, res, err, 'failed to acknowledge');
    }
  }
);

/** POST /api/assistance/:id/resolve  body { note } — resolve with a required note. */
app.post(
  '/api/assistance/:id/resolve',
  requireAuth,
  requireRole('instructor', 'admin'),
  validate({ params: idParams, body: resolveAssistanceBody }),
  async (req, res) => {
    try {
      const detail = await resolveAssistance(req.valid!.params.id, req.auth!.userId, req.valid!.body.note);
      res.json(detail);
    } catch (err: any) {
      if (err instanceof AssistanceError) return sendError(req, res, err.status, 'assistance_error', err.message);
      sendServerError(req, res, err, 'failed to resolve');
    }
  }
);

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
    res.json({ items: rows });
  } catch (err) {
    sendServerError(req, res, err, 'failed to load history');
  }
});

// ===========================================================================
// Stage 5 — feedback + tracking
// ===========================================================================

/** GET /api/feedback/questions — active questions, ordered. Any authenticated user. */
app.get('/api/feedback/questions', requireAuth, async (req, res) => {
  try {
    const questions = await getQuestions();
    res.json({ items: questions });
  } catch (err) {
    sendServerError(req, res, err, 'failed to load feedback questions');
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
      sendServerError(req, res, err, 'failed to submit feedback');
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
    sendServerError(req, res, err, 'failed to load progress');
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
      const log = await getSubmissionLog(studentId, { limit: req.valid!.query.limit, cursor: req.valid!.query.cursor });
      res.json(log);
    } catch (err) {
      sendServerError(req, res, err, 'failed to load submissions');
    }
  }
);

/** GET /api/mission-quality — SME report. SME/QC/admin only. */
app.get(
  '/api/mission-quality',
  requireAuth,
  requireRole('sme', 'qc', 'admin'),
  validate({ query: listQuery }),
  async (req, res) => {
    try {
      const page = await getMissionQualityPage({ limit: req.valid!.query.limit, cursor: req.valid!.query.cursor });
      res.json(page);
    } catch (err) {
      sendServerError(req, res, err, 'failed to build mission-quality report');
    }
  }
);

/** GET /api/missions — cursor-paginated mission-bank listing. SME/QC/admin only. */
app.get(
  '/api/missions',
  requireAuth,
  requireRole('sme', 'qc', 'admin'),
  validate({ query: listQuery }),
  async (req, res) => {
    try {
      const page = await getMissionBank({ limit: req.valid!.query.limit, cursor: req.valid!.query.cursor });
      res.json(page);
    } catch (err) {
      sendServerError(req, res, err, 'failed to list missions');
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
      sendServerError(req, res, err, 'failed to build mission-quality report');
    }
  }
);

/**
 * GET /api/attempts/:assignmentId — the audit trail for one assignment.
 * A student may only read attempts for their OWN assignment. The owner is looked
 * up by assignment id (the resource key), and a mismatch is a 403 (not an empty
 * 200); the attempt query is then keyed to that authorised student id.
 */
app.get(
  '/api/attempts/:assignmentId',
  requireAuth,
  validate({ params: assignmentIdParams, query: listQuery }),
  async (req, res) => {
    const assignmentId = req.valid!.params.assignmentId;
    try {
      const [[asg]] = await pool.query<any[]>(`SELECT student_id FROM assignments WHERE id = ?`, [assignmentId]);
      if (!asg) return sendError(req, res, 404, 'not_found', 'assignment not found');
      if (req.auth!.role === 'student' && Number(asg.student_id) !== req.auth!.userId) {
        return sendError(req, res, 403, 'forbidden', "cannot access another user's data");
      }
      const page = await getAttemptLog(assignmentId, Number(asg.student_id), {
        limit: req.valid!.query.limit,
        cursor: req.valid!.query.cursor,
      });
      res.json(page);
    } catch (err) {
      sendServerError(req, res, err, 'failed to load attempt log');
    }
  }
);

/**
 * GET /api/assignment/:assignmentId/review — a read-only review of the student's
 * OWN completed assignment: the question, options, their answer, the correct key,
 * the explanation, band and when submitted. Ownership enforced by the owner
 * lookup (student cross-access → 403). Only graded assignments are reviewable.
 */
app.get(
  '/api/assignment/:assignmentId/review',
  requireAuth,
  validate({ params: assignmentIdParams }),
  async (req, res) => {
    const assignmentId = req.valid!.params.assignmentId;
    // Students are constrained to their own id; staff may review any (null owner).
    const requesterStudentId = req.auth!.role === 'student' ? req.auth!.userId : null;
    try {
      const result = await getAssignmentReview(assignmentId, requesterStudentId);
      switch (result.kind) {
        case 'ok':
          return res.json(result.review);
        case 'not_found':
          return sendError(req, res, 404, 'not_found', 'assignment not found');
        case 'forbidden':
          return sendError(req, res, 403, 'forbidden', "cannot access another user's data");
        case 'not_graded':
          return sendError(req, res, 409, 'not_graded', 'this mission has not been completed yet');
      }
    } catch (err) {
      sendServerError(req, res, err, 'failed to load review');
    }
  }
);

/** Who may open the quality view: exactly the roles /api/mission-quality admits. */
const QUALITY_ROLES: readonly Role[] = ['sme', 'qc', 'admin'];

const htmlPage = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
  `${body}</body></html>`;

/** GET /quality — the internal SME mission-quality view (HTML shell), gated
 *  SERVER-SIDE (audit #41). The data was already protected by
 *  /api/mission-quality; now the page itself is too: anonymous -> redirect to
 *  the staff login, signed in without a quality role -> 403 access denied. */
app.get('/quality', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); // per-user answer: never cache it
  try {
    const auth = (await authFromSession(req)) ?? (await getAuthProvider().authenticate(req));
    if (!auth) return res.redirect(302, '/login');
    if (!QUALITY_ROLES.includes(auth.role)) {
      rlog(req).info({ userId: auth.userId, role: auth.role }, 'quality view refused');
      return res
        .status(403)
        .type('html')
        .send(
          htmlPage(
            'Access denied',
            `<h1>Access denied</h1><p>The mission-quality view is for subject-matter experts, QC and admins. ` +
              `<a href="/login">Sign in with a different account</a>.</p>`
          )
        );
    }
    res.sendFile(join(__dirname, '..', 'public', 'quality.html'));
  } catch (err) {
    const outage = isDbUnavailable(err);
    rlog(req).error({ err }, outage ? 'database unavailable' : 'quality view failed');
    res
      .status(outage ? 503 : 500)
      .type('html')
      .send(
        htmlPage(
          outage ? 'Temporarily unavailable' : 'Something went wrong',
          outage
            ? '<h1>Temporarily unavailable</h1><p>The service is temporarily unavailable. Please try again in a moment.</p>'
            : '<h1>Something went wrong</h1><p>Please try again.</p>'
        )
      );
  }
});

/** GET /login — the staff login page (Mission Hub). Public shell; the actual
 *  credential check is POST /api/login. */
app.get('/login', (_req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'login.html'));
});

// The runtime-configuration hooks are registered outside production only, so
// in production /api/test/* does not exist at all (404) under any config.
// Outside production they answer 403 unless ENABLE_TEST_HOOKS is set.
if (!isProduction()) {
  /**
   * POST /api/test/feedback-gating  body { enabled: boolean | null }
   * Test hook (ENABLE_TEST_HOOKS only): inject FEEDBACK_GATES_UNLOCK at runtime so
   * an HTTP-driven harness can set the server's behaviour for its own run.
   */
  app.post('/api/test/feedback-gating', (req, res) => {
    if (!testHooksEnabled()) {
      return sendError(req, res, 403, 'forbidden', 'test hooks disabled');
    }
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean' && enabled !== null) {
      return sendError(req, res, 400, 'validation_error', 'enabled must be boolean or null');
    }
    setFeedbackGatesUnlock(enabled);
    res.json({ feedbackGatesUnlock: feedbackGatesUnlock() });
  });

  /**
   * POST /api/test/selection-mode  body { mode: 'legacy' | 'curriculum' | null }
   * Test hook (ENABLE_TEST_HOOKS only): each harness sets the selection mode it was
   * written for, so legacy and curriculum suites run green in one pass.
   */
  app.post('/api/test/selection-mode', (req, res) => {
    if (!testHooksEnabled()) {
      return sendError(req, res, 403, 'forbidden', 'test hooks disabled');
    }
    const mode = req.body?.mode;
    if (mode !== 'legacy' && mode !== 'curriculum' && mode !== null) {
      return sendError(req, res, 400, 'validation_error', "mode must be 'legacy', 'curriculum' or null");
    }
    setSelectionMode(mode);
    res.json({ selectionMode: selectionMode() });
  });

  /**
   * POST /api/test/curriculum-config  body { poolLookbackSessions?: number|null, percentScope?: string|null }
   * Test hook (ENABLE_TEST_HOOKS only).
   */
  app.post('/api/test/curriculum-config', (req, res) => {
    if (!testHooksEnabled()) {
      return sendError(req, res, 403, 'forbidden', 'test hooks disabled');
    }
    try {
      if (req.body && 'poolLookbackSessions' in req.body) setPoolLookbackSessions(req.body.poolLookbackSessions);
      if (req.body && 'percentScope' in req.body) setPercentScope(req.body.percentScope);
      if (req.body && 'revisionMixPercent' in req.body) setRevisionMixPercent(req.body.revisionMixPercent);
    } catch (err: any) {
      return sendError(req, res, 400, 'validation_error', err?.message ?? 'invalid curriculum config');
    }
    res.json({
      poolLookbackSessions: poolLookbackSessions(),
      percentScope: percentScope(),
      revisionMixPercent: revisionMixPercent(),
    });
  });
}

/** Shared: mission content (title/body/difficulty + options). */
async function loadMissionContent(missionId: number) {
  const [missionRows] = await pool.query<any[]>(`SELECT id, title, body, difficulty FROM missions WHERE id = ?`, [
    missionId,
  ]);
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
if (testHooksEnabled()) {
  app.get('/api/test/boom', () => {
    throw new Error('boom: synthetic error to exercise the central error handler');
  });
  // Windows cannot DELIVER SIGTERM to another process (process.kill maps to
  // TerminateProcess, which kills outright), so the drain path cannot be
  // exercised there by signalling. This hook runs the identical handler —
  // process.emit('SIGTERM') — so the behaviour can be tested on a developer
  // machine; CI on Linux sends the real signal. Test-hooks only: never in
  // production.
  app.post('/api/test/shutdown', (_req, res) => {
    res.json({ ok: true });
    setImmediate(() => process.emit('SIGTERM'));
  });
  app.get('/api/test/logs', (req, res) => {
    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : undefined;
    res.json(getTestLogs(requestId));
  });
  app.post('/api/test/reset-rate-limit', (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : undefined;
    resetRateLimiter(username);
    res.json({ ok: true });
  });
  // Drop the in-process feedback-question cache so an edited prompt/option is
  // picked up without restarting (the questions are otherwise cached for the
  // process lifetime).
  app.post('/api/test/clear-feedback-cache', (_req, res) => {
    clearQuestionCache();
    res.json({ ok: true });
  });
}

/**
 * Central error handler — LAST middleware. Catches anything thrown or passed to
 * next(err), logs it with stack + requestId, reports it to Sentry (if enabled),
 * and returns the consistent JSON shape. A stack trace is NEVER sent to the client.
 */
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (status < 500) {
    // The CLIENT's error (malformed JSON, a body over the size limit, ...):
    // expected, nothing for us to act on — WARN, not ERROR, and not reported
    // to Sentry, or real errors drown in it.
    rlog(req).warn({ err: { type: err?.type, message: err?.message }, status }, 'client error');
    if (res.headersSent) return;
    return sendError(req, res, status, err?.code ?? 'bad_request', String(err?.message ?? 'error'));
  }
  captureException(err);
  if (res.headersSent) {
    rlog(req).error({ err }, 'unhandled error');
    return;
  }
  if (isDbUnavailable(err)) return sendServerError(req, res, err, 'internal server error');
  rlog(req).error({ err }, 'unhandled error');
  sendError(req, res, status, err?.code ?? 'internal_error', 'internal server error');
});

const PORT = Number(process.env.PORT) || 3000;
initSentry()
  .then(() => assertProductionSecurity())
  .catch((err) => {
    // Fatal, pre-listen security failure (e.g. default staff passwords in
    // production). Print the reason and refuse to start.
    process.stderr.write(`\nFATAL: ${err?.message ?? err}\n\n`);
    process.exit(1);
  })
  .then(() => {
    const server = app.listen(PORT, () => {
      logger.info(
        { port: PORT, authMode: getAuthProvider().mode, selectionMode: selectionMode() },
        `Mission Hub listening on http://localhost:${PORT}`
      );
      warnIfInsecureAuth();
      if (testHooksEnabled()) {
        logger.warn(
          { testHooks: true },
          'ENABLE_TEST_HOOKS is set — test-only routes (/api/test/*) are exposed and feedback gating is runtime-injectable. NEVER enable this in production.'
        );
      }
    });
    // A student's submit must not be cut off by a deploy.
    installShutdownHandlers(server, { timeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS) || 20_000 });
  });
