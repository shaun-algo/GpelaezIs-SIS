-- Keep exactly one active curriculum for the application-wide setup default.
-- Prefer the curriculum that is primary for the currently active school year;
-- otherwise keep the newest active curriculum, then the newest non-deleted row.
-- Older curriculum rows remain available as inactive historical records.

START TRANSACTION;

SET @keep_curriculum_id := COALESCE(
    (
        SELECT m.curriculum_id
        FROM curriculum_school_year_map m
        JOIN school_years sy
          ON sy.school_year_id = m.school_year_id
         AND sy.is_deleted = 0
         AND sy.is_active = 1
        JOIN curricula c
          ON c.curriculum_id = m.curriculum_id
         AND c.is_deleted = 0
        WHERE m.is_deleted = 0
          AND m.is_primary = 1
        ORDER BY sy.year_start DESC, m.map_id DESC
        LIMIT 1
    ),
    (
        SELECT curriculum_id
        FROM curricula
        WHERE is_deleted = 0
          AND is_active = 1
        ORDER BY effective_from DESC, curriculum_id DESC
        LIMIT 1
    ),
    (
        SELECT curriculum_id
        FROM curricula
        WHERE is_deleted = 0
        ORDER BY effective_from DESC, curriculum_id DESC
        LIMIT 1
    )
);

UPDATE curricula
SET is_active = IF(curriculum_id = @keep_curriculum_id, 1, 0)
WHERE is_deleted = 0;

COMMIT;
