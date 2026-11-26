<?php

require_once __DIR__ . '/../connection.php';

try {
    $conn->exec('DROP TRIGGER IF EXISTS trg_final_grades_bu_deped_rules');
    $conn->exec(
        "CREATE TRIGGER trg_final_grades_bu_deped_rules BEFORE UPDATE ON final_grades FOR EACH ROW
        BEGIN
            DECLARE v_sy_id INT DEFAULT NULL;
            DECLARE v_system VARCHAR(20) DEFAULT NULL;
            DECLARE v_expected INT DEFAULT 0;
            DECLARE v_actual INT DEFAULT 0;
            DECLARE v_avg DECIMAL(5,2) DEFAULT NULL;
            DECLARE v_msg VARCHAR(255) DEFAULT '';

            IF NEW.is_deleted = 0 THEN
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
                    WHEN 'Three-Term' THEN 3
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
            END IF;
        END"
    );
    echo "Final-grade soft-delete trigger updated.\n";
} catch (Exception $e) {
    fwrite(STDERR, "Trigger update failed: {$e->getMessage()}\n");
    exit(1);
}
