-- Additive SF9 support.
-- Grade 1-3 grading modes are configured independently per school year;
-- descriptive mode uses the handwritten SF9 report-card workflow.

CREATE TABLE IF NOT EXISTS `school_year_grade_policies` (
  `policy_id` int(11) NOT NULL AUTO_INCREMENT,
  `school_year_id` int(11) NOT NULL,
  `grade_level_id` int(11) NOT NULL,
  `grading_mode` varchar(30) NOT NULL DEFAULT 'Numeric' COMMENT 'Numeric or Descriptive',
  `sf9_template_variant` varchar(30) NOT NULL COMMENT 'G1, G2, G3, or G4_10',
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`policy_id`),
  UNIQUE KEY `uq_sy_grade_policy` (`school_year_id`, `grade_level_id`),
  KEY `idx_sy_grade_policy_grade` (`grade_level_id`),
  CONSTRAINT `fk_sy_grade_policy_school_year` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`),
  CONSTRAINT `fk_sy_grade_policy_grade_level` FOREIGN KEY (`grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Per-school-year grading mode and SF9 template selection by grade level';

CREATE TABLE IF NOT EXISTS `report_card_term_comments` (
  `term_comment_id` int(11) NOT NULL AUTO_INCREMENT,
  `enrollment_id` int(11) NOT NULL,
  `grading_period_id` int(11) NOT NULL,
  `comment_text` text DEFAULT NULL,
  `recorded_by` int(11) DEFAULT NULL,
  `recorded_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_by` int(11) DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`term_comment_id`),
  UNIQUE KEY `uq_report_card_term_comment` (`enrollment_id`, `grading_period_id`),
  KEY `idx_report_card_term_comment_period` (`grading_period_id`),
  CONSTRAINT `fk_report_card_term_comment_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  CONSTRAINT `fk_report_card_term_comment_period` FOREIGN KEY (`grading_period_id`) REFERENCES `grading_periods` (`grading_period_id`),
  CONSTRAINT `fk_report_card_term_comment_recorded_by` FOREIGN KEY (`recorded_by`) REFERENCES `users` (`user_id`),
  CONSTRAINT `fk_report_card_term_comment_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `users` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Teacher remarks printed per grading term on the numeric SF9 templates';

-- Seed the existing 2026-2027 numeric templates for Grades 2-10 when those
-- rows are available in the target database. Grade 1 falls back to its
-- built-in descriptive mode unless a school-year policy row overrides it.
INSERT INTO `school_year_grade_policies` (`school_year_id`, `grade_level_id`, `grading_mode`, `sf9_template_variant`)
SELECT sy.school_year_id,
       gl.grade_level_id,
       'Numeric',
       CASE WHEN gl.grade_level_id = 2 THEN 'G2'
            WHEN gl.grade_level_id = 3 THEN 'G3'
            ELSE 'G4_10' END
FROM `school_years` sy
JOIN `grade_levels` gl ON gl.grade_level_id BETWEEN 2 AND 10 AND gl.is_deleted = 0
WHERE sy.year_label = '2026-2027'
  AND sy.is_deleted = 0
ON DUPLICATE KEY UPDATE
  `grading_mode` = VALUES(`grading_mode`),
  `sf9_template_variant` = VALUES(`sf9_template_variant`),
  `is_deleted` = 0,
  `deleted_at` = NULL;
