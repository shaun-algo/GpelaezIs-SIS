-- Close source enrollments independently from promotion result.
-- `enrollments.enrollment_status = Completed` means the learner finished that
-- school-year enrollment. Promotion readiness remains in
-- `learner_progression.final_status`.

ALTER TABLE learner_progression
  MODIFY COLUMN final_status
    ENUM('Promoted','Conditionally Promoted','Retained','Completed') NOT NULL
    COMMENT 'Promotion result. Completed is reserved for terminal/non-rollover completion unless next_grade_level_id is set.';

DROP VIEW IF EXISTS vw_learner_progression_candidates;

CREATE VIEW vw_learner_progression_candidates AS
SELECT
    lp.progression_id,
    lp.enrollment_id,
    lp.learner_id,
    lp.school_year_id AS source_school_year_id,
    lp.current_grade_level_id,
    lp.next_grade_level_id,
    lp.general_average,
    lp.final_status,
    lp.remarks,
    lp.is_processed,
    e.section_id AS source_section_id,
    sec.section_name AS source_section_name,
    e.curriculum_id AS source_curriculum_id
FROM learner_progression lp
JOIN enrollments e
  ON e.enrollment_id = lp.enrollment_id
 AND e.is_deleted = 0
LEFT JOIN sections sec
  ON sec.section_id = e.section_id
WHERE lp.final_status IN ('Promoted','Conditionally Promoted','Retained')
   OR (lp.final_status = 'Completed' AND lp.next_grade_level_id IS NOT NULL);
