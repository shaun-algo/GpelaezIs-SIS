-- Canonical DepEd grading-period terminology and SY 2025-2026 correction.
-- Three-Term is the three-grading-period organization of a school year;
-- Trimester remains in the ENUM only as a read/import compatibility value.

ALTER TABLE `school_years`
    MODIFY COLUMN `grading_system_type`
    ENUM('Quarterly','Three-Term','Trimester','Semester')
    NOT NULL DEFAULT 'Quarterly'
    COMMENT 'Grading periods: Quarterly=4, Three-Term=3, Semester=2; Trimester is legacy compatibility only';

SET @sf10_history_type_column = (
    SELECT IF(
        EXISTS(
            SELECT 1
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'learner_academic_history'
              AND COLUMN_NAME = 'grading_system_type'
        ),
        'ALTER TABLE `learner_academic_history` MODIFY COLUMN `grading_system_type` ENUM(\'Quarterly\',\'Three-Term\',\'Trimester\') DEFAULT NULL COMMENT \'Historical record periods: Quarterly=4, Three-Term=3; Trimester is legacy compatibility only\'',
        'SELECT 1'
    )
);
PREPARE sf10_history_type_stmt FROM @sf10_history_type_column;
EXECUTE sf10_history_type_stmt;
DEALLOCATE PREPARE sf10_history_type_stmt;

UPDATE `school_years`
SET `grading_system_type` = 'Quarterly'
WHERE `year_label` = '2025-2026'
  AND `is_deleted` = 0;

UPDATE `school_years`
SET `grading_system_type` = 'Three-Term'
WHERE `grading_system_type` = 'Trimester'
  AND `is_deleted` = 0;

UPDATE `learner_academic_history`
SET `grading_system_type` = 'Three-Term'
WHERE `grading_system_type` = 'Trimester';

UPDATE `grading_periods` gp
JOIN `school_years` sy ON sy.school_year_id = gp.school_year_id
SET gp.period_name = CASE gp.period_no
        WHEN 1 THEN '1st Quarter'
        WHEN 2 THEN '2nd Quarter'
        WHEN 3 THEN '3rd Quarter'
        WHEN 4 THEN '4th Quarter'
        ELSE gp.period_name
    END,
    gp.is_deleted = 0,
    gp.deleted_at = NULL
WHERE sy.year_label = '2025-2026'
  AND gp.period_no BETWEEN 1 AND 4;

UPDATE `grading_periods` gp
JOIN `school_years` sy ON sy.school_year_id = gp.school_year_id
SET gp.period_name = CASE gp.period_no
        WHEN 1 THEN 'Term 1'
        WHEN 2 THEN 'Term 2'
        WHEN 3 THEN 'Term 3'
        ELSE gp.period_name
    END
WHERE sy.grading_system_type = 'Three-Term'
  AND gp.period_no BETWEEN 1 AND 3
  AND gp.is_deleted = 0;
