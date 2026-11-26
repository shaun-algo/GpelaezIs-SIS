-- Migration: Simplify grade model and support flexible grading periods
-- Quarterly (4), Trimester (3), Semester (2)
--
-- What changes:
-- 1. grades table no longer stores WW/PT/QE/initial_grade; only the direct period grade (quarterly_grade).
-- 2. grading_periods.quarter_no renamed to period_no to be system-agnostic.
-- 3. school_years.grading_system_type enum expanded to Quarterly/Semester/Trimester.
-- 4. final_grades triggers compute the final grade as the simple arithmetic mean of period grades,
--    validated against the number of periods required by the school year's grading system.
-- 5. General average continues to be the simple mean of final grades.
--
-- Apply with: mysql -u root -p capstone_migration < simplify_grades_flexible_periods.sql

SET FOREIGN_KEY_CHECKS = 0;
START TRANSACTION;

-- ============================================================
-- 1. school_years.grading_system_type: allow Semester / Trimester
-- ============================================================
ALTER TABLE `school_years`
    MODIFY COLUMN `grading_system_type`
        ENUM('Quarterly','Semester','Trimester')
        NOT NULL DEFAULT 'Quarterly'
        COMMENT 'Grading system used by the school year: Quarterly=4, Trimester=3, Semester=2';

-- ============================================================
-- 2. grading_periods: rename quarter_no -> period_no
-- ============================================================
SET @rename_grading_periods = (
    SELECT IF(
        EXISTS(
            SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'grading_periods'
              AND COLUMN_NAME = 'quarter_no'
        ),
        'ALTER TABLE `grading_periods` CHANGE COLUMN `quarter_no` `period_no` TINYINT(3) UNSIGNED DEFAULT NULL COMMENT "1..N period number (N depends on school year grading system)"',
        'SELECT 1'
    )
);
PREPARE stmt FROM @rename_grading_periods;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================
-- 3. grades: drop complex component columns, keep direct period grade
-- ============================================================
DROP TRIGGER IF EXISTS `trg_grades_bi_deped_rules`;
DROP TRIGGER IF EXISTS `trg_grades_bu_deped_rules`;

SET @drop_grades_components = (
    SELECT GROUP_CONCAT(CONCAT('DROP COLUMN `', COLUMN_NAME, '`') SEPARATOR ', ')
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'grades'
      AND COLUMN_NAME IN ('written_works','performance_tasks','quarterly_exam','initial_grade')
);
SET @alter_grades = IF(@drop_grades_components IS NOT NULL AND @drop_grades_components <> '',
    CONCAT('ALTER TABLE `grades` ', @drop_grades_components, ', MODIFY COLUMN `quarterly_grade` DECIMAL(5,2) DEFAULT NULL COMMENT "Direct period grade entered by the teacher (60-100 floor/ceiling)"'),
    'ALTER TABLE `grades` MODIFY COLUMN `quarterly_grade` DECIMAL(5,2) DEFAULT NULL COMMENT "Direct period grade entered by the teacher (60-100 floor/ceiling)"'
);
PREPARE stmt FROM @alter_grades;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE `grades` COMMENT='Per-subject per-period grade entries. Only the period grade is stored; averages are computed by simple mean.';

DELIMITER $$
CREATE TRIGGER `trg_grades_bi_deped_rules` BEFORE INSERT ON `grades` FOR EACH ROW BEGIN
    IF NEW.quarterly_grade IS NOT NULL AND (NEW.quarterly_grade < 60.00 OR NEW.quarterly_grade > 100.00) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DepEd grade violation: quarterly_grade must be between 60 and 100';
    END IF;
END$$

CREATE TRIGGER `trg_grades_bu_deped_rules` BEFORE UPDATE ON `grades` FOR EACH ROW BEGIN
    IF NEW.quarterly_grade IS NOT NULL AND (NEW.quarterly_grade < 60.00 OR NEW.quarterly_grade > 100.00) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DepEd grade violation: quarterly_grade must be between 60 and 100';
    END IF;
END$$
DELIMITER ;

-- ============================================================
-- 4. final_grades: recompute as simple mean of period grades
-- ============================================================
DROP TRIGGER IF EXISTS `trg_final_grades_bi_deped_rules`;
DROP TRIGGER IF EXISTS `trg_final_grades_bu_deped_rules`;

DELIMITER $$
CREATE TRIGGER `trg_final_grades_bi_deped_rules` BEFORE INSERT ON `final_grades` FOR EACH ROW BEGIN
    DECLARE v_sy_id INT DEFAULT NULL;
    DECLARE v_system VARCHAR(20) DEFAULT NULL;
    DECLARE v_expected INT DEFAULT 0;
    DECLARE v_actual INT DEFAULT 0;
    DECLARE v_avg DECIMAL(5,2) DEFAULT NULL;
    DECLARE v_msg VARCHAR(255) DEFAULT '';

    IF NEW.final_grade IS NOT NULL AND NEW.final_grade < 60.00 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DepEd floor grade violation: final_grade must be >= 60';
    END IF;

    -- Find the school year and grading system for this enrollment.
    SELECT e.school_year_id, sy.grading_system_type
      INTO v_sy_id, v_system
    FROM enrollments e
    JOIN school_years sy ON sy.school_year_id = e.school_year_id
    WHERE e.enrollment_id = NEW.enrollment_id;

    SET v_expected = CASE v_system
        WHEN 'Semester' THEN 2
        WHEN 'Trimester' THEN 3
        WHEN 'Quarterly' THEN 4
        ELSE 4
    END;

    -- Count recorded period grades and compute simple average.
    SELECT COUNT(DISTINCT gp.period_no), ROUND(AVG(g.quarterly_grade), 2)
      INTO v_actual, v_avg
    FROM grades g
    JOIN grading_periods gp ON gp.grading_period_id = g.grading_period_id
    WHERE g.enrollment_id = NEW.enrollment_id
      AND g.class_id = NEW.class_id
      AND g.is_deleted = 0
      AND gp.is_deleted = 0
      AND gp.school_year_id = v_sy_id
      AND g.quarterly_grade IS NOT NULL;

    IF v_actual < v_expected THEN
        SET v_msg = CONCAT('Cannot compute final grade: ', v_expected, ' period grade(s) required');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    IF NEW.final_grade IS NULL THEN
        SET NEW.final_grade = v_avg;
    ELSEIF v_avg IS NOT NULL AND ABS(NEW.final_grade - v_avg) > 0.01 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final_grade must equal the average of the period grades';
    END IF;

    IF NEW.final_grade IS NOT NULL THEN
        SET NEW.remark = IF(NEW.final_grade >= 75.00, 'Passed', 'Failed');
    END IF;
END$$

CREATE TRIGGER `trg_final_grades_bu_deped_rules` BEFORE UPDATE ON `final_grades` FOR EACH ROW BEGIN
    DECLARE v_sy_id INT DEFAULT NULL;
    DECLARE v_system VARCHAR(20) DEFAULT NULL;
    DECLARE v_expected INT DEFAULT 0;
    DECLARE v_actual INT DEFAULT 0;
    DECLARE v_avg DECIMAL(5,2) DEFAULT NULL;
    DECLARE v_msg VARCHAR(255) DEFAULT '';

    IF NEW.final_grade IS NOT NULL AND NEW.final_grade < 60.00 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DepEd floor grade violation: final_grade must be >= 60';
    END IF;

    SELECT e.school_year_id, sy.grading_system_type
      INTO v_sy_id, v_system
    FROM enrollments e
    JOIN school_years sy ON sy.school_year_id = e.school_year_id
    WHERE e.enrollment_id = NEW.enrollment_id;

    SET v_expected = CASE v_system
        WHEN 'Semester' THEN 2
        WHEN 'Trimester' THEN 3
        WHEN 'Quarterly' THEN 4
        ELSE 4
    END;

    SELECT COUNT(DISTINCT gp.period_no), ROUND(AVG(g.quarterly_grade), 2)
      INTO v_actual, v_avg
    FROM grades g
    JOIN grading_periods gp ON gp.grading_period_id = g.grading_period_id
    WHERE g.enrollment_id = NEW.enrollment_id
      AND g.class_id = NEW.class_id
      AND g.is_deleted = 0
      AND gp.is_deleted = 0
      AND gp.school_year_id = v_sy_id
      AND g.quarterly_grade IS NOT NULL;

    IF v_actual < v_expected THEN
        SET v_msg = CONCAT('Cannot update final grade: ', v_expected, ' period grade(s) required');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    IF NEW.final_grade IS NULL THEN
        SET NEW.final_grade = v_avg;
    ELSEIF v_avg IS NOT NULL AND ABS(NEW.final_grade - v_avg) > 0.01 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final_grade must equal the average of the period grades';
    END IF;

    IF NEW.final_grade IS NOT NULL THEN
        SET NEW.remark = IF(NEW.final_grade >= 75.00, 'Passed', 'Failed');
    END IF;
END$$
DELIMITER ;

-- ============================================================
-- 5. Efficiency indexes for bulk grade encoding / roster reads
-- ============================================================
DROP INDEX IF EXISTS `idx_enroll_section_sy_status` ON `enrollments`;
CREATE INDEX `idx_enroll_section_sy_status` ON `enrollments` (`section_id`, `school_year_id`, `enrollment_status`, `is_deleted`, `enrollment_id`);

DROP INDEX IF EXISTS `idx_grades_class_period` ON `grades`;
CREATE INDEX `idx_grades_class_period` ON `grades` (`class_id`, `grading_period_id`, `is_deleted`, `enrollment_id`, `quarterly_grade`);

COMMIT;
SET FOREIGN_KEY_CHECKS = 1;
