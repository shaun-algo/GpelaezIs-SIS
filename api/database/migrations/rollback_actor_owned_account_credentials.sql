-- Rollback: Remove actor-owned account credential fields
-- Use only if you need to undo add_actor_owned_account_credentials.sql before the application layer is adapted.
-- This leaves the legacy users table untouched.

DROP VIEW IF EXISTS account_credentials_v;
DROP PROCEDURE IF EXISTS validate_actor_account_credentials;

DROP PROCEDURE IF EXISTS deped_drop_fk_if_exists;
DELIMITER $$
CREATE PROCEDURE deped_drop_fk_if_exists(
    IN p_table_name VARCHAR(64),
    IN p_constraint_name VARCHAR(64)
)
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_schema = DATABASE()
          AND table_name = p_table_name
          AND constraint_name = p_constraint_name
    ) THEN
        SET @ddl := CONCAT('ALTER TABLE `', p_table_name, '` DROP FOREIGN KEY `', p_constraint_name, '`');
        PREPARE stmt FROM @ddl;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$
DELIMITER ;

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

CALL deped_drop_fk_if_exists('employees', 'fk_employee_account_role');
CALL deped_drop_fk_if_exists('learners', 'fk_learner_account_role');

CALL deped_drop_index_if_exists('employees', 'uq_employee_username');
CALL deped_drop_index_if_exists('employees', 'idx_employee_account_role');
CALL deped_drop_index_if_exists('learners', 'uq_learner_username');
CALL deped_drop_index_if_exists('learners', 'idx_learner_account_role');

CALL deped_drop_column_if_exists('employees', 'account_created_at');
CALL deped_drop_column_if_exists('employees', 'last_login');
CALL deped_drop_column_if_exists('employees', 'is_active');
CALL deped_drop_column_if_exists('employees', 'role_id');
CALL deped_drop_column_if_exists('employees', 'locked_until');
CALL deped_drop_column_if_exists('employees', 'failed_login_count');
CALL deped_drop_column_if_exists('employees', 'password_updated_at');
CALL deped_drop_column_if_exists('employees', 'must_change_password');
CALL deped_drop_column_if_exists('employees', 'password');
CALL deped_drop_column_if_exists('employees', 'username');

CALL deped_drop_column_if_exists('learners', 'account_created_at');
CALL deped_drop_column_if_exists('learners', 'last_login');
CALL deped_drop_column_if_exists('learners', 'is_active');
CALL deped_drop_column_if_exists('learners', 'role_id');
CALL deped_drop_column_if_exists('learners', 'locked_until');
CALL deped_drop_column_if_exists('learners', 'failed_login_count');
CALL deped_drop_column_if_exists('learners', 'password_updated_at');
CALL deped_drop_column_if_exists('learners', 'must_change_password');
CALL deped_drop_column_if_exists('learners', 'password');
CALL deped_drop_column_if_exists('learners', 'username');

DROP TABLE IF EXISTS system_accounts;

DROP PROCEDURE IF EXISTS deped_drop_fk_if_exists;
DROP PROCEDURE IF EXISTS deped_drop_index_if_exists;
DROP PROCEDURE IF EXISTS deped_drop_column_if_exists;
