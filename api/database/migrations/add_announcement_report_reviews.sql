-- Record administrator decisions for reported posts without deleting reports.
CREATE TABLE IF NOT EXISTS announcement_report_reviews (
    announcement_id INT NOT NULL,
    resolution ENUM('no_issue') NOT NULL DEFAULT 'no_issue',
    reviewed_by INT NULL,
    reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (announcement_id),
    KEY idx_announcement_report_reviews_resolution (resolution, reviewed_at),
    CONSTRAINT fk_announcement_report_reviews_announcement
        FOREIGN KEY (announcement_id) REFERENCES announcements (announcement_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_announcement_report_reviews_reviewer
        FOREIGN KEY (reviewed_by) REFERENCES users (user_id)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
