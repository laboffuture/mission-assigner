// Curriculum selection acceptance harness — the HOUR model.
// Criteria 1–11 and 15 here; 12–14 are the pipeline (pipeline/tests/test_hours.py
// and verify-curriculum-pipeline.mjs); 16–18 are migrations, the audit and CI.
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
cfg.setPoolLookbackHours(0);
cfg.setPercentScope('credit');
// Off by default here so the ranking sections are deterministic; the revision mix
// has its own section below.
cfg.setRevisionMixPercent(0);

const trackId = await cur.findTrack('Robotics', "Tesla's Track");
if (trackId == null) {
  console.log("FATAL: Tesla's Track not found — run `npm run db:seed` first.");
  process.exit(2);
}

async function hourInfo(id) {
  const [r] = await q(
    `SELECT h.id, h.hour_number n, c.code, c.id cid, c.total_hours total
       FROM hours h JOIN credits c ON c.id = h.credit_id
      WHERE h.id = ?`,
    [id]
  );
  return r ? { id: Number(r.id), n: Number(r.n), code: r.code, cid: Number(r.cid), total: Number(r.total) } : null;
}
const at = async (code, hour) => hourInfo(await cur.findHour(trackId, code, hour));
async function missionHour(missionId) {
  const [m] = await q(`SELECT hour_id FROM missions WHERE id = ?`, [missionId]);
  return hourInfo(m.hour_id);
}
const label = (i) => (i ? `${i.code}:H${i.n}` : 'none');

let counter = 0;
async function newStudent(tag, level, pos) {
  const r = await q(
    `INSERT INTO students (display_name, age, subject, current_level, placement_status)
     VALUES (?, 14, 'Robotics', ?, 'complete')`,
    [`CUR-${tag}-${++counter}`, level]
  );
  const id = Number(r.insertId);
  if (pos) {
    const hourId = await cur.findHour(trackId, ...pos);
    if (hourId == null) throw new Error(`no hour ${pos.join('/')}`);
    await cur.setPosition(id, trackId, hourId, 'explicit');
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
       JOIN hours h ON h.id = m.hour_id
       JOIN credits c ON c.id = h.credit_id
      WHERE c.track_id = ? AND ${where}
        AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.student_id = ? AND a.mission_id = m.id)`,
    [studentId, trackId, studentId]
  );
}

await q(`DELETE FROM students WHERE display_name LIKE 'CUR-%'`);
await q(`DELETE FROM tracks WHERE name = 'CUR Scratch Track'`);

// ---------------------------------------------------------------------------
console.log('\n[1] Loading a credit definition creates exactly total_hours hours, 1..N');
{
  const credits = await q(
    `SELECT c.code, c.total_hours, COUNT(h.id) hours, MIN(h.hour_number) lo, MAX(h.hour_number) hi
       FROM credits c LEFT JOIN hours h ON h.credit_id = c.id
      WHERE c.track_id = ? GROUP BY c.id, c.code, c.sequence, c.total_hours ORDER BY c.sequence`,
    [trackId]
  );
  check('5 credits C1..C5 in order', credits.map((c) => c.code).join() === 'C1,C2,C3,C4,C5');
  check(
    'hours per credit are DATA, and vary: 24, 24, 30, 30, 24',
    credits.map((c) => Number(c.total_hours)).join() === '24,24,30,30,24',
    `(${credits.map((c) => `${c.code}=${c.total_hours}`).join(' ')})`
  );
  check(
    'every credit holds exactly total_hours rows, numbered 1..N',
    credits.every(
      (c) => Number(c.hours) === Number(c.total_hours) && Number(c.lo) === 1 && Number(c.hi) === Number(c.total_hours)
    ),
    `(${credits.map((c) => `${c.code}:${c.hours} rows ${c.lo}..${c.hi}`).join(' ')})`
  );
  check('the hour number IS the position — C1 hour 9 is hour 9', (await at('C1', 9)).n === 9);
  check('…and numbering restarts per credit', (await at('C2', 1)).n === 1 && (await at('C3', 30)).n === 30);
  check('a credit has no hour beyond its total', (await cur.findHour(trackId, 'C1', 25)) === null);
}

const scratch = {
  subject: 'Robotics',
  track: 'CUR Scratch Track',
  display_order: 99,
  credits: [
    { code: 'X1', total_hours: 17 },
    { code: 'X2', total_hours: 9, hours: Array.from({ length: 9 }, (_, i) => ({ title: `X2 hour ${i + 1}` })) },
  ],
};
let scratchTrackId;
{
  const r = await cur.loadCurriculumDefinition(scratch);
  scratchTrackId = r.trackId;
  check(
    'a new definition creates 1 track, 2 credits, 26 hours',
    eq(r.created, { tracks: 1, credits: 2, hours: 26 }) && !r.noop,
    `(${JSON.stringify(r.created)})`
  );
  const rows = await q(
    `SELECT h.hour_number n, h.title FROM hours h JOIN credits c ON c.id = h.credit_id
      WHERE c.track_id = ? AND c.code = 'X2' ORDER BY h.hour_number`,
    [scratchTrackId]
  );
  check('…numbered 1..9 with no gaps', rows.map((x) => x.n).join() === '1,2,3,4,5,6,7,8,9');
  check('…and an hour list supplies titles', rows[0].title === 'X2 hour 1' && rows[8].title === 'X2 hour 9');
  const noTitles = await q(
    `SELECT COUNT(*) n FROM hours h JOIN credits c ON c.id = h.credit_id
      WHERE c.track_id = ? AND c.code = 'X1' AND h.title IS NULL`,
    [scratchTrackId]
  );
  check('a credit declared by total alone still gets all its hours', Number(noTitles[0].n) === 17);
}

// ---------------------------------------------------------------------------
console.log('\n[2] A definition whose hour list disagrees with total_hours is refused');
{
  let refused = '';
  try {
    await cur.loadCurriculumDefinition({
      ...scratch,
      track: 'CUR Mismatch Track',
      credits: [{ code: 'X1', total_hours: 24, hours: Array.from({ length: 23 }, () => ({})) }],
    });
  } catch (e) {
    refused = e.message;
  }
  check('refused', refused !== '', `(${refused.slice(0, 120)})`);
  check(
    '…naming BOTH numbers (24 declared, 23 listed)',
    /24/.test(refused) && /23/.test(refused),
    `(${refused.replace(/\s+/g, ' ').slice(0, 200)})`
  );
  const [t] = await q(`SELECT id FROM tracks WHERE name = 'CUR Mismatch Track'`);
  check('…and nothing was written', t === undefined);

  // The same rule, enforced against the DATABASE rather than the definition: an
  // hour row deleted behind the loader's back must be caught, not tolerated.
  const [x2] = await q(`SELECT id FROM credits WHERE track_id = ? AND code = 'X2'`, [scratchTrackId]);
  await q(`DELETE FROM hours WHERE credit_id = ? AND hour_number = 9`, [x2.id]);
  let caught = '';
  try {
    await cur.assertHourCounts(scratchTrackId);
  } catch (e) {
    caught = e.message;
  }
  check(
    'a credit missing an hour row is an error, not a warning',
    /X2/.test(caught) && /9/.test(caught),
    `(${caught.slice(0, 140)})`
  );
  const healed = await cur.loadCurriculumDefinition(scratch);
  check('…and re-running the load repairs it', healed.created.hours === 1, `(${JSON.stringify(healed.created)})`);
}

// ---------------------------------------------------------------------------
console.log('\n[3] Re-running the load is a no-op');
{
  const countIn = async (t) =>
    Number(
      (await q(`SELECT COUNT(*) n FROM hours h JOIN credits c ON c.id = h.credit_id WHERE c.track_id = ?`, [t]))[0].n
    );
  const before = await countIn(scratchTrackId);
  const again = await cur.loadCurriculumDefinition(scratch);
  check(
    'same definition again: noop, nothing created or updated',
    again.noop && again.updated === 0,
    `(${JSON.stringify(again)})`
  );
  check('hour rows unchanged', (await countIn(scratchTrackId)) === before);
  const seeded = await cur.loadCurriculum('curriculum/teslas-track.json');
  check("re-loading the seeded Tesla's Track definition is a noop", seeded.noop);

  // Shrinking a credit whose hours carry content is refused; shrinking empty
  // hours is allowed, because nothing has been taught from them.
  const [x1] = await q(`SELECT id FROM credits WHERE track_id = ? AND code = 'X1'`, [scratchTrackId]);
  const [h17] = await q(`SELECT id FROM hours WHERE credit_id = ? AND hour_number = 17`, [x1.id]);
  const sid = await newStudent('shrink', 2, null);
  await cur.setPosition(sid, scratchTrackId, Number(h17.id), 'explicit');
  let refused = '';
  try {
    await cur.loadCurriculumDefinition({ ...scratch, credits: [{ code: 'X1', total_hours: 16 }, scratch.credits[1]] });
  } catch (e) {
    refused = e.message;
  }
  check(
    'a definition that removes a TAUGHT hour is refused, not applied',
    /shrink/.test(refused) && /position/.test(refused),
    `(${refused.slice(0, 160)})`
  );
  check('…and the hour is still there', (await q(`SELECT id FROM hours WHERE id = ?`, [h17.id])).length === 1);

  await q(`DELETE FROM student_positions WHERE student_id = ?`, [sid]);
  const shrunk = await cur.loadCurriculumDefinition({
    ...scratch,
    credits: [{ code: 'X1', total_hours: 16 }, scratch.credits[1]],
  });
  check(
    'an EMPTY hour may be removed, and the removal is reported',
    shrunk.removed === 1,
    `(${JSON.stringify(shrunk)})`
  );
  await q(`DELETE FROM tracks WHERE id = ?`, [scratchTrackId]);
}

// ---------------------------------------------------------------------------
console.log('\n[4] A student at C1 hour 7 receives hours 1-7 only, never hour 8');
{
  const sid = await newStudent('h7', 2, ['C1', 7]);
  const poolIds = await cur.getHourPool(sid, trackId);
  const infos = await Promise.all(poolIds.map(hourInfo));
  check(
    'base pool is H7..H1 — current first, then later before earlier',
    infos.map((i) => i.n).join() === '7,6,5,4,3,2,1',
    `(${infos.map(label)})`
  );

  const served = [];
  for (let i = 0; i < 35; i++) {
    const r = await sel.selectMission(sid);
    if (!r) break;
    served.push(await missionHour(r.missionId));
  }
  check('35 unseen missions served (5 per hour x 7 hours)', served.length === 35, `(n=${served.length})`);
  check(
    'every one from C1 hours 1-7 — never hour 8',
    served.every((h) => h.code === 'C1' && h.n >= 1 && h.n <= 7),
    `(${[...new Set(served.map(label))].join(' ')})`
  );
  check(
    'the first 5 are all the current hour, H7',
    served.slice(0, 5).every((h) => h.n === 7)
  );
  check(
    'then H6, H5, ... down to H1, in that order',
    [6, 5, 4, 3, 2, 1].every((n, k) => served.slice(5 + k * 5, 10 + k * 5).every((h) => h.n === n)),
    `(${served.map((h) => h.n).join(',')})`
  );
  check('36th: nothing — all 35 are still open, so none may be repeated yet', (await sel.selectMission(sid)) === null);

  await q(`UPDATE assignments SET status = 'graded' WHERE student_id = ?`, [sid]);
  const rep = await sel.selectMission(sid);
  const repH = rep ? await missionHour(rep.missionId) : null;
  check(
    'once completed, a revision repeat is served — still within H1-H7',
    !!rep && repH.code === 'C1' && repH.n <= 7,
    `(${label(repH)})`
  );
  const [asg] = rep ? await q(`SELECT revision_seq FROM assignments WHERE id = ?`, [rep.assignmentId]) : [];
  check('the repeat is recorded as a revision (revision_seq 1)', !!asg && Number(asg.revision_seq) === 1);
  const [log] = await q(
    `SELECT pool_size, chosen_hour_id FROM selection_log WHERE student_id = ? ORDER BY id DESC LIMIT 1`,
    [sid]
  );
  check(
    'selection_log records the pool size and chosen hour',
    Number(log.pool_size) > 0 && Number(log.chosen_hour_id) === repH?.id
  );
}

// ---------------------------------------------------------------------------
console.log('\n[5] A student in C1 never receives C2 content');
{
  const sid = await newStudent('c1end', 2, ['C1', 24]); // the last hour of C1
  const widest = await Promise.all((await cur.getHourPool(sid, trackId, { tier: 'track' })).map(hourInfo));
  check(
    'even the widest pool of a C1 student holds only C1 hours',
    widest.length === 24 && widest.every((h) => h.code === 'C1'),
    `(n=${widest.length})`
  );

  await consume(sid, `c.code = 'C1'`);
  const choice = await choose(sid);
  const h = choice.chosen ? await hourInfo(choice.chosen.hour_id) : null;
  check(
    'C1 exhausted: repeats C1 as revision rather than advancing to C2',
    choice.revision && h?.code === 'C1',
    `(${label(h)})`
  );
  const [oldest] = await q(
    `SELECT MAX(m.id) id FROM missions m JOIN hours h ON h.id = m.hour_id
       JOIN credits c ON c.id = h.credit_id WHERE c.track_id = ? AND c.code = 'C1'`,
    [trackId]
  );
  check('D3c: the repeat is the mission seen longest ago', choice.chosen?.mission_id === Number(oldest.id));
}
{
  const fresh = await newStudent('c2h1-fresh', 2, ['C2', 1]);
  const f = await choose(fresh);
  check(
    'a C2 student with C2 content available gets C2, nothing relaxed',
    (await hourInfo(f.chosen.hour_id)).code === 'C2' && f.relaxations.length === 0
  );

  const sid = await newStudent('c2h1', 2, ['C2', 1]);
  await consume(sid, `c.code = 'C2'`);
  const choice = await choose(sid);
  const h = choice.chosen ? await hourInfo(choice.chosen.hour_id) : null;
  check(
    'D2/D3b: once C2 is exhausted, earlier-credit (C1) content is allowed',
    h?.code === 'C1' && !choice.revision,
    `(${label(h)})`
  );
  check('…starting from the latest C1 hour with content (H24)', h?.n === 24);
  check(
    '…and the step is logged as previous_credits',
    eq(choice.relaxations, ['curriculum:previous_credits']),
    `(${choice.relaxations})`
  );
}

// ---------------------------------------------------------------------------
console.log('\n[6] The current hour is strongly preferred');
{
  let current = 0;
  for (let i = 0; i < 20; i++) {
    const sid = await newStudent('rank', 2, ['C1', 7]);
    if ((await choose(sid)).chosen?.is_current_hour) current++;
  }
  check(
    '20 independent selections at C1 hour 7: the majority come from the current hour',
    current > 10,
    `(${current}/20)`
  );
}

// ---------------------------------------------------------------------------
console.log('\n[7] Exhaustion follows the relaxation order, each step logged');
{
  cfg.setPoolLookbackHours(1);
  const sid = await newStudent('lookback', 2, ['C1', 7]);
  const base = await Promise.all((await cur.getHourPool(sid, trackId)).map(hourInfo));
  check(
    'POOL_LOOKBACK_HOURS=1: base pool is H7 and H6 only',
    base.map(label).join() === 'C1:H7,C1:H6',
    `(${base.map(label)})`
  );

  await consume(sid, `c.code = 'C1' AND h.hour_number IN (6, 7)`);
  const a = await choose(sid);
  const ah = a.chosen ? await hourInfo(a.chosen.hour_id) : null;
  check('a: pool exhausted → widen to the credit, serving H5 before H4', ah?.n === 5, `(${label(ah)})`);
  check('logged: [widen_credit]', eq(a.relaxations, ['curriculum:widen_credit']), `(${a.relaxations})`);

  await consume(sid, `c.code = 'C1' AND h.hour_number <= 7`);
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
    'widen to all hours in the credit',
    'widen to previous credits',
    'repeat oldest completed mission',
    'no eligible mission',
  ];
  check(
    'each step also reached the application log',
    steps.every((t) => msgs.some((m) => typeof m === 'string' && m.includes(t)))
  );
  cfg.setPoolLookbackHours(0);
}

// ---------------------------------------------------------------------------
console.log('\n[8] Never a mission from an hour ahead of the student');
{
  for (const pos of [
    ['C1', 1],
    ['C1', 12],
    ['C1', 22],
    ['C2', 1],
  ]) {
    const sid = await newStudent('sweep', 2, pos);
    const ceiling = await at(...pos);
    const served = [];
    for (let i = 0; i < 12; i++) {
      const r = await sel.selectMission(sid);
      if (!r) break;
      served.push(await missionHour(r.missionId));
    }
    const ahead = served.filter((h) => h.code > ceiling.code || (h.code === ceiling.code && h.n > ceiling.n));
    check(
      `at ${pos.join(' hour ')}: ${served.length} selections, none ahead`,
      served.length > 0 && ahead.length === 0,
      `(ahead=${ahead.map(label)})`
    );
  }

  // SAFETY IN SQL: hand the chooser a deliberately wrong pool containing every
  // hour in the track. The ceiling in the query must still refuse H8+ and C2.
  const everyHour = (
    await q(`SELECT h.id FROM hours h JOIN credits c ON c.id = h.credit_id WHERE c.track_id = ?`, [trackId])
  ).map((r) => Number(r.id));
  const sid = await newStudent('ceiling', 2, ['C1', 7]);
  await consume(sid, `c.code = 'C1' AND h.hour_number <= 7`);
  const forced = await choose(sid, {}, { poolOverride: everyHour });
  const fh = forced.chosen ? await hourInfo(forced.chosen.hour_id) : null;
  check(
    `with a corrupted pool of all ${everyHour.length} hours, SQL still serves nothing past C1 hour 7`,
    !!fh && fh.code === 'C1' && fh.n <= 7 && forced.revision,
    `(${label(fh)}, revision=${forced.revision})`
  );
  check('…and the corrupted pool really did span the whole track', everyHour.length === 132, `(${everyHour.length})`);

  const slotStudent = await newStudent('slot', 2, ['C1', 7]);
  const wk = await publishWeek(slotStudent, '2026-12-07');
  const slot1 = wk.slots.find((s) => s.slot_index === 1);
  const fill = await fillSlot(slot1.id);
  const fillH = fill.hourId ? await hourInfo(fill.hourId) : null;
  check(
    'fillSlot (the week-board path) fills slot 1 from the current hour',
    !fill.gap && fillH?.code === 'C1' && fillH?.n === 7,
    `(${label(fillH)})`
  );
}

// ---------------------------------------------------------------------------
console.log('\n[9] derivePositionFromPercent rounds DOWN, and clamps');
{
  check('39% of 24 hours → hour 9, not 10', cur.hourNumberFromPercent(39, 24).hour === 9);
  check('39% of 30 hours → hour 11', cur.hourNumberFromPercent(39, 30).hour === 11);
  const tiny = cur.hourNumberFromPercent(3.99, 24);
  check('0.99 of an hour floors to 0 and clamps to hour 1 (never rounded up)', tiny.raw === 0 && tiny.hour === 1);
  check('0% → hour 1, not "no hour"', cur.hourNumberFromPercent(0, 24).hour === 1);
  check('100% of 24 → hour 24 (the last hour)', cur.hourNumberFromPercent(100, 24).hour === 24);
  check('29% of 100 → 29 exactly (no floating-point drift to 28)', cur.hourNumberFromPercent(29, 100).hour === 29);
  for (const bad of [101, -1]) {
    let threw = false;
    try {
      cur.hourNumberFromPercent(bad, 24);
    } catch {
      threw = true;
    }
    check(`${bad}% is rejected`, threw);
  }

  const c1 = (await at('C1', 1)).cid;
  const d = await cur.derivePositionFromPercent(39, 'credit', trackId, { creditId: c1 });
  const h = await hourInfo(d.hourId);
  check('39% of credit C1 (24 hours) → hour 9', h.code === 'C1' && h.n === 9 && d.total === 24, `(${label(h)})`);
}

// ---------------------------------------------------------------------------
console.log('\n[10] The same percentage on credits of different length gives different hours');
{
  const c1 = (await at('C1', 1)).cid; // 24 hours
  const c3 = (await at('C3', 1)).cid; // 30 hours
  const short = await cur.derivePositionFromPercent(50, 'credit', trackId, { creditId: c1 });
  const long = await cur.derivePositionFromPercent(50, 'credit', trackId, { creditId: c3 });
  const sh = await hourInfo(short.hourId);
  const lh = await hourInfo(long.hourId);
  check('50% of a 24-hour credit → hour 12', sh.code === 'C1' && sh.n === 12 && short.total === 24, `(${label(sh)})`);
  check('50% of a 30-hour credit → hour 15', lh.code === 'C3' && lh.n === 15 && long.total === 30, `(${label(lh)})`);
  check('…so the total comes from the credit, not from a constant', sh.n !== lh.n);
}

// ---------------------------------------------------------------------------
console.log('\n[11] PERCENT_SCOPE, and a derivation that is logged and never overwrites');
{
  const byTrack = await cur.derivePositionFromPercent(39, 'track', trackId);
  const byTrackH = await hourInfo(byTrack.hourId);
  check(
    'track scope: 39% of 132 hours → #51 → C3 hour 3',
    byTrack.total === 132 && byTrack.index === 51 && byTrackH.code === 'C3' && byTrackH.n === 3,
    `(total=${byTrack.total} index=${byTrack.index} ${label(byTrackH)})`
  );

  const sid = await newStudent('percent', 2, null);
  check(
    'no stored position and no percentage → null (never guessed)',
    (await cur.resolvePosition(sid, trackId)) === null
  );

  cfg.setPercentScope('credit');
  const p1 = await cur.resolvePosition(sid, trackId, { percent: 39 });
  const p1h = await hourInfo(p1.hourId);
  check(
    '39% with PERCENT_SCOPE=credit → C1 hour 9, source derived_percent',
    p1.source === 'derived_percent' && p1h.code === 'C1' && p1h.n === 9
  );
  check(
    'source_detail keeps percent, scope, total and hour',
    p1.sourceDetail.percent === 39 &&
      p1.sourceDetail.scope === 'credit' &&
      p1.sourceDetail.total === 24 &&
      p1.sourceDetail.hour_number === 9
  );
  const derivedLog = (scope) =>
    logMsgs().some((e) => e.msg === 'position derived from LMS percent' && e.scope === scope && e.percent === 39);
  check('derivation logged with scope=credit', derivedLog('credit'));

  cfg.setPercentScope('track');
  const p2 = await cur.resolvePosition(sid, trackId, { percent: 39 });
  const p2h = await hourInfo(p2.hourId);
  check(
    'switching to PERCENT_SCOPE=track re-derives: C3 hour 3',
    p2h.code === 'C3' && p2h.n === 3 && p2.sourceDetail.scope === 'track',
    `(${label(p2h)})`
  );
  check('derivation logged with scope=track', derivedLog('track'));

  const h7 = await cur.findHour(trackId, 'C1', 7);
  await cur.setPosition(sid, trackId, h7, 'explicit');
  const p3 = await cur.resolvePosition(sid, trackId, { percent: 90 });
  check('an explicit position is never overwritten by a percentage', p3.source === 'explicit' && p3.hourId === h7);
  cfg.setPercentScope('credit');
}

// ---------------------------------------------------------------------------
console.log('\n[12] Within one hour, difficulty follows the student level');
{
  const low = await choose(await newStudent('lvl1', 1, ['C1', 7]));
  const high = await choose(await newStudent('lvl4', 4, ['C1', 7]));
  const lh = await hourInfo(low.chosen.hour_id);
  const hh = await hourInfo(high.chosen.hour_id);
  check('both served from the same (current) hour H7', lh.n === 7 && hh.n === 7);
  check(
    'level 1 student → difficulty 1; level 4 student → difficulty 4',
    low.chosen.difficulty === 1 && high.chosen.difficulty === 4,
    `(${low.chosen.difficulty} vs ${high.chosen.difficulty})`
  );
}

// ---------------------------------------------------------------------------
console.log('\n[13] SELECTION_MODE=legacy keeps the old selection');
{
  cfg.setSelectionMode('legacy');
  const sid = await newStudent('legacy', 2, ['C1', 7]);
  const r = await sel.selectMission(sid);
  const [m] = r ? await q(`SELECT difficulty, subject FROM missions WHERE id = ?`, [r.missionId]) : [];
  check(
    'legacy: exact difficulty = current level, subject match',
    !!m && Number(m.difficulty) === 2 && m.subject === 'Robotics'
  );
  const [log] = await q(
    `SELECT pool_size, chosen_hour_id, filters_applied FROM selection_log WHERE student_id = ? ORDER BY id DESC LIMIT 1`,
    [sid]
  );
  const f = parse(log.filters_applied);
  check(
    'legacy selection_log is the old shape (no pool, no curriculum fields)',
    log.pool_size === null && log.chosen_hour_id === null && f.mode === undefined && f.difficulty === 2
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
    // "From the CURRENT hour" only holds with revision mixing off. Pin it on
    // the server: with the 20% default this check used to fail one run in five,
    // depending on whatever mix an earlier run had left the server at. Mixing
    // itself is covered by [D4] and audit case 21.
    const curriculumConfig = (body) =>
      fetch(`${BASE}/api/test/curriculum-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    await curriculumConfig({ revisionMixPercent: 0 });
    const wk = await (await fetch(`${BASE}/api/week/${sid}`, { headers })).json();
    const slot1 = wk.slots.find((s) => s.slot_index === 1);
    const opened = await (await fetch(`${BASE}/api/slot/${slot1.slot_id}/open`, { method: 'POST', headers })).json();
    const [a] = await q(`SELECT m.hour_id FROM assignments a JOIN missions m ON m.id = a.mission_id WHERE a.id = ?`, [
      opened.assignment_id,
    ]);
    const h = a ? await hourInfo(a.hour_id) : null;
    check(
      'seeded student at C1 hour 7 opens slot 1 → a mission from C1 hour 7',
      h?.code === 'C1' && h?.n === 7,
      `(${label(h)})`
    );
    await curriculumConfig({ revisionMixPercent: null }); // back to the configured default
    await useSelectionMode(null);
  } else {
    check('server test hooks enabled (start with ENABLE_TEST_HOOKS=1)', false);
  }
} catch (err) {
  check('server reachable on ' + BASE, false, `(${err.message})`);
}

// ---------------------------------------------------------------------------
console.log('\n[D4] REVISION_MIX_PERCENT mixes earlier hours into the current one');
{
  const sid = await newStudent('mix', 2, ['C1', 7]); // pool H1..H7, all unseen

  cfg.setRevisionMixPercent(100);
  const always = [];
  for (let i = 0; i < 10; i++) always.push((await choose(sid)).chosen);
  check(
    'at 100%: every pick comes from an earlier hour',
    always.every((c) => !c.is_current_hour)
  );
  check('…and is flagged as a revision mix, not a repeat', (await choose(sid)).revisionMix === true);

  cfg.setRevisionMixPercent(0);
  const never = [];
  for (let i = 0; i < 10; i++) never.push((await choose(sid)).chosen);
  check(
    'at 0%: every pick is the current hour',
    never.every((c) => c.is_current_hour)
  );

  cfg.setRevisionMixPercent(20);
  let earlier = 0;
  const draws = 200;
  for (let i = 0; i < draws; i++) if (!(await choose(sid)).chosen.is_current_hour) earlier++;
  const pct = (earlier / draws) * 100;
  check(
    `at 20%: roughly one pick in five revises (${pct.toFixed(1)}%)`,
    pct >= 8 && pct <= 34,
    `(${earlier}/${draws})`
  );

  // A student with nothing earlier to revise still gets the current hour.
  const first = await newStudent('mix-h1', 2, ['C1', 1]);
  cfg.setRevisionMixPercent(100);
  const only = await choose(first);
  check(
    'at 100% with no earlier hour available, the current hour is still served',
    only.chosen?.is_current_hour === true && only.revisionMix === false
  );
  cfg.setRevisionMixPercent(0);
}

// ---------------------------------------------------------------------------
console.log('\n[D2] Time band widens before falling back to a repeat');
{
  const sid = await newStudent('band', 2, ['C1', 1]); // pool is H1 only
  const h1 = await at('C1', 1);
  // One MEDIUM mission on H1; the slot asks for SHORT.
  const ins = await q(
    `INSERT INTO missions (version, subject, title, body, mission_type, grading_mode, difficulty,
                           age_min, age_max, time_band, answer_key, status, hour_id)
     VALUES (1, 'Robotics', 'CUR-band medium H01', 'A longer medium-band robotics question.', 'quiz', 'auto', 2,
             12, 18, 'medium', ?, 'live', ?)`,
    [JSON.stringify({ correct: 'a', explanation: 'because a' }), h1.id]
  );
  const mediumId = Number(ins.insertId);
  for (const k of ['a', 'b', 'c', 'd']) {
    await q(`INSERT INTO mission_options (mission_id, option_key, option_text) VALUES (?, ?, ?)`, [
      mediumId,
      k,
      `Option ${k}`,
    ]);
  }
  await consume(sid, `c.code = 'C1' AND h.hour_number = 1 AND m.time_band = 'short'`);

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
  await hook('curriculum-config', { poolLookbackHours: 0, revisionMixPercent: 0 });
  await hook('feedback-gating', { enabled: false }); // so each submit unlocks the next slot

  const sid = await newStudent('revxp', 2, ['C1', 1]); // H1 only: 5 missions, 8 slots
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
  check('the 5 unseen H1 missions are served first, none marked revision', firsts.length === 5, `(n=${firsts.length})`);
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
  await hook('curriculum-config', { poolLookbackHours: null, revisionMixPercent: null });
  await useSelectionMode(null);
}

// ---------------------------------------------------------------------------
console.log('\n[14] Revisions rotate even when every timestamp is in the same second');
{
  // assigned_at has one-second resolution, so a demo (or a fast student) can
  // produce several assignments that all share a timestamp. Ordering the repeat
  // by last_seen then mission id then makes the SAME mission win every time:
  // the one just served comes straight back (audit finding 50). Assignment ids
  // are monotonic, so they order same-second events correctly.
  const sid = await newStudent('same-second', 2, ['C1', 24]);
  // ONE literal timestamp for every row, so every last_seen genuinely ties —
  // what a demo produces when slots are opened and graded within a second.
  const TS = '2026-06-01 09:00:00';
  await q(
    `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, status, assigned_at, graded_at)
     SELECT ?, m.id, m.version, 2, 'graded', ?, ?
       FROM missions m
       JOIN hours h ON h.id = m.hour_id
       JOIN credits c ON c.id = h.credit_id
      WHERE c.track_id = ? AND c.code = 'C1'
        AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.student_id = ? AND a.mission_id = m.id)`,
    [sid, TS, TS, trackId, sid]
  );

  // Four slots opened and graded one after another, all stamped that same second.
  const served = [];
  for (let i = 0; i < 4; i++) {
    const c = await choose(sid);
    if (!c.chosen) break;
    served.push(Number(c.chosen.mission_id));
    await q(
      `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, status,
                                assigned_at, graded_at, revision_seq, is_revision)
       VALUES (?, ?, 1, 2, 'graded', ?, ?,
               (SELECT COALESCE(MAX(a.revision_seq), 0) + 1 FROM assignments a
                 WHERE a.student_id = ? AND a.mission_id = ?), TRUE)`,
      [sid, c.chosen.mission_id, TS, TS, sid, c.chosen.mission_id]
    );
  }
  check('four revisions served', served.length === 4, `(got ${served.length})`);
  check(
    'no mission is repeated within the same second',
    new Set(served).size === served.length,
    `(served ${served.join(' -> ')})`
  );
}

await q(`DELETE FROM students WHERE display_name LIKE 'CUR-%'`);
await q(`DELETE FROM missions WHERE title LIKE 'CUR-%'`);
await pool.end();
console.log(`\n==== Curriculum: ${pass} passed, ${fail} failed ====`);
// Set the code and let Node exit on its own. process.exit() here races the
// closing pino stream and mysql2 pool handles and trips a libuv assertion on
// Windows (UV_HANDLE_CLOSING), which would fail the suite after it had passed.
process.exitCode = fail ? 1 : 0;
