-- DepEd Half-Day (HD) Attendance Support Migration
-- This migration adds HD status and decimal support for monthly attendance summaries
-- Run this on your existing database to enable DepEd-compliant half-day tracking

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

-- Verification queries (run these to verify the migration was successful):
-- SHOW COLUMNS FROM attendance LIKE 'status';
-- SHOW COLUMNS FROM attendance_monthly_summaries LIKE 'days_present';
-- SHOW COLUMNS FROM attendance_monthly_summaries LIKE 'days_absent';
