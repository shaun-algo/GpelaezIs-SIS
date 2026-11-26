-- Email OTP recovery schema.
-- Back up the database and validate this script on a disposable clone first.
-- OTP values are never stored. The application stores only password_hash output.

CREATE TABLE IF NOT EXISTS email_otps (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    email VARCHAR(254) NOT NULL,
    otp_hash VARCHAR(255) NOT NULL,
    otp_expires_at DATETIME NOT NULL,
    attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
    max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 5,
    last_sent_at DATETIME NOT NULL,
    verified TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_email_otps_email_created (email, created_at, id),
    KEY idx_email_otps_expiry (otp_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

