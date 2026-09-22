// Backups must work without Docker and must FAIL VISIBLY (audit #7, #8, #64).
//
// A failed backup used to leave a 20-byte gzip — valid, empty, named like a real
// backup — because the output file was created before the dump ran and the
// "empty file" check tested only for a non-zero size (gzip of nothing is 20
// bytes). This proves: a failed or truncated dump leaves NO file; a good dump is
// verified (valid gzip, CREATE TABLE present, mysqldump's completion marker);
// restore refuses an invalid backup BEFORE dropping its target; backup-verify
// passes end to end and removes its scratch databases on every exit path.
//
// Uses throwaway directories and scratch databases only.
// Run: npm run verify:backups
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0,
  fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`)) : (fail++, console.log(`  FAIL ${name} ${detail}`));
  return !!cond;
}
const root = await mysql.createConnection({
  host: process.env.DB_HOST ?? '127.0.0.1',
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASS ?? 'devpass',
  multipleStatements: true,
});
const q = async (sql, p = []) => (await root.query(sql, p))[0];
const bash = (script, args, env = {}) => {
  const r = spawnSync('bash', [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 600000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: (r.stdout ?? '').trim() };
};
const work = mkdtempSync(join(tmpdir(), 'mh-backups-'));
const listing = (dir) => readdirSync(dir).sort();
const dbExists = async (name) => (await q(`SHOW DATABASES LIKE ?`, [name])).length > 0;

// A fake mysqldump that writes a TRUNCATED dump and exits 0 — the failure that
// exit codes alone cannot catch. The backup's own verification must reject it.
// A real deployment configures both clients; scripts/lib/db.sh otherwise looks
// for mysql next to MYSQLDUMP, which for the fake dumper would find nothing. So
// when the dumper is faked, name the real mysql client explicitly.
const realDumpDir = process.env.MYSQLDUMP ? dirname(process.env.MYSQLDUMP) : null;
const REAL_MYSQL = realDumpDir
  ? ([join(realDumpDir, 'mysql.exe'), join(realDumpDir, 'mysql')].find(
      (p) => spawnSync(p, ['--version']).status === 0
    ) ?? 'mysql')
  : 'mysql';
const fakeDump = join(work, 'fake-mysqldump.sh');
writeFileSync(
  fakeDump,
  '#!/usr/bin/env bash\necho "-- MySQL dump (truncated, no tables, no completion marker)"\nexit 0\n'
);
chmodSync(fakeDump, 0o755);

const SRC = 'mission_demo_bkptest';
await q(`DROP DATABASE IF EXISTS \`${SRC}\``);
const mig = spawnSync(process.execPath, ['--import', 'tsx', 'src/migrator.ts', 'up'], {
  cwd: ROOT,
  env: { ...process.env, DB_NAME: SRC },
  encoding: 'utf8',
});
if (mig.status !== 0) {
  console.log(`FATAL: could not build ${SRC}: ${(mig.stdout + mig.stderr).slice(-300)}`);
  process.exit(2);
}

console.log('\n[1] A dump of a database that does not exist fails, and leaves no file');
{
  const dir = mkdtempSync(join(work, 'nodb-'));
  const r = bash('scripts/backup.sh', [], { DB_NAME: 'mission_demo_does_not_exist', BACKUP_DIR: dir });
  check('exits non-zero', r.code !== 0, `(exit ${r.code})`);
  check('no file left behind (not even a partial)', listing(dir).length === 0, `(left: ${listing(dir).join(', ')})`);
}

console.log('\n[2] A dump with wrong credentials fails, and leaves no file');
{
  const dir = mkdtempSync(join(work, 'badpw-'));
  const r = bash('scripts/backup.sh', [], { DB_NAME: SRC, DB_PASS: 'definitely-wrong', BACKUP_DIR: dir });
  check('exits non-zero', r.code !== 0, `(exit ${r.code})`);
  check('no file left behind', listing(dir).length === 0, `(left: ${listing(dir).join(', ')})`);
}

console.log('\n[3] A dump that exits 0 but is truncated is rejected by verification, and leaves no file');
{
  const dir = mkdtempSync(join(work, 'trunc-'));
  const r = bash('scripts/backup.sh', [], { DB_NAME: SRC, BACKUP_DIR: dir, MYSQLDUMP: fakeDump, MYSQL: REAL_MYSQL });
  check('exits non-zero', r.code !== 0, `(exit ${r.code})`);
  check(
    'says why (verification)',
    /CREATE TABLE|completion|incomplete|invalid/i.test(r.out),
    `(${r.out.replace(/\s+/g, ' ').slice(-160)})`
  );
  check('no file left behind', listing(dir).length === 0, `(left: ${listing(dir).join(', ')})`);
}

console.log('\n[4] A good dump produces one verified file and nothing else');
let good = null;
{
  const dir = mkdtempSync(join(work, 'good-'));
  const r = bash('scripts/backup.sh', [], { DB_NAME: SRC, BACKUP_DIR: dir });
  check('exits 0', r.code === 0, `(exit ${r.code} ${r.out.replace(/\s+/g, ' ').slice(-200)})`);
  const files = listing(dir);
  check('exactly one file, no partials', files.length === 1 && /\.sql\.gz$/.test(files[0]), `(${files.join(', ')})`);
  check('stdout is the file path', r.stdout.endsWith(files[0] ?? '?'), `(${r.stdout})`);
  if (files.length === 1) {
    good = join(dir, files[0]);
    const sql = gunzipSync(readFileSync(good)).toString('utf8');
    check('valid gzip with CREATE TABLE statements', /^CREATE TABLE/m.test(sql), `(${sql.length} bytes)`);
    check('ends with mysqldump completion marker', /-- Dump completed/.test(sql.slice(-400)));
  }
}

console.log('\n[5] restore.sh refuses an invalid backup BEFORE dropping its target');
{
  const target = 'mission_demo_bkptarget';
  await q(
    `DROP DATABASE IF EXISTS \`${target}\`; CREATE DATABASE \`${target}\`; CREATE TABLE \`${target}\`.marker (id INT); INSERT INTO \`${target}\`.marker VALUES (1)`
  );
  const empty = join(work, 'empty.sql.gz');
  writeFileSync(empty, gzipSync(Buffer.alloc(0)));
  const r = bash('scripts/restore.sh', [empty, target]);
  check('exits non-zero', r.code !== 0, `(exit ${r.code})`);
  const survived = (
    await q(`SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'marker'`, [
      target,
    ])
  )[0].n;
  check('target NOT dropped (marker survives)', Number(survived) === 1, `(${r.out.replace(/\s+/g, ' ').slice(-160)})`);
  if (good) {
    const ok = bash('scripts/restore.sh', [good, target]);
    check('a valid backup restores', ok.code === 0, `(exit ${ok.code} ${ok.out.replace(/\s+/g, ' ').slice(-160)})`);
    const tables = Number(
      (await q(`SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [target]))[0].n
    );
    check('restored database has the schema', tables > 20, `(${tables} tables)`);
  }
  await q(`DROP DATABASE IF EXISTS \`${target}\``);
}

console.log('\n[6] backup-verify fails when the dump fails — and still drops its scratch databases');
{
  const r = bash('scripts/backup-verify.sh', [], {
    MYSQLDUMP: fakeDump,
    MYSQL: REAL_MYSQL,
    BACKUP_DIR: mkdtempSync(join(work, 'bv-fail-')),
  });
  check('exits non-zero', r.code !== 0, `(exit ${r.code})`);
  check('scratch source DB dropped', !(await dbExists('mission_demo_bkpsrc')));
  check('scratch restore DB dropped', !(await dbExists('mission_demo_bkprestore')));
}

console.log('\n[7] backup-verify passes end to end, and leaves nothing behind');
{
  const dir = mkdtempSync(join(work, 'bv-ok-'));
  const r = bash('scripts/backup-verify.sh', [], { BACKUP_DIR: dir });
  if (r.code !== 0) console.log(`--- backup-verify output (tail) ---\n${r.out.split('\n').slice(-10).join('\n')}`);
  check('exits 0', r.code === 0, `(exit ${r.code})`);
  check('reports PASSED', /BACKUP VERIFY PASSED/.test(r.out));
  check('scratch source DB dropped', !(await dbExists('mission_demo_bkpsrc')));
  check('scratch restore DB dropped', !(await dbExists('mission_demo_bkprestore')));
}

await q(`DROP DATABASE IF EXISTS \`${SRC}\``);
rmSync(work, { recursive: true, force: true });
await root.end();
console.log(`\n==== Backups: ${pass} passed, ${fail} failed ====`);
process.exitCode = fail ? 1 : 0;
