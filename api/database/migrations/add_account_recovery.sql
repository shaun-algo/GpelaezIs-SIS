-- Account recovery. Back up and validate on a clone before applying. No contact emails are auto-verified.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INT UNSIGNED NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS recovery_contacts (
    user_id INT NOT NULL PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    verified_at DATETIME NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    email_snapshot VARCHAR(254) NULL,
    purpose ENUM('reset','verify') NOT NULL DEFAULT 'reset',
    delivery_kind ENUM('email','adviser') NOT NULL DEFAULT 'email',
    auth_version INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    consumed_at DATETIME NULL,
    INDEX (user_id, consumed_at),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS learner_recovery_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    auth_version INT UNSIGNED NOT NULL,
    status ENUM('pending','approved','rejected','completed','expired') NOT NULL DEFAULT 'pending',
    requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    decided_at DATETIME NULL,
    approved_by INT NULL,
    verification_method VARCHAR(50) NULL,
    fallback_reason VARCHAR(300) NULL,
    token_id BIGINT UNSIGNED NULL,
    INDEX (user_id,status),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (approved_by) REFERENCES users(user_id),
    FOREIGN KEY (token_id) REFERENCES password_reset_tokens(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS recovery_rate_limits (
    bucket CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    window_started DATETIME NOT NULL,
    attempts INT UNSIGNED NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS recovery_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    event VARCHAR(40) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS recovery_mail_queue (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    recipient VARCHAR(254) NOT NULL,
    encrypted_payload MEDIUMTEXT NULL,
    status ENUM('pending','sending','sent','failed','expired') NOT NULL DEFAULT 'pending',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    finished_at DATETIME NULL,
    INDEX (status, id)
) ENGINE=InnoDB;
DROP TRIGGER IF EXISTS recovery_users_password_version;
DROP TRIGGER IF EXISTS recovery_learners_password_version;
DELIMITER $$
CREATE TRIGGER recovery_users_password_version BEFORE UPDATE ON users FOR EACH ROW
BEGIN
    IF NOT (OLD.password <=> NEW.password) THEN SET NEW.auth_version = OLD.auth_version + 1; END IF;
END$$
CREATE TRIGGER recovery_learners_password_version AFTER UPDATE ON learners FOR EACH ROW
BEGIN
    IF NOT (OLD.password <=> NEW.password) THEN
        UPDATE users SET auth_version=auth_version+1 WHERE user_id=NEW.user_id;
    END IF;
END$$
DELIMITER ;
