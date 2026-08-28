import 'dotenv/config';
import mysql from 'mysql2/promise';

/**
 * Shared MySQL connection pool. Raw SQL only, no ORM.
 * All queries use parameterised `?` placeholders.
 */
export const pool = mysql.createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASS ?? '',
  database: process.env.DB_NAME ?? 'mission_demo',
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // JSON columns come back parsed on some mysql2 versions and as strings on
  // others; grading.ts handles both defensively.
  multipleStatements: false,
});

/**
 * A connection pool WITHOUT a selected database, used by schema.ts to create
 * the database before it exists.
 */
export function rootPool() {
  return mysql.createPool({
    host: process.env.DB_HOST ?? '127.0.0.1',
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASS ?? '',
    port: 3306,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    multipleStatements: true,
  });
}
