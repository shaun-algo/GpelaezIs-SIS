-- Grade 1 descriptive progression support.
-- Run once on an existing database after learner_progression exists.
-- Grade 1 promotion is based on complete PACE A-E ratings for Terms 1-3;
-- numeric final_grades/general_averages are not required for that grade mode.

SET @has_progression_basis := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'learner_progression'
      AND COLUMN_NAME = 'progression_basis'
);

SET @add_progression_basis_sql := IF(
    @has_progression_basis = 0,
    'ALTER TABLE learner_progression ADD COLUMN progression_basis ENUM(\'numerical_grades\',\'descriptive_pace\',\'kindergarten_checklists\') NOT NULL DEFAULT \'numerical_grades\' COMMENT \'Determines which metric drives the final_status decision\' AFTER processed_at',
    'SELECT 1'
);

PREPARE add_progression_basis_stmt FROM @add_progression_basis_sql;
EXECUTE add_progression_basis_stmt;
DEALLOCATE PREPARE add_progression_basis_stmt;

ALTER TABLE learner_progression
    MODIFY COLUMN progression_basis
        ENUM('numerical_grades','descriptive_pace','kindergarten_checklists')
        NOT NULL DEFAULT 'numerical_grades'
        COMMENT 'Determines which metric drives the final_status decision';
