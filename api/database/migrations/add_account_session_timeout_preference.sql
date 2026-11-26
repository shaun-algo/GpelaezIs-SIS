-- Persist an account's personal auto end Session duration.
-- The school_settings.session_timeout_minutes value remains the school-wide
-- default. This additive table lets learner accounts keep their own choice
-- without changing the default used by other accounts.

CREATE TABLE IF NOT EXISTS account_settings (
    user_id INT NOT NULL,
    session_timeout_minutes TINYINT UNSIGNED DEFAULT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    CONSTRAINT fk_account_settings_user
        FOREIGN KEY (user_id) REFERENCES users (user_id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Per-account settings that override school defaults';
