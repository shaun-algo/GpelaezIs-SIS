-- Admin-managed recommended actions keyed to the supported risk indicators.
-- Safe to apply more than once.

CREATE TABLE IF NOT EXISTS `risk_indicator_catalog` (
    `indicator_catalog_id` INT(11) NOT NULL AUTO_INCREMENT,
    `indicator_code` VARCHAR(100) NOT NULL,
    `indicator_name` VARCHAR(150) NOT NULL,
    `category` VARCHAR(50) NOT NULL DEFAULT 'Academic',
    `is_fallback` TINYINT(1) NOT NULL DEFAULT 0,
    `is_active` TINYINT(1) NOT NULL DEFAULT 1,
    `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
    `deleted_at` DATETIME DEFAULT NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`indicator_catalog_id`),
    UNIQUE KEY `uq_risk_indicator_catalog_code` (`indicator_code`),
    KEY `idx_risk_indicator_catalog_active` (`is_active`, `is_deleted`, `category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `risk_action_rules` (
    `risk_action_rule_id` INT(11) NOT NULL AUTO_INCREMENT,
    `indicator_catalog_id` INT(11) NOT NULL,
    `risk_band` ENUM('low','medium','high') NOT NULL,
    `recommended_action` TEXT NOT NULL,
    `is_active` TINYINT(1) NOT NULL DEFAULT 1,
    `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
    `active_indicator_catalog_id` INT(11) GENERATED ALWAYS AS (
        CASE WHEN `is_deleted` = 0 THEN `indicator_catalog_id` ELSE NULL END
    ) PERSISTENT,
    `deleted_at` DATETIME DEFAULT NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`risk_action_rule_id`),
    UNIQUE KEY `uq_risk_action_indicator_active` (`active_indicator_catalog_id`),
    KEY `idx_risk_action_rules_indicator` (`indicator_catalog_id`),
    KEY `idx_risk_action_rules_active` (`risk_band`, `is_active`, `is_deleted`),
    CONSTRAINT `fk_risk_action_rules_indicator`
        FOREIGN KEY (`indicator_catalog_id`) REFERENCES `risk_indicator_catalog` (`indicator_catalog_id`)
        ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT IGNORE INTO `risk_indicator_catalog`
    (`indicator_code`, `indicator_name`, `category`, `is_fallback`)
VALUES
    ('Chronic Absence', 'Chronic Absence', 'Attendance', 0),
    ('Frequent Absence', 'Frequent Absence', 'Attendance', 0),
    ('Attendance Rate Below Threshold', 'Attendance Rate Below Threshold', 'Attendance', 0),
    ('Repeated Tardiness', 'Repeated Tardiness', 'Attendance', 0),
    ('No Encoded Grades', 'No Encoded Grades', 'Academic', 0),
    ('Incomplete Grades', 'Incomplete Grades', 'Academic', 0),
    ('2 or More Failing Subjects', '2 or More Failing Subjects', 'Academic', 0),
    ('1 Failing Subject', '1 Failing Subject', 'Academic', 0),
    ('Lowest Grade Below Passing', 'Lowest Grade Below Passing', 'Academic', 0),
    ('Period Average Below Passing', 'Period Average Below Passing', 'Academic', 0),
    ('Low General Average', 'Low General Average', 'Academic', 0),
    ('Failed Subject Final Grade', 'Failed Subject Final Grade', 'Academic', 0),
    ('Sudden Grade Drop', 'Sudden Grade Drop', 'Academic Trend', 0),
    ('__DEFAULT__', 'General fallback (no specific indicator match)', 'General', 1);

-- Seed the current hard-coded guidance without overwriting later admin edits.
INSERT IGNORE INTO `risk_action_rules`
    (`indicator_catalog_id`, `risk_band`, `recommended_action`)
SELECT c.indicator_catalog_id, seed.risk_band, seed.recommended_action
FROM (
    SELECT 'Chronic Absence' AS indicator_code, 'high' AS risk_band,
           'Urgent: convene adviser/parent conference, provide attendance coaching, and refer to guidance counselor.' AS recommended_action
    UNION ALL SELECT 'Frequent Absence', 'medium',
           'Needs Proper Monitoring and Teacher Support.'
    UNION ALL SELECT 'Repeated Tardiness', 'high',
           'Urgent: convene adviser/parent conference, provide attendance coaching, and refer to guidance counselor.'
    UNION ALL SELECT 'No Encoded Grades', 'low',
           'Continue the Academic Flow'
    UNION ALL SELECT 'Incomplete Grades', 'low',
           'The Assigned Teacher must begin the grade input for the term'
    UNION ALL SELECT '2 or More Failing Subjects', 'high',
           'Urgent: subject remediation, peer tutoring, and individualized learning plan.'
    UNION ALL SELECT '1 Failing Subject', 'high',
           'Urgent: subject remediation, peer tutoring, and individualized learning plan.'
    UNION ALL SELECT 'Sudden Grade Drop', 'high',
           'Urgent: academic coaching and close progress monitoring every week.'
    UNION ALL SELECT 'Low General Average', 'high',
           'Urgent: academic coaching and close progress monitoring every week.'
    UNION ALL SELECT 'Failed Subject Final Grade', 'high',
           'The Learner Requires Parent Consultation'
    UNION ALL SELECT 'Attendance Rate Below Threshold', 'medium',
           'Monitor attendance closely; notify parents and implement attendance contract.'
    UNION ALL SELECT 'Lowest Grade Below Passing', 'medium',
           'Schedule remedial sessions and retakes; monitor next period closely.'
    UNION ALL SELECT 'Period Average Below Passing', 'high',
           'This Learner Should Have proper monitoring in all Academic Component Layer Such as Grades per Subjects and Performances.'
    UNION ALL SELECT '__DEFAULT__', 'high',
           'Urgent: multi-faceted intervention by adviser, parents, and guidance counselor.'
) seed
JOIN `risk_indicator_catalog` c ON c.indicator_code = seed.indicator_code
WHERE NOT EXISTS (
    SELECT 1
    FROM `risk_action_rules` existing
    WHERE existing.`indicator_catalog_id` = c.`indicator_catalog_id`
);
