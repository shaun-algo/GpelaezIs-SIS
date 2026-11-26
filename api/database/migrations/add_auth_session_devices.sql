-- Per-browser device controls for Account security.
-- One row represents one account/device cookie. A new PHP session from the
-- same browser updates that row instead of creating another history record.
CREATE TABLE IF NOT EXISTS auth_session_devices (
    session_device_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT(11) NOT NULL,
    session_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    device_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_agent VARCHAR(512) DEFAULT NULL,
    is_main_device TINYINT(1) NOT NULL DEFAULT 0,
    trusted_at DATETIME DEFAULT NULL,
    new_device_pending TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME DEFAULT NULL,
    blocked_at DATETIME DEFAULT NULL,
    PRIMARY KEY (session_device_id),
    UNIQUE KEY uq_auth_session_devices_session (session_hash),
    UNIQUE KEY uq_auth_session_devices_user_fingerprint (user_id, device_fingerprint),
    KEY idx_auth_session_devices_user (user_id, revoked_at, blocked_at, last_seen_at),
    KEY idx_auth_session_devices_fingerprint (user_id, device_fingerprint, blocked_at),
    CONSTRAINT fk_auth_session_devices_user
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
