import type { Pool } from 'mysql2/promise';

// 011 — bind an Idempotency-Key to the request it was first used with (audit
// #40). The key used to identify only (key, assignment), so reusing it with a
// DIFFERENT answer replayed the first result as if it answered the second.
// request_hash is the SHA-256 of the canonical request body; the same key with
// a different body is refused (422). NULL on rows written before this migration.

export async function up(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE idempotency_keys ADD COLUMN request_hash CHAR(64) NULL AFTER assignment_id`);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE idempotency_keys DROP COLUMN request_hash`);
}
