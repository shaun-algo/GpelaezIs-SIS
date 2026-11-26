-- Add dynamic SF9 observed-values encoding.
-- Additive only: creates master-data tables and per-learner quarterly ratings.

CREATE TABLE IF NOT EXISTS `observed_value_core_values` (
  `core_value_id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(40) NOT NULL,
  `core_value` varchar(100) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`core_value_id`),
  UNIQUE KEY `uq_ov_core_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `observed_value_indicators` (
  `indicator_id` int(11) NOT NULL AUTO_INCREMENT,
  `core_value_id` int(11) NOT NULL,
  `code` varchar(60) NOT NULL,
  `behavior_statement` varchar(255) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`indicator_id`),
  UNIQUE KEY `uq_ov_indicator_code` (`code`),
  KEY `idx_ov_indicator_core` (`core_value_id`),
  CONSTRAINT `fk_ov_indicator_core` FOREIGN KEY (`core_value_id`) REFERENCES `observed_value_core_values` (`core_value_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `learner_observed_values` (
  `observed_value_id` int(11) NOT NULL AUTO_INCREMENT,
  `enrollment_id` int(11) NOT NULL,
  `grading_period_id` int(11) NOT NULL,
  `indicator_id` int(11) NOT NULL,
  `rating_code` enum('AO','SO','RO','NO') DEFAULT NULL,
  `encoded_by` int(11) DEFAULT NULL,
  `encoded_at` datetime DEFAULT current_timestamp(),
  `updated_by` int(11) DEFAULT NULL,
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`observed_value_id`),
  UNIQUE KEY `uq_learner_observed_period_indicator` (`enrollment_id`,`grading_period_id`,`indicator_id`),
  KEY `idx_lov_period` (`grading_period_id`),
  KEY `idx_lov_indicator` (`indicator_id`),
  KEY `idx_lov_encoded_by` (`encoded_by`),
  KEY `idx_lov_updated_by` (`updated_by`),
  CONSTRAINT `fk_lov_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  CONSTRAINT `fk_lov_period` FOREIGN KEY (`grading_period_id`) REFERENCES `grading_periods` (`grading_period_id`),
  CONSTRAINT `fk_lov_indicator` FOREIGN KEY (`indicator_id`) REFERENCES `observed_value_indicators` (`indicator_id`),
  CONSTRAINT `fk_lov_encoded_by` FOREIGN KEY (`encoded_by`) REFERENCES `users` (`user_id`),
  CONSTRAINT `fk_lov_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `users` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `observed_value_core_values` (`code`, `core_value`, `sort_order`, `is_deleted`, `deleted_at`) VALUES
('MAKA_DIYOS', 'Maka-Diyos', 1, 0, NULL),
('MAKATAO', 'Makatao', 2, 0, NULL),
('MAKAKALIKASAN', 'Makakalikasan', 3, 0, NULL),
('MAKABANSA', 'Makabansa', 4, 0, NULL)
ON DUPLICATE KEY UPDATE
  `core_value` = VALUES(`core_value`),
  `sort_order` = VALUES(`sort_order`),
  `is_deleted` = 0,
  `deleted_at` = NULL;

INSERT INTO `observed_value_indicators` (`core_value_id`, `code`, `behavior_statement`, `sort_order`, `is_deleted`, `deleted_at`)
SELECT cv.core_value_id, seed.code, seed.behavior_statement, seed.sort_order, 0, NULL
FROM (
  SELECT 'MAKA_DIYOS' AS core_code, 'MAKA_DIYOS_1' AS code, 'Expresses one''s spiritual beliefs while respecting the spiritual beliefs of others' AS behavior_statement, 1 AS sort_order
  UNION ALL SELECT 'MAKA_DIYOS', 'MAKA_DIYOS_2', 'Shows adherence to ethical principles by upholding truth in all undertakings', 2
  UNION ALL SELECT 'MAKATAO', 'MAKATAO_1', 'Is sensitive to individual, social and cultural differences; resists stereotyping people', 3
  UNION ALL SELECT 'MAKATAO', 'MAKATAO_2', 'Demonstrates contributions toward solidarity', 4
  UNION ALL SELECT 'MAKAKALIKASAN', 'MAKAKALIKASAN_1', 'Cares for the environment and utilizes resources wisely, judiciously and economically', 5
  UNION ALL SELECT 'MAKABANSA', 'MAKABANSA_1', 'Demonstrates pride in being a Filipino; exercises the rights and responsibilities of a Filipino citizen', 6
  UNION ALL SELECT 'MAKABANSA', 'MAKABANSA_2', 'Demonstrates appropriate behavior in carrying out activities in the school, community and country', 7
) seed
JOIN `observed_value_core_values` cv ON cv.code = seed.core_code
ON DUPLICATE KEY UPDATE
  `core_value_id` = VALUES(`core_value_id`),
  `behavior_statement` = VALUES(`behavior_statement`),
  `sort_order` = VALUES(`sort_order`),
  `is_deleted` = 0,
  `deleted_at` = NULL;
