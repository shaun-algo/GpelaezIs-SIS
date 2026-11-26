-- Bind every active school year to exactly one primary curriculum and
-- backfill enrollments that were created before the binding was enforced.
-- The school-year map is the source of truth; academic APIs must not fall
-- back to whichever curriculum happens to be globally active.

START TRANSACTION;

CREATE TEMPORARY TABLE _curriculum_school_year_primary (
    school_year_id INT NOT NULL PRIMARY KEY,
    curriculum_id INT NOT NULL
);

INSERT INTO _curriculum_school_year_primary (school_year_id, curriculum_id)
SELECT sy.school_year_id,
       COALESCE(chosen.curriculum_id, fallback.curriculum_id) AS curriculum_id
FROM school_years sy
LEFT JOIN (
    SELECT m.school_year_id, m.curriculum_id
    FROM curriculum_school_year_map m
    JOIN (
        SELECT school_year_id,
               COALESCE(
                   MIN(CASE WHEN is_primary = 1 THEN map_id END),
                   MIN(map_id)
               ) AS chosen_map_id
        FROM curriculum_school_year_map
        WHERE is_deleted = 0
        GROUP BY school_year_id
    ) picked ON picked.chosen_map_id = m.map_id
    WHERE m.is_deleted = 0
) chosen ON chosen.school_year_id = sy.school_year_id
CROSS JOIN (
    SELECT curriculum_id
    FROM curricula
    WHERE is_deleted = 0
    ORDER BY is_active DESC, effective_from DESC, curriculum_id DESC
    LIMIT 1
) fallback
WHERE sy.is_deleted = 0;

UPDATE curriculum_school_year_map m
JOIN _curriculum_school_year_primary p
  ON p.school_year_id = m.school_year_id
SET m.is_primary = 0
WHERE m.is_deleted = 0;

INSERT INTO curriculum_school_year_map (curriculum_id, school_year_id, is_primary, is_deleted, deleted_at)
SELECT p.curriculum_id, p.school_year_id, 1, 0, NULL
FROM _curriculum_school_year_primary p
ON DUPLICATE KEY UPDATE
    is_primary = 1,
    is_deleted = 0,
    deleted_at = NULL;

UPDATE enrollments e
JOIN curriculum_school_year_map m
  ON m.school_year_id = e.school_year_id
 AND m.is_primary = 1
 AND m.is_deleted = 0
SET e.curriculum_id = m.curriculum_id
WHERE e.curriculum_id IS NULL
  AND e.is_deleted = 0
  AND EXISTS (
      SELECT 1
      FROM sections s
      WHERE s.section_id = e.section_id
        AND s.is_deleted = 0
        AND s.school_year_id = e.school_year_id
        AND s.grade_level_id = e.grade_level_id
        AND (
            s.max_capacity IS NULL
            OR (
                SELECT COUNT(*)
                FROM enrollments e2
                WHERE e2.section_id = e.section_id
                  AND e2.school_year_id = e.school_year_id
                  AND e2.is_deleted = 0
                  AND (e2.enrollment_status = 'Enrolled' OR e2.enrollment_status IS NULL)
                  AND e2.enrollment_id <> e.enrollment_id
            ) < s.max_capacity
        )
  );

DROP TEMPORARY TABLE _curriculum_school_year_primary;

COMMIT;
