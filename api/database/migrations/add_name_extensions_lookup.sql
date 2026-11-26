-- Add the shared name-extension lookup used by employee and learner dropdowns.
-- Existing employee/learner name_extension columns remain VARCHAR values.
-- Apply enforce_name_extension_lookup_fks.sql afterward to enforce the lookup.

CREATE TABLE IF NOT EXISTS `name_extensions` (
    `extension_id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `extension_name` VARCHAR(20) NOT NULL,
    `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
    `deleted_at` DATETIME DEFAULT NULL,
    PRIMARY KEY (`extension_id`),
    UNIQUE KEY `uq_name_extensions_extension_name` (`extension_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Name extension suffix lookup for employee and learner names';

INSERT INTO `name_extensions` (`extension_name`, `is_deleted`, `deleted_at`) VALUES
    ('Jr.', 0, NULL),
    ('Sr.', 0, NULL),
    ('II', 0, NULL),
    ('III', 0, NULL),
    ('IV', 0, NULL)
ON DUPLICATE KEY UPDATE
    `is_deleted` = VALUES(`is_deleted`),
    `deleted_at` = VALUES(`deleted_at`);
