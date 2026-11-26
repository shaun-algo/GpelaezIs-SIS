-- Per-user announcement controls. Apply after backing up the target database.
-- Hiding is private to the viewer; reports remain available for moderation review.
CREATE TABLE IF NOT EXISTS announcement_user_actions (
    announcement_user_action_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    announcement_id INT NOT NULL,
    user_id INT NOT NULL,
    action_type ENUM('hidden', 'reported') NOT NULL,
    report_reason VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (announcement_user_action_id),
    UNIQUE KEY uq_announcement_user_action (announcement_id, user_id, action_type),
    KEY idx_announcement_user_actions_user (user_id, action_type),
    KEY idx_announcement_user_actions_announcement (announcement_id, action_type),
    CONSTRAINT fk_announcement_user_actions_announcement
        FOREIGN KEY (announcement_id) REFERENCES announcements (announcement_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_announcement_user_actions_user
        FOREIGN KEY (user_id) REFERENCES users (user_id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
