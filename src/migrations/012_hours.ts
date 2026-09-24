import type { Pool } from 'mysql2/promise';

// 012 — the curriculum unit becomes the HOUR.
//
// Subject → Track → Credit → Hour. Hours are flat, 1..total_hours within a
// credit, and the hour number IS the position: the credit_sequence machinery
// from 009 (a session's running position across its projects) disappears, and
// with it a whole class of off-by-one.
//
// Projects leave the position chain entirely. If the SME groups hours under a
// project heading, that grouping survives as hours.project_label — a display
// string, never read by selection, ordering or the pool.
//
// Hours per credit VARY (C1 24, C2 24, C3 30, C4 30, C5 to be confirmed), so
// credits.total_hours is data, not an assumption in code. The loader and the
// pipeline both check the hour rows against it.
//
// This REPLACES the session model rather than transforming it: SELECTION_MODE is
// still legacy, no student has a real position and no real mission carries a
// session_id — only seeded test data. The down migration rebuilds the session
// shape faithfully (one project per credit, one session per hour), so it works
// on a populated database too; project_label is display-only and is not
// reconstructed.

export async function up(pool: Pool): Promise<void> {
  // Hours per credit. NOT NULL with no default: a credit whose total nobody
  // stated is exactly the bug this column exists to prevent, so existing rows
  // are filled from their session count and the default is then dropped.
  await pool.query(`ALTER TABLE credits ADD COLUMN total_hours SMALLINT UNSIGNED NOT NULL DEFAULT 0`);
  await pool.query(`
    UPDATE credits c
       SET total_hours = COALESCE((
             SELECT COUNT(*) FROM sessions s
               JOIN projects p ON p.id = s.project_id
              WHERE p.credit_id = c.id
           ), 0)
  `);
  await pool.query(`ALTER TABLE credits ALTER COLUMN total_hours DROP DEFAULT`);

  await pool.query(`
    CREATE TABLE hours (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      credit_id      BIGINT UNSIGNED NOT NULL,
      hour_number    SMALLINT UNSIGNED NOT NULL,
      title          VARCHAR(200) NULL,
      project_label  VARCHAR(120) NULL,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_hour (credit_id, hour_number),
      KEY idx_hour_credit (credit_id, hour_number),
      CONSTRAINT fk_hours_credit FOREIGN KEY (credit_id) REFERENCES credits (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  // Carry the existing (seeded) sessions across so nothing referencing them is
  // orphaned mid-migration: one hour per session, numbered by credit_sequence,
  // keeping the project name as a label only.
  await pool.query(`
    INSERT INTO hours (credit_id, hour_number, title, project_label)
    SELECT p.credit_id, s.credit_sequence, s.title, p.name
      FROM sessions s
      JOIN projects p ON p.id = s.project_id
     ORDER BY p.credit_id, s.credit_sequence
  `);

  // missions.session_id → hour_id, keeping each mission on the same content.
  await pool.query(`ALTER TABLE missions ADD COLUMN hour_id BIGINT UNSIGNED NULL AFTER session_id`);
  await pool.query(`
    UPDATE missions m
      JOIN sessions s ON s.id = m.session_id
      JOIN projects p ON p.id = s.project_id
      JOIN hours h ON h.credit_id = p.credit_id AND h.hour_number = s.credit_sequence
       SET m.hour_id = h.id
  `);
  await pool.query(`ALTER TABLE missions DROP FOREIGN KEY fk_missions_session`);
  await pool.query(`ALTER TABLE missions DROP INDEX idx_mission_session, DROP COLUMN session_id`);
  await pool.query(
    `ALTER TABLE missions
       ADD INDEX idx_missions_hour (hour_id, status, difficulty),
       ADD CONSTRAINT fk_missions_hour FOREIGN KEY (hour_id) REFERENCES hours (id)`
  );

  // student_positions.session_id → hour_id.
  await pool.query(`ALTER TABLE student_positions ADD COLUMN hour_id BIGINT UNSIGNED NULL AFTER credit_id`);
  await pool.query(`
    UPDATE student_positions sp
      JOIN sessions s ON s.id = sp.session_id
      JOIN projects p ON p.id = s.project_id
      JOIN hours h ON h.credit_id = p.credit_id AND h.hour_number = s.credit_sequence
       SET sp.hour_id = h.id
  `);
  // A position with no hour cannot be honoured and must not be kept: the ceiling
  // has nothing to measure against. There are none outside test data.
  await pool.query(`DELETE FROM student_positions WHERE hour_id IS NULL`);
  await pool.query(`ALTER TABLE student_positions DROP FOREIGN KEY fk_positions_session`);
  await pool.query(`ALTER TABLE student_positions DROP COLUMN session_id`);
  await pool.query(
    `ALTER TABLE student_positions
       MODIFY COLUMN hour_id BIGINT UNSIGNED NOT NULL,
       ADD CONSTRAINT fk_positions_hour FOREIGN KEY (hour_id) REFERENCES hours (id) ON DELETE CASCADE`
  );

  // content_chunks.session_id → hour_id (no FK, as in 010: the pipeline imports
  // chunks before the curriculum is guaranteed loaded).
  await pool.query(`ALTER TABLE content_chunks CHANGE COLUMN session_id hour_id BIGINT UNSIGNED NULL`);
  await pool.query(`
    UPDATE content_chunks cc
      JOIN sessions s ON s.id = cc.hour_id
      JOIN projects p ON p.id = s.project_id
      JOIN hours h ON h.credit_id = p.credit_id AND h.hour_number = s.credit_sequence
       SET cc.hour_id = h.id
  `);

  await pool.query(`ALTER TABLE selection_log CHANGE COLUMN chosen_session_id chosen_hour_id BIGINT UNSIGNED NULL`);

  // Projects and sessions leave the model entirely.
  await pool.query(`DROP TABLE sessions`);
  await pool.query(`DROP TABLE projects`);
}

export async function down(pool: Pool): Promise<void> {
  // Rebuild the 009 shape: one project per credit holding every hour of that
  // credit as a session, sequence = credit_sequence = hour_number. Faithful for
  // everything selection used; project_label is display-only and is not restored
  // (the 009 schema has nowhere to put it).
  await pool.query(`
    CREATE TABLE projects (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      credit_id      BIGINT UNSIGNED NOT NULL,
      name           VARCHAR(200) NOT NULL,
      sequence       SMALLINT UNSIGNED NOT NULL,
      session_count  SMALLINT UNSIGNED NOT NULL,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_project (credit_id, sequence),
      CONSTRAINT fk_projects_credit FOREIGN KEY (credit_id) REFERENCES credits (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await pool.query(`
    CREATE TABLE sessions (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id       BIGINT UNSIGNED NOT NULL,
      sequence         SMALLINT UNSIGNED NOT NULL,
      credit_sequence  SMALLINT UNSIGNED NOT NULL,
      title            VARCHAR(200) NULL,
      created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_session (project_id, sequence),
      KEY idx_session_credit_seq (project_id, credit_sequence),
      CONSTRAINT fk_sessions_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  // One project per credit that has any hours.
  await pool.query(`
    INSERT INTO projects (credit_id, name, sequence, session_count)
    SELECT h.credit_id, 'Project 1', 1, COUNT(*)
      FROM hours h
     GROUP BY h.credit_id
  `);
  await pool.query(`
    INSERT INTO sessions (project_id, sequence, credit_sequence, title)
    SELECT p.id, h.hour_number, h.hour_number, h.title
      FROM hours h
      JOIN projects p ON p.credit_id = h.credit_id AND p.sequence = 1
     ORDER BY h.credit_id, h.hour_number
  `);

  await pool.query(`ALTER TABLE missions ADD COLUMN session_id BIGINT UNSIGNED NULL AFTER hour_id`);
  await pool.query(`
    UPDATE missions m
      JOIN hours h ON h.id = m.hour_id
      JOIN projects p ON p.credit_id = h.credit_id AND p.sequence = 1
      JOIN sessions s ON s.project_id = p.id AND s.credit_sequence = h.hour_number
       SET m.session_id = s.id
  `);
  await pool.query(`ALTER TABLE missions DROP FOREIGN KEY fk_missions_hour`);
  await pool.query(`ALTER TABLE missions DROP INDEX idx_missions_hour, DROP COLUMN hour_id`);
  await pool.query(
    `ALTER TABLE missions
       ADD INDEX idx_mission_session (session_id, status, difficulty),
       ADD CONSTRAINT fk_missions_session FOREIGN KEY (session_id) REFERENCES sessions (id)`
  );

  await pool.query(`ALTER TABLE student_positions ADD COLUMN session_id BIGINT UNSIGNED NULL AFTER credit_id`);
  await pool.query(`
    UPDATE student_positions sp
      JOIN hours h ON h.id = sp.hour_id
      JOIN projects p ON p.credit_id = h.credit_id AND p.sequence = 1
      JOIN sessions s ON s.project_id = p.id AND s.credit_sequence = h.hour_number
       SET sp.session_id = s.id
  `);
  await pool.query(`DELETE FROM student_positions WHERE session_id IS NULL`);
  await pool.query(`ALTER TABLE student_positions DROP FOREIGN KEY fk_positions_hour`);
  await pool.query(`ALTER TABLE student_positions DROP COLUMN hour_id`);
  await pool.query(
    `ALTER TABLE student_positions
       MODIFY COLUMN session_id BIGINT UNSIGNED NOT NULL,
       ADD CONSTRAINT fk_positions_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE`
  );

  await pool.query(`
    UPDATE content_chunks cc
      JOIN hours h ON h.id = cc.hour_id
      JOIN projects p ON p.credit_id = h.credit_id AND p.sequence = 1
      JOIN sessions s ON s.project_id = p.id AND s.credit_sequence = h.hour_number
       SET cc.hour_id = s.id
  `);
  await pool.query(`ALTER TABLE content_chunks CHANGE COLUMN hour_id session_id BIGINT UNSIGNED NULL`);

  await pool.query(`ALTER TABLE selection_log CHANGE COLUMN chosen_hour_id chosen_session_id BIGINT UNSIGNED NULL`);

  await pool.query(`DROP TABLE hours`);
  await pool.query(`ALTER TABLE credits DROP COLUMN total_hours`);
}
