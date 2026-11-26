    -- Date-driven grading-period lifecycle with an explicit administrator override.
-- Automatic periods are open only within their inclusive date range; after the
-- end date they become Locked. Admin actions switch a period to manual mode.

ALTER TABLE `grading_periods`
    ADD COLUMN IF NOT EXISTS `status_mode`
        ENUM('automatic', 'manual') NOT NULL DEFAULT 'automatic'
        COMMENT 'Automatic date lifecycle or administrator manual override'
        AFTER `status`;

-- Existing submitted/approved periods are deliberate workflow decisions and
-- must remain under administrator control. Existing Open/Locked periods keep
-- the date-driven default so configured calendars can take effect immediately.
UPDATE `grading_periods`
SET `status_mode` = 'manual'
WHERE `is_deleted` = 0
  AND `status` IN ('Submitted', 'Approved');

CREATE INDEX IF NOT EXISTS `idx_grading_periods_lifecycle`
    ON `grading_periods` (`school_year_id`, `status_mode`, `date_start`, `date_end`, `is_deleted`);
