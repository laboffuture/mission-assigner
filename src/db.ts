import 'dotenv/config';
import mysql from 'mysql2/promise';
import { dbPort } from './dbConfig.js';

/**
 * Shared MySQL connection pool. Raw SQL only, no ORM.
 * All queries use parameterised `?` placeholders.
 *
 * TIMEZONE CONVENTION (Item 7): everything is UTC.
 *  - `timezone: 'Z'` tells mysql2 to read/write DATETIME/TIMESTAMP values as UTC
 *    (so a driver-returned Date is not silently shifted by the Node process's
 *    local zone).
 *  - We ALSO set the SQL session `time_zone = '+00:00'` on every physical
 *    connection, so NOW()/CURDATE()/UTC math run in UTC regardless of the
 *    container's default — never rely on the server's local zone.
 *  - Time arithmetic is done in SQL (TIMESTAMPDIFF, CONVERT_TZ), never in JS
 *    against a driver Date. Per-student local-day logic (streaks) converts UTC
 *    to the student's zone with CONVERT_TZ.
 */
export const pool = mysql.createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASS ?? '',
  database: process.env.DB_NAME ?? 'mission_demo',
  port: dbPort(),
  timezone: 'Z',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // JSON columns come back parsed on some mysql2 versions and as strings on
  // others; grading.ts handles both defensively.
  multipleStatements: false,
});
/**
 * Seconds a statement waits for a row lock before giving up. MySQL's default is
 * 50, which means a student's submit can sit there for most of a minute behind a
 * stuck transaction and then fail anyway. A short wait turns that into a
 * transient error the submit path RETRIES (src/retry.ts) — faster and more
 * likely to succeed. Unset leaves the server's own default alone.
 */
function lockWaitTimeout(): number | null {
  const raw = Number(process.env.DB_LOCK_WAIT_TIMEOUT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
  const wait = lockWaitTimeout();
  if (wait != null) conn.query(`SET SESSION innodb_lock_wait_timeout = ${wait}`);
});

/**
 * A connection pool WITHOUT a selected database, used to create the database
 * before it exists.
 */
export function rootPool() {
  const p = mysql.createPool({
    host: process.env.DB_HOST ?? '127.0.0.1',
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASS ?? '',
    port: dbPort(),
    timezone: 'Z',
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    multipleStatements: true,
  });
  p.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  return p;
}
