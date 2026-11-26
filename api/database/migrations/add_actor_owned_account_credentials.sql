-- Migration: Add actor-owned account credential fields
-- Purpose:
-- - Move the database design toward account credentials owned by employees and learners.
-- - Preserve the legacy users table during the transition so the current application layer keeps working.
-- - Copy existing credentials into employees/learners and place unlinked legacy users in system_accounts.
--
-- Safe to rerun: column, index, constraint, table, view, and procedure creation are guarded.

DROP PROCEDURE IF EXISTS deped_add_column_if_missing;
DELIMITER $$
CREATE PROCEDURE deped_add_column_if_missing(
    IN p_table_name VARCHAR(64),
    IN p_column_name VARCHAR(64),
    IN p_column_definition TEXT
)
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = p_table_name
          AND column_name = p_column_name
    ) THEN
        SET @ddl := CONCAT('ALTER TABLE `', p_table_name, '` ADD COLUMN ', p_column_definition);
        PREPARE stmt FROM @ddl;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS deped_add_index_if_missing;
DELIMITER $$
CREATE PROCEDURE deped_add_index_if_missing(
    IN p_table_name VARCHAR(64),
    IN p_index_name VARCHAR(64),
    IN p_index_definition TEXT
)
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = p_table_name
          AND index_name = p_index_name
    ) THEN
        SET @ddl := CONCAT('ALTER TABLE `', p_table_name, '` ADD ', p_index_definition);
        PREPARE stmt FROM @ddl;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS deped_add_fk_if_missing;
DELIMITER $$
CREATE PROCEDURE deped_add_fk_if_missing(
    IN p_table_name VARCHAR(64),
    IN p_constraint_name VARCHAR(64),
    IN p_constraint_definition TEXT
)
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_schema = DATABASE()
          AND table_name = p_table_name
          AND constraint_name = p_constraint_name
    ) THEN
        SET @ddl := CONCAT('ALTER TABLE `', p_table_name, '` ADD CONSTRAINT `', p_constraint_name, '` ', p_constraint_definition);
        PREPARE stmt FROM @ddl;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$
DELIMITER ;

CALL deped_add_column_if_missing('employees', 'username', '`username` varchar(100) DEFAULT NULL AFTER `employee_number`');
CALL deped_add_column_if_missing('employees', 'password', '`password` varchar(255) DEFAULT NULL AFTER `username`');
CALL deped_add_column_if_missing('employees', 'must_change_password', '`must_change_password` tinyint(1) NOT NULL DEFAULT 1 COMMENT "Force change of the auto-generated default on first login" AFTER `password`');
CALL deped_add_column_if_missing('employees', 'password_updated_at', '`password_updated_at` datetime DEFAULT NULL AFTER `must_change_password`');
CALL deped_add_column_if_missing('employees', 'failed_login_count', '`failed_login_count` int(11) NOT NULL DEFAULT 0 AFTER `password_updated_at`');
CALL deped_add_column_if_missing('employees', 'locked_until', '`locked_until` datetime DEFAULT NULL AFTER `failed_login_count`');
CALL deped_add_column_if_missing('employees', 'role_id', '`role_id` int(11) DEFAULT NULL AFTER `locked_until`');
CALL deped_add_column_if_missing('employees', 'is_active', '`is_active` tinyint(1) DEFAULT 1 AFTER `role_id`');
CALL deped_add_column_if_missing('employees', 'last_login', '`last_login` datetime DEFAULT NULL AFTER `is_active`');
CALL deped_add_column_if_missing('employees', 'account_created_at', '`account_created_at` datetime DEFAULT NULL AFTER `last_login`');

CALL deped_add_column_if_missing('learners', 'username', '`username` varchar(100) DEFAULT NULL AFTER `lrn`');
CALL deped_add_column_if_missing('learners', 'password', '`password` varchar(255) DEFAULT NULL AFTER `username`');
CALL deped_add_column_if_missing('learners', 'must_change_password', '`must_change_password` tinyint(1) NOT NULL DEFAULT 1 COMMENT "Force change of the auto-generated default on first login" AFTER `password`');
CALL deped_add_column_if_missing('learners', 'password_updated_at', '`password_updated_at` datetime DEFAULT NULL AFTER `must_change_password`');
CALL deped_add_column_if_missing('learners', 'failed_login_count', '`failed_login_count` int(11) NOT NULL DEFAULT 0 AFTER `password_updated_at`');
CALL deped_add_column_if_missing('learners', 'locked_until', '`locked_until` datetime DEFAULT NULL AFTER `failed_login_count`');
CALL deped_add_column_if_missing('learners', 'role_id', '`role_id` int(11) DEFAULT NULL AFTER `locked_until`');
CALL deped_add_column_if_missing('learners', 'is_active', '`is_active` tinyint(1) DEFAULT 1 AFTER `role_id`');
CALL deped_add_column_if_missing('learners', 'last_login', '`last_login` datetime DEFAULT NULL AFTER `is_active`');
CALL deped_add_column_if_missing('learners', 'account_created_at', '`account_created_at` datetime DEFAULT NULL AFTER `last_login`');

UPDATE employees e
JOIN users u ON u.user_id = e.user_id
SET e.username = u.username,
    e.password = u.password,
    e.must_change_password = COALESCE(u.must_change_password, 1),
    e.password_updated_at = u.password_updated_at,
    e.failed_login_count = COALESCE(u.failed_login_count, 0),
    e.locked_until = u.locked_until,
    e.role_id = u.role_id,
    e.is_active = u.is_active,
    e.last_login = u.last_login,
    e.account_created_at = u.created_at;

UPDATE learners l
JOIN users u ON u.user_id = l.user_id
SET l.username = u.username,
    l.password = u.password,
    l.must_change_password = COALESCE(u.must_change_password, 1),
    l.password_updated_at = u.password_updated_at,
    l.failed_login_count = COALESCE(u.failed_login_count, 0),
    l.locked_until = u.locked_until,
    l.role_id = u.role_id,
    l.is_active = u.is_active,
    l.last_login = u.last_login,
    l.account_created_at = u.created_at;

CREATE TABLE IF NOT EXISTS system_accounts (
    system_account_id int(11) NOT NULL AUTO_INCREMENT,
    legacy_user_id int(11) DEFAULT NULL,
    username varchar(100) NOT NULL,
    password varchar(255) NOT NULL,
    must_change_password tinyint(1) NOT NULL DEFAULT 1 COMMENT 'Force change of the auto-generated default on first login',
    password_updated_at datetime DEFAULT NULL,
    failed_login_count int(11) NOT NULL DEFAULT 0,
    locked_until datetime DEFAULT NULL,
    role_id int(11) NOT NULL,
    is_active tinyint(1) DEFAULT 1,
    last_login datetime DEFAULT NULL,
    purpose varchar(150) DEFAULT 'Legacy or automation account',
    created_at datetime DEFAULT current_timestamp(),
    updated_at datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
    is_deleted tinyint(1) DEFAULT 0,
    deleted_at datetime DEFAULT NULL,
    PRIMARY KEY (system_account_id),
    UNIQUE KEY uq_system_account_legacy_user (legacy_user_id),
    UNIQUE KEY uq_system_account_username (username),
    KEY idx_system_account_role (role_id),
    CONSTRAINT fk_system_account_legacy_user FOREIGN KEY (legacy_user_id) REFERENCES users (user_id),
    CONSTRAINT fk_system_account_role FOREIGN KEY (role_id) REFERENCES roles (role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Non-employee/non-learner accounts for system administration and automation';

INSERT INTO system_accounts (
    legacy_user_id,
    username,
    password,
    must_change_password,
    password_updated_at,
    failed_login_count,
    locked_until,
    role_id,
    is_active,
    last_login,
    purpose,
    created_at,
    updated_at,
    is_deleted,
    deleted_at
)
SELECT u.user_id,
       u.username,
       u.password,
       COALESCE(u.must_change_password, 1),
       u.password_updated_at,
       COALESCE(u.failed_login_count, 0),
       u.locked_until,
       u.role_id,
       u.is_active,
       u.last_login,
       CASE
           WHEN LOWER(COALESCE(r.role_name, '')) LIKE '%admin%' THEN 'System administrator account'
           ELSE 'Legacy account without employee or learner profile'
       END,
       u.created_at,
       u.updated_at,
       u.is_deleted,
       u.deleted_at
FROM users u
LEFT JOIN roles r ON r.role_id = u.role_id
LEFT JOIN employees e ON e.user_id = u.user_id
LEFT JOIN learners l ON l.user_id = u.user_id
WHERE e.employee_id IS NULL
  AND l.learner_id IS NULL
ON DUPLICATE KEY UPDATE
    username = VALUES(username),
    password = VALUES(password),
    must_change_password = VALUES(must_change_password),
    password_updated_at = VALUES(password_updated_at),
    failed_login_count = VALUES(failed_login_count),
    locked_until = VALUES(locked_until),
    role_id = VALUES(role_id),
    is_active = VALUES(is_active),
    last_login = VALUES(last_login),
    purpose = VALUES(purpose),
    updated_at = VALUES(updated_at),
    is_deleted = VALUES(is_deleted),
    deleted_at = VALUES(deleted_at);

CALL deped_add_index_if_missing('employees', 'uq_employee_username', 'UNIQUE KEY `uq_employee_username` (`username`)');
CALL deped_add_index_if_missing('employees', 'idx_employee_account_role', 'KEY `idx_employee_account_role` (`role_id`)');
CALL deped_add_index_if_missing('learners', 'uq_learner_username', 'UNIQUE KEY `uq_learner_username` (`username`)');
CALL deped_add_index_if_missing('learners', 'idx_learner_account_role', 'KEY `idx_learner_account_role` (`role_id`)');

CALL deped_add_fk_if_missing('employees', 'fk_employee_account_role', 'FOREIGN KEY (`role_id`) REFERENCES `roles` (`role_id`)');
CALL deped_add_fk_if_missing('learners', 'fk_learner_account_role', 'FOREIGN KEY (`role_id`) REFERENCES `roles` (`role_id`)');

CREATE OR REPLACE VIEW account_credentials_v AS
SELECT 'employee' AS account_type,
       e.employee_id AS actor_id,
       e.user_id AS legacy_user_id,
       e.username,
       e.password,
       e.must_change_password,
       e.password_updated_at,
       e.failed_login_count,
       e.locked_until,
       e.role_id,
       r.role_name,
       e.is_active,
       e.last_login,
       e.is_deleted,
       e.deleted_at
FROM employees e
LEFT JOIN roles r ON r.role_id = e.role_id
WHERE e.username IS NOT NULL
UNION ALL
SELECT 'learner' AS account_type,
       l.learner_id AS actor_id,
       l.user_id AS legacy_user_id,
       l.username,
       l.password,
       l.must_change_password,
       l.password_updated_at,
       l.failed_login_count,
       l.locked_until,
       l.role_id,
       r.role_name,
       l.is_active,
       l.last_login,
       l.is_deleted,
       l.deleted_at
FROM learners l
LEFT JOIN roles r ON r.role_id = l.role_id
WHERE l.username IS NOT NULL
UNION ALL
SELECT 'system' AS account_type,
       sa.system_account_id AS actor_id,
       sa.legacy_user_id,
       sa.username,
       sa.password,
       sa.must_change_password,
       sa.password_updated_at,
       sa.failed_login_count,
       sa.locked_until,
       sa.role_id,
       r.role_name,
       sa.is_active,
       sa.last_login,
       sa.is_deleted,
       sa.deleted_at
FROM system_accounts sa
LEFT JOIN roles r ON r.role_id = sa.role_id
WHERE sa.username IS NOT NULL;

DROP PROCEDURE IF EXISTS validate_actor_account_credentials;
DELIMITER $$
CREATE PROCEDURE validate_actor_account_credentials()
BEGIN
    SELECT 'employee_accounts_missing_credentials' AS check_name,
           COUNT(*) AS issue_count
    FROM employees e
    JOIN users u ON u.user_id = e.user_id
    WHERE e.username IS NULL
       OR e.password IS NULL
       OR e.role_id IS NULL
    UNION ALL
    SELECT 'learner_accounts_missing_credentials' AS check_name,
           COUNT(*) AS issue_count
    FROM learners l
    JOIN users u ON u.user_id = l.user_id
    WHERE l.username IS NULL
       OR l.password IS NULL
       OR l.role_id IS NULL
    UNION ALL
    SELECT 'employee_credential_mismatches' AS check_name,
           COUNT(*) AS issue_count
    FROM employees e
    JOIN users u ON u.user_id = e.user_id
    WHERE NOT (
        e.username <=> u.username
        AND e.password <=> u.password
        AND e.role_id <=> u.role_id
        AND e.is_active <=> u.is_active
        AND e.must_change_password <=> u.must_change_password
        AND e.password_updated_at <=> u.password_updated_at
        AND e.failed_login_count <=> u.failed_login_count
        AND e.locked_until <=> u.locked_until
        AND e.last_login <=> u.last_login
    )
    UNION ALL
    SELECT 'learner_credential_mismatches' AS check_name,
           COUNT(*) AS issue_count
    FROM learners l
    JOIN users u ON u.user_id = l.user_id
    WHERE NOT (
        l.username <=> u.username
        AND l.password <=> u.password
        AND l.role_id <=> u.role_id
        AND l.is_active <=> u.is_active
        AND l.must_change_password <=> u.must_change_password
        AND l.password_updated_at <=> u.password_updated_at
        AND l.failed_login_count <=> u.failed_login_count
        AND l.locked_until <=> u.locked_until
        AND l.last_login <=> u.last_login
    )
    UNION ALL
    SELECT 'system_accounts_missing_for_unlinked_users' AS check_name,
           COUNT(*) AS issue_count
    FROM users u
    LEFT JOIN employees e ON e.user_id = u.user_id
    LEFT JOIN learners l ON l.user_id = u.user_id
    LEFT JOIN system_accounts sa ON sa.legacy_user_id = u.user_id
    WHERE e.employee_id IS NULL
      AND l.learner_id IS NULL
      AND sa.system_account_id IS NULL
    UNION ALL
    SELECT 'duplicate_usernames_across_actor_accounts' AS check_name,
           COUNT(*) AS issue_count
    FROM (
        SELECT username
        FROM account_credentials_v
        WHERE is_deleted = 0
        GROUP BY username
        HAVING COUNT(*) > 1
    ) duplicates;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS deped_add_column_if_missing;
DROP PROCEDURE IF EXISTS deped_add_index_if_missing;
DROP PROCEDURE IF EXISTS deped_add_fk_if_missing;
