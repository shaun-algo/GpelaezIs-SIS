-- Subject masterfile categories for the K to 10 / MATATAG curriculum.
-- The category is a normalized lookup value. Curriculum learning areas remain
-- a separate per-curriculum configuration used by report-card displays.

CREATE TABLE IF NOT EXISTS `subject_categories` (
    `subject_category_id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `category_code` VARCHAR(60) NOT NULL,
    `category_name` VARCHAR(150) NOT NULL,
    `description` VARCHAR(255) DEFAULT NULL,
    `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `is_active` TINYINT(1) NOT NULL DEFAULT 1,
    `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
    `deleted_at` DATETIME DEFAULT NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`subject_category_id`),
    UNIQUE KEY `uq_subject_categories_code` (`category_code`),
    UNIQUE KEY `uq_subject_categories_name` (`category_name`),
    KEY `idx_subject_categories_active` (`is_active`, `is_deleted`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Normalized subject category lookup for curriculum setup';

INSERT INTO `subject_categories`
    (`category_code`, `category_name`, `description`, `sort_order`, `is_active`, `is_deleted`, `deleted_at`)
VALUES
    ('FOUNDATIONAL_CORE', 'Foundational / Core Subject Areas', 'Filipino, English, Mathematics, and Science.', 1, 1, 0, NULL),
    ('VALUES_CULTURAL', 'Values and Cultural Subjects', 'GMRC or Values Education and Makabansa.', 2, 1, 0, NULL),
    ('SPECIALIZED_MULTIDISCIPLINARY', 'Specialized / Multidisciplinary Areas', 'Araling Panlipunan, TLE, and MAPEH-related subjects.', 3, 1, 0, NULL)
ON DUPLICATE KEY UPDATE
    `is_active` = 1,
    `is_deleted` = 0,
    `deleted_at` = NULL;

ALTER TABLE `subjects`
    ADD COLUMN IF NOT EXISTS `subject_category_id` INT UNSIGNED NULL
        COMMENT 'FK to subject_categories; broad masterfile grouping' AFTER `description`;

CREATE INDEX IF NOT EXISTS `idx_subjects_category`
    ON `subjects` (`subject_category_id`);

SET @subject_category_fk_exists := (
    SELECT COUNT(*)
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'subjects'
      AND CONSTRAINT_NAME = 'fk_subjects_category'
);
SET @subject_category_fk_sql := IF(
    @subject_category_fk_exists = 0,
    'ALTER TABLE `subjects` ADD CONSTRAINT `fk_subjects_category` FOREIGN KEY (`subject_category_id`) REFERENCES `subject_categories` (`subject_category_id`) ON DELETE SET NULL ON UPDATE CASCADE',
    'SELECT 1'
);
PREPARE subject_category_fk_stmt FROM @subject_category_fk_sql;
EXECUTE subject_category_fk_stmt;
DEALLOCATE PREPARE subject_category_fk_stmt;

-- Backfill the current subject seeds. New custom subjects can be classified
-- from the Subject masterlist; the API also infers a canonical category when
-- a legacy curriculum quick-create request does not send one.
UPDATE `subjects` s
JOIN `subject_categories` c
  ON c.`category_code` = CASE
    WHEN LOWER(s.`subject_name`) REGEXP 'filipino|english|mother tongue|reading|language|mathematics|(^|[^a-z])math([^a-z]|$)|science'
      THEN 'FOUNDATIONAL_CORE'
    WHEN LOWER(s.`subject_name`) REGEXP 'gmrc|good manners|right conduct|values education|edukasyon sa pagpapakatao|makabansa'
      THEN 'VALUES_CULTURAL'
    WHEN LOWER(s.`subject_name`) REGEXP 'araling panlipunan|social studies|(^|[^a-z])ap([^a-z]|$)|epp|tle|technology|livelihood|mapeh|music|arts|physical education|(^|[^a-z])p\.e\.([^a-z]|$)|(^|[^a-z])pe([^a-z]|$)|health'
      THEN 'SPECIALIZED_MULTIDISCIPLINARY'
    ELSE ''
  END
SET s.`subject_category_id` = c.`subject_category_id`
WHERE s.`is_deleted` = 0
  AND s.`subject_category_id` IS NULL;
