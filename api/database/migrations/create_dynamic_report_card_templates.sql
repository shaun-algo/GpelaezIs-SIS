-- Versioned, schema-driven report-card templates.
-- The schema is intentionally stored as LONGTEXT instead of a native JSON
-- column so this migration remains compatible with older MariaDB installs.

CREATE TABLE IF NOT EXISTS `report_card_templates` (
  `template_id` int(11) NOT NULL AUTO_INCREMENT,
  `template_code` varchar(80) NOT NULL,
  `template_name` varchar(180) NOT NULL,
  `grade_scope` varchar(40) NOT NULL DEFAULT 'all',
  `grading_mode` varchar(30) NOT NULL DEFAULT 'Numeric',
  `version_no` int(11) NOT NULL DEFAULT 1,
  `status` varchar(20) NOT NULL DEFAULT 'Draft',
  `schema_json` longtext NOT NULL,
  `created_by` int(11) DEFAULT NULL,
  `updated_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`template_id`),
  UNIQUE KEY `uq_report_card_template_version` (`template_code`, `version_no`),
  KEY `idx_report_card_template_status` (`status`, `is_deleted`),
  KEY `idx_report_card_template_scope` (`grade_scope`, `grading_mode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Versioned dynamic report-card template schemas';

CREATE TABLE IF NOT EXISTS `report_card_template_assignments` (
  `assignment_id` int(11) NOT NULL AUTO_INCREMENT,
  `school_year_id` int(11) NOT NULL,
  `grade_level_id` int(11) NOT NULL,
  `template_id` int(11) NOT NULL,
  `assigned_by` int(11) DEFAULT NULL,
  `assigned_at` datetime NOT NULL DEFAULT current_timestamp(),
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`assignment_id`),
  UNIQUE KEY `uq_report_card_template_assignment` (`school_year_id`, `grade_level_id`),
  KEY `idx_report_card_template_assignment_template` (`template_id`),
  CONSTRAINT `fk_report_card_template_assignment_school_year`
    FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`),
  CONSTRAINT `fk_report_card_template_assignment_template`
    FOREIGN KEY (`template_id`) REFERENCES `report_card_templates` (`template_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='School-year and grade-level template assignments';

INSERT INTO `report_card_templates`
  (`template_code`, `template_name`, `grade_scope`, `grading_mode`, `version_no`, `status`, `schema_json`)
VALUES
  (
    'SF9-G1-DYNAMIC',
    'SF9 Grade 1 Descriptive v1',
    '1',
    'Descriptive',
    1,
    'Published',
    '{"schema_version":1,"mode":"Descriptive","indicator":{"key":"descriptor","label":"Grade Indicator","type":"enum","values":["A","B","C","D","E"]},"columns":[{"key":"periods","label":"Term","type":"period","source":"grading_periods"}],"rows":[{"key":"reading","label":"Reading and Literacy","binding":"reading","type":"learning_area"},{"key":"language","label":"Language","binding":"language","type":"learning_area"},{"key":"mathematics","label":"Mathematics","binding":"mathematics","type":"learning_area"},{"key":"gmrc","label":"Good Manners and Right Conduct","binding":"gmrc","type":"learning_area"},{"key":"makabansa","label":"Makabansa","binding":"makabansa","type":"learning_area"}],"options":{"show_general_average":false}}'
  ),
  (
    'SF9-G2-DYNAMIC',
    'SF9 Grade 2 Numeric v1',
    '2',
    'Numeric',
    1,
    'Published',
    '{"schema_version":1,"mode":"Numeric","indicator":{"key":"numeric","label":"Numeric Grade","type":"numeric","min":60,"max":100},"columns":[{"key":"periods","label":"Term","type":"period","source":"grading_periods"},{"key":"final_grade","label":"Final Grade","type":"computed","source":"final_grade"},{"key":"remarks","label":"Remarks","type":"computed","source":"remarks"}],"rows":[{"key":"filipino","label":"Filipino","binding":"filipino","type":"learning_area"},{"key":"english","label":"English","binding":"english","type":"learning_area"},{"key":"mathematics","label":"Mathematics","binding":"mathematics","type":"learning_area"},{"key":"gmrc","label":"GMRC / Values Education","binding":"gmrc","type":"learning_area"},{"key":"makabansa","label":"Makabansa","binding":"makabansa","type":"learning_area"}],"options":{"show_general_average":true}}'
  ),
  (
    'SF9-G4-10-DYNAMIC',
    'SF9 Grade 4-10 Numeric v1',
    '4-10',
    'Numeric',
    1,
    'Published',
    '{"schema_version":1,"mode":"Numeric","indicator":{"key":"numeric","label":"Numeric Grade","type":"numeric","min":60,"max":100},"columns":[{"key":"periods","label":"Term","type":"period","source":"grading_periods"},{"key":"final_grade","label":"Final Grade","type":"computed","source":"final_grade"},{"key":"remarks","label":"Remarks","type":"computed","source":"remarks"}],"rows":[{"key":"filipino","label":"Filipino","binding":"filipino","type":"learning_area"},{"key":"english","label":"English","binding":"english","type":"learning_area"},{"key":"mathematics","label":"Mathematics","binding":"mathematics","type":"learning_area"},{"key":"science","label":"Science","binding":"science","type":"learning_area"},{"key":"araling_pampanlipunan","label":"Araling Panlipunan","binding":"araling panlipunan","type":"learning_area"},{"key":"gmrc","label":"GMRC / Values Education","binding":"gmrc","type":"learning_area"},{"key":"epp_tle","label":"EPP / TLE","binding":"epp","type":"learning_area"},{"key":"mapeh","label":"MAPEH","binding":"mapeh","type":"group"},{"key":"music_arts","label":"Music and Arts","binding":"music and arts","type":"learning_area"},{"key":"pe_health","label":"Physical Education and Health","binding":"physical education and health","type":"learning_area"}],"options":{"show_general_average":true}}'
  )
ON DUPLICATE KEY UPDATE
  `template_name` = VALUES(`template_name`),
  `grade_scope` = VALUES(`grade_scope`),
  `grading_mode` = VALUES(`grading_mode`),
  `status` = VALUES(`status`),
  `schema_json` = VALUES(`schema_json`),
  `is_deleted` = 0,
  `deleted_at` = NULL;
