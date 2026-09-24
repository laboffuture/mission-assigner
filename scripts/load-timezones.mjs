// Load MySQL's named-timezone tables — part of setting a database up.
//
// A fresh MySQL ships mysql.time_zone* EMPTY, and CONVERT_TZ with a NAMED zone
// then returns NULL. Streaks are computed from per-student local days, so every
// streak silently becomes nothing. The api refuses to start in that state
// (src/timezoneCheck.ts); this is the command it names.
//
// Three paths, in order:
//   1. Already loaded          -> nothing to do (safe to re-run).
//   2. mysql_tzinfo_to_sql     -> the real thing, every zone, with transitions.
//   3. Neither (Windows hosts) -> insert the fixed-offset zones this project
//      actually uses, so development works. Not a substitute for the real
//      tables on a server, and it says so.
//
// Run: npm run db:timezones
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const ZONEINFO = '/usr/share/zoneinfo';

// Zones with no DST, so a single fixed offset is exactly right.
const FIXED_OFFSET_ZONES = [
  ['Asia/Kolkata', '05:30:00'],
  ['UTC', '00:00:00'],
];

const conn = await mysql.createConnection({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASS ?? '',
  multipleStatements: true,
});

const resolves = async (zone) => {
  const [[row]] = await conn.query(`SELECT CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?) AS c`, [zone]);
  return row.c != null;
};

const needed = ['Asia/Kolkata', 'UTC'];
const missing = [];
for (const z of needed) if (!(await resolves(z))) missing.push(z);

if (missing.length === 0) {
  const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM mysql.time_zone_name`);
  console.log(`timezones: already loaded (${n} named zones) — nothing to do`);
  await conn.end();
  process.exit(0);
}

console.log(`timezones: ${missing.join(', ')} do not resolve — loading`);

const tzinfo = spawnSync('mysql_tzinfo_to_sql', ['--version'], { encoding: 'utf8' });
const haveTzinfo = !tzinfo.error && existsSync(ZONEINFO);

if (haveTzinfo) {
  // mysql_tzinfo_to_sql writes SQL on stdout; feed it straight in. It emits
  // multi-row INSERTs, hence multipleStatements above.
  const sql = spawnSync('mysql_tzinfo_to_sql', [ZONEINFO], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (sql.status !== 0) {
    console.error(`FAILED: mysql_tzinfo_to_sql exited ${sql.status}: ${String(sql.stderr).slice(0, 300)}`);
    await conn.end();
    process.exit(1);
  }
  await conn.query('USE mysql');
  await conn.query(sql.stdout);
  console.log('timezones: loaded from ' + ZONEINFO);
} else {
  // No zoneinfo on this machine (Windows). Insert just what this project uses.
  console.log('timezones: mysql_tzinfo_to_sql / zoneinfo not available here —');
  console.log('           inserting the fixed-offset zones this project uses instead.');
  console.log('           A SERVER should use the real tables (the compose stack does).');
  for (const [name, offset] of FIXED_OFFSET_ZONES) {
    const [[existing]] = await conn.query(`SELECT Time_zone_id AS id FROM mysql.time_zone_name WHERE Name = ?`, [name]);
    if (existing) continue;
    const [res] = await conn.query(`INSERT INTO mysql.time_zone (Use_leap_seconds) VALUES ('N')`);
    const id = res.insertId;
    await conn.query(`INSERT INTO mysql.time_zone_name (Name, Time_zone_id) VALUES (?, ?)`, [name, id]);
    await conn.query(
      `INSERT INTO mysql.time_zone_transition_type (Time_zone_id, Transition_type_id, Offset, Is_DST, Abbreviation)
       VALUES (?, 0, ?, 0, ?)`,
      [id, offsetSeconds(offset), name === 'UTC' ? 'UTC' : 'IST']
    );
    console.log(`           + ${name} (${offset})`);
  }
  await conn.query('FLUSH TABLES');
}

function offsetSeconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

const stillMissing = [];
for (const z of needed) if (!(await resolves(z))) stillMissing.push(z);
await conn.end();

if (stillMissing.length > 0) {
  console.error(`FAILED: ${stillMissing.join(', ')} still do not resolve after loading`);
  process.exit(1);
}
console.log('timezones: OK — named zones resolve');
