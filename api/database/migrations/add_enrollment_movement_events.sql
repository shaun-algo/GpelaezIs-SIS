-- Enrollment movement history for LIS-derived and authorized manual status changes.
-- This is additive: current enrollment state remains in enrollments.enrollment_status.

START TRANSACTION;

CREATE TABLE IF NOT EXISTS enrollment_movement_events (
  movement_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_key VARCHAR(191) NOT NULL,
  source_type VARCHAR(32) NOT NULL COMMENT 'LIS_IMPORT, MANUAL_PROFILE, MANUAL_ENROLLMENT, SYSTEM',
  import_id INT(11) DEFAULT NULL,
  import_row_number INT(11) DEFAULT NULL,
  enrollment_id INT(11) NOT NULL,
  learner_id INT(11) NOT NULL,
  school_year_id INT(11) NOT NULL,
  section_id INT(11) DEFAULT NULL,
  grade_level_id INT(11) DEFAULT NULL,
  gender_snapshot VARCHAR(20) DEFAULT NULL,
  movement_type VARCHAR(32) NOT NULL COMMENT 'Transfer-In, Dropped, Transferred Out',
  previous_status VARCHAR(32) DEFAULT NULL,
  new_status VARCHAR(32) DEFAULT NULL,
  previous_classification VARCHAR(32) DEFAULT NULL,
  new_classification VARCHAR(32) DEFAULT NULL,
  raw_lis_remark VARCHAR(255) DEFAULT NULL,
  source_effective_date DATE DEFAULT NULL,
  observed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT(11) DEFAULT NULL,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  deleted_at DATETIME DEFAULT NULL,
  PRIMARY KEY (movement_event_id),
  UNIQUE KEY uq_enrollment_movement_source (source_key),
  KEY idx_enrollment_movement_report (school_year_id, movement_type, observed_at, is_deleted),
  KEY idx_enrollment_movement_enrollment (enrollment_id, observed_at),
  KEY idx_enrollment_movement_learner (learner_id, observed_at),
  KEY idx_enrollment_movement_import (import_id, import_row_number),
  CONSTRAINT fk_movement_enrollment FOREIGN KEY (enrollment_id) REFERENCES enrollments(enrollment_id),
  CONSTRAINT fk_movement_learner FOREIGN KEY (learner_id) REFERENCES learners(learner_id),
  CONSTRAINT fk_movement_school_year FOREIGN KEY (school_year_id) REFERENCES school_years(school_year_id),
  CONSTRAINT fk_movement_created_by FOREIGN KEY (created_by) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Immutable enrollment movements adopted from LIS imports or authorized manual corrections';

COMMIT;
