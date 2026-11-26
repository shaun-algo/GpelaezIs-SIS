-- Migration: Promotion / rollover workflow seed + learner_progression trigger fix
-- Purpose:
--   1) Idempotently seed grade_level_progression for DepEd K-10 flow.
--   2) Recreate learner_progression status triggers so they handle:
--      - Grades 1-10: promotion from final grades (0 failed = Promoted, <=2 = Conditionally Promoted, >2 = Retained, terminal = Completed)
--      - Kindergarten: progression from checklist/portfolio completion (Completed or Conditionally Promoted)
--   3) Add INSERT guard for kindergarten numerical averages.
--
-- Run this against the capstone_migration database before using the Promotion & Rollover UI.

USE capstone_migration;

START TRANSACTION;

-- ============================================================================
-- 1. Seed grade_level_progression
-- ============================================================================
INSERT INTO grade_level_progression (grade_level_id, next_grade_level_id, is_terminal)
VALUES
    (1, 2, 0),
    (2, 3, 0),
    (3, 4, 0),
    (4, 5, 0),
    (5, 6, 0),
    (6, 7, 0),
    (7, 8, 0),
    (8, 9, 0),
    (9, 10, 0),
    (10, NULL, 1),
    (11, 1, 0)
ON DUPLICATE KEY UPDATE
    next_grade_level_id = VALUES(next_grade_level_id),
    is_terminal = VALUES(is_terminal),
    updated_at = CURRENT_TIMESTAMP;

-- ============================================================================
-- 2. Drop old status triggers
-- ============================================================================
DROP TRIGGER IF EXISTS trg_learner_progression_bi_status;
DROP TRIGGER IF EXISTS trg_learner_progression_bu_status;
DROP TRIGGER IF EXISTS trg_prevent_kg_numerical_progression;

-- ============================================================================
-- 3. Recreate INSERT status trigger (Grades 1-10 + Kindergarten)
-- ============================================================================
DELIMITER $$

CREATE TRIGGER trg_learner_progression_bi_status
BEFORE INSERT ON learner_progression
FOR EACH ROW
BEGIN
    DECLARE v_grade_name VARCHAR(50) DEFAULT NULL;
    DECLARE v_terminal TINYINT DEFAULT 0;
    DECLARE v_next_grade INT DEFAULT NULL;
    DECLARE v_failed_count INT DEFAULT 0;
    DECLARE v_total_standards INT DEFAULT 0;
    DECLARE v_demos_count INT DEFAULT 0;
    DECLARE v_portfolio_count INT DEFAULT 0;
    DECLARE v_completion_rate DECIMAL(5,2) DEFAULT NULL;
    DECLARE v_curriculum_id INT DEFAULT NULL;

    -- Resolve the grade name + progression metadata
    SELECT gl.grade_name, glp.is_terminal, glp.next_grade_level_id
      INTO v_grade_name, v_terminal, v_next_grade
    FROM grade_levels gl
    LEFT JOIN grade_level_progression glp ON glp.grade_level_id = gl.grade_level_id
    WHERE gl.grade_level_id = NEW.current_grade_level_id
    LIMIT 1;

    -- Kindergarten path: use checklist/portfolio evidence, not numerical grades
    IF v_grade_name = 'Kindergarten' OR NEW.progression_basis = 'kindergarten_checklists' THEN
        SET NEW.progression_basis = 'kindergarten_checklists';
        SET NEW.general_average = NULL;

        -- Get curriculum used by this enrollment so we can count the right standards
        SELECT curriculum_id INTO v_curriculum_id
        FROM enrollments
        WHERE enrollment_id = NEW.enrollment_id
          AND is_deleted = 0
        LIMIT 1;

        IF v_curriculum_id IS NOT NULL THEN
            SELECT COUNT(*)
              INTO v_total_standards
            FROM kindergarten_learning_standards
            WHERE curriculum_id = v_curriculum_id
              AND is_active = 1;

            SELECT COUNT(DISTINCT kc.kg_standard_id)
              INTO v_demos_count
            FROM kindergarten_checklists kc
            WHERE kc.enrollment_id = NEW.enrollment_id
              AND kc.is_deleted = 0
              AND kc.proficiency_status IN ('Developing','Consistent');
        END IF;

        SELECT COUNT(*)
          INTO v_portfolio_count
        FROM kindergarten_portfolios kp
        WHERE kp.enrollment_id = NEW.enrollment_id
          AND kp.is_deleted = 0;

        IF v_total_standards > 0 THEN
            SET v_completion_rate = ROUND((v_demos_count / v_total_standards) * 100, 2);
        END IF;

        SET NEW.kg_checklist_completion_rate = v_completion_rate;
        SET NEW.kg_portfolio_artifacts_count = v_portfolio_count;

        IF v_completion_rate >= 75.00 AND v_portfolio_count >= 4 THEN
            SET NEW.final_status = 'Completed';
            SET NEW.next_grade_level_id = v_next_grade;
            SET NEW.remarks = 'Completed Kindergarten with required readiness indicators.';
        ELSEIF v_completion_rate IS NOT NULL OR v_portfolio_count > 0 THEN
            SET NEW.final_status = 'Conditionally Promoted';
            SET NEW.next_grade_level_id = v_next_grade;
            SET NEW.remarks = 'Kindergarten readiness below threshold; proceed with early intervention.';
        ELSE
            SET NEW.final_status = 'Conditionally Promoted';
            SET NEW.next_grade_level_id = v_next_grade;
            SET NEW.remarks = 'No Kindergarten assessment data on record; manual review required.';
        END IF;
    ELSE
        -- Numerical-grade path (Grades 1-10)
        SELECT COUNT(*)
          INTO v_failed_count
        FROM final_grades fg
        WHERE fg.enrollment_id = NEW.enrollment_id
          AND fg.is_deleted = 0
          AND fg.final_grade IS NOT NULL
          AND fg.final_grade < 75.00;

        IF v_terminal = 1 THEN
            SET NEW.final_status = 'Completed';
            SET NEW.next_grade_level_id = NULL;
            SET NEW.remarks = 'Completed terminal grade level.';
        ELSEIF v_failed_count = 0 THEN
            SET NEW.final_status = 'Promoted';
            SET NEW.next_grade_level_id = v_next_grade;
            SET NEW.remarks = 'Promoted with no failed learning areas.';
        ELSEIF v_failed_count <= 2 THEN
            SET NEW.final_status = 'Conditionally Promoted';
            SET NEW.next_grade_level_id = v_next_grade;
            SET NEW.remarks = CONCAT('Conditionally promoted with ', v_failed_count, ' failed learning area(s).');
        ELSE
            SET NEW.final_status = 'Retained';
            SET NEW.next_grade_level_id = NEW.current_grade_level_id;
            SET NEW.remarks = CONCAT('Retained with ', v_failed_count, ' failed learning areas.');
        END IF;
    END IF;
END$$

-- ============================================================================
-- 4. Recreate UPDATE status trigger
-- ============================================================================
CREATE TRIGGER trg_learner_progression_bu_status
BEFORE UPDATE ON learner_progression
FOR EACH ROW
BEGIN
    DECLARE v_grade_name VARCHAR(50) DEFAULT NULL;
    DECLARE v_terminal TINYINT DEFAULT 0;
    DECLARE v_next_grade INT DEFAULT NULL;
    DECLARE v_failed_count INT DEFAULT 0;
    DECLARE v_total_standards INT DEFAULT 0;
    DECLARE v_demos_count INT DEFAULT 0;
    DECLARE v_portfolio_count INT DEFAULT 0;
    DECLARE v_completion_rate DECIMAL(5,2) DEFAULT NULL;
    DECLARE v_curriculum_id INT DEFAULT NULL;

    SELECT gl.grade_name, glp.is_terminal, glp.next_grade_level_id
      INTO v_grade_name, v_terminal, v_next_grade
    FROM grade_levels gl
    LEFT JOIN grade_level_progression glp ON glp.grade_level_id = gl.grade_level_id
    WHERE gl.grade_level_id = NEW.current_grade_level_id
    LIMIT 1;

    IF v_grade_name = 'Kindergarten' OR NEW.progression_basis = 'kindergarten_checklists' THEN
        SET NEW.progression_basis = 'kindergarten_checklists';
        SET NEW.general_average = NULL;

        SELECT curriculum_id INTO v_curriculum_id
        FROM enrollments
        WHERE enrollment_id = NEW.enrollment_id
          AND is_deleted = 0
        LIMIT 1;

        IF v_curriculum_id IS NOT NULL THEN
            SELECT COUNT(*)
              INTO v_total_standards
            FROM kindergarten_learning_standards
            WHERE curriculum_id = v_curriculum_id
              AND is_active = 1;

            SELECT COUNT(DISTINCT kc.kg_standard_id)
              INTO v_demos_count
            FROM kindergarten_checklists kc
            WHERE kc.enrollment_id = NEW.enrollment_id
              AND kc.is_deleted = 0
              AND kc.proficiency_status IN ('Developing','Consistent');
        END IF;

        SELECT COUNT(*)
          INTO v_portfolio_count
        FROM kindergarten_portfolios kp
        WHERE kp.enrollment_id = NEW.enrollment_id
          AND kp.is_deleted = 0;

        IF v_total_standards > 0 THEN
            SET v_completion_rate = ROUND((v_demos_count / v_total_standards) * 100, 2);
        END IF;

        SET NEW.kg_checklist_completion_rate = v_completion_rate;
        SET NEW.kg_portfolio_artifacts_count = v_portfolio_count;

        IF v_completion_rate >= 75.00 AND v_portfolio_count >= 4 THEN
            SET NEW.final_status = 'Completed';
            SET NEW.next_grade_level_id = v_next_grade;
            SET NEW.remarks = 'Completed Kindergarten with required readiness indicators.';
        ELSEIF v_completion_rate IS NOT NULL OR v_portfolio_count > 0 THEN
            SET NEW.final_status = 'Conditionally Promoted';
            SET NEW.next_grade_level_id = v_next_grade;
            SET NEW.remarks = 'Kindergarten readiness below threshold; proceed with early intervention.';
        ELSE
            SET NEW.final_status = 'Conditionally Promoted';
            SET NEW.next_grade_level_id = v_next_grade;
            SET NEW.remarks = 'No Kindergarten assessment data on record; manual review required.';
        END IF;
    ELSE
        SELECT COUNT(*)
          INTO v_failed_count
        FROM final_grades fg
        WHERE fg.enrollment_id = NEW.enrollment_id
          AND fg.is_deleted = 0
          AND fg.final_grade IS NOT NULL
          AND fg.final_grade < 75.00;

        IF v_terminal = 1 THEN
            SET NEW.final_status = 'Completed';
            SET NEW.next_grade_level_id = NULL;
            SET NEW.remarks = 'Completed terminal grade level.';
        ELSEIF v_failed_count = 0 THEN
            SET NEW.final_status = 'Promoted';
            SET NEW.next_grade_level_id = v_next_grade;
            SET NEW.remarks = 'Promoted with no failed learning areas.';
        ELSEIF v_failed_count <= 2 THEN
            SET NEW.final_status = 'Conditionally Promoted';
            SET NEW.next_grade_level_id = v_next_grade;
            SET NEW.remarks = CONCAT('Conditionally promoted with ', v_failed_count, ' failed learning area(s).');
        ELSE
            SET NEW.final_status = 'Retained';
            SET NEW.next_grade_level_id = NEW.current_grade_level_id;
            SET NEW.remarks = CONCAT('Retained with ', v_failed_count, ' failed learning areas.');
        END IF;
    END IF;
END$$

-- ============================================================================
-- 5. Re-create kindergarten numerical-grade guard for both INSERT and UPDATE
-- ============================================================================
CREATE TRIGGER trg_prevent_kg_numerical_progression_bi
BEFORE INSERT ON learner_progression
FOR EACH ROW
BEGIN
    DECLARE v_grade_name VARCHAR(50);

    SELECT gl.grade_name INTO v_grade_name
    FROM enrollments e
    JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
    WHERE e.enrollment_id = NEW.enrollment_id
    LIMIT 1;

    IF v_grade_name = 'Kindergarten' AND NEW.progression_basis = 'kindergarten_checklists' THEN
        IF NEW.general_average IS NOT NULL THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Kindergarten progression cannot use general_average. Use kg_checklist_completion_rate instead.';
        END IF;
    END IF;
END$$

CREATE TRIGGER trg_prevent_kg_numerical_progression_bu
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
        IF NEW.general_average IS NOT NULL THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Kindergarten progression cannot use general_average. Use kg_checklist_completion_rate instead.';
        END IF;
    END IF;
END$$

DELIMITER ;

COMMIT;
