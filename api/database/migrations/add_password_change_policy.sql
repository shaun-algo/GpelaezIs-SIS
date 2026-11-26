-- Migration: Add first-login password change policy fields
-- Purpose:
-- - Auto-created accounts often start with username/LRN/employee-number based passwords.
-- - These fields let the app alert users and clear the warning after they change password.

SET @has_must_change_password := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'users'
    AND column_name = 'must_change_password'
);

SET @sql_add_must_change_password := IF(
  @has_must_change_password = 0,
  'ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 1 COMMENT "Force change of the auto-generated default on first login" AFTER password',
  'SELECT 1'
);
PREPARE stmt_add_must_change_password FROM @sql_add_must_change_password;
EXECUTE stmt_add_must_change_password;
DEALLOCATE PREPARE stmt_add_must_change_password;

SET @has_password_updated_at := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'users'
    AND column_name = 'password_updated_at'
);

SET @sql_add_password_updated_at := IF(
  @has_password_updated_at = 0,
  'ALTER TABLE users ADD COLUMN password_updated_at DATETIME DEFAULT NULL AFTER must_change_password',
  'SELECT 1'
);
PREPARE stmt_add_password_updated_at FROM @sql_add_password_updated_at;
EXECUTE stmt_add_password_updated_at;
DEALLOCATE PREPARE stmt_add_password_updated_at;

UPDATE users
SET must_change_password = 1
WHERE is_deleted = 0
  AND password_updated_at IS NULL;
