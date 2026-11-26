-- ============================================================
-- Curriculum Setup: seed and repair K to 10 / MATATAG learning areas
-- ============================================================
-- This migration is safe to run more than once. The application also
-- creates these areas for newly created curricula.

INSERT INTO curriculum_learning_areas
    (curriculum_id, area_code, area_name, sort_order, is_deleted, deleted_at)
SELECT c.curriculum_id, seed.area_code, seed.area_name, seed.sort_order, 0, NULL
FROM curricula c
JOIN (
    SELECT 'LANG' AS area_code, 'Languages (MTB-MLE / Filipino / English)' AS area_name, 1 AS sort_order
    UNION ALL SELECT 'MATH', 'Mathematics', 2
    UNION ALL SELECT 'SCI', 'Science', 3
    UNION ALL SELECT 'SOAPSS', 'Social Studies (Araling Panlipunan)', 4
    UNION ALL SELECT 'VALUES', 'Values Education (EsP)', 5
    UNION ALL SELECT 'MAPEH', 'MAPEH', 6
    UNION ALL SELECT 'GMRC', 'Good Manners and Right Conduct (GMRC)', 7
    UNION ALL SELECT 'MAKAB', 'Makabansa', 8
    UNION ALL SELECT 'TECHVOC', 'Technology and Livelihood (EPP / TLE)', 9
) seed
WHERE c.is_deleted = 0
ON DUPLICATE KEY UPDATE
    area_name = VALUES(area_name),
    sort_order = VALUES(sort_order),
    is_deleted = 0,
    deleted_at = NULL;

UPDATE curriculum_subjects cs
JOIN subjects s ON s.subject_id = cs.subject_id
JOIN curriculum_learning_areas cla
  ON cla.curriculum_id = cs.curriculum_id
 AND cla.is_deleted = 0
 AND cla.area_code = CASE
    WHEN LOWER(s.subject_name) LIKE '%mapeh%'
      OR LOWER(s.subject_name) LIKE '%music%'
      OR LOWER(s.subject_name) LIKE '%arts%'
      OR LOWER(s.subject_name) LIKE '%physical education%'
      OR LOWER(s.subject_name) LIKE '%health%'
        THEN 'MAPEH'
    WHEN LOWER(s.subject_name) LIKE '%filipino%'
      OR LOWER(s.subject_name) LIKE '%english%'
      OR LOWER(s.subject_name) LIKE '%mother tongue%'
      OR LOWER(s.subject_name) LIKE '%reading and literacy%'
        THEN 'LANG'
    WHEN LOWER(s.subject_name) LIKE '%mathematics%'
      OR LOWER(s.subject_name) LIKE '%math%'
        THEN 'MATH'
    WHEN LOWER(s.subject_name) LIKE '%science%'
        THEN 'SCI'
    WHEN LOWER(s.subject_name) LIKE '%araling panlipunan%'
      OR LOWER(s.subject_name) LIKE '%social studies%'
        THEN 'SOAPSS'
    WHEN LOWER(s.subject_name) LIKE '%gmrc%'
      OR LOWER(s.subject_name) LIKE '%good manners%'
      OR LOWER(s.subject_name) LIKE '%right conduct%'
        THEN 'GMRC'
    WHEN LOWER(s.subject_name) LIKE '%makabansa%'
        THEN 'MAKAB'
    WHEN LOWER(s.subject_name) LIKE '%values education%'
      OR LOWER(s.subject_name) LIKE '%edukasyon sa pagpapakatao%'
      OR LOWER(s.subject_name) LIKE '%esp%'
        THEN 'VALUES'
    WHEN LOWER(s.subject_name) LIKE '%epp%'
      OR LOWER(s.subject_name) LIKE '%tle%'
      OR LOWER(s.subject_name) LIKE '%technology%'
      OR LOWER(s.subject_name) LIKE '%livelihood%'
        THEN 'TECHVOC'
    ELSE ''
 END
SET cs.learning_area_id = cla.area_id
WHERE cs.is_deleted = 0
  AND cs.learning_area_id IS NULL;
