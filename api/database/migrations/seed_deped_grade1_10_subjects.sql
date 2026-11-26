-- ============================================================
-- Seed: DepEd Grade 1-10 subjects per user-provided official list
-- ============================================================
-- Assumptions / mapping notes:
--   * "GMRC / Values Education" in Grades 1-5 is represented by the GMRC subject.
--   * Grade 6 keeps "Edukasyon sa Pagpapakatao (EsP)" for the transition year.
--   * Grades 7-9 use the separate "Values Education" subject; Grade 10 keeps
--     "Edukasyon sa Pagpapakatao (EsP)" for the final old K to 12 year.
--   * "Music, Arts, Physical Education and Health" in Grades 1-3 is represented
--     by the four MAPEH component subjects (Music, Arts, PE, Health).
--   * "MAPEH" in Grades 4-10 is the clustered MAPEH subject.
--   * "EPP foundations" and "EPP" in Grades 1-5 are represented by the EPP subject.
--   * "TLE" in Grade 6 and Grades 7-10 is the TLE subject.
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;
START TRANSACTION;

-- 1. Restore the Arts MAPEH component and add Reading and Literacy
UPDATE subjects
   SET is_deleted = 0,
       deleted_at = NULL,
       description = 'MAPEH component subject — Arts'
 WHERE subject_id = 14;

INSERT INTO subjects (subject_name, description, is_deleted, deleted_at)
SELECT 'Reading and Literacy', 'Reading and Literacy — Grades 1 and 2', 0, NULL
  FROM DUAL
 WHERE NOT EXISTS (
     SELECT 1 FROM subjects WHERE subject_name = 'Reading and Literacy' AND is_deleted = 0
 );

SET @reading_lit_id = (SELECT subject_id FROM subjects WHERE subject_name = 'Reading and Literacy' AND is_deleted = 0 LIMIT 1);

-- 1b. Keep the shared subject catalog names aligned with the intermediate-grade forms.
UPDATE subjects SET subject_name = 'Araling Panlipunan (AP)', description = 'Araling Panlipunan (AP)' WHERE subject_id = 5;
UPDATE subjects SET subject_name = 'Good Manners & Right Conduct (GMRC)', description = 'Good Manners & Right Conduct (GMRC)' WHERE subject_id = 8;
UPDATE subjects SET subject_name = 'MAPEH', description = 'Music, Arts, Physical Education and Health (MAPEH)' WHERE subject_id = 7;
UPDATE subjects SET subject_name = 'EPP (Edukasyong Pantahanan at Pangkabuhayan)', description = 'EPP — Edukasyong Pantahanan at Pangkabuhayan' WHERE subject_id = 11;
UPDATE subjects SET subject_name = 'TLE (Technology & Livelihood Education)', description = 'TLE — Technology & Livelihood Education' WHERE subject_id = 12;

INSERT INTO subjects (subject_name, description, is_deleted, deleted_at)
SELECT 'Values Education', 'Values Education — MATATAG Grades 7-9', 0, NULL
  FROM DUAL
 WHERE NOT EXISTS (
     SELECT 1 FROM subjects WHERE subject_name = 'Values Education' AND is_deleted = 0
 );

SET @values_education_id = (SELECT subject_id FROM subjects WHERE subject_name = 'Values Education' AND is_deleted = 0 LIMIT 1);

-- 2. Remove old Grade 1-10 assignments for the primary curriculum so we can re-seed cleanly
DELETE FROM curriculum_subjects
 WHERE curriculum_id = 1
   AND grade_level_id BETWEEN 1 AND 10;

-- 3. Insert clean Grade 1-10 assignments
-- Grade 1
INSERT INTO curriculum_subjects (curriculum_id, grade_level_id, subject_id, is_required, weekly_minutes, sort_order, learning_area_id, notes) VALUES
(1, 1, 1,  1, 100, 1,  1, 'Mother Tongue'),
(1, 1, 17, 1, 60,  2,  1, 'Reading and Literacy'),
(1, 1, 4,  1, 60,  3,  2, 'Mathematics'),
(1, 1, 10, 1, 40,  4,  3, 'Science'),
(1, 1, 8,  1, 40,  5,  7, 'GMRC / Values Education'),
(1, 1, 9,  1, 40,  6,  8, 'Makabansa'),
(1, 1, 13, 1, 20,  7,  6, 'Music'),
(1, 1, 14, 1, 20,  8,  6, 'Arts'),
(1, 1, 15, 1, 20,  9,  6, 'Physical Education'),
(1, 1, 16, 1, 20, 10,  6, 'Health'),
(1, 1, 11, 1, 40, 11,  9, 'EPP foundations');

-- Grade 2
INSERT INTO curriculum_subjects (curriculum_id, grade_level_id, subject_id, is_required, weekly_minutes, sort_order, learning_area_id, notes) VALUES
(1, 2, 1,  1, 80,  1,  1, 'Mother Tongue'),
(1, 2, 2,  1, 60,  2,  1, 'Filipino'),
(1, 2, 3,  1, 60,  3,  1, 'English'),
(1, 2, 4,  1, 60,  4,  2, 'Mathematics'),
(1, 2, 10, 1, 40,  5,  3, 'Science'),
(1, 2, 8,  1, 40,  6,  7, 'GMRC / Values Education'),
(1, 2, 9,  1, 40,  7,  8, 'Makabansa'),
(1, 2, 13, 1, 20,  8,  6, 'Music'),
(1, 2, 14, 1, 20,  9,  6, 'Arts'),
(1, 2, 15, 1, 20, 10,  6, 'Physical Education'),
(1, 2, 16, 1, 20, 11,  6, 'Health'),
(1, 2, 11, 1, 40, 12,  9, 'EPP foundations');

-- Grade 3
INSERT INTO curriculum_subjects (curriculum_id, grade_level_id, subject_id, is_required, weekly_minutes, sort_order, learning_area_id, notes) VALUES
(1, 3, 2,  1, 60,  1,  1, 'Filipino'),
(1, 3, 3,  1, 60,  2,  1, 'English'),
(1, 3, 4,  1, 60,  3,  2, 'Mathematics'),
(1, 3, 10, 1, 60,  4,  3, 'Science'),
(1, 3, 5,  1, 40,  5,  4, 'Araling Panlipunan'),
(1, 3, 8,  1, 40,  6,  7, 'GMRC / Values Education'),
(1, 3, 9,  1, 40,  7,  8, 'Makabansa'),
(1, 3, 13, 1, 20,  8,  6, 'Music'),
(1, 3, 14, 1, 20,  9,  6, 'Arts'),
(1, 3, 15, 1, 20, 10,  6, 'Physical Education'),
(1, 3, 16, 1, 20, 11,  6, 'Health'),
(1, 3, 11, 1, 60, 12,  9, 'EPP');

-- Grade 4
INSERT INTO curriculum_subjects (curriculum_id, grade_level_id, subject_id, is_required, weekly_minutes, sort_order, learning_area_id, notes) VALUES
(1, 4, 3,  1, 60,  1,  1, 'English'),
(1, 4, 2,  1, 60,  2,  1, 'Filipino'),
(1, 4, 4,  1, 60,  3,  2, 'Mathematics'),
(1, 4, 10, 1, 60,  4,  3, 'Science'),
(1, 4, 5,  1, 40,  5,  4, 'Araling Panlipunan (AP)'),
(1, 4, 8,  1, 40,  6,  7, 'Good Manners & Right Conduct (GMRC)'),
(1, 4, 7,  1, 80,  7,  6, 'MAPEH'),
(1, 4, 11, 1, 80,  8,  9, 'EPP (Edukasyong Pantahanan at Pangkabuhayan)');

-- Grade 5
INSERT INTO curriculum_subjects (curriculum_id, grade_level_id, subject_id, is_required, weekly_minutes, sort_order, learning_area_id, notes) VALUES
(1, 5, 3,  1, 60,  1,  1, 'English'),
(1, 5, 2,  1, 60,  2,  1, 'Filipino'),
(1, 5, 4,  1, 60,  3,  2, 'Mathematics'),
(1, 5, 10, 1, 60,  4,  3, 'Science'),
(1, 5, 5,  1, 40,  5,  4, 'Araling Panlipunan (AP)'),
(1, 5, 8,  1, 40,  6,  7, 'Good Manners & Right Conduct (GMRC)'),
(1, 5, 7,  1, 80,  7,  6, 'MAPEH'),
(1, 5, 11, 1, 80,  8,  9, 'EPP (Edukasyong Pantahanan at Pangkabuhayan)');

-- Grade 6
INSERT INTO curriculum_subjects (curriculum_id, grade_level_id, subject_id, is_required, weekly_minutes, sort_order, learning_area_id, notes) VALUES
(1, 6, 3,  1, 60,  1,  1, 'English'),
(1, 6, 2,  1, 60,  2,  1, 'Filipino'),
(1, 6, 4,  1, 60,  3,  2, 'Mathematics'),
(1, 6, 10, 1, 60,  4,  3, 'Science'),
(1, 6, 5,  1, 40,  5,  4, 'Araling Panlipunan (AP)'),
(1, 6, 6,  1, 40,  6,  5, 'Edukasyon sa Pagpapakatao (EsP)'),
(1, 6, 7,  1, 80,  7,  6, 'MAPEH'),
(1, 6, 12, 1, 80,  8,  9, 'TLE (Technology & Livelihood Education)');

-- Grade 7
INSERT INTO curriculum_subjects (curriculum_id, grade_level_id, subject_id, is_required, weekly_minutes, sort_order, learning_area_id, notes) VALUES
(1, 7, 3,  1, 60,  1,  1, 'English'),
(1, 7, 2,  1, 60,  2,  1, 'Filipino'),
(1, 7, 4,  1, 60,  3,  2, 'Mathematics'),
(1, 7, 10, 1, 60,  4,  3, 'Science'),
(1, 7, 5,  1, 40,  5,  4, 'Araling Panlipunan (AP)'),
(1, 7, @values_education_id, 1, 40,  6,  5, 'Values Education'),
(1, 7, 7,  1, 80,  7,  6, 'MAPEH'),
(1, 7, 12, 1, 80,  8,  9, 'TLE (Technology & Livelihood Education)');

-- Grade 8
INSERT INTO curriculum_subjects (curriculum_id, grade_level_id, subject_id, is_required, weekly_minutes, sort_order, learning_area_id, notes) VALUES
(1, 8, 3,  1, 60,  1,  1, 'English'),
(1, 8, 2,  1, 60,  2,  1, 'Filipino'),
(1, 8, 4,  1, 60,  3,  2, 'Mathematics'),
(1, 8, 10, 1, 60,  4,  3, 'Science'),
(1, 8, 5,  1, 40,  5,  4, 'Araling Panlipunan (AP)'),
(1, 8, @values_education_id, 1, 40,  6,  5, 'Values Education'),
(1, 8, 7,  1, 80,  7,  6, 'MAPEH'),
(1, 8, 12, 1, 80,  8,  9, 'TLE (Technology & Livelihood Education)');

-- Grade 9
INSERT INTO curriculum_subjects (curriculum_id, grade_level_id, subject_id, is_required, weekly_minutes, sort_order, learning_area_id, notes) VALUES
(1, 9, 3,  1, 60,  1,  1, 'English'),
(1, 9, 2,  1, 60,  2,  1, 'Filipino'),
(1, 9, 4,  1, 60,  3,  2, 'Mathematics'),
(1, 9, 10, 1, 60,  4,  3, 'Science'),
(1, 9, 5,  1, 40,  5,  4, 'Araling Panlipunan (AP)'),
(1, 9, @values_education_id, 1, 40,  6,  5, 'Values Education'),
(1, 9, 7,  1, 80,  7,  6, 'MAPEH'),
(1, 9, 12, 1, 80,  8,  9, 'TLE (Technology & Livelihood Education)');

-- Grade 10
INSERT INTO curriculum_subjects (curriculum_id, grade_level_id, subject_id, is_required, weekly_minutes, sort_order, learning_area_id, notes) VALUES
(1, 10, 3,  1, 60,  1,  1, 'English'),
(1, 10, 2,  1, 60,  2,  1, 'Filipino'),
(1, 10, 4,  1, 60,  3,  2, 'Mathematics'),
(1, 10, 10, 1, 60,  4,  3, 'Science'),
(1, 10, 5,  1, 40,  5,  4, 'Araling Panlipunan (AP)'),
(1, 10, 6,  1, 40,  6,  5, 'Edukasyon sa Pagpapakatao (EsP)'),
(1, 10, 7,  1, 80,  7,  6, 'MAPEH'),
(1, 10, 12, 1, 80,  8,  9, 'TLE (Technology & Livelihood Education)');

-- 4. Refresh subject descriptions to match the new scope
UPDATE subjects SET description = 'Mother Tongue — Grades 1-2'        WHERE subject_id = 1;
UPDATE subjects SET description = 'Science — Grades 1-10; spiral progression' WHERE subject_id = 10;
UPDATE subjects SET description = 'EPP / TLE — Grades 1-4; livelihood foundations' WHERE subject_id = 11;
UPDATE subjects SET description = 'TLE — Grades 5-10; technology and livelihood' WHERE subject_id = 12;

COMMIT;
SET FOREIGN_KEY_CHECKS = 1;
