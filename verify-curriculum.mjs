// Curriculum selection acceptance harness — criteria 1–10 and 14.
// (11–13 are the pipeline: pipeline/tests/test_sessions.py and verify-curriculum-pipeline.mjs.)
//
// Mostly in-process against the DB; the last section drives the running server.
// Requires MySQL, a fresh `npm run db:seed`, and the server on :3000 with
// ENABLE_TEST_HOOKS=1.  Run: npm run verify:curriculum  (tsx — imports .ts)
import 'dotenv/config';
import { useSelectionMode } from './test-support/selection-mode.mjs';

// The in-memory log ring (criteria 6 and 9 assert on log lines) is only created
// when ENABLE_TEST_HOOKS is set at logger import, so import the app modules after.
process.env.ENABLE_TEST_HOOKS ||= '1';
const { pool } = await import('./src/db.js');
const cfg = await import('./src/config.js');
const cur = await import('./src/curriculum.js');
const sel = await import('./src/selection.js');
const { fillSlot } = await import('./src/slotFiller.js');
const { publishWeek } = await import('./src/weekPublisher.js');
const { getTestLogs } = await import('./src/logger.js');

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let pass = 0,
  fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`)) : (fail++, console.log(`  FAIL ${name} ${detail}`));
}
const q = async (sql, params = []) => (await pool.query(sql, params))[0];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const logMsgs = () => getTestLogs();

cfg.setSelectionMode('curriculum');
cfg.setPoolLookbackSessions(0);
cfg.setPercentScope('credit');
// Off by default here so the ranking sections are deterministic; the revision mix
// has its own section below.
cfg.setRevisionMixPercent(0);

const trackId = await cur.findTrack('Robotics', "Tesla's Track");
if (trackId == null) {
  console.log("FATAL: Tesla's Track not found — run `npm run db:seed` first.");
  process.exit(2);
}

async function sessionInfo(id) {
  const [r] = await q(
    `SELECT s.id, s.credit_sequence cs, s.sequence seq, p.sequence pseq, p.id pid, c.code, c.id cid
       FROM sessions s JOIN projects p ON p.id = s.project_id JOIN credits c ON c.id = p.credit_id
      WHERE s.id = ?`,
    [id]
  );
  return r
    ? {
        id: Number(r.id),
        cs: Number(r.cs),
        seq: Number(r.seq),
        pseq: Number(r.pseq),
        pid: Number(r.pid),
        code: r.code,
        cid: Number(r.cid),
      }
    : null;
}
const at = async (code, p, s) => sessionInfo(await cur.findSession(trackId, code, p, s));
async function missionSession(missionId) {
  const [m] = await q(`SELECT session_id FROM missions WHERE id = ?`, [missionId]);
  return sessionInfo(m.session_id);
}
const label = (i) => (i ? `${i.code}:${i.cs}` : 'none');

let counter = 0;
async function newStudent(tag, level, pos) {
  const r = await q(
    `INSERT INTO students (display_name, age, subject, current_level, placement_status)
     VALUES (?, 14, 'Robotics', ?, 'complete')`,
    [`CUR-${tag}-${++counter}`, level]
  );
  const id = Number(r.insertId);
  if (pos) {
    const sessionId = await cur.findSession(trackId, ...pos);
    await cur.setPosition(id, trackId, sessionId, 'explicit');
  }
  return id;
}
async function choose(studentId, extra = {}, opts = {}) {
  const [st] = await q(`SELECT age, subject, current_level FROM students WHERE id = ?`, [studentId]);
  return sel.chooseCurriculumMission(
    pool,
    { studentId, subject: st.subject, age: Number(st.age), targetLevel: Number(st.current_level), ...extra },
    opts
  );
}
/** Mark missions in the track as completed by the student. Higher mission id = seen longer ago. */
async function consume(studentId, where) {
  await q(
    `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, status, assigned_at)
     SELECT ?, m.id, m.version, 2, 'graded', DATE_SUB(UTC_TIMESTAMP(), INTERVAL m.id MINUTE)
       FROM missions m
       JOIN sessions s ON s.id = m.session_id
       JOIN projects p ON p.id = s.project_id
       JOIN credits c ON c.id = p.credit_id
      WHERE c.track_id = ? AND ${where}
        AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.student_id = ? AND a.mission_id = m.id)`,
    [studentId, trackId, studentId]
  );
}

await q(`DELETE FROM students WHERE display_name LIKE 'CUR-%'`);
await q(`DELETE FROM tracks WHERE name = 'CUR Scratch Track'`);

// ---------------------------------------------------------------------------
console.log('\n[1] Loading a curriculum creates the correct tree');
{
  const credits = await q(
    `SELECT c.code, COUNT(DISTINCT p.id) projects, COUNT(s.id) sessions
       FROM credits c JOIN projects p ON p.credit_id = c.id JOIN sessions s ON s.project_id = p.id
      WHERE c.track_id = ? GROUP BY c.id, c.code, c.sequence ORDER BY c.sequence`,
    [trackId]
  );
  check('5 credits C1..C5 in order', credits.map((c) => c.code).join() === 'C1,C2,C3,C4,C5');
  check('C1: 3 projects, 25 sessions', Number(credits[0].projects) === 3 && Number(credits[0].sessions) === 25);
  check(
    'C2..C5: 2 projects, 17 sessions each',
    credits.slice(1).every((c) => Number(c.projects) === 2 && Number(c.sessions) === 17)
  );
  const counts = await q(
    `SELECT p.session_count n FROM projects p JOIN credits c ON c.id = p.credit_id
      WHERE c.track_id = ? AND c.code = 'C1' ORDER BY p.sequence`,
    [trackId]
  );
  check('C1 projects hold 9, 8, 8 sessions', counts.map((r) => r.n).join() === '9,8,8');
  check('C1/P1/S9 → credit_sequence 9', (await at('C1', 1, 9)).cs === 9);
  check("C1/P2/S1 → credit_sequence 10 (follows P1's 9)", (await at('C1', 2, 1)).cs === 10);
  check('C1/P3/S1 → credit_sequence 18', (await at('C1', 3, 1)).cs === 18);
  check('C1/P3/S8 → credit_sequence 25', (await at('C1', 3, 8)).cs === 25);
  check('C2/P2/S1 → credit_sequence 10 (restarts per credit)', (await at('C2', 2, 1)).cs === 10);
}

const scratch = {
  subject: 'Robotics',
  track: 'CUR Scratch Track',
  display_order: 99,
  credits: [
    {
      code: 'X1',
      projects: [
        { name: 'P1', session_count: 9 },
        { name: 'P2', session_count: 8 },
      ],
    },
    { code: 'X2', projects: [{ name: 'P1', session_count: 9 }] },
  ],
};
let scratchTrackId;
{
  const r = await cur.loadCurriculumDefinition(scratch);
  scratchTrackId = r.trackId;
  check(
    'a new definition creates 1 track, 2 credits, 3 projects, 26 sessions',
    eq(r.created, { tracks: 1, credits: 2, projects: 3, sessions: 26 }) && !r.noop,
    `(${JSON.stringify(r.created)})`
  );
  const [x] = await q(
    `SELECT s.credit_sequence cs FROM sessions s JOIN projects p ON p.id = s.project_id JOIN credits c ON c.id = p.credit_id
      WHERE c.track_id = ? AND c.code = 'X1' AND p.sequence = 2 AND s.sequence = 1`,
    [scratchTrackId]
  );
  check('…and computes credit_sequence across the project boundary (X1/P2/S1 = 10)', Number(x.cs) === 10);
}

// ---------------------------------------------------------------------------
console.log('\n[2] Re-running the load is a no-op');
{
  const countIn = async (t) =>
    Number(
      (
        await q(
          `SELECT COUNT(*) n FROM sessions s JOIN projects p ON p.id = s.project_id JOIN credits c ON c.id = p.credit_id WHERE c.track_id = ?`,
          [t]
        )
      )[0].n
    );
  const before = await countIn(scratchTrackId);
  const again = await cur.loadCurriculumDefinition(scratch);
  check(
    'same definition again: noop, nothing created or updated',
    again.noop && again.updated === 0,
    `(${JSON.stringify(again)})`
  );
  check('session rows unchanged', (await countIn(scratchTrackId)) === before);
  const seeded = await cur.loadCurriculum('curriculum/teslas-track.json');
  check("re-loading the seeded Tesla's Track definition is a noop", seeded.noop);

  let refused = '';
  try {
    await cur.loadCurriculumDefinition({
      ...scratch,
      credits: [
        {
          code: 'X1',
          projects: [
            { name: 'P1', session_count: 9 },
            { name: 'P2', session_count: 7 },
          ],
        },
        scratch.credits[1],
      ],
    });
  } catch (e) {
    refused = e.message;
  }
  check('a definition that removes sessions is refused, not applied', /shrink/.test(refused), `(${refused})`);
  await q(`DELETE FROM tracks WHERE id = ?`, [scratchTrackId]);
}

// ---------------------------------------------------------------------------
console.log('\n[3] A student at C1/P1/S4 receives sessions 1–4 only');
{
  const sid = await newStudent('s4', 2, ['C1', 1, 4]);
  const poolIds = await cur.getSessionPool(sid, trackId);
  const infos = await Promise.all(poolIds.map(sessionInfo));
  check(
    'base pool is S4, S3, S2, S1 — current first, then later before earlier',
    infos.map(label).join() === 'C1:4,C1:3,C1:2,C1:1',
    `(${infos.map(label)})`
  );

  const served = [];
  for (let i = 0; i < 20; i++) {
    const r = await sel.selectMission(sid);
    if (!r) break;
    served.push(await missionSession(r.missionId));
  }
  check('20 unseen missions served', served.length === 20, `(n=${served.length})`);
  check(
    'every one from C1 sessions 1–4',
    served.every((s) => s.code === 'C1' && s.cs >= 1 && s.cs <= 4),
    `(${served.map(label)})`
  );
  check(
    'the first 5 are all the current session S4',
    served.slice(0, 5).every((s) => s.cs === 4)
  );
  check(
    'then S3, S2, S1 in that order',
    served.slice(5, 10).every((s) => s.cs === 3) &&
      served.slice(10, 15).every((s) => s.cs === 2) &&
      served.slice(15).every((s) => s.cs === 1)
  );
  check('21st: nothing — all 20 are still open, so none may be repeated yet', (await sel.selectMission(sid)) === null);

  await q(`UPDATE assignments SET status = 'graded' WHERE student_id = ?`, [sid]);
  const rep = await sel.selectMission(sid);
  const repS = rep ? await missionSession(rep.missionId) : null;
  check(
    'once completed, a revision repeat is served — still within S1–S4',
    !!rep && repS.code === 'C1' && repS.cs <= 4,
    `(${label(repS)})`
  );
  const [asg] = rep ? await q(`SELECT revision_seq FROM assignments WHERE id = ?`, [rep.assignmentId]) : [];
  check('the repeat is recorded as a revision (revision_seq 1)', !!asg && Number(asg.revision_seq) === 1);
  const [log] = await q(
    `SELECT pool_size, chosen_session_id FROM selection_log WHERE student_id = ? ORDER BY id DESC LIMIT 1`,
    [sid]
  );
  check(
    'selection_log records the pool size and chosen session',
    Number(log.pool_size) > 0 && Number(log.chosen_session_id) === repS?.id
  );
}

// ---------------------------------------------------------------------------
console.log('\n[4] A student in C1 never receives C2 content');
{
  const sid = await newStudent('c1end', 2, ['C1', 3, 8]); // credit_sequence 25, the last session of C1
  const widest = await Promise.all((await cur.getSessionPool(sid, trackId, { tier: 'track' })).map(sessionInfo));
  check(
    'even the widest pool of a C1 student holds only C1 sessions',
    widest.length === 25 && widest.every((s) => s.code === 'C1'),
    `(n=${widest.length})`
  );

  await consume(sid, `c.code = 'C1'`);
  const choice = await choose(sid);
  const s = choice.chosen ? await sessionInfo(choice.chosen.session_id) : null;
  check(
    'C1 exhausted: repeats C1 as revision rather than advancing to C2',
    choice.revision && s?.code === 'C1',
    `(${label(s)})`
  );
  const [oldest] = await q(
    `SELECT MAX(m.id) id FROM missions m JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id
       JOIN credits c ON c.id = p.credit_id WHERE c.track_id = ? AND c.code = 'C1'`,
    [trackId]
  );
  check('D3c: the repeat is the mission seen longest ago', choice.chosen?.mission_id === Number(oldest.id));
}
{
  const fresh = await newStudent('c2s1-fresh', 2, ['C2', 1, 1]);
  const f = await choose(fresh);
  check(
    'a C2 student with C2 content available gets C2, nothing relaxed',
    (await sessionInfo(f.chosen.session_id)).code === 'C2' && f.relaxations.length === 0
  );

  const sid = await newStudent('c2s1', 2, ['C2', 1, 1]);
  await consume(sid, `c.code = 'C2'`);
  const choice = await choose(sid);
  const s = choice.chosen ? await sessionInfo(choice.chosen.session_id) : null;
  check(
    'D2/D3b: once C2 is exhausted, earlier-credit (C1) content is allowed',
    s?.code === 'C1' && !choice.revision,
    `(${label(s)})`
  );
  check('…starting from the latest C1 session with content (S24)', s?.cs === 24);
  check(
    '…and the step is logged as previous_credits',
    eq(choice.relaxations, ['curriculum:previous_credits']),
    `(${choice.relaxations})`
  );
}

// ---------------------------------------------------------------------------
console.log('\n[5] The current session is strongly preferred');
{
  let current = 0;
  for (let i = 0; i < 20; i++) {
    const sid = await newStudent('rank', 2, ['C1', 1, 4]);
    if ((await choose(sid)).chosen?.is_current_session) current++;
  }
  check(
    '20 independent selections at C1/P1/S4: the majority come from the current session',
    current > 10,
    `(${current}/20)`
  );
}

// ---------------------------------------------------------------------------
console.log('\n[6] Exhaustion follows D3 order, each step logged');
{
  cfg.setPoolLookbackSessions(1);
  const sid = await newStudent('lookback', 2, ['C1', 1, 4]);
  const base = await Promise.all((await cur.getSessionPool(sid, trackId)).map(sessionInfo));
  check(
    'POOL_LOOKBACK_SESSIONS=1: base pool is S4 and S3 only',
    base.map(label).join() === 'C1:4,C1:3',
    `(${base.map(label)})`
  );

  await consume(sid, `c.code = 'C1' AND s.credit_sequence IN (3, 4)`);
  const a = await choose(sid);
  const as = a.chosen ? await sessionInfo(a.chosen.session_id) : null;
  check('a: pool exhausted → widen to the credit, serving S2 before S1', as?.cs === 2, `(${label(as)})`);
  check('logged: [widen_credit]', eq(a.relaxations, ['curriculum:widen_credit']), `(${a.relaxations})`);

  await consume(sid, `c.code = 'C1' AND s.credit_sequence <= 4`);
  const c = await choose(sid);
  check(
    'b then c: no earlier credits → revision repeat',
    c.revision &&
      eq(c.relaxations, ['curriculum:widen_credit', 'curriculum:previous_credits', 'curriculum:repeat_oldest']),
    `(${c.relaxations})`
  );

  // d: a slot whose mission type nothing matches walks every step to empty. Via
  // fillSlot, so the selection_log row is the real one.
  const wk = await publishWeek(sid, '2026-12-07');
  const probe = await q(
    `INSERT INTO week_slots (student_week_id, slot_index, day_label, mission_type, time_band, status)
     VALUES (?, 9, 'Probe', 'project', 'short', 'open')`,
    [wk.studentWeekId]
  );
  const fill = await fillSlot(Number(probe.insertId));
  // The full D3 ladder. widen_time_band sits between previous_credits and
  // repeat_oldest (decision 2) and only logs when a band filter is actually
  // widened — this probe slot is 'short', so every step appears.
  const ALL = [
    'curriculum:widen_credit',
    'curriculum:previous_credits',
    'curriculum:widen_time_band',
    'curriculum:repeat_oldest',
    'curriculum:exhausted',
  ];
  check('d: nothing eligible anywhere → empty (coverage gap)', fill.gap === true);
  check('fillSlot reports a → b → b2 → c → d in order', eq(fill.relaxations, ALL), `(${fill.relaxations})`);
  const [log] = await q(
    `SELECT chosen_mission, filters_applied FROM selection_log WHERE student_id = ? ORDER BY id DESC LIMIT 1`,
    [sid]
  );
  check(
    'selection_log records the same ordered steps',
    log.chosen_mission === null && eq(parse(log.filters_applied).relaxations, ALL)
  );
  const msgs = logMsgs().map((e) => e.msg);
  const steps = [
    'widen to all sessions in the credit',
    'widen to previous credits',
    'repeat oldest completed mission',
    'no eligible mission',
  ];
  check(
    'each step also reached the application log',
    steps.every((t) => msgs.some((m) => typeof m === 'string' && m.includes(t)))
  );
  cfg.setPoolLookbackSessions(0);
}

// ---------------------------------------------------------------------------
console.log('\n[7] Never a mission from a session ahead of the student');
{
  for (const pos of [
    ['C1', 1, 1],
    ['C1', 2, 3],
    ['C1', 3, 2],
    ['C2', 1, 1],
  ]) {
    const sid = await newStudent('sweep', 2, pos);
    const ceiling = await at(...pos);
    const served = [];
    for (let i = 0; i < 12; i++) {
      const r = await sel.selectMission(sid);
      if (!r) break;
      served.push(await missionSession(r.missionId));
    }
    const ahead = served.filter((s) => s.code > ceiling.code || (s.code === ceiling.code && s.cs > ceiling.cs));
    check(
      `at ${pos.join('/')}: ${served.length} selections, none ahead`,
      served.length > 0 && ahead.length === 0,
      `(ahead=${ahead.map(label)})`
    );
  }

  // SAFETY IN SQL: hand the chooser a deliberately wrong pool containing every
  // session in the track. The ceiling in the query must still refuse S5+ and C2.
  const everySession = (
    await q(
      `SELECT s.id FROM sessions s JOIN projects p ON p.id = s.project_id JOIN credits c ON c.id = p.credit_id WHERE c.track_id = ?`,
      [trackId]
    )
  ).map((r) => Number(r.id));
  const sid = await newStudent('ceiling', 2, ['C1', 1, 4]);
  await consume(sid, `c.code = 'C1' AND s.credit_sequence <= 4`);
  const forced = await choose(sid, {}, { poolOverride: everySession });
  const fs = forced.chosen ? await sessionInfo(forced.chosen.session_id) : null;
  check(
    'with a corrupted pool of all 93 sessions, SQL still serves nothing past C1/S4',
    !!fs && fs.code === 'C1' && fs.cs <= 4 && forced.revision,
    `(${label(fs)}, revision=${forced.revision})`
  );

  const slotStudent = await newStudent('slot', 2, ['C1', 1, 4]);
  const wk = await publishWeek(slotStudent, '2026-12-07');
  const slot1 = wk.slots.find((s) => s.slot_index === 1);
  const fill = await fillSlot(slot1.id);
  const fillS = fill.sessionId ? await sessionInfo(fill.sessionId) : null;
  check(
    'fillSlot (the week-board path) fills slot 1 from the current session',
    !fill.gap && fillS?.code === 'C1' && fillS?.cs === 4,
    `(${label(fillS)})`
  );
}

// ---------------------------------------------------------------------------
console.log('\n[8] derivePositionFromPercent rounds down');
{
  check('39% of 25 → session 9, not 10', cur.sessionIndexFromPercent(39, 25).index === 9);
  const tiny = cur.sessionIndexFromPercent(3.99, 25);
  check(
    '3.99% of 25 → floor is 0, clamped to session 1 (never rounded up to 1 by arithmetic)',
    tiny.raw === 0 && tiny.index === 1
  );
  check('100% of 25 → session 25', cur.sessionIndexFromPercent(100, 25).index === 25);
  check('29% of 100 → 29 exactly (no floating-point drift to 28)', cur.sessionIndexFromPercent(29, 100).index === 29);
  let threw = false;
  try {
    cur.sessionIndexFromPercent(101, 25);
  } catch {
    threw = true;
  }
  check('a percentage above 100 is rejected', threw);

  const c1 = (await at('C1', 1, 1)).cid;
  const d = await cur.derivePositionFromPercent(39, 'credit', trackId, { creditId: c1 });
  const s = await sessionInfo(d.sessionId);
  check(
    '39% of credit C1 → C1/P1/S9',
    s.code === 'C1' && s.pseq === 1 && s.seq === 9 && d.total === 25,
    `(${label(s)})`
  );
}

// ---------------------------------------------------------------------------
console.log('\n[9] PERCENT_SCOPE changes the derived session, and the derivation is logged');
{
  const p1Id = (await at('C1', 1, 1)).pid;
  const byProject = await sessionInfo(
    (await cur.derivePositionFromPercent(39, 'project', trackId, { projectId: p1Id })).sessionId
  );
  const byTrack = await cur.derivePositionFromPercent(39, 'track', trackId);
  const byTrackS = await sessionInfo(byTrack.sessionId);
  check(
    'project scope: 39% of P1 (9 sessions) → C1/P1/S3',
    byProject.code === 'C1' && byProject.pseq === 1 && byProject.seq === 3,
    `(${label(byProject)})`
  );
  check(
    'track scope: 39% of 93 sessions → #36 → C2/P2/S2',
    byTrack.total === 93 && byTrack.index === 36 && byTrackS.code === 'C2' && byTrackS.pseq === 2 && byTrackS.seq === 2,
    `(${label(byTrackS)})`
  );

  const sid = await newStudent('percent', 2, null);
  check(
    'no stored position and no percentage → null (never guessed)',
    (await cur.resolvePosition(sid, trackId)) === null
  );

  cfg.setPercentScope('credit');
  const p1 = await cur.resolvePosition(sid, trackId, { percent: 39 });
  const p1s = await sessionInfo(p1.sessionId);
  check(
    '39% with PERCENT_SCOPE=credit → C1/P1/S9, source derived_percent',
    p1.source === 'derived_percent' && p1s.seq === 9 && p1s.pseq === 1
  );
  check(
    'source_detail keeps percent, scope, total and index',
    p1.sourceDetail.percent === 39 &&
      p1.sourceDetail.scope === 'credit' &&
      p1.sourceDetail.total === 25 &&
      p1.sourceDetail.index === 9
  );
  const derivedLog = (scope) =>
    logMsgs().some((e) => e.msg === 'position derived from LMS percent' && e.scope === scope && e.percent === 39);
  check('derivation logged with scope=credit', derivedLog('credit'));

  cfg.setPercentScope('project');
  const p2 = await cur.resolvePosition(sid, trackId, { percent: 39 });
  const p2s = await sessionInfo(p2.sessionId);
  check(
    'switching to PERCENT_SCOPE=project re-derives: C1/P1/S3',
    p2s.pseq === 1 && p2s.seq === 3 && p2.sourceDetail.scope === 'project',
    `(${label(p2s)})`
  );
  check('derivation logged with scope=project', derivedLog('project'));

  const s4 = await cur.findSession(trackId, 'C1', 1, 4);
  await cur.setPosition(sid, trackId, s4, 'explicit');
  const p3 = await cur.resolvePosition(sid, trackId, { percent: 90 });
  check('an explicit position is never overwritten by a percentage', p3.source === 'explicit' && p3.sessionId === s4);
  cfg.setPercentScope('credit');
}

// ---------------------------------------------------------------------------
console.log('\n[10] Within one session, difficulty follows the student level');
{
  const low = await choose(await newStudent('lvl1', 1, ['C1', 1, 4]));
  const high = await choose(await newStudent('lvl4', 4, ['C1', 1, 4]));
  const ls = await sessionInfo(low.chosen.session_id);
  const hs = await sessionInfo(high.chosen.session_id);
  check('both served from the same (current) session S4', ls.cs === 4 && hs.cs === 4);
  check(
    'level 1 student → difficulty 1; level 4 student → difficulty 4',
    low.chosen.difficulty === 1 && high.chosen.difficulty === 4,
    `(${low.chosen.difficulty} vs ${high.chosen.difficulty})`
  );
}

// ---------------------------------------------------------------------------
console.log('\n[14] SELECTION_MODE=legacy keeps the old selection');
{
  cfg.setSelectionMode('legacy');
  const sid = await newStudent('legacy', 2, ['C1', 1, 4]);
  const r = await sel.selectMission(sid);
  const [m] = r ? await q(`SELECT difficulty, subject FROM missions WHERE id = ?`, [r.missionId]) : [];
  check(
    'legacy: exact difficulty = current level, subject match',
    !!m && Number(m.difficulty) === 2 && m.subject === 'Robotics'
  );
  const [log] = await q(
    `SELECT pool_size, chosen_session_id, filters_applied FROM selection_log WHERE student_id = ? ORDER BY id DESC LIMIT 1`,
    [sid]
  );
  const f = parse(log.filters_applied);
  check(
    'legacy selection_log is the old shape (no pool, no curriculum fields)',
    log.pool_size === null && log.chosen_session_id === null && f.mode === undefined && f.difficulty === 2
  );
  cfg.setSelectionMode('curriculum');
}

// ---------------------------------------------------------------------------
console.log('\n[HTTP] The running server serves curriculum-scoped missions');
try {
  if (await useSelectionMode('curriculum')) {
    const [ananya] = await q(`SELECT id FROM students WHERE display_name = 'Ananya Rao'`);
    const sid = Number(ananya.id);
    const headers = { 'X-User-Id': String(sid) };
    const wk = await (await fetch(`${BASE}/api/week/${sid}`, { headers })).json();
    const slot1 = wk.slots.find((s) => s.slot_index === 1);
    const opened = await (await fetch(`${BASE}/api/slot/${slot1.slot_id}/open`, { method: 'POST', headers })).json();
    const [a] = await q(
      `SELECT m.session_id FROM assignments a JOIN missions m ON m.id = a.mission_id WHERE a.id = ?`,
      [opened.assignment_id]
    );
    const s = a ? await sessionInfo(a.session_id) : null;
    check(
      'seeded student at C1/P1/S4 opens slot 1 → a mission from C1/S4',
      s?.code === 'C1' && s?.cs === 4,
      `(${label(s)})`
    );
    await useSelectionMode(null);
  } else {
    check('server test hooks enabled (start with ENABLE_TEST_HOOKS=1)', false);
  }
} catch (err) {
  check('server reachable on ' + BASE, false, `(${err.message})`);
}

// ---------------------------------------------------------------------------
console.log('\n[D4] REVISION_MIX_PERCENT mixes earlier sessions into the current one');
{
  const sid = await newStudent('mix', 2, ['C1', 1, 4]); // pool S1..S4, all unseen

  cfg.setRevisionMixPercent(100);
  const always = [];
  for (let i = 0; i < 10; i++) always.push((await choose(sid)).chosen);
  check(
    'at 100%: every pick comes from an earlier session',
    always.every((c) => !c.is_current_session)
  );
  check('…and is flagged as a revision mix, not a repeat', (await choose(sid)).revisionMix === true);

  cfg.setRevisionMixPercent(0);
  const never = [];
  for (let i = 0; i < 10; i++) never.push((await choose(sid)).chosen);
  check(
    'at 0%: every pick is the current session',
    never.every((c) => c.is_current_session)
  );

  cfg.setRevisionMixPercent(20);
  let earlier = 0;
  const draws = 200;
  for (let i = 0; i < draws; i++) if (!(await choose(sid)).chosen.is_current_session) earlier++;
  const pct = (earlier / draws) * 100;
  check(
    `at 20%: roughly one pick in five revises (${pct.toFixed(1)}%)`,
    pct >= 8 && pct <= 34,
    `(${earlier}/${draws})`
  );

  // A student with nothing earlier to revise still gets the current session.
  const first = await newStudent('mix-s1', 2, ['C1', 1, 1]);
  cfg.setRevisionMixPercent(100);
  const only = await choose(first);
  check(
    'at 100% with no earlier session available, the current session is still served',
    only.chosen?.is_current_session === true && only.revisionMix === false
  );
  cfg.setRevisionMixPercent(0);
}

// ---------------------------------------------------------------------------
console.log('\n[D2] Time band widens before falling back to a repeat');
{
  const sid = await newStudent('band', 2, ['C1', 1, 1]); // pool is S1 only
  const s1 = await at('C1', 1, 1);
  // One MEDIUM mission on S1; the slot asks for SHORT.
  const ins = await q(
    `INSERT INTO missions (version, subject, title, body, mission_type, grading_mode, difficulty,
                           age_min, age_max, time_band, answer_key, status, session_id)
     VALUES (1, 'Robotics', 'CUR-band medium S01', 'A longer medium-band robotics question.', 'quiz', 'auto', 2,
             12, 18, 'medium', ?, 'live', ?)`,
    [JSON.stringify({ correct: 'a', explanation: 'because a' }), s1.id]
  );
  const mediumId = Number(ins.insertId);
  for (const k of ['a', 'b', 'c', 'd']) {
    await q(`INSERT INTO mission_options (mission_id, option_key, option_text) VALUES (?, ?, ?)`, [
      mediumId,
      k,
      `Option ${k}`,
    ]);
  }
  await consume(sid, `c.code = 'C1' AND s.credit_sequence = 1 AND m.time_band = 'short'`);

  const choice = await choose(sid, { missionType: 'quiz', timeBands: ['short'] });
  check(
    'short band exhausted → widen_time_band is applied',
    choice.relaxations.includes('curriculum:widen_time_band'),
    `(${choice.relaxations})`
  );
  check('…before any repeat', !choice.relaxations.includes('curriculum:repeat_oldest'));
  check(
    '…and it serves the unseen medium mission rather than repeating',
    choice.chosen?.mission_id === mediumId && choice.revision === false
  );
  check(
    'D3 order is previous_credits → widen_time_band → repeat_oldest',
    eq(choice.relaxations, ['curriculum:previous_credits', 'curriculum:widen_time_band']),
    `(${choice.relaxations})`
  );
  await q(`DELETE FROM missions WHERE id = ?`, [mediumId]);
}

// ---------------------------------------------------------------------------
console.log('\n[D1] A revision repeat earns attempt + submit XP, never correct');
{
  const hook = async (name, body) => {
    const r = await fetch(`${BASE}/api/test/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${name} hook failed: HTTP ${r.status}`);
    return r.json();
  };
  await useSelectionMode('curriculum');
  await hook('curriculum-config', { poolLookbackSessions: 0, revisionMixPercent: 0 });
  await hook('feedback-gating', { enabled: false }); // so each submit unlocks the next slot

  const sid = await newStudent('revxp', 2, ['C1', 1, 1]); // S1 only: 5 missions, 8 slots
  await publishWeek(sid, '2026-12-14');
  const hdr = { 'X-User-Id': String(sid), 'Content-Type': 'application/json' };
  const served = [];
  for (let i = 0; i < 6; i++) {
    const wk = await (await fetch(`${BASE}/api/week/${sid}`, { headers: hdr })).json();
    const slot = wk.slots.find((s) => s.status === 'open');
    if (!slot) break;
    const opened = await (
      await fetch(`${BASE}/api/slot/${slot.slot_id}/open`, { method: 'POST', headers: hdr })
    ).json();
    if (opened.empty) break;
    const [row] = await q(
      `SELECT a.mission_id, a.is_revision, a.revision_seq, m.answer_key ak
         FROM assignments a JOIN missions m ON m.id = a.mission_id WHERE a.id = ?`,
      [opened.assignment_id]
    );
    const ak = typeof row.ak === 'string' ? JSON.parse(row.ak) : row.ak;
    const res = await (
      await fetch(`${BASE}/api/submit`, {
        method: 'POST',
        headers: hdr,
        body: JSON.stringify({ assignmentId: opened.assignment_id, selected: ak.correct }),
      })
    ).json();
    served.push({
      aid: opened.assignment_id,
      missionId: Number(row.mission_id),
      isRevision: Boolean(Number(row.is_revision)),
      res,
    });
  }

  const firsts = served.filter((s) => !s.isRevision);
  const revisions = served.filter((s) => s.isRevision);
  check('the 5 unseen S1 missions are served first, none marked revision', firsts.length === 5, `(n=${firsts.length})`);
  check('then a revision repeat is served once they are exhausted', revisions.length === 1, `(n=${revisions.length})`);
  check(
    'every submit was graded correct',
    served.every((s) => s.res.correct === true)
  );

  const xpFor = async (aid, type) =>
    Number((await q(`SELECT COUNT(*) n FROM xp_events WHERE assignment_id = ? AND event_type = ?`, [aid, type]))[0].n);
  const firstOfRepeat = firsts.find((f) => f.missionId === revisions[0]?.missionId);
  check(
    'the first (non-revision) pass of that mission earned correct XP',
    (await xpFor(firstOfRepeat.aid, 'correct')) === 1
  );
  const rev = revisions[0];
  check('the revision earned attempt XP', (await xpFor(rev.aid, 'attempt')) === 1);
  check('the revision earned submit XP', (await xpFor(rev.aid, 'submit')) === 1);
  check('the revision earned NO correct XP', (await xpFor(rev.aid, 'correct')) === 0);
  check('the submit response reports no correct award', rev.res.xp.correct === null);
  const [total] = await q(
    `SELECT COUNT(*) n FROM xp_events x JOIN assignments a ON a.id = x.assignment_id
      WHERE a.student_id = ? AND a.mission_id = ? AND x.event_type = 'correct'`,
    [sid, rev.missionId]
  );
  check('a repeated mission can never earn correct XP twice', Number(total.n) === 1, `(n=${total.n})`);

  await hook('feedback-gating', { enabled: true });
  await hook('curriculum-config', { poolLookbackSessions: null, revisionMixPercent: null });
  await useSelectionMode(null);
}

await q(`DELETE FROM students WHERE display_name LIKE 'CUR-%'`);
await q(`DELETE FROM missions WHERE title LIKE 'CUR-%'`);
await pool.end();
console.log(`\n==== Curriculum: ${pass} passed, ${fail} failed ====`);
// Set the code and let Node exit on its own. process.exit() here races the
// closing pino stream and mysql2 pool handles and trips a libuv assertion on
// Windows (UV_HANDLE_CLOSING), which would fail the suite after it had passed.
process.exitCode = fail ? 1 : 0;
