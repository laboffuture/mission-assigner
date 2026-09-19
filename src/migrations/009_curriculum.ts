import type { Pool } from 'mysql2/promise';

// 009 — curriculum position drives mission selection.
//
// Subject → Track → Credit → Project → Session. A student's position is stored
// per track; missions are tagged to a session. credit_sequence is the session's
// running position within its credit across all projects, and is what selection
// filters on.
//
// Also:
//  - assignments.revision_seq: the curriculum exhaustion ladder (D3c) may re-serve
//    a mission the student already completed, marked as revision. The original
//    UNIQUE (student_id, mission_id) made that impossible, so uniqueness now
//    includes revision_seq. First-time assignments are revision_seq 0, so the
//    "never serve a mission twice" guarantee for non-revision work is unchanged.
//  - selection_log.pool_size / chosen_session_id for auditing curriculum picks.

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE tracks (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      subject        VARCHAR(60) NOT NULL,
      name           VARCHAR(120) NOT NULL,
      display_order  SMALLINT UNSIGNED NOT NULL,
      active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_track (subject, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE credits (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      track_id    BIGINT UNSIGNED NOT NULL,
      code        VARCHAR(20) NOT NULL,
      name        VARCHAR(160) NULL,
      sequence    SMALLINT UNSIGNED NOT NULL,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_credit (track_id, sequence),
      UNIQUE KEY uq_credit_code (track_id, code),
      CONSTRAINT fk_credits_track
        FOREIGN KEY (track_id) REFERENCES tracks (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE projects (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      credit_id      BIGINT UNSIGNED NOT NULL,
      name           VARCHAR(200) NOT NULL,
      sequence       SMALLINT UNSIGNED NOT NULL,
      session_count  SMALLINT UNSIGNED NOT NULL,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_project (credit_id, sequence),
      CONSTRAINT fk_projects_credit
        FOREIGN KEY (credit_id) REFERENCES credits (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

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
      CONSTRAINT fk_sessions_project
        FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE student_positions (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      student_id     BIGINT UNSIGNED NOT NULL,
      track_id       BIGINT UNSIGNED NOT NULL,
      credit_id      BIGINT UNSIGNED NOT NULL,
      session_id     BIGINT UNSIGNED NOT NULL,
      source         ENUM('explicit','derived_percent','manual') NOT NULL,
      source_detail  JSON NULL,
      updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_position (student_id, track_id),
      CONSTRAINT fk_positions_student
        FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
      CONSTRAINT fk_positions_track
        FOREIGN KEY (track_id) REFERENCES tracks (id) ON DELETE CASCADE,
      CONSTRAINT fk_positions_credit
        FOREIGN KEY (credit_id) REFERENCES credits (id) ON DELETE CASCADE,
      CONSTRAINT fk_positions_session
        FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `);

  // Missions tag to a session. NULL = legacy (not curriculum-scoped). RESTRICT on
  // delete: removing a session must never silently orphan its missions.
  await pool.query(
    `ALTER TABLE missions
       ADD COLUMN session_id BIGINT UNSIGNED NULL,
       ADD INDEX idx_mission_session (session_id, status, difficulty),
       ADD CONSTRAINT fk_missions_session FOREIGN KEY (session_id) REFERENCES sessions (id)`
  );

  // Revision support. Add the widened key BEFORE dropping the old one so the
  // student_id foreign key always has a usable index.
  //
  // is_revision is what the XP rules read: a revision repeat earns 'attempt' and
  // 'submit' XP but never 'correct', so re-answering a mission already passed
  // cannot farm correct-XP.
  await pool.query(
    `ALTER TABLE assignments
       ADD COLUMN revision_seq SMALLINT UNSIGNED NOT NULL DEFAULT 0,
       ADD COLUMN is_revision BOOLEAN NOT NULL DEFAULT FALSE,
       ADD UNIQUE KEY uq_assignments_student_mission_rev (student_id, mission_id, revision_seq)`
  );
  await pool.query(`ALTER TABLE assignments DROP INDEX uq_assignments_student_mission`);

  await pool.query(
    `ALTER TABLE selection_log
       ADD COLUMN pool_size INT UNSIGNED NULL,
       ADD COLUMN chosen_session_id BIGINT UNSIGNED NULL`
  );
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE selection_log DROP COLUMN chosen_session_id, DROP COLUMN pool_size`);
  await pool.query(`ALTER TABLE assignments ADD UNIQUE KEY uq_assignments_student_mission (student_id, mission_id)`);
  await pool.query(
    `ALTER TABLE assignments
       DROP INDEX uq_assignments_student_mission_rev,
       DROP COLUMN is_revision,
       DROP COLUMN revision_seq`
  );
  await pool.query(`ALTER TABLE missions DROP FOREIGN KEY fk_missions_session`);
  await pool.query(`ALTER TABLE missions DROP INDEX idx_mission_session, DROP COLUMN session_id`);
  await pool.query(`
    SET FOREIGN_KEY_CHECKS = 0;
    DROP TABLE IF EXISTS student_positions;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS projects;
    DROP TABLE IF EXISTS credits;
    DROP TABLE IF EXISTS tracks;
    SET FOREIGN_KEY_CHECKS = 1;
  `);
}
