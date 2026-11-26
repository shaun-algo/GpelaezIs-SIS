-- Monthly SF2 attendance encoding.
-- Apply once to an existing database before deploying the monthly attendance UI.
-- No learner attendance rows are deleted or rewritten by this migration.

ALTER TABLE `attendance`
  MODIFY COLUMN `grading_period_id` int(11) DEFAULT NULL,
  MODIFY COLUMN `status`
    ENUM(
      'Present',
      'Absent',
      'Late',
      'Half-day',
      'NLPA',
      'Cutting',
      'Excused',
      'Official Business',
      'HD',
      'Holiday',
      'No Classes'
    ) NOT NULL DEFAULT 'Present'
    COMMENT 'SF2 symbols: blank=Present, X=Absent, upper-half=Late, lower-half=Cutting, HD=Half-day (0.5), H=Holiday, NC=No Classes';
