-- Keep only one live recommended action for each risk indicator.
-- When older band-specific rows conflict, retain the most severe band first.
-- Archived rows stay available in the archive; the generated unique key permits
-- multiple archived rows while allowing only one non-deleted action per indicator.

UPDATE `risk_action_rules` AS losing
JOIN `risk_action_rules` AS preferred
  ON preferred.`indicator_catalog_id` = losing.`indicator_catalog_id`
 AND preferred.`is_deleted` = 0
 AND (
      FIELD(preferred.`risk_band`, 'high', 'medium', 'low')
          < FIELD(losing.`risk_band`, 'high', 'medium', 'low')
      OR (
          FIELD(preferred.`risk_band`, 'high', 'medium', 'low')
              = FIELD(losing.`risk_band`, 'high', 'medium', 'low')
          AND preferred.`risk_action_rule_id` < losing.`risk_action_rule_id`
      )
 )
SET losing.`is_active` = 0,
    losing.`is_deleted` = 1,
    losing.`deleted_at` = COALESCE(losing.`deleted_at`, NOW())
WHERE losing.`is_deleted` = 0;

SET @risk_action_indicator_index_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'risk_action_rules'
      AND index_name = 'idx_risk_action_rules_indicator'
);
SET @risk_action_ddl = IF(
    @risk_action_indicator_index_exists = 0,
    'ALTER TABLE `risk_action_rules` ADD INDEX `idx_risk_action_rules_indicator` (`indicator_catalog_id`)',
    'SET @risk_action_noop = 1'
);
PREPARE risk_action_stmt FROM @risk_action_ddl;
EXECUTE risk_action_stmt;
DEALLOCATE PREPARE risk_action_stmt;

SET @risk_action_old_index_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'risk_action_rules'
      AND index_name = 'uq_risk_action_indicator_band'
);
SET @risk_action_ddl = IF(
    @risk_action_old_index_exists > 0,
    'ALTER TABLE `risk_action_rules` DROP INDEX `uq_risk_action_indicator_band`',
    'SET @risk_action_noop = 1'
);
PREPARE risk_action_stmt FROM @risk_action_ddl;
EXECUTE risk_action_stmt;
DEALLOCATE PREPARE risk_action_stmt;

SET @risk_action_active_column_exists = (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'risk_action_rules'
      AND column_name = 'active_indicator_catalog_id'
);
SET @risk_action_ddl = IF(
    @risk_action_active_column_exists = 0,
    'ALTER TABLE `risk_action_rules` ADD COLUMN `active_indicator_catalog_id` INT(11) GENERATED ALWAYS AS (CASE WHEN `is_deleted` = 0 THEN `indicator_catalog_id` ELSE NULL END) PERSISTENT',
    'SET @risk_action_noop = 1'
);
PREPARE risk_action_stmt FROM @risk_action_ddl;
EXECUTE risk_action_stmt;
DEALLOCATE PREPARE risk_action_stmt;

SET @risk_action_active_index_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'risk_action_rules'
      AND index_name = 'uq_risk_action_indicator_active'
);
SET @risk_action_ddl = IF(
    @risk_action_active_index_exists = 0,
    'ALTER TABLE `risk_action_rules` ADD UNIQUE INDEX `uq_risk_action_indicator_active` (`active_indicator_catalog_id`)',
    'SET @risk_action_noop = 1'
);
PREPARE risk_action_stmt FROM @risk_action_ddl;
EXECUTE risk_action_stmt;
DEALLOCATE PREPARE risk_action_stmt;
