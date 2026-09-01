import type { Pool } from 'mysql2/promise';

// 002 — Stage 3: segments, weekly templates/slots, XP, cold start.
// Mirrors src/stage3.sql (CREATE) + the students ALTERs from src/migrate.ts.

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE segments (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name         VARCHAR(80) NOT NULL,
      subject      VARCHAR(60) NOT NULL,
      age_min      TINYINT UNSIGNED NOT NULL,
      age_max      TINYINT UNSIGNED NOT NULL,
      min_level    TINYINT UNSIGNED NOT NULL DEFAULT 0,
      max_level    TINYINT UNSIGNED NOT NULL DEFAULT 4,
      start_level  TINYINT UNSIGNED NOT NULL,
      description  TEXT NULL,
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_segment (name, subject)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE segment_prerequisites (
      segment_id  BIGINT UNSIGNED NOT NULL,
      course_ref  VARCHAR(120) NOT NULL,
      PRIMARY KEY (segment_id, course_ref),
      CONSTRAINT fk_segment_prereq_segment
        FOREIGN KEY (segment_id) REFERENCES segments (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE student_courses (
      student_id    BIGINT UNSIGNED NOT NULL,
      course_ref    VARCHAR(120) NOT NULL,
      completed_at  TIMESTAMP NULL,
      PRIMARY KEY (student_id, course_ref),
      CONSTRAINT fk_student_courses_student
        FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE week_templates (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name        VARCHAR(80) NOT NULL,
      subject     VARCHAR(60) NOT NULL,
      segment_id  BIGINT UNSIGNED NULL,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_week_templates_subject (subject, segment_id, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE week_template_slots (
      id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      template_id   BIGINT UNSIGNED NOT NULL,
      slot_index    TINYINT UNSIGNED NOT NULL,
      day_label     VARCHAR(20) NOT NULL,
      mission_type  ENUM('quiz','descriptive','project','attendance') NOT NULL,
      time_band     ENUM('short','medium','long','heavy') NOT NULL,
      level_offset  TINYINT NOT NULL DEFAULT 0,
      is_weekly     BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (id),
      UNIQUE KEY uq_template_slot (template_id, slot_index),
      CONSTRAINT fk_template_slot_template
        FOREIGN KEY (template_id) REFERENCES week_templates (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE student_weeks (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      student_id   BIGINT UNSIGNED NOT NULL,
      template_id  BIGINT UNSIGNED NOT NULL,
      week_start   DATE NOT NULL,
      status       ENUM('active','complete') NOT NULL DEFAULT 'active',
      created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_student_week (student_id, week_start),
      CONSTRAINT fk_student_weeks_student
        FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE week_slots (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      student_week_id  BIGINT UNSIGNED NOT NULL,
      slot_index       TINYINT UNSIGNED NOT NULL,
      day_label        VARCHAR(20) NOT NULL,
      mission_type     VARCHAR(20) NOT NULL,
      time_band        VARCHAR(20) NOT NULL,
      assignment_id    BIGINT UNSIGNED NULL,
      status           ENUM('locked','open','submitted') NOT NULL DEFAULT 'locked',
      opened_at        TIMESTAMP NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_week_slot (student_week_id, slot_index),
      CONSTRAINT fk_week_slots_student_week
        FOREIGN KEY (student_week_id) REFERENCES student_weeks (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE xp_rules (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      event_type  ENUM('attempt','submit','correct','streak_bonus') NOT NULL,
      difficulty  TINYINT UNSIGNED NULL,
      points      SMALLINT UNSIGNED NOT NULL,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (id),
      UNIQUE KEY uq_xp_rule (event_type, difficulty)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE xp_events (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      student_id     BIGINT UNSIGNED NOT NULL,
      assignment_id  BIGINT UNSIGNED NULL,
      event_type     VARCHAR(20) NOT NULL,
      difficulty     TINYINT UNSIGNED NULL,
      points         SMALLINT NOT NULL,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_xp_student (student_id, created_at),
      CONSTRAINT fk_xp_events_student
        FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE assistance_events (
      id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      student_id        BIGINT UNSIGNED NOT NULL,
      trigger_reason    VARCHAR(80) NOT NULL,
      level_at_trigger  TINYINT UNSIGNED NOT NULL,
      context           JSON NOT NULL,
      status            ENUM('open','acknowledged','resolved') NOT NULL DEFAULT 'open',
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_assist_status (status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `);

  // students columns (order matters — matches the original migrate.ts sequence).
  await pool.query(`
    ALTER TABLE students
      ADD COLUMN segment_id BIGINT UNSIGNED NULL,
      ADD COLUMN total_xp INT UNSIGNED NOT NULL DEFAULT 0,
      ADD COLUMN placement_status ENUM('pending','in_progress','complete') NOT NULL DEFAULT 'pending',
      ADD COLUMN stall_count TINYINT UNSIGNED NOT NULL DEFAULT 0;
  `);
  await pool.query(`ALTER TABLE students ADD INDEX idx_students_segment (segment_id)`);
  await pool.query(
    `ALTER TABLE students
       ADD CONSTRAINT fk_students_segment
       FOREIGN KEY (segment_id) REFERENCES segments (id) ON DELETE SET NULL`
  );
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE students DROP FOREIGN KEY fk_students_segment`);
  await pool.query(`ALTER TABLE students DROP INDEX idx_students_segment`);
  await pool.query(`
    ALTER TABLE students
      DROP COLUMN stall_count,
      DROP COLUMN placement_status,
      DROP COLUMN total_xp,
      DROP COLUMN segment_id;
  `);
  await pool.query(`
    SET FOREIGN_KEY_CHECKS = 0;
    DROP TABLE IF EXISTS assistance_events;
    DROP TABLE IF EXISTS xp_events;
    DROP TABLE IF EXISTS xp_rules;
    DROP TABLE IF EXISTS week_slots;
    DROP TABLE IF EXISTS student_weeks;
    DROP TABLE IF EXISTS week_template_slots;
    DROP TABLE IF EXISTS week_templates;
    DROP TABLE IF EXISTS student_courses;
    DROP TABLE IF EXISTS segment_prerequisites;
    DROP TABLE IF EXISTS segments;
    SET FOREIGN_KEY_CHECKS = 1;
  `);
}
