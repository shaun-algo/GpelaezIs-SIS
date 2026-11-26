-- Account deactivation requests are a reversible, reviewable workflow.
-- Approval disables sign-in through users.is_active; it does not delete the
-- account or employee record.
CREATE TABLE IF NOT EXISTS account_deactivation_requests (
    request_id INT(11) NOT NULL AUTO_INCREMENT,
    user_id INT(11) NOT NULL,
    employee_id INT(11) DEFAULT NULL,
    reason_code VARCHAR(40) NOT NULL,
    reason_other VARCHAR(500) DEFAULT NULL,
    status ENUM('PENDING','APPROVED','DECLINED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME DEFAULT NULL,
    reviewed_by INT(11) DEFAULT NULL,
    reviewer_note VARCHAR(500) DEFAULT NULL,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    deleted_at DATETIME DEFAULT NULL,
    PRIMARY KEY (request_id),
    KEY idx_deactivation_request_status (status, is_deleted, requested_at),
    KEY idx_deactivation_request_user (user_id, status, is_deleted),
    KEY idx_deactivation_request_reviewer (reviewed_by),
    KEY idx_deactivation_request_employee (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
