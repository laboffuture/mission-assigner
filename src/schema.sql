-- Mission automation demo — production-grade schema.
-- MySQL 8, InnoDB, utf8mb4. Run via `npm run db:schema`.

SET FOREIGN_KEY_CHECKS = 0;

-- Stage 3 tables (dropped here so a full rebuild is clean; recreated by
-- `npm run db:migrate`, which re-adds them and the students columns).
DROP TABLE IF EXISTS xp_events;
DROP TABLE IF EXISTS assistance_events;
DROP TABLE IF EXISTS week_slots;
DROP TABLE IF EXISTS student_weeks;
DROP TABLE IF EXISTS week_template_slots;
DROP TABLE IF EXISTS week_templates;
DROP TABLE IF EXISTS xp_rules;
DROP TABLE IF EXISTS student_courses;
DROP TABLE IF EXISTS segment_prerequisites;
DROP TABLE IF EXISTS segments;

DROP TABLE IF EXISTS selection_log;
DROP TABLE IF EXISTS level_events;
DROP TABLE IF EXISTS assignments;
DROP TABLE IF EXISTS mission_tags;
DROP TABLE IF EXISTS mission_options;
DROP TABLE IF EXISTS missions;
DROP TABLE IF EXISTS student_interests;
DROP TABLE IF EXISTS students;

SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------------
-- students
-- ---------------------------------------------------------------------------
CREATE TABLE students (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  moodle_user_id     BIGINT UNSIGNED NULL,
  display_name       VARCHAR(120) NOT NULL,
  age                TINYINT UNSIGNED NOT NULL,
  subject            VARCHAR(60) NOT NULL,
  current_level      TINYINT UNSIGNED NOT NULL DEFAULT 1,
  consecutive_wrong  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_students_moodle_user_id (moodle_user_id),
  KEY idx_students_subject_level_age (subject, current_level, age)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- student_interests
-- ---------------------------------------------------------------------------
CREATE TABLE student_interests (
  student_id  BIGINT UNSIGNED NOT NULL,
  tag         VARCHAR(40) NOT NULL,
  PRIMARY KEY (student_id, tag),
  KEY idx_student_interests_tag (tag),
  CONSTRAINT fk_student_interests_student
    FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- missions
-- ---------------------------------------------------------------------------
CREATE TABLE missions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version       INT UNSIGNED NOT NULL DEFAULT 1,
  subject       VARCHAR(60) NOT NULL,
  title         VARCHAR(200) NOT NULL,
  body          TEXT NOT NULL,
  mission_type  ENUM('quiz','descriptive','project','attendance') NOT NULL,
  grading_mode  ENUM('auto','llm','manual','attendance') NOT NULL,
  difficulty    TINYINT UNSIGNED NOT NULL,
  age_min       TINYINT UNSIGNED NOT NULL,
  age_max       TINYINT UNSIGNED NOT NULL,
  time_band     ENUM('short','medium','long','heavy') NOT NULL,
  answer_key    JSON NULL,
  rubric        JSON NULL,
  status        ENUM('draft','in_review','live','retired') NOT NULL DEFAULT 'draft',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_missions_id_version (id, version),
  KEY idx_missions_filter (status, subject, difficulty, age_min, age_max)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- mission_options
-- ---------------------------------------------------------------------------
CREATE TABLE mission_options (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mission_id   BIGINT UNSIGNED NOT NULL,
  option_key   CHAR(1) NOT NULL,
  option_text  VARCHAR(500) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mission_options_mission_key (mission_id, option_key),
  CONSTRAINT fk_mission_options_mission
    FOREIGN KEY (mission_id) REFERENCES missions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- mission_tags
-- ---------------------------------------------------------------------------
CREATE TABLE mission_tags (
  mission_id  BIGINT UNSIGNED NOT NULL,
  tag         VARCHAR(40) NOT NULL,
  PRIMARY KEY (mission_id, tag),
  KEY idx_mission_tags_tag (tag),
  CONSTRAINT fk_mission_tags_mission
    FOREIGN KEY (mission_id) REFERENCES missions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- assignments
-- ---------------------------------------------------------------------------
CREATE TABLE assignments (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id        BIGINT UNSIGNED NOT NULL,
  mission_id        BIGINT UNSIGNED NOT NULL,
  mission_version   INT UNSIGNED NOT NULL,
  level_at_assign   TINYINT UNSIGNED NOT NULL,
  status            ENUM('open','submitted','graded') NOT NULL DEFAULT 'open',
  response          JSON NULL,
  score_pct         DECIMAL(5,2) NULL,
  score_band        ENUM('pass_strong','pass','fail') NULL,
  assigned_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at      TIMESTAMP NULL,
  graded_at         TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_assignments_student_mission (student_id, mission_id),
  KEY idx_assignments_student_status (student_id, status),
  CONSTRAINT fk_assignments_student
    FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_assignments_mission
    FOREIGN KEY (mission_id) REFERENCES missions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- level_events
-- ---------------------------------------------------------------------------
CREATE TABLE level_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id     BIGINT UNSIGNED NOT NULL,
  assignment_id  BIGINT UNSIGNED NULL,
  from_level     TINYINT UNSIGNED NOT NULL,
  to_level       TINYINT UNSIGNED NOT NULL,
  reason         VARCHAR(80) NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_level_events_student_created (student_id, created_at),
  CONSTRAINT fk_level_events_student
    FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- selection_log
-- ---------------------------------------------------------------------------
CREATE TABLE selection_log (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id       BIGINT UNSIGNED NOT NULL,
  chosen_mission   BIGINT UNSIGNED NULL,
  candidates       JSON NOT NULL,
  filters_applied  JSON NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_selection_log_student_created (student_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
