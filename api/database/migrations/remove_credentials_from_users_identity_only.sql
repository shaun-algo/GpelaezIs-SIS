-- Migration: Remove duplicate credential storage from users
-- Purpose:
-- - Keep users.user_id only as a legacy identity anchor for existing foreign keys.
-- - Store login credentials only in employees, learners, and system_accounts.
-- - Provide user_identity_v for modules that need a displayable actor from old user_id fields.

DROP VIEW IF EXISTS user_identity_v;

DROP PROCEDURE IF EXISTS deped_drop_index_if_exists;
DELIMITER $$
CREATE PROCEDURE deped_drop_index_if_exists(
    IN p_table_name VARCHAR(64),
    IN p_index_name VARCHAR(64)
)
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = p_table_name
          AND index_name = p_index_name
    ) THEN
        SET @ddl := CONCAT('ALTER TABLE `', p_table_name, '` DROP INDEX `', p_index_name, '`');
        PREPARE stmt FROM @ddl;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS deped_drop_column_if_exists;
DELIMITER $$
CREATE PROCEDURE deped_drop_column_if_exists(
    IN p_table_name VARCHAR(64),
    IN p_column_name VARCHAR(64)
)
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = p_table_name
          AND column_name = p_column_name
    ) THEN
        SET @ddl := CONCAT('ALTER TABLE `', p_table_name, '` DROP COLUMN `', p_column_name, '`');
        PREPARE stmt FROM @ddl;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$
DELIMITER ;

CALL deped_drop_index_if_exists('users', 'uq_username');

CALL deped_drop_column_if_exists('users', 'last_login');
CALL deped_drop_column_if_exists('users', 'locked_until');
CALL deped_drop_column_if_exists('users', 'failed_login_count');
CALL deped_drop_column_if_exists('users', 'password_updated_at');
CALL deped_drop_column_if_exists('users', 'must_change_password');
CALL deped_drop_column_if_exists('users', 'password');
CALL deped_drop_column_if_exists('users', 'username');
CALL deped_drop_column_if_exists('users', 'is_active');

CREATE OR REPLACE VIEW user_identity_v AS
SELECT legacy_user_id AS user_id,
       username,
       role_id,
       role_name,
       is_active,
       is_deleted,
       deleted_at,
       account_type,
       actor_id
FROM account_credentials_v
WHERE legacy_user_id IS NOT NULL
UNION ALL
SELECT u.user_id,
       CONCAT('Identity #', u.user_id) AS username,
       u.role_id,
       r.role_name,
       CASE WHEN COALESCE(u.is_deleted, 0) = 1 THEN 0 ELSE 1 END AS is_active,
       u.is_deleted,
       u.deleted_at,
       'identity' AS account_type,
       u.user_id AS actor_id
FROM users u
LEFT JOIN roles r ON r.role_id = u.role_id
WHERE NOT EXISTS (
    SELECT 1
    FROM account_credentials_v ac
    WHERE ac.legacy_user_id = u.user_id
);

DROP PROCEDURE IF EXISTS validate_actor_account_credentials;
DELIMITER $$
CREATE PROCEDURE validate_actor_account_credentials()
BEGIN
    SELECT 'employee_accounts_missing_credentials' AS check_name,
           COUNT(*) AS issue_count
    FROM employees e
    WHERE e.user_id IS NOT NULL
      AND (e.username IS NULL OR e.password IS NULL OR e.role_id IS NULL)
    UNION ALL
    SELECT 'learner_accounts_missing_credentials' AS check_name,
           COUNT(*) AS issue_count
    FROM learners l
    WHERE l.user_id IS NOT NULL
      AND (l.username IS NULL OR l.password IS NULL OR l.role_id IS NULL)
    UNION ALL
    SELECT 'system_accounts_missing_credentials' AS check_name,
           COUNT(*) AS issue_count
    FROM system_accounts sa
    WHERE sa.username IS NULL OR sa.password IS NULL OR sa.role_id IS NULL
    UNION ALL
    SELECT 'identity_rows_missing_for_accounts' AS check_name,
           COUNT(*) AS issue_count
    FROM account_credentials_v ac
    LEFT JOIN users u ON u.user_id = ac.legacy_user_id
    WHERE ac.legacy_user_id IS NOT NULL
      AND u.user_id IS NULL
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

DROP PROCEDURE IF EXISTS deped_drop_index_if_exists;
DROP PROCEDURE IF EXISTS deped_drop_column_if_exists;
