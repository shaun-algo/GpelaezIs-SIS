-- Restore active Intervention Statuses masterfile backing table.
-- The interventions table still stores status as an enum; this lookup table
-- supports the admin reference-data CRUD page.

CREATE TABLE IF NOT EXISTS `intervention_statuses` (
    `intervention_status_id` INT(11) NOT NULL AUTO_INCREMENT,
    `status_name` VARCHAR(50) NOT NULL,
    `description` VARCHAR(150) DEFAULT NULL,
    `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
    `deleted_at` DATETIME DEFAULT NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`intervention_status_id`),
    UNIQUE KEY `uq_intervention_status_name_active` (`status_name`, `is_deleted`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `intervention_statuses` (`status_name`, `description`)
SELECT seed.status_name, seed.description
FROM (
    SELECT 'Pending' AS status_name, 'Intervention is planned or awaiting action.' AS description
    UNION ALL SELECT 'Ongoing', 'Intervention is currently in progress.'
    UNION ALL SELECT 'Resolved', 'Concern has been addressed.'
    UNION ALL SELECT 'Escalated', 'Concern has been escalated for additional support.'
) seed
WHERE NOT EXISTS (
    SELECT 1
    FROM `intervention_statuses` existing
    WHERE existing.status_name = seed.status_name
      AND existing.is_deleted = 0
);
