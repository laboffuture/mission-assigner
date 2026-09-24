// Curriculum pipeline acceptance harness — criteria 12, 13 and 14, end to end.
// Runs the real Stage 2 CLI (mock LLM, no API key) against MySQL with throwaway
// input/log directories, then checks what landed in the database.
// Requires MySQL, a fresh `npm run db:seed` (Tesla's Track loaded) and pipeline/.venv.
// Run: npm run verify:curriculum-pipeline
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pipelineDir = join(root, 'pipeline');
const venvPy = ['pipeline/.venv/Scripts/python.exe', 'pipeline/.venv/bin/python']
  .map((p) => join(root, p))
  .find(existsSync);
if (!venvPy) {
  console.log('FATAL: pipeline/.venv not found — create it (see pipeline/README.md).');
  process.exit(2);
}

let pass = 0,
  fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`)) : (fail++, console.log(`  FAIL ${name} ${detail}`));
}

// The SME shape: content organised by HOUR, with each file declaring the hours
// it covers. GOOD covers hours 1..9 of C1; BROKEN declares 10..17 but contains
// only seven hours, which must be refused whole.
const GOOD = 'tesla-c1-a.md'; // C1 hours 1..9, all present
const BROKEN = 'tesla-c1-b.md'; // C1 hours 10..17 declared, only 10..16 in the file
const TOPICS = ['Chassis', 'Wheels', 'Motors', 'Batteries', 'Switches', 'Sensors', 'Wiring', 'Testing', 'Showcase'];

function hourFile(title, firstHour, lastHour) {
  const out = [`# ${title}`, 'This credit builds a small wheeled robot from a kit, one hour at a time.'];
  for (let n = firstHour; n <= lastHour; n++) {
    const topic = TOPICS[(n - 1) % TOPICS.length];
    out.push(`## Hour ${n}: ${topic}`);
    out.push(
      `In this hour students study ${topic.toLowerCase()} on the robot kit in careful detail. ` +
        `A robot that loops through its control code repeats the same steps many times each second. ` +
        `Understanding ${topic.toLowerCase()} lets students predict how the robot will behave on the track.`
    );
  }
  return out.join('\n\n');
}

const work = mkdtempSync(join(tmpdir(), 'mh-curr-pipeline-'));
const inputDir = join(work, 'input');
const logsDir = join(work, 'logs');
mkdirSync(inputDir, { recursive: true });
writeFileSync(join(inputDir, GOOD), hourFile('C1: Rolling robot, hours 1-9', 1, 9));
// Declares 10..17, delivers 10..16 — one hour short of what it promises.
writeFileSync(join(inputDir, BROKEN), hourFile('C1: Line follower, hours 10-17', 10, 16));
const curriculumFile = join(work, 'curriculum.json');
writeFileSync(
  curriculumFile,
  JSON.stringify({
    files: {
      [GOOD]: { subject: 'Robotics', track: "Tesla's Track", credit: 'C1', hours: [1, 9] },
      [BROKEN]: { subject: 'Robotics', track: "Tesla's Track", credit: 'C1', hours: [10, 17] },
    },
    legacy_files: [],
  })
);

const env = {
  ...process.env,
  PIPELINE_INPUT_DIR: inputDir,
  PIPELINE_LOGS_DIR: logsDir,
  PIPELINE_CURRICULUM_FILE: curriculumFile,
  LLM_PROVIDER: 'mock',
  PYTHONIOENCODING: 'utf-8',
};
function pipeline(...args) {
  const r = spawnSync(venvPy, ['-m', 'src.main', ...args], { cwd: pipelineDir, env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});
async function cleanup() {
  const [[t]] = await db.query(
    `SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_chunks'`
  );
  if (Number(t.n) === 0) return;
  await db.query(
    `DELETE m FROM missions m JOIN content_chunks cc ON cc.id = m.source_chunk_id WHERE cc.source_file IN (?, ?)`,
    [GOOD, BROKEN]
  );
  await db.query(`DELETE FROM content_chunks WHERE source_file IN (?, ?)`, [GOOD, BROKEN]);
}
await cleanup();

try {
  // -------------------------------------------------------------------------
  console.log('\n[13] A file whose hours do not match its DECLARED range fails loudly');
  const ingest = pipeline('ingest');
  check('ingest exits non-zero because a file was rejected', ingest.code !== 0, `(exit=${ingest.code})`);
  check('the error names the file', ingest.out.includes(BROKEN));
  check(
    '…the range declared and the number found',
    ingest.out.includes('hours 10..17') && ingest.out.includes('7 were found'),
    `(${ingest.out.replace(/\s+/g, ' ').slice(-220)})`
  );
  check('…and the hours it did find', ingest.out.includes('[10, 11, 12, 13, 14, 15, 16]'));
  const [brokenChunks] = await db.query(`SELECT COUNT(*) n FROM content_chunks WHERE source_file = ?`, [BROKEN]);
  check('nothing from the rejected file was stored', Number(brokenChunks[0].n) === 0);

  // -------------------------------------------------------------------------
  console.log('\n[12] Hours are detected and missions tagged with the right hour_id');
  const [chunks] = await db.query(
    `SELECT cc.id, cc.chunk_ref, cc.hour_id, h.hour_number, c.code
       FROM content_chunks cc
       LEFT JOIN hours h ON h.id = cc.hour_id
       LEFT JOIN credits c ON c.id = h.credit_id
      WHERE cc.source_file = ?`,
    [GOOD]
  );
  check('the good file was chunked', chunks.length === 9, `(chunks=${chunks.length})`);
  const mismatched = chunks.filter((ch) => {
    const n = Number((/Hour (\d+)/.exec(ch.chunk_ref) ?? [])[1]);
    return !(ch.code === 'C1' && Number(ch.hour_number) === n);
  });
  check(
    'every chunk is tagged with the C1 hour its heading names',
    mismatched.length === 0,
    `(wrong=${mismatched.map((c) => c.chunk_ref)})`
  );

  for (const step of ['generate', 'validate', 'import']) {
    const r = pipeline(step);
    check(
      `pipeline ${step} succeeds for the good file`,
      r.code === 0,
      r.code === 0 ? '' : `(exit=${r.code}) ${r.out.slice(-400)}`
    );
  }

  const [missions] = await db.query(
    `SELECT m.id, m.hour_id, m.subject, m.status, cc.hour_id chunk_hour
       FROM missions m JOIN content_chunks cc ON cc.id = m.source_chunk_id
      WHERE cc.source_file = ?`,
    [GOOD]
  );
  check('missions were imported', missions.length > 0, `(n=${missions.length})`);
  check(
    "every mission carries its chunk's hour_id",
    missions.every((m) => m.hour_id != null && Number(m.hour_id) === Number(m.chunk_hour))
  );
  check('all 9 hours received missions', new Set(missions.map((m) => Number(m.hour_id))).size === 9);
  check(
    'missions take the track subject (Robotics), not levels.json',
    missions.every((m) => m.subject === 'Robotics')
  );
  check(
    'and land as draft, never live',
    missions.every((m) => m.status === 'draft')
  );

  // -------------------------------------------------------------------------
  console.log('\n[14] The coverage report identifies an hour with no live missions');
  const cov = pipeline('coverage');
  check('coverage runs', cov.code === 0, cov.code === 0 ? '' : `(exit=${cov.code}) ${cov.out.slice(-400)}`);
  check(
    'C1 hour 23 (seeded deliberately empty) is reported as a GAP',
    /Hour 23: 0\s+GAP/.test(cov.out),
    `(${(cov.out.match(/Hour 2[23]: \d+\s*(GAP)?/g) ?? []).join(' | ')})`
  );
  check('a seeded hour with missions is not a gap', /Hour 7: 5(?!\s+GAP)/.test(cov.out));
} finally {
  await cleanup();
  await db.end();
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n==== Curriculum pipeline: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
