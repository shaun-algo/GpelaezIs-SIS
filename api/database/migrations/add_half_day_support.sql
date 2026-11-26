-- DepEd Half-Day (HD) Attendance Support
-- Adds HD status and decimal support for monthly attendance summaries
-- This enables proper SF9 report card generation with 0.5 values for half-days

START TRANSACTION;

-- 1) Add HD (Half-Day) status to attendance enum
ALTER TABLE attendance
  MODIFY COLUMN status ENUM('Present','Absent','Late','Cutting','Excused','Official Business','HD') NOT NULL DEFAULT 'Present'
  COMMENT 'SF2: blank=Present X=Absent upper-half=Late lower-half=Cutting HD=Half-Day (0.5)';

-- 2) Change monthly summary columns to DECIMAL to support 0.5 values
ALTER TABLE attendance_monthly_summaries
  MODIFY COLUMN days_present DECIMAL(5,1) DEFAULT 0 COMMENT 'Days present (can include 0.5 for half-days)',
  MODIFY COLUMN days_absent DECIMAL(5,1) DEFAULT 0 COMMENT 'Days absent (can include 0.5 for half-days)';

COMMIT;
