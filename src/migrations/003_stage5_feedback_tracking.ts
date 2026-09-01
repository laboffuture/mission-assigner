import type { Pool } from 'mysql2/promise';

// 003 — Stage 5: feedback questions/responses, attempt audit log, assignment
// feedback columns, and the 'feedback' xp_rules event type.
// Mirrors src/stage5.sql (CREATE) + the assignments/xp_rules ALTERs from migrate5.ts.

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE feedback_questions (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      question_key   VARCHAR(40) NOT NULL,
      prompt         VARCHAR(300) NOT NULL,
      answer_type    ENUM('scale_1_5','yes_no','single_select','free_text') NOT NULL,
      options        JSON NULL,
      display_order  TINYINT UNSIGNED NOT NULL,
      required       BOOLEAN NOT NULL DEFAULT TRUE,
      active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_question_key (question_key),
      KEY idx_active_order (active, display_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE feedback_responses (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      assignment_id  BIGINT UNSIGNED NOT NULL,
      student_id     BIGINT UNSIGNED NOT NULL,
      question_id    BIGINT UNSIGNED NOT NULL,
      question_key   VARCHAR(40) NOT NULL,
      answer_value   VARCHAR(500) NOT NULL,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_response (assignment_id, question_id),
      KEY idx_fr_question (question_key, created_at),
      CONSTRAINT fk_fr_assignment
        FOREIGN KEY (assignment_id) REFERENCES assignments (id) ON DELETE CASCADE,
      CONSTRAINT fk_fr_student
        FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
      CONSTRAINT fk_fr_question
        FOREIGN KEY (question_id) REFERENCES feedback_questions (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE attempt_logs (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      assignment_id  BIGINT UNSIGNED NOT NULL,
      student_id     BIGINT UNSIGNED NOT NULL,
      event          ENUM('opened','viewed','submitted','graded','feedback_submitted') NOT NULL,
      detail         JSON NULL,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_attempt_assignment (assignment_id, created_at),
      KEY idx_attempt_student (student_id, created_at),
      CONSTRAINT fk_attempt_assignment
        FOREIGN KEY (assignment_id) REFERENCES assignments (id) ON DELETE CASCADE,
      CONSTRAINT fk_attempt_student
        FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `);

  await pool.query(`
    ALTER TABLE assignments
      ADD COLUMN feedback_status ENUM('not_required','pending','complete') NOT NULL DEFAULT 'pending',
      ADD COLUMN feedback_completed_at TIMESTAMP NULL,
      ADD COLUMN opened_at TIMESTAMP NULL,
      ADD COLUMN time_to_submit_seconds INT UNSIGNED NULL;
  `);

  await pool.query(
    `ALTER TABLE xp_rules
       MODIFY COLUMN event_type
       ENUM('attempt','submit','correct','streak_bonus','feedback') NOT NULL`
  );
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(
    `ALTER TABLE xp_rules
       MODIFY COLUMN event_type
       ENUM('attempt','submit','correct','streak_bonus') NOT NULL`
  );
  await pool.query(`
    ALTER TABLE assignments
      DROP COLUMN time_to_submit_seconds,
      DROP COLUMN opened_at,
      DROP COLUMN feedback_completed_at,
      DROP COLUMN feedback_status;
  `);
  await pool.query(`
    SET FOREIGN_KEY_CHECKS = 0;
    DROP TABLE IF EXISTS attempt_logs;
    DROP TABLE IF EXISTS feedback_responses;
    DROP TABLE IF EXISTS feedback_questions;
    SET FOREIGN_KEY_CHECKS = 1;
  `);
}
