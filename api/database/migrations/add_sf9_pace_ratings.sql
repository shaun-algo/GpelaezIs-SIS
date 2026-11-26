-- Grade 1 descriptive SF9 PACE ratings for SY 2026-2027.
-- Competency ratings entered on the printable-form preview are persisted here;
-- the cover-page narrative fields remain print-only.

CREATE TABLE IF NOT EXISTS `sf9_pace_ratings` (
  `pace_rating_id` int(11) NOT NULL AUTO_INCREMENT,
  `school_year_id` int(11) NOT NULL,
  `grade_level_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `grading_period_id` int(11) NOT NULL,
  `catalog_key` varchar(180) NOT NULL,
  `rating_code` char(1) NOT NULL,
  `recorded_by` int(11) DEFAULT NULL,
  `updated_by` int(11) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`pace_rating_id`),
  UNIQUE KEY `uq_sf9_pace_rating` (`enrollment_id`, `grading_period_id`, `catalog_key`),
  KEY `idx_sf9_pace_rating_scope` (`school_year_id`, `grade_level_id`, `grading_period_id`),
  KEY `idx_sf9_pace_rating_catalog` (`catalog_key`),
  CONSTRAINT `fk_sf9_pace_rating_school_year` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`),
  CONSTRAINT `fk_sf9_pace_rating_grade_level` FOREIGN KEY (`grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`),
  CONSTRAINT `fk_sf9_pace_rating_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  CONSTRAINT `fk_sf9_pace_rating_period` FOREIGN KEY (`grading_period_id`) REFERENCES `grading_periods` (`grading_period_id`),
  CONSTRAINT `fk_sf9_pace_rating_recorded_by` FOREIGN KEY (`recorded_by`) REFERENCES `users` (`user_id`),
  CONSTRAINT `fk_sf9_pace_rating_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `users` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Grade 1 descriptive PACE A-E ratings; SF9 narrative fields remain print-only';

-- Activate the approved descriptive Grade 1 mode for the target school year.
INSERT INTO `school_year_grade_policies` (`school_year_id`, `grade_level_id`, `grading_mode`, `sf9_template_variant`)
SELECT sy.school_year_id, gl.grade_level_id, 'Descriptive', 'G1'
FROM `school_years` sy
JOIN `grade_levels` gl ON gl.grade_level_id = 1 AND gl.is_deleted = 0
WHERE sy.year_label = '2026-2027'
  AND sy.is_deleted = 0
ON DUPLICATE KEY UPDATE
  `grading_mode` = VALUES(`grading_mode`),
  `sf9_template_variant` = VALUES(`sf9_template_variant`),
  `is_deleted` = 0,
  `deleted_at` = NULL;
