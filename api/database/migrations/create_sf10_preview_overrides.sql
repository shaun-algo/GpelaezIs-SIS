-- SF10 preview-only manual fields, scoped per learner.
-- These overrides are intentionally separate from official grades and
-- previous-school academic history. They are used for print preparation.

START TRANSACTION;

CREATE TABLE IF NOT EXISTS learner_sf10_preview_overrides (
  learner_id int(11) NOT NULL,
  overrides_json longtext NOT NULL,
  created_by int(11) DEFAULT NULL,
  updated_by int(11) DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp(),
  updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (learner_id),
  CONSTRAINT fk_sf10_preview_overrides_learner
    FOREIGN KEY (learner_id) REFERENCES learners (learner_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Manual SF10 preview fields for print preparation, scoped per learner';

COMMIT;
