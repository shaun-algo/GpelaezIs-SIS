-- Returnee / Balik-Aral import workflow.
-- Additive and repeatable. Apply to the school database only after taking a backup.

START TRANSACTION;

ALTER TABLE enrollments
  ADD COLUMN IF NOT EXISTS entry_classification varchar(32) DEFAULT NULL
    COMMENT 'Import classification: New, Promote, Returnee, Transfer-In';

ALTER TABLE sf1_import_staging
  ADD COLUMN IF NOT EXISTS detected_entry_classification varchar(32) DEFAULT NULL;

COMMIT;
