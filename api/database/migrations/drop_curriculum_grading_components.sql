-- Migration: Drop curriculum_grading_components table
-- Reason: Grades are now captured directly per Period (quarterly/trimester grade).
-- Class-record component weights (WW, PT, QE) are no longer used, so this
-- source-of-truth table and its foreign keys are being removed.

-- Drop foreign key constraints first (safe even if already absent)
ALTER TABLE `curriculum_grading_components`
    DROP FOREIGN KEY IF EXISTS `fk_cgc_curriculum`,
    DROP FOREIGN KEY IF EXISTS `fk_cgc_grade_level`;

-- Drop the table
DROP TABLE IF EXISTS `curriculum_grading_components`;
