import type { Pool } from 'mysql2/promise';

// 008 — assistance-event workflow columns.
//
// assistance_events already has status (open|acknowledged|resolved) and the
// stored context. The instructor queue needs to record WHO actioned an event and
// WHEN, plus the required resolution note. acknowledged_by/resolved_by reference
// the staff user (students.id); all nullable because an open event has none yet.

export async function up(pool: Pool): Promise<void> {
  await pool.query(
    `ALTER TABLE assistance_events
       ADD COLUMN acknowledged_at  TIMESTAMP NULL,
       ADD COLUMN acknowledged_by  BIGINT UNSIGNED NULL,
       ADD COLUMN resolved_at      TIMESTAMP NULL,
       ADD COLUMN resolved_by      BIGINT UNSIGNED NULL,
       ADD COLUMN resolution_note  VARCHAR(1000) NULL`
  );
  await pool.query(
    `ALTER TABLE assistance_events
       ADD CONSTRAINT fk_assist_ack_by  FOREIGN KEY (acknowledged_by) REFERENCES students (id) ON DELETE SET NULL,
       ADD CONSTRAINT fk_assist_res_by  FOREIGN KEY (resolved_by)     REFERENCES students (id) ON DELETE SET NULL`
  );
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(
    `ALTER TABLE assistance_events
       DROP FOREIGN KEY fk_assist_ack_by,
       DROP FOREIGN KEY fk_assist_res_by`
  );
  await pool.query(
    `ALTER TABLE assistance_events
       DROP COLUMN acknowledged_at,
       DROP COLUMN acknowledged_by,
       DROP COLUMN resolved_at,
       DROP COLUMN resolved_by,
       DROP COLUMN resolution_note`
  );
}
