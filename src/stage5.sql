-- Stage 5 — feedback capture and tracking.
-- ADDITIVE migration: every statement is idempotent (CREATE TABLE IF NOT EXISTS).
-- The assignments-table column additions and the xp_rules ENUM extension are
-- applied conditionally by migrate5.ts, because MySQL 8 has no
-- `ADD COLUMN IF NOT EXISTS` / `MODIFY ... IF`.
-- Run via `npm run db:migrate5` (after db:migrate, before db:seed).

-- ---------------------------------------------------------------------------
-- feedback_questions — the questions a student answers after every mission.
-- CONFIGURABLE by SME/management: question text lives HERE, never in code/HTML.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback_questions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  question_key   VARCHAR(40) NOT NULL,           -- stable machine key, e.g. 'perceived_difficulty'
  prompt         VARCHAR(300) NOT NULL,          -- the text shown to the student
  answer_type    ENUM('scale_1_5','yes_no','single_select','free_text') NOT NULL,
  options        JSON NULL,                      -- single_select: ["Too easy","About right","Too hard"]
  display_order  TINYINT UNSIGNED NOT NULL,
  required       BOOLEAN NOT NULL DEFAULT TRUE,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_question_key (question_key),
  KEY idx_active_order (active, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- feedback_responses — one row per (assignment, question).
-- question_key is DENORMALISED so historical responses stay interpretable even
-- after the SME edits or retires the question.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback_responses (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  assignment_id  BIGINT UNSIGNED NOT NULL,
  student_id     BIGINT UNSIGNED NOT NULL,
  question_id    BIGINT UNSIGNED NOT NULL,
  question_key   VARCHAR(40) NOT NULL,           -- denormalised: survives question edits
  answer_value   VARCHAR(500) NOT NULL,          -- everything stored as text, interpreted by type
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

-- ---------------------------------------------------------------------------
-- attempt_logs — the audit trail. Every meaningful action on an assignment.
-- Streaks and tracking views are DERIVED from this; nothing here is mutable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attempt_logs (
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
