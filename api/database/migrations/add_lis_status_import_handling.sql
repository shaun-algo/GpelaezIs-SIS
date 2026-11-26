-- Source-authoritative LIS/SF1 status handling.
-- External enrollment documents and previous-school grade requirements are
-- resolved before import. This migration only persists the source status and
-- the resulting local operational state.
-- Additive and repeatable. Apply after a protected database backup.

START TRANSACTION;

ALTER TABLE learners
  ADD COLUMN IF NOT EXISTS is_lwd TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Beginning-of-school-year Learner with Disability identifier from the source record'
    AFTER is_indigenous;

ALTER TABLE sf1_import_staging
  ADD COLUMN IF NOT EXISTS detected_lwd TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Source LWD flag resolved during import validation'
    AFTER detected_entry_classification;

INSERT INTO enrollment_types (type_name, description, is_deleted)
SELECT 'Transfer-In', 'Learner received from another school', 0
WHERE NOT EXISTS (
    SELECT 1 FROM enrollment_types
    WHERE LOWER(type_name) IN ('transfer-in', 'transfer in', 'transferred in')
      AND is_deleted = 0
);

INSERT INTO enrollment_types (type_name, description, is_deleted)
SELECT 'Balik-Aral', 'Learner returning to formal schooling', 0
WHERE NOT EXISTS (
    SELECT 1 FROM enrollment_types
    WHERE LOWER(type_name) IN ('balik-aral', 'balik aral')
      AND is_deleted = 0
);

INSERT INTO sf1_remark_map (raw_remark, learner_status, enrollment_status, enrollment_type_name)
VALUES
    ('transfer-in', 'Enrolled', 'Enrolled', 'Transfer-In'),
    ('transfer in', 'Enrolled', 'Enrolled', 'Transfer-In'),
    ('transferred in', 'Enrolled', 'Enrolled', 'Transfer-In'),
    ('transferred-in', 'Enrolled', 'Enrolled', 'Transfer-In'),
    ('t/i', 'Enrolled', 'Enrolled', 'Transfer-In'),
    ('ti', 'Enrolled', 'Enrolled', 'Transfer-In'),
    ('balik-aral', 'Enrolled', 'Enrolled', 'Balik-Aral'),
    ('balik aral', 'Enrolled', 'Enrolled', 'Balik-Aral'),
    ('ba', 'Enrolled', 'Enrolled', 'Balik-Aral'),
    ('b/a', 'Enrolled', 'Enrolled', 'Balik-Aral'),
    ('transferred out', 'Transferred Out', 'Transferred Out', NULL),
    ('transferred-out', 'Transferred Out', 'Transferred Out', NULL),
    ('t/o', 'Transferred Out', 'Transferred Out', NULL),
    ('dropped out', 'Dropped', 'Dropped', NULL),
    ('dropped', 'Dropped', 'Dropped', NULL),
    ('drp', 'Dropped', 'Dropped', NULL),
    ('late enrollment', 'Enrolled', 'Enrolled', NULL),
    ('late-enrollment', 'Enrolled', 'Enrolled', NULL),
    ('late enrollee', 'Enrolled', 'Enrolled', NULL),
    ('late enrolled', 'Enrolled', 'Enrolled', NULL)
ON DUPLICATE KEY UPDATE
    learner_status = VALUES(learner_status),
    enrollment_status = VALUES(enrollment_status),
    enrollment_type_name = VALUES(enrollment_type_name);

COMMIT;
