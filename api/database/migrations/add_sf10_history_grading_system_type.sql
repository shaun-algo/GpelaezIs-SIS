-- Persist the period model selected for manually entered previous-school SF10 records.
-- NULL remains valid for legacy rows so the API can infer the old shape from q4.

SET @sf10_history_grading_system_column = (
    SELECT IF(
        EXISTS(
            SELECT 1
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'learner_academic_history'
              AND COLUMN_NAME = 'grading_system_type'
        ),
        'SELECT 1',
        'ALTER TABLE `learner_academic_history` ADD COLUMN `grading_system_type` ENUM(\'Quarterly\',\'Three-Term\',\'Trimester\') DEFAULT NULL COMMENT \'Historical record periods: Quarterly=4, Three-Term=3; Trimester is legacy\' AFTER `grade_level_label`'
    )
);
PREPARE sf10_history_stmt FROM @sf10_history_grading_system_column;
EXECUTE sf10_history_stmt;
DEALLOCATE PREPARE sf10_history_stmt;
