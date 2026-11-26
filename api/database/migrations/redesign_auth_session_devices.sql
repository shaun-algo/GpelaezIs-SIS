-- Convert the earlier per-login session table into one row per account/device.
-- Apply after add_auth_session_devices.sql on existing installations.

ALTER TABLE auth_session_devices
    ADD COLUMN IF NOT EXISTS is_main_device TINYINT(1) NOT NULL DEFAULT 0 AFTER user_agent,
    ADD COLUMN IF NOT EXISTS trusted_at DATETIME DEFAULT NULL AFTER is_main_device,
    ADD COLUMN IF NOT EXISTS new_device_pending TINYINT(1) NOT NULL DEFAULT 0 AFTER trusted_at;

-- Keep the latest row for each account/device fingerprint before adding the
-- unique key. Existing rows are treated as already trusted so this migration
-- never interrupts a user's current access with a historical prompt.
CREATE TEMPORARY TABLE auth_session_devices_keep AS
    SELECT user_id, device_fingerprint, MAX(session_device_id) AS keep_id
    FROM auth_session_devices
    GROUP BY user_id, device_fingerprint;

DELETE d
FROM auth_session_devices d
JOIN auth_session_devices_keep k
  ON k.user_id = d.user_id
 AND k.device_fingerprint = d.device_fingerprint
WHERE d.session_device_id <> k.keep_id;

DROP TEMPORARY TABLE auth_session_devices_keep;

UPDATE auth_session_devices
SET new_device_pending = 0,
    trusted_at = COALESCE(trusted_at, created_at),
    is_main_device = 0;

UPDATE auth_session_devices d
JOIN (
    SELECT user_id, MIN(session_device_id) AS first_device_id
    FROM auth_session_devices
    GROUP BY user_id
) first_device
  ON first_device.user_id = d.user_id
 AND first_device.first_device_id = d.session_device_id
SET d.is_main_device = 1;

SET @has_device_key := (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'auth_session_devices'
      AND index_name = 'uq_auth_session_devices_user_fingerprint'
);
SET @add_device_key_sql := IF(
    @has_device_key = 0,
    'ALTER TABLE auth_session_devices ADD UNIQUE KEY uq_auth_session_devices_user_fingerprint (user_id, device_fingerprint)',
    'SELECT 1'
);
PREPARE add_device_key_stmt FROM @add_device_key_sql;
EXECUTE add_device_key_stmt;
DEALLOCATE PREPARE add_device_key_stmt;
