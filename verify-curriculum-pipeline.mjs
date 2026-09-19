// Curriculum pipeline acceptance harness — criteria 11, 12 and 13, end to end.
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

const GOOD = 'tesla-c1-p1.md'; // C1 Project 1: 9 sessions, all present
const BROKEN = 'tesla-c1-p2.md'; // C1 Project 2: 8 sessions defined, only 7 in the file
const TOPICS = ['Chassis', 'Wheels', 'Motors', 'Batteries', 'Switches', 'Sensors', 'Wiring', 'Testing', 'Showcase'];

function projectFile(title, sessionCount) {
  const out = [`# ${title}`, 'This project builds a small wheeled robot from a kit, one session at a time.'];
  for (let n = 1; n <= sessionCount; n++) {
    const topic = TOPICS[n - 1];
    out.push(`## Session ${n}: ${topic}`);
    out.push(
      `In this session students study ${topic.toLowerCase()} on the robot kit in careful detail. ` +
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
writeFileSync(join(inputDir, GOOD), projectFile('Project 1: Rolling robot', 9));
writeFileSync(join(inputDir, BROKEN), projectFile('Project 2: Line follower', 7));
const curriculumFile = join(work, 'curriculum.json');
writeFileSync(
  curriculumFile,
  JSON.stringify({
    files: {
      [GOOD]: { subject: 'Robotics', track: "Tesla's Track", credit: 'C1', project: 1 },
      [BROKEN]: { subject: 'Robotics', track: "Tesla's Track", credit: 'C1', project: 2 },
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
  console.log('\n[12] A project file whose session count does not match fails loudly');
  const ingest = pipeline('ingest');
  check('ingest exits non-zero because a file was rejected', ingest.code !== 0, `(exit=${ingest.code})`);
  check('the error names the file', ingest.out.includes(BROKEN));
  check('…the count expected and the count found', ingest.out.includes('expected 8') && ingest.out.includes('found 7'));
  check('…and the sessions it did find', ingest.out.includes('[1, 2, 3, 4, 5, 6, 7]'));
  const [brokenChunks] = await db.query(`SELECT COUNT(*) n FROM content_chunks WHERE source_file = ?`, [BROKEN]);
  check('nothing from the rejected file was stored', Number(brokenChunks[0].n) === 0);

  // -------------------------------------------------------------------------
  console.log('\n[11] Sessions are detected and missions tagged with the right session_id');
  const [chunks] = await db.query(
    `SELECT cc.id, cc.chunk_ref, cc.session_id, s.sequence, p.sequence pseq, c.code
       FROM content_chunks cc
       LEFT JOIN sessions s ON s.id = cc.session_id
       LEFT JOIN projects p ON p.id = s.project_id
       LEFT JOIN credits c ON c.id = p.credit_id
      WHERE cc.source_file = ?`,
    [GOOD]
  );
  check('the good file was chunked', chunks.length === 9, `(chunks=${chunks.length})`);
  const mismatched = chunks.filter((ch) => {
    const n = Number((/Session (\d+)/.exec(ch.chunk_ref) ?? [])[1]);
    return !(ch.code === 'C1' && Number(ch.pseq) === 1 && Number(ch.sequence) === n);
  });
  check(
    'every chunk is tagged with the C1/P1 session its heading names',
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
    `SELECT m.id, m.session_id, m.subject, m.status, cc.session_id chunk_session
       FROM missions m JOIN content_chunks cc ON cc.id = m.source_chunk_id
      WHERE cc.source_file = ?`,
    [GOOD]
  );
  check('missions were imported', missions.length > 0, `(n=${missions.length})`);
  check(
    "every mission carries its chunk's session_id",
    missions.every((m) => m.session_id != null && Number(m.session_id) === Number(m.chunk_session))
  );
  check('all 9 sessions received missions', new Set(missions.map((m) => Number(m.session_id))).size === 9);
  check(
    'missions take the track subject (Robotics), not levels.json',
    missions.every((m) => m.subject === 'Robotics')
  );
  check(
    'and land as draft, never live',
    missions.every((m) => m.status === 'draft')
  );

  // -------------------------------------------------------------------------
  console.log('\n[13] The coverage report identifies a session with no live missions');
  const cov = pipeline('coverage');
  check('coverage runs', cov.code === 0, cov.code === 0 ? '' : `(exit=${cov.code}) ${cov.out.slice(-400)}`);
  check(
    'C1/P3/S8 (credit #25, seeded with no missions) is reported as a GAP',
    /P3 S8 \(credit #25\): 0\s+GAP/.test(cov.out)
  );
  check('a seeded session with missions is not a gap', /P1 S4 \(credit #4\): 5(?!\s+GAP)/.test(cov.out));
} finally {
  await cleanup();
  await db.end();
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n==== Curriculum pipeline: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
