-- SF10 transfer-in history (additive and repeatable)
--
-- Local enrollments remain the source of truth for this school.  These tables
-- store the official academic records supplied by a previous school so SF10
-- can render both sources without pretending that another school's database
-- was queried.

START TRANSACTION;

CREATE TABLE IF NOT EXISTS learner_previous_schools (
  previous_school_id int(11) NOT NULL AUTO_INCREMENT,
  learner_id int(11) NOT NULL,
  enrollment_id int(11) DEFAULT NULL,
  last_grade_level_completed varchar(50) DEFAULT NULL,
  last_school_year_completed varchar(20) DEFAULT NULL,
  last_school_attended varchar(200) DEFAULT NULL,
  last_school_id varchar(20) DEFAULT NULL COMMENT 'DepEd School ID of previous school',
  is_deleted tinyint(1) NOT NULL DEFAULT 0,
  deleted_at datetime DEFAULT NULL,
  PRIMARY KEY (previous_school_id),
  KEY idx_previous_school_learner (learner_id),
  KEY idx_previous_school_enrollment (enrollment_id),
  CONSTRAINT fk_previous_school_learner
    FOREIGN KEY (learner_id) REFERENCES learners (learner_id),
  CONSTRAINT fk_previous_school_enrollment
    FOREIGN KEY (enrollment_id) REFERENCES enrollments (enrollment_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Previous school summary for transfer-in and balik-aral learners';

-- Older deployments used a required enrollment_id even though registration
-- can collect previous-school information before enrollment is created.
ALTER TABLE learner_previous_schools
  MODIFY COLUMN enrollment_id int(11) DEFAULT NULL;

CREATE TABLE IF NOT EXISTS learner_academic_history (
  history_id int(11) NOT NULL AUTO_INCREMENT,
  learner_id int(11) NOT NULL,
  enrollment_id int(11) DEFAULT NULL COMMENT 'Current-school transfer-in enrollment, when known',
  school_year_label varchar(20) NOT NULL,
  grade_level_id int(11) DEFAULT NULL,
  grade_level_label varchar(50) NOT NULL,
  grading_system_type enum('Quarterly','Trimester') DEFAULT NULL COMMENT 'Historical record periods: Quarterly=4, Trimester=3',
  school_name varchar(200) NOT NULL,
  school_id varchar(20) DEFAULT NULL COMMENT 'DepEd School ID of previous school',
  district varchar(150) DEFAULT NULL,
  division varchar(150) DEFAULT NULL,
  region varchar(100) DEFAULT NULL,
  section_name varchar(100) DEFAULT NULL,
  adviser_name varchar(200) DEFAULT NULL,
  general_average decimal(5,2) DEFAULT NULL,
  source_type varchar(50) NOT NULL DEFAULT 'Previous School SF10',
  source_reference varchar(255) DEFAULT NULL,
  verified tinyint(1) NOT NULL DEFAULT 0,
  created_by int(11) DEFAULT NULL,
  updated_by int(11) DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp(),
  updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  is_deleted tinyint(1) NOT NULL DEFAULT 0,
  deleted_at datetime DEFAULT NULL,
  PRIMARY KEY (history_id),
  KEY idx_academic_history_learner (learner_id, is_deleted),
  KEY idx_academic_history_year (school_year_label, grade_level_label),
  KEY idx_academic_history_enrollment (enrollment_id),
  CONSTRAINT fk_academic_history_learner
    FOREIGN KEY (learner_id) REFERENCES learners (learner_id),
  CONSTRAINT fk_academic_history_enrollment
    FOREIGN KEY (enrollment_id) REFERENCES enrollments (enrollment_id) ON DELETE SET NULL,
  CONSTRAINT fk_academic_history_grade
    FOREIGN KEY (grade_level_id) REFERENCES grade_levels (grade_level_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Verified academic records supplied by a previous school for SF10';

CREATE TABLE IF NOT EXISTS learner_academic_history_grades (
  history_grade_id int(11) NOT NULL AUTO_INCREMENT,
  history_id int(11) NOT NULL,
  subject_name varchar(150) NOT NULL,
  subject_code varchar(50) DEFAULT NULL,
  q1 decimal(5,2) DEFAULT NULL,
  q2 decimal(5,2) DEFAULT NULL,
  q3 decimal(5,2) DEFAULT NULL,
  q4 decimal(5,2) DEFAULT NULL,
  final_rating decimal(5,2) DEFAULT NULL,
  remarks varchar(100) DEFAULT NULL,
  sort_order int(11) NOT NULL DEFAULT 0,
  is_deleted tinyint(1) NOT NULL DEFAULT 0,
  deleted_at datetime DEFAULT NULL,
  PRIMARY KEY (history_grade_id),
  KEY idx_academic_history_grade_history (history_id, is_deleted),
  CONSTRAINT fk_academic_history_grade_history
    FOREIGN KEY (history_id) REFERENCES learner_academic_history (history_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Subject ratings belonging to a previous-school SF10 record';

COMMIT;
