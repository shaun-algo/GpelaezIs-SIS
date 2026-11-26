-- Migration: Align attendance.status with DepEd-based status values
-- New canonical values: Present, Absent, Late, Half-day, NLPA, Holiday, No Classes
-- Legacy values (Cutting, Excused, Official Business, HD) are retained
-- for backward compatibility with existing records.

ALTER TABLE `attendance`
    MODIFY COLUMN `status`
        ENUM('Present','Absent','Late','Half-day','NLPA','Cutting','Excused','Official Business','HD','Holiday','No Classes')
        NOT NULL
        DEFAULT 'Present'
        COMMENT 'SF2 symbols: blank=Present, X=Absent, half-shaded=Late, H=Holiday, NC=No Classes; legacy values retained for compat.';
