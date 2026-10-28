// Curriculum pipeline acceptance harness — criteria 12, 13 and 14, end to end.
// Runs the real Stage 2 CLI (mock LLM, no API key) against MySQL with throwaway
// input/log directories, then checks what landed in the database.
// Requires MySQL, a fresh `npm run db:seed` and pipeline/.venv. Runs entirely in
// the TEST database (DB_NAME, default mission_demo) against its own fixture
// track — never the pilot database that holds real SME curriculum.
// Run: npm run verify:curriculum-pipeline
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const OTHER = 'tesla-c1-c.md'; // C1 hours 18..24 — valid, and must survive a scoped run
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
      [GOOD]: { subject: 'Robotics', track: 'Test Track Alpha', credit: 'C1', hours: [1, 9] },
      [BROKEN]: { subject: 'Robotics', track: 'Test Track Alpha', credit: 'C1', hours: [10, 17] },
      [OTHER]: { subject: 'Robotics', track: 'Test Track Alpha', credit: 'C1', hours: [18, 24] },
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
  // PINNED, not inherited. The child is python, and src/db.py loads pipeline/.env
  // at import — which now names the PILOT database, where real curriculum lives.
  // load_dotenv() does not override an existing variable, so passing this
  // explicitly is what keeps this harness in the test database. Without it the
  // harness would be one unset variable away from truncating pilot content.
  DB_NAME: process.env.DB_NAME ?? 'mission_demo',
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
    `DELETE m FROM missions m JOIN content_chunks cc ON cc.id = m.source_chunk_id
      WHERE cc.source_file IN (?, ?, ?)`,
    [GOOD, BROKEN, OTHER]
  );
  await db.query(`DELETE FROM content_chunks WHERE source_file IN (?, ?, ?)`, [GOOD, BROKEN, OTHER]);
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

  // -------------------------------------------------------------------------
  // input/ holds more than the document being worked on — sample-cs.md is a
  // legacy fixture the tests and the no-hour path depend on, so it cannot just be
  // moved away — and an unscoped generate would spend real money drafting
  // missions for it.
  console.log('\n[15] --file scopes a run to one document and leaves the others alone');
  writeFileSync(join(inputDir, OTHER), hourFile('C1: Arm, hours 18-24', 18, 24));
  const full = pipeline('ingest');
  check('an unscoped ingest still reads every file', full.code !== 0 && full.out.includes(OTHER), `(exit=${full.code})`);

  const hashes = async (file) =>
    Object.fromEntries(
      (await db.query(`SELECT chunk_ref, content_hash FROM content_chunks WHERE source_file = ?`, [file]))[0].map(
        (r) => [r.chunk_ref, r.content_hash]
      )
    );
  const otherBefore = await hashes(OTHER);
  const goodBefore = await hashes(GOOD);
  check('both valid files are in the database', Object.keys(otherBefore).length === 7 && Object.keys(goodBefore).length === 9,
    `(other=${Object.keys(otherBefore).length}, good=${Object.keys(goodBefore).length})`);

  // Change BOTH documents, then ingest only one. The other's stored hashes must
  // not move — which is the sharpest form of "never touched".
  writeFileSync(join(inputDir, GOOD), hourFile('C1: Rolling robot, hours 1-9', 1, 9) + '\n\nA further sentence for the good file.');
  writeFileSync(join(inputDir, OTHER), hourFile('C1: Arm, hours 18-24', 18, 24) + '\n\nA further sentence for the other file.');
  const scoped = pipeline('ingest', '--file', GOOD);
  check('a scoped ingest exits 0 even though a broken file sits beside it', scoped.code === 0, `(exit=${scoped.code}) ${scoped.out.slice(-200)}`);
  check(
    'it says which document it is limited to',
    scoped.out.includes(`--file ${GOOD}: reading ONLY this document`),
    `(${scoped.out.replace(/\s+/g, ' ').slice(0, 200)})`
  );
  check('the rejected file is not even read', !scoped.out.includes(BROKEN));

  const goodAfter = await hashes(GOOD);
  const otherAfter = await hashes(OTHER);
  check(
    'the scoped file WAS re-hashed (its content changed)',
    Object.keys(goodAfter).some((ref) => goodAfter[ref] !== goodBefore[ref])
  );
  check(
    'the other file was not touched at all, though its content changed too',
    JSON.stringify(otherAfter) === JSON.stringify(otherBefore),
    `(${Object.keys(otherAfter).filter((r) => otherAfter[r] !== otherBefore[r]).join(', ')})`
  );

  // ...and the same for generate, which is the one that costs money.
  const queueFile = join(logsDir, 'pending_generation.json');
  const queued = JSON.parse(readFileSync(queueFile, 'utf8'));
  check('the scoped ingest queued only its own chunks', queued.every((c) => c.source_file === GOOD) && queued.length > 0,
    `(files=${[...new Set(queued.map((c) => c.source_file))].join(', ')})`);

  // Queue both files' chunks, then generate for one.
  const bothQueue = [...queued.map((c) => ({ ...c })), ...Object.keys(otherBefore).map((ref) => ({
    ...queued[0], chunk_ref: ref, source_file: OTHER,
  }))];
  writeFileSync(queueFile, JSON.stringify(bothQueue, null, 2));
  const draftsBefore = new Set(readdirSync(join(logsDir, 'drafts')));
  const gen = pipeline('generate', '--file', OTHER);
  check('a scoped generate exits 0', gen.code === 0, `(exit=${gen.code}) ${gen.out.slice(-300)}`);
  check(
    'it reports the subset it will call for',
    new RegExp(`--file ${OTHER}: ${Object.keys(otherBefore).length} of ${bothQueue.length} queued`).test(gen.out),
    `(${gen.out.replace(/\s+/g, ' ').slice(0, 260)})`
  );
  const added = readdirSync(join(logsDir, 'drafts')).filter((f) => !draftsBefore.has(f));
  check(
    'every draft the scoped run added is from the scoped file',
    added.length === Object.keys(otherBefore).length && added.every((f) => f.startsWith('C1_Arm')),
    `(added ${added.length}: ${added.slice(0, 3).join(', ')})`
  );

  const missing = pipeline('generate', '--file', 'not-a-document.md');
  check(
    'an unmatched --file is a loud failure, not a silent no-op',
    missing.code !== 0 && /matched none of the \d+ queued/.test(missing.out),
    `(exit=${missing.code}) ${missing.out.replace(/\s+/g, ' ').slice(-160)}`
  );
  check('…and it names what was queued', missing.out.includes('not-a-document.md') && missing.out.includes(OTHER),
    `(${missing.out.replace(/\s+/g, ' ').slice(-200)})`);

  // -------------------------------------------------------------------------
  // The failure that went unnoticed for a month: db:seed rebuilds `hours` with
  // fresh ids, content_chunks.hour_id has no foreign key, and 25 chunks sat
  // pointing at hour ids that were long gone. Nothing complained until an import
  // would have hit the missions.hour_id foreign key — after the drafts were paid
  // for. So generate checks the tags before it spends anything.
  console.log('\n[16] A queued chunk tagged with an hour that no longer exists stops the run');
  {
    const good = JSON.parse(readFileSync(queueFile, 'utf8')).filter((c) => c.source_file === GOOD);
    check('the queue has tagged chunks to work with', good.length > 0 && good.every((c) => c.hour_id != null));

    const dangled = good.map((c, i) => (i === 0 ? { ...c, hour_id: 99999999 } : c));
    writeFileSync(queueFile, JSON.stringify(dangled, null, 2));
    const draftBytes = () =>
      Object.fromEntries(
        readdirSync(join(logsDir, 'drafts')).map((f) => [f, readFileSync(join(logsDir, 'drafts', f), 'utf8')])
      );
    const before = draftBytes();

    const r = pipeline('generate');
    check('exits non-zero', r.code !== 0, `(exit=${r.code})`);
    check(
      'names the chunk that is wrong',
      /no longer exist/.test(r.out) && r.out.includes(dangled[0].chunk_ref),
      `(${r.out.replace(/\s+/g, ' ').slice(-300)})`
    );
    check('…and the hour id that does not exist', r.out.includes('99999999'));
    check('…and which database it looked in', r.out.includes(process.env.DB_NAME ?? 'mission_demo'));
    check('…and the fix, in the order it has to be done', /curriculum:load/.test(r.out) && /ingest --file/.test(r.out));
    check('says plainly that nothing was charged', /nothing has been charged/i.test(r.out));
    // Not "no new file": the draft for this chunk_ref already exists, so a run
    // that went ahead would OVERWRITE it. Compare the bytes.
    check(
      'and not one draft was written or overwritten — not even for the chunks that were fine',
      JSON.stringify(draftBytes()) === JSON.stringify(before)
    );

    // The same queue with the tag intact goes through, so the refusal is about
    // the dangling id and nothing else.
    writeFileSync(queueFile, JSON.stringify(good, null, 2));
    const ok = pipeline('generate');
    check('the same queue with real hour ids generates fine', ok.code === 0, `(exit=${ok.code}) ${ok.out.slice(-200)}`);
    check('and says so', /all \d+ hour tag\(s\) in the queue resolve/.test(ok.out), `(${ok.out.replace(/\s+/g, ' ').slice(0, 200)})`);
  }

  // -------------------------------------------------------------------------
  // Row ids are not stable facts. The drafts for hour 1 of the SME document were
  // made against a database whose `hours` were later rebuilt by a reseed, so they
  // carry chunk_id 505 and hour_id 133 - rows that exist nowhere now. Importing
  // by those ids would fail on the missions.hour_id foreign key, or, with
  // different numbers, attach missions to whatever row inherited the id. So a
  // draft finds its chunk by (source_file, chunk_ref), and content_hash proves it
  // was written from the text that chunk holds now.
  console.log('\n[17] A draft with stale ids imports; a draft whose content moved on is refused');
  {
    const validatedDir = join(logsDir, 'validated');
    const [[chunkRow]] = await db.query(
      `SELECT id, chunk_ref, content_hash, hour_id FROM content_chunks WHERE source_file = ? ORDER BY id LIMIT 1`,
      [GOOD]
    );
    check('a stored chunk to aim at', !!chunkRow && chunkRow.hour_id != null, `(${JSON.stringify(chunkRow ?? null)})`);

    const draft = (overrides) => ({
      // Deliberately wrong, and deliberately ids that do not exist anywhere.
      chunk_id: 999999,
      hour_id: 888888,
      chunk_ref: chunkRow.chunk_ref,
      source_file: GOOD,
      content_hash: chunkRow.content_hash,
      subject: 'Robotics',
      missions: [
        {
          title: 'Stale-id draft',
          body: 'What does the controller do first?',
          difficulty: 1,
          tags: ['loops'],
          options: [
            { key: 'a', text: 'Boot' },
            { key: 'b', text: 'Sleep' },
            { key: 'c', text: 'Stop' },
            { key: 'd', text: 'Reset' },
          ],
          correct: 'a',
          explanation: 'It boots first.',
          source_quote: 'x',
        },
      ],
      ...overrides,
    });

    // Only our draft in the validated directory, so the counts are ours.
    rmSync(validatedDir, { recursive: true, force: true });
    mkdirSync(validatedDir, { recursive: true });
    writeFileSync(join(validatedDir, 'stale-ids.json'), JSON.stringify(draft({}), null, 2));

    await db.query(`DELETE FROM missions WHERE source_chunk_id = ?`, [chunkRow.id]);
    const ok = pipeline('import');
    check('a draft with stale chunk_id and hour_id imports', ok.code === 0, `(exit=${ok.code}) ${ok.out.slice(-300)}`);
    check('…and says it ignored them', /ignoring stale ids/.test(ok.out), `(${ok.out.replace(/\s+/g, ' ').slice(-240)})`);

    const [imported] = await db.query(
      `SELECT source_chunk_id, hour_id, source_chunk_hash, status FROM missions WHERE title = 'Stale-id draft'`
    );
    check('the mission was written', imported.length === 1, `(n=${imported.length})`);
    check(
      'it carries the chunk id the DATABASE has, not the draft\'s 999999',
      Number(imported[0]?.source_chunk_id) === Number(chunkRow.id),
      `(${imported[0]?.source_chunk_id} vs ${chunkRow.id})`
    );
    check(
      'and the hour id from that chunk, not the draft\'s 888888',
      Number(imported[0]?.hour_id) === Number(chunkRow.hour_id),
      `(${imported[0]?.hour_id} vs ${chunkRow.hour_id})`
    );
    check('as a draft, never live', imported[0]?.status === 'draft', `(${imported[0]?.status})`);

    // ...and a draft whose text has moved on is refused, with a message.
    rmSync(validatedDir, { recursive: true, force: true });
    mkdirSync(validatedDir, { recursive: true });
    writeFileSync(
      join(validatedDir, 'moved-on.json'),
      JSON.stringify(draft({ content_hash: 'a'.repeat(64), missions: [{ ...draft({}).missions[0], title: 'Moved-on draft' }] }), null, 2)
    );
    const refused = pipeline('import');
    check('a mismatched content_hash is refused', refused.code !== 0, `(exit=${refused.code})`);
    check('…naming the draft file', refused.out.includes('moved-on.json'), `(${refused.out.replace(/\s+/g, ' ').slice(-240)})`);
    check(
      '…saying the document changed and to regenerate',
      /different text than the chunk now holds/.test(refused.out) && /regenerate/.test(refused.out)
    );
    const [notWritten] = await db.query(`SELECT id FROM missions WHERE title = 'Moved-on draft'`);
    check('and nothing was written for it', notWritten.length === 0, `(n=${notWritten.length})`);

    // A chunk_ref that matches nothing names the fix.
    rmSync(validatedDir, { recursive: true, force: true });
    mkdirSync(validatedDir, { recursive: true });
    writeFileSync(join(validatedDir, 'no-such-chunk.json'), JSON.stringify(draft({ chunk_ref: 'Not a chunk anybody ingested' }), null, 2));
    const missing = pipeline('import');
    check('an unmatched chunk_ref is refused', missing.code !== 0, `(exit=${missing.code})`);
    check('…and names the ingest command that would fix it', /ingest --file/.test(missing.out),
      `(${missing.out.replace(/\s+/g, ' ').slice(-240)})`);

    rmSync(validatedDir, { recursive: true, force: true });
    await db.query(`DELETE FROM missions WHERE title IN ('Stale-id draft', 'Moved-on draft')`);
  }

} finally {
  await cleanup();
  await db.end();
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n==== Curriculum pipeline: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
