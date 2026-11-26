-- Transfer-In support for settled learners received from another school.
-- Additive and repeatable. Apply after taking a database backup.

START TRANSACTION;

ALTER TABLE enrollments
  ADD COLUMN IF NOT EXISTS entry_classification varchar(32) DEFAULT NULL
    COMMENT 'Import classification: New, Promote, Returnee, Transfer-In';

ALTER TABLE sf1_import_staging
  ADD COLUMN IF NOT EXISTS detected_entry_classification varchar(32) DEFAULT NULL;

INSERT INTO enrollment_types (type_name, description, is_deleted)
SELECT 'Transfer-In', 'Learner received from another school', 0
WHERE NOT EXISTS (
    SELECT 1 FROM enrollment_types
    WHERE LOWER(type_name) IN ('transfer-in', 'transfer in', 'transferred in')
      AND is_deleted = 0
);

INSERT INTO sf1_remark_map (raw_remark, learner_status, enrollment_status, enrollment_type_name)
VALUES
    ('transfer-in', 'Enrolled', 'Enrolled', 'Transfer-In'),
    ('transfer in', 'Enrolled', 'Enrolled', 'Transfer-In'),
    ('transferred in', 'Enrolled', 'Enrolled', 'Transfer-In'),
    ('transferred-in', 'Enrolled', 'Enrolled', 'Transfer-In'),
    ('t/i', 'Enrolled', 'Enrolled', 'Transfer-In'),
    ('ti', 'Enrolled', 'Enrolled', 'Transfer-In')
ON DUPLICATE KEY UPDATE
    learner_status = VALUES(learner_status),
    enrollment_status = VALUES(enrollment_status),
    enrollment_type_name = VALUES(enrollment_type_name);

COMMIT;
