import type { Pool } from 'mysql2/promise';

// 006 — Item 8: idempotency store for /api/submit. A retried submit carrying the
// same Idempotency-Key returns the original result instead of re-grading.

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE idempotency_keys (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      idempotency_key  VARCHAR(120) NOT NULL,
      assignment_id    BIGINT UNSIGNED NOT NULL,
      response         JSON NULL,
      created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_idem (idempotency_key, assignment_id),
      KEY idx_idem_created (created_at),
      CONSTRAINT fk_idem_assignment
        FOREIGN KEY (assignment_id) REFERENCES assignments (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS idempotency_keys`);
}
