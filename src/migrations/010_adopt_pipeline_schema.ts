import type { Pool } from 'mysql2/promise';

// 010 — adopt the Stage 2 pipeline's schema into the migration chain.
//
// pipeline/src/db.py::ensure_schema used to create these objects itself, at
// runtime, with CREATE TABLE IF NOT EXISTS and information_schema guards. They
// were therefore never in the umzug chain, and verify:migrations — whose entire
// job is catching schema drift — compared a fresh chain against a live database
// that had six extra objects and failed. It only passed on the first run after a
// fresh migrate, because run-all checks migrations before the pipeline stage
// runs; every subsequent run failed.
//
// This migration takes ownership of all six. db.py now verifies they exist and
// tells the operator to run migrations if they do not, instead of creating them.
//
// Written defensively (each object is checked before it is created) because on
// any database the pipeline has already touched, these objects are present and
// 010 has not yet been recorded as applied. That makes this migration an
// adoption rather than a creation: a no-op where the pipeline got there first,
// and the real creator on a fresh database. Column order is deliberately
// session_id (009) → source_chunk_id → generated_at → review_notes →
// source_chunk_hash, which is the order the pipeline appended them in, so a
// fresh chain and an already-drifted database converge on the same shape.

const MISSIONS_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['source_chunk_id', 'ADD COLUMN source_chunk_id BIGINT UNSIGNED NULL'],
  ['generated_at', 'ADD COLUMN generated_at TIMESTAMP NULL'],
  ['review_notes', 'ADD COLUMN review_notes TEXT NULL'],
  // Records WHICH version (content_hash) of the chunk a mission was generated
  // from, so a repeat import of identical content is a no-op rather than churn.
  ['source_chunk_hash', 'ADD COLUMN source_chunk_hash CHAR(64) NULL'],
];

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return Number(rows[0].n) > 0;
}

async function columnExists(pool: Pool, table: string, column: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows[0].n) > 0;
}

async function indexExists(pool: Pool, table: string, index: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index]
  );
  return Number(rows[0].n) > 0;
}

export async function up(pool: Pool): Promise<void> {
  // 1. content_chunks — the pipeline's own table. Chunked SME source material;
  // one row per chunk, keyed by (source_file, chunk_ref). session_id is part of
  // the table here rather than a later ALTER, so a fresh database gets the final
  // shape in one step. Intentionally no FK to sessions: the pipeline imports
  // chunks before the curriculum is guaranteed loaded, and this matches the
  // shape the pipeline has been creating in production.
  if (!(await tableExists(pool, 'content_chunks'))) {
    await pool.query(`
      CREATE TABLE content_chunks (
        id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        source_file   VARCHAR(255) NOT NULL,
        chunk_ref     VARCHAR(120) NOT NULL,
        heading       VARCHAR(255) NOT NULL,
        body          MEDIUMTEXT NOT NULL,
        content_hash  CHAR(64) NOT NULL,
        subject       VARCHAR(60) NOT NULL,
        session_id    BIGINT UNSIGNED NULL,
        created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_chunk (source_file, chunk_ref),
        KEY idx_chunk_hash (content_hash)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  } else if (!(await columnExists(pool, 'content_chunks', 'session_id'))) {
    // A database whose content_chunks predates the curriculum work.
    await pool.query(`ALTER TABLE content_chunks ADD COLUMN session_id BIGINT UNSIGNED NULL`);
  }

  // 2. The pipeline's columns on missions, in the order it appended them.
  for (const [column, ddl] of MISSIONS_COLUMNS) {
    if (!(await columnExists(pool, 'missions', column))) {
      await pool.query(`ALTER TABLE missions ${ddl}`);
    }
  }

  // 3. Lookup index for the "changed chunk retires its missions" path.
  if (!(await indexExists(pool, 'missions', 'idx_missions_source_chunk'))) {
    await pool.query(`ALTER TABLE missions ADD INDEX idx_missions_source_chunk (source_chunk_id)`);
  }
}

export async function down(pool: Pool): Promise<void> {
  if (await indexExists(pool, 'missions', 'idx_missions_source_chunk')) {
    await pool.query(`ALTER TABLE missions DROP INDEX idx_missions_source_chunk`);
  }
  // Reverse order of the up().
  for (const [column] of [...MISSIONS_COLUMNS].reverse()) {
    if (await columnExists(pool, 'missions', column)) {
      await pool.query(`ALTER TABLE missions DROP COLUMN \`${column}\``);
    }
  }
  await pool.query(`DROP TABLE IF EXISTS content_chunks`);
}
