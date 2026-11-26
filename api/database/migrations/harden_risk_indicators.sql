-- Migration: Harden risk_indicators against unbounded growth and duplicates
-- Notes:
-- - risk_indicators are derived, so we can safely purge soft-deleted history.
-- - Adds a uniqueness rule to prevent duplicates per assessment.

-- 1) Purge soft-deleted duplicates (prevents table bloat from reassessment loops)
DELETE FROM risk_indicators WHERE is_deleted = 1;

-- 2) Ensure no duplicate active rows exist before adding UNIQUE key
DELETE ri1 FROM risk_indicators ri1
JOIN risk_indicators ri2
  ON ri1.risk_assessment_id = ri2.risk_assessment_id
 AND ri1.indicator_type = ri2.indicator_type
 AND ri1.indicator_id < ri2.indicator_id
WHERE ri1.is_deleted = 0 AND ri2.is_deleted = 0;

-- 3) Add UNIQUE key if missing (MariaDB/MySQL compatible)
SET @has_uq := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'risk_indicators'
    AND index_name = 'uq_ri_assessment_type'
);
SET @sql_add_uq := IF(
  @has_uq = 0,
  'ALTER TABLE risk_indicators ADD UNIQUE KEY uq_ri_assessment_type (risk_assessment_id, indicator_type)',
  'SELECT 1'
);
PREPARE stmt_add_uq FROM @sql_add_uq;
EXECUTE stmt_add_uq;
DEALLOCATE PREPARE stmt_add_uq;
