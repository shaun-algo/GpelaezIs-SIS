-- Restore source enrollments that were completed too early by the old
-- promotion compute workflow while grading periods are still open.
--
-- This keeps already-processed rollover records completed, and only restores
-- unprocessed progression records for school years with at least one Open
-- grading period.

UPDATE enrollments e
JOIN learner_progression lp
  ON lp.enrollment_id = e.enrollment_id
 AND lp.is_processed = 0
SET e.enrollment_status = 'Enrolled',
    e.status_updated_at = CURRENT_TIMESTAMP
WHERE e.is_deleted = 0
  AND e.enrollment_status = 'Completed'
  AND EXISTS (
      SELECT 1
      FROM grading_periods gp
      WHERE gp.school_year_id = e.school_year_id
        AND gp.is_deleted = 0
        AND UPPER(gp.status) = 'OPEN'
  );
