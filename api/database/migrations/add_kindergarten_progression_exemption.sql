-- Kindergarten Progression Exemption Migration
-- Addresses GAP 3: No Kindergarten Exemption in Progression Logic
-- This migration enables Kindergarten completion tracking without requiring numerical grades
-- Kindergarten progression is based on checklist/portfolio completion, not general_average

START TRANSACTION;

-- 1) Add kindergarten-specific progression tracking columns
ALTER TABLE learner_progression
  ADD COLUMN kg_checklist_completion_rate DECIMAL(5,2) DEFAULT NULL COMMENT 'Kindergarten: % of learning standards demonstrated (0-100)',
  ADD COLUMN kg_portfolio_artifacts_count INT(11) DEFAULT NULL COMMENT 'Kindergarten: number of portfolio artifacts submitted',
  ADD COLUMN progression_basis ENUM('numerical_grades', 'kindergarten_checklists') DEFAULT 'numerical_grades' COMMENT 'Determines which metric drives the final_status decision';

-- 2) Add trigger to auto-set progression_basis for Kindergarten enrollments
DELIMITER $$

CREATE TRIGGER trg_kg_progression_basis_bi
BEFORE INSERT ON learner_progression
FOR EACH ROW
BEGIN
  DECLARE v_grade_name VARCHAR(50);

  SELECT gl.grade_name INTO v_grade_name
  FROM enrollments e
  JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
  WHERE e.enrollment_id = NEW.enrollment_id
  LIMIT 1;

  IF v_grade_name = 'Kindergarten' THEN
    SET NEW.progression_basis = 'kindergarten_checklists';
  ELSE
    SET NEW.progression_basis = 'numerical_grades';
  END IF;
END$$

CREATE TRIGGER trg_kg_progression_basis_bu
BEFORE UPDATE ON learner_progression
FOR EACH ROW
BEGIN
  DECLARE v_grade_name VARCHAR(50);

  SELECT gl.grade_name INTO v_grade_name
  FROM enrollments e
  JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
  WHERE e.enrollment_id = NEW.enrollment_id
  LIMIT 1;

  IF v_grade_name = 'Kindergarten' THEN
    SET NEW.progression_basis = 'kindergarten_checklists';
  ELSE
    SET NEW.progression_basis = 'numerical_grades';
  END IF;
END$$

DELIMITER ;

-- 3) Add validation trigger to prevent numerical grades for Kindergarten progression
DELIMITER $$

CREATE TRIGGER trg_prevent_kg_numerical_progression
BEFORE UPDATE ON learner_progression
FOR EACH ROW
BEGIN
  DECLARE v_grade_name VARCHAR(50);

  SELECT gl.grade_name INTO v_grade_name
  FROM enrollments e
  JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
  WHERE e.enrollment_id = NEW.enrollment_id
  LIMIT 1;

  IF v_grade_name = 'Kindergarten' AND NEW.progression_basis = 'kindergarten_checklists' THEN
    -- Ensure general_average is NULL for Kindergarten
    IF NEW.general_average IS NOT NULL THEN
      SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Kindergarten progression cannot use general_average. Use kg_checklist_completion_rate instead.';
    END IF;
  END IF;
END$$

DELIMITER ;

-- 4) Create view for Kindergarten progression metrics
CREATE OR REPLACE VIEW v_kindergarten_progression AS
SELECT
  lp.progression_id,
  lp.enrollment_id,
  e.learner_id,
  gl.grade_name,
  lp.kg_checklist_completion_rate,
  lp.kg_portfolio_artifacts_count,
  lp.progression_basis,
  lp.final_status,
  lp.next_grade_level_id,
  lp.decided_at,
  lp.remarks,
  -- Computed: number of checklist entries evaluated
  (SELECT COUNT(*) FROM kindergarten_checklists kc
   WHERE kc.enrollment_id = lp.enrollment_id AND kc.is_deleted = 0) AS total_checklist_entries,
  -- Computed: number of portfolios submitted
  (SELECT COUNT(*) FROM kindergarten_portfolios kp
   WHERE kp.enrollment_id = lp.enrollment_id AND kp.is_deleted = 0) AS total_portfolio_entries
FROM learner_progression lp
JOIN enrollments e ON e.enrollment_id = lp.enrollment_id
JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
WHERE gl.grade_name = 'Kindergarten';

COMMIT;

-- Verification queries (run these to verify the migration was successful):
-- SHOW COLUMNS FROM learner_progression LIKE 'kg_checklist_completion_rate';
-- SHOW COLUMNS FROM learner_progression LIKE 'kg_portfolio_artifacts_count';
-- SHOW COLUMNS FROM learner_progression LIKE 'progression_basis';
-- SHOW TRIGGERS WHERE `Trigger` LIKE '%kg_progression%';
-- SELECT * FROM v_kindergarten_progression LIMIT 5;

-- Business Logic Implementation Notes:
--
-- API Layer should implement the following logic for Kindergarten progression:
--
-- 1. When computing Kindergarten progression:
--    - Calculate kg_checklist_completion_rate = (COUNT('Consistent' + 'Developing') / TOTAL standards) * 100
--    - Count kg_portfolio_artifacts_count from kindergarten_portfolios table
--    - Set progression_basis = 'kindergarten_checklists'
--    - Set general_average = NULL (enforced by trigger)
--
-- 2. Kindergarten completion criteria (recommended):
--    - kg_checklist_completion_rate >= 75% (at least 75% of standards at 'Developing' or 'Consistent')
--    - kg_portfolio_artifacts_count >= 4 (one per quarter minimum)
--    - final_status = 'Completed' (not 'Promoted' since they move to Grade 1)
--    - promoted_to_grade_level_id = grade_level_id for Grade 1
--
-- 3. For Grades 1-10:
--    - progression_basis = 'numerical_grades' (auto-set by trigger)
--    - Use general_average for promotion decisions (existing logic)
--    - kg_checklist_completion_rate and kg_portfolio_artifacts_count remain NULL
