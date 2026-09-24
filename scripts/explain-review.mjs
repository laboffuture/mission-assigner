// Index review: EXPLAIN every query on a student's path, and fail on a plan
// that will not survive a year of data.
//
// Indexes are cheap to get wrong and expensive to notice: with a seed database
// every plan is fast, because a full scan of 200 rows is fast. The thing worth
// catching is a query whose plan is a FULL TABLE SCAN of a table that grows with
// use — assignments, attempt_logs, xp_events, feedback_responses, sessions. Those
// are fine today and terrible in a year, and nothing in a test would say so.
//
// So: run each query through EXPLAIN, and fail if a growing table is reached
// with type=ALL or by index-less join. Small fixed tables (missions, segments,
// week_template_slots) are allowed to scan — they do not grow, and MySQL is
// right to prefer a scan of 3 rows.
//
// The queries are written out here rather than extracted from the source, so
// they can drift from the code. Each one names where it came from; if a handler
// changes shape, change it here too. A wrong plan reported on the right query
// beats no plan at all.
//
// Run: npm run db:explain      (against the compose stack in CI; see ci.yml)
import 'dotenv/config';
import mysql from 'mysql2/promise';

for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    const message = String(err?.stack ?? err)
      .split('\n')
      .slice(0, 3)
      .join(' | ');
    console.log(`INDEX REVIEW CRASHED (${event}): ${message}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Index review crashed::${message.slice(0, 400)}`);
    process.exit(1);
  });
}

const conn = await mysql.createConnection({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASS ?? '',
  database: process.env.DB_NAME ?? 'mission_demo',
  timezone: 'Z',
});

/** Tables that grow with use. A full scan of one of these is a finding. */
const GROWING = new Set([
  'assignments',
  'attempt_logs',
  'xp_events',
  'feedback_responses',
  'sessions',
  'week_slots',
  'student_weeks',
  'idempotency_keys',
  'level_events',
  'selection_log',
  'assistance_events',
  'revision_queue',
]);

const QUERIES = [
  {
    name: 'week: the slots of one week (src/server.ts GET /api/week)',
    core: true,
    sql: `SELECT ws.id, ws.slot_index, ws.status, ws.assignment_id, COALESCE(wts.is_weekly, 0) AS is_weekly
            FROM week_slots ws
            LEFT JOIN week_template_slots wts ON wts.template_id = ? AND wts.slot_index = ws.slot_index
           WHERE ws.student_week_id = ?
           ORDER BY ws.slot_index ASC`,
    params: ['$templateId', '$weekId'],
  },
  {
    name: 'week: mission content for the filled slots (src/server.ts GET /api/week)',
    core: true,
    sql: `SELECT ws.id AS week_slot_id, m.id AS mission_id, m.title, m.difficulty
            FROM week_slots ws
            JOIN assignments a ON a.id = ws.assignment_id
            JOIN missions m ON m.id = a.mission_id
           WHERE ws.student_week_id = ? AND ws.status <> 'locked' AND ws.assignment_id IS NOT NULL`,
    params: ['$weekId'],
  },
  {
    name: 'submit: the assignment being graded (src/grading.ts submitAndGrade)',
    core: true,
    sql: `SELECT a.id, a.status, a.student_id, a.mission_id, m.answer_key, m.difficulty
            FROM assignments a JOIN missions m ON m.id = a.mission_id
           WHERE a.id = ?`,
    params: ['$assignmentId'],
  },
  {
    name: 'submit: ownership check (src/server.ts POST /api/submit)',
    core: true,
    sql: `SELECT status FROM assignments WHERE id = ? AND student_id = ?`,
    params: ['$assignmentId', '$ownerId'],
  },
  {
    name: 'submit: idempotency lookup (src/server.ts POST /api/submit)',
    sql: `SELECT request_hash, response FROM idempotency_keys WHERE idempotency_key = ? AND assignment_id = ?`,
    params: ['$idemKey', '$idemAssignment'],
  },
  {
    name: 'retention: expired idempotency keys (src/idempotencyPrune.ts)',
    sql: `SELECT id FROM idempotency_keys WHERE created_at < (UTC_TIMESTAMP() - INTERVAL 7 DAY) ORDER BY created_at LIMIT 500`,
    params: [],
  },
  {
    name: 'streak: a student’s submission days (src/streaks.ts)',
    core: true,
    sql: `SELECT DISTINCT DATE(CONVERT_TZ(created_at, '+00:00', ?)) AS d
            FROM attempt_logs WHERE student_id = ? AND event = 'submitted'`,
    params: ['Asia/Kolkata', '$studentId'],
  },
  {
    name: 'progress: a student’s XP events (src/tracking.ts)',
    core: true,
    sql: `SELECT event_type, points, created_at FROM xp_events WHERE student_id = ? ORDER BY created_at DESC LIMIT 50`,
    params: ['$studentId'],
  },
  {
    name: 'attempts: the audit trail of one assignment (src/server.ts GET /api/attempts)',
    core: true,
    sql: `SELECT id, event, created_at FROM attempt_logs WHERE assignment_id = ? ORDER BY created_at ASC`,
    params: ['$assignmentId'],
  },
  {
    name: 'quality: perceived difficulty for one mission (src/tracking.ts)',
    sql: `SELECT fr.answer_value AS v
            FROM feedback_responses fr
            JOIN assignments a ON a.id = fr.assignment_id
           WHERE a.mission_id = ? AND fr.question_key = 'perceived_difficulty'`,
    params: ['$missionId'],
  },
  {
    name: 'selection: missions this student has not seen (src/selection.ts)',
    core: true,
    sql: `SELECT m.id FROM missions m
           WHERE m.subject = ? AND m.difficulty = ?
             AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.student_id = ? AND a.mission_id = m.id)
           LIMIT 25`,
    params: ['Computer Science', 1, '$studentId'],
  },
  {
    name: 'assistance: the open queue, one page (src/assistance.ts listAssistance)',
    sql: `SELECT ae.id, ae.student_id, s.display_name, seg.name AS segment_name, ae.created_at
            FROM assistance_events ae
            JOIN students s ON s.id = ae.student_id
            LEFT JOIN segments seg ON seg.id = s.segment_id
           WHERE ae.status = 'open'
           ORDER BY ae.created_at ASC, ae.id ASC
           LIMIT 51`,
    params: [],
  },
  {
    name: 'curriculum: the hours of one credit (src/curriculum.ts getHourPool)',
    core: true,
    sql: `SELECT h.id FROM hours h JOIN credits c ON c.id = h.credit_id
           WHERE c.id = ? ORDER BY h.hour_number ASC LIMIT 30`,
    params: ['$creditId'],
  },
  {
    name: 'curriculum: a student’s position and its credit (src/curriculum.ts getPosition)',
    sql: `SELECT sp.hour_id, h.hour_number, c.code, c.total_hours
            FROM student_positions sp
            JOIN hours h ON h.id = sp.hour_id
            JOIN credits c ON c.id = h.credit_id
           WHERE sp.student_id = ? AND sp.track_id = ?`,
    params: ['$positionStudent', '$positionTrack'],
  },
];

/**
 * EXPLAIN on an id that matches nothing answers "Impossible WHERE" and tells you
 * nothing about the plan, so the review runs against ids that actually exist.
 */
const idOf = async (table, column = 'id') => {
  const [[row]] = await conn.query(`SELECT MIN(${column}) AS id FROM ${table}`);
  return row?.id ?? 1;
};
// The ownership check needs an assignment and the student who OWNS it: two
// independent minimums are a pair that does not exist, and MySQL answers
// "Impossible WHERE" instead of a plan.
const [[owned]] = await conn.query(`SELECT id, student_id FROM assignments ORDER BY id LIMIT 1`);
const [[idem]] = await conn.query(`SELECT idempotency_key, assignment_id FROM idempotency_keys ORDER BY id LIMIT 1`);
const [[position]] = await conn.query(`SELECT student_id, track_id FROM student_positions ORDER BY id LIMIT 1`);
const REAL = {
  $assignmentId: owned?.id ?? (await idOf('assignments')),
  $ownerId: owned?.student_id ?? (await idOf('students')),
  $positionStudent: position?.student_id ?? null,
  $positionTrack: position?.track_id ?? null,
  $idemKey: idem?.idempotency_key ?? null,
  $idemAssignment: idem?.assignment_id ?? null,
  $studentId: await idOf('students'),
  $missionId: await idOf('missions'),
  $weekId: await idOf('student_weeks'),
  $templateId: await idOf('week_templates'),
  $creditId: await idOf('credits'),
};
const resolve = (params) => params.map((p) => (typeof p === 'string' && p.startsWith('$') ? (REAL[p] ?? 1) : p));

let findings = 0;
let skipped = 0;
const rowsOf = async (sql, params) => (await conn.query(`EXPLAIN ${sql}`, resolve(params)))[0];

console.log(`Index review against ${process.env.DB_NAME ?? 'mission_demo'}\n`);
for (const { name, sql, params, core } of QUERIES) {
  let plan;
  try {
    plan = await rowsOf(sql, params);
  } catch (err) {
    console.log(`  ERROR ${name}: ${err.message}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Index review::${name} — ${err.message.slice(0, 200)}`);
    findings++;
    continue;
  }
  console.log(`  ${name}`);
  // A lookup with no matching row is answered before any plan is chosen, so the
  // output says nothing about indexes. Say THAT, rather than counting it as a
  // query that came back clean.
  const degenerate = plan.every(
    (step) => step.table == null && /Impossible WHERE|no matching row|const table/i.test(String(step.Extra ?? ''))
  );
  if (degenerate) {
    skipped++;
    console.log('      SKIPPED — nothing in the database matches these values, so MySQL chose no plan');
    // A query on the student's path has to be plannable wherever this runs: if
    // it is not, the review proved nothing about the part that matters. Queries
    // that depend on data an environment may simply not have yet (an assistance
    // event, a stored idempotency key) are reported and allowed.
    if (core) {
      findings++;
      const message = `${name} — on the student path, but nothing in the database matches, so no plan was produced`;
      console.log(`      ^^^^ ${message}`);
      if (process.env.GITHUB_ACTIONS) console.log(`::error title=Index review::${message.slice(0, 250)}`);
    }
    continue;
  }
  for (const step of plan) {
    const table = step.table ?? '(derived)';
    const detail = `type=${step.type} key=${step.key ?? 'NONE'} rows=${step.rows} ${step.Extra ?? ''}`.trim();
    const scanning = (step.type === 'ALL' || step.key == null) && GROWING.has(String(table));
    console.log(`      ${scanning ? 'SCAN ' : '     '}${table}: ${detail}`);
    if (scanning) {
      findings++;
      const message = `${name} — reaches the growing table "${table}" with no index (${detail})`;
      console.log(`      ^^^^ ${message}`);
      if (process.env.GITHUB_ACTIONS) console.log(`::error title=Index review::${message.slice(0, 250)}`);
    }
  }
}

await conn.end();
console.log(
  `\n==== Index review: ${QUERIES.length} queries, ${QUERIES.length - skipped} planned, ${skipped} skipped for lack of data, ${findings} needing an index ====`
);
process.exitCode = findings ? 1 : 0;
