-- Add per-curriculum subject instructional-time settings.
--
-- weekly_minutes is retained for compatibility with existing curriculum data.
-- meeting_minutes is the duration of one scheduled class meeting; the
-- application falls back to weekly_minutes for older rows until this value
-- is configured.

ALTER TABLE curriculum_subjects
    ADD COLUMN IF NOT EXISTS meeting_minutes SMALLINT UNSIGNED NULL
        COMMENT 'Total daily instructional minutes for subject' AFTER weekly_minutes,
    ADD COLUMN IF NOT EXISTS meetings_per_week TINYINT UNSIGNED NULL
        COMMENT 'Expected subject meetings per week' AFTER meeting_minutes;

-- Seed the current K-10 timetable defaults where a subject has no explicit
-- profile yet. The curriculum editor remains the source of truth for local
-- variations.
UPDATE curriculum_subjects cs
JOIN grade_levels gl ON gl.grade_level_id = cs.grade_level_id
SET cs.meeting_minutes = CASE
        WHEN gl.grade_name IN ('Grade 1', 'Grade 2') THEN 40
        ELSE 45
    END,
    cs.meetings_per_week = 5
WHERE cs.is_deleted = 0
  AND gl.is_deleted = 0
  AND gl.grade_name REGEXP '^Grade (1|2|3|4|5|6|7|8|9|10)$'
  AND cs.meeting_minutes IS NULL;

CREATE INDEX IF NOT EXISTS idx_curriculum_subjects_time
    ON curriculum_subjects (curriculum_id, grade_level_id, subject_id, meeting_minutes);
