<?php

require_once __DIR__ . '/../connection.php';

try {
    $conn->exec("DROP TRIGGER IF EXISTS `trg_enrollments_bu_capacity_consistency`");
    $conn->exec("DROP TRIGGER IF EXISTS `trg_enrollments_bi_capacity_consistency`");

    $conn->exec(<<<'SQL'
CREATE TRIGGER `trg_enrollments_bu_capacity_consistency` BEFORE UPDATE ON `enrollments`
FOR EACH ROW BEGIN
  DECLARE current_count INT DEFAULT 0;
  DECLARE max_cap INT DEFAULT NULL;
  DECLARE sec_sy INT DEFAULT NULL;
  DECLARE sec_grade INT DEFAULT NULL;

  IF NEW.is_deleted = 0 AND (NEW.enrollment_status = 'Enrolled' OR NEW.enrollment_status IS NULL) THEN
    SELECT s.max_capacity, s.school_year_id, s.grade_level_id
      INTO max_cap, sec_sy, sec_grade
    FROM sections s
    WHERE s.section_id = NEW.section_id
      AND s.is_deleted = 0
    LIMIT 1;

    IF max_cap IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid section_id';
    END IF;

    IF NEW.school_year_id <> sec_sy THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Enrollment school_year_id does not match section school_year_id';
    END IF;

    IF NEW.grade_level_id <> sec_grade THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Enrollment grade_level_id does not match section grade_level_id';
    END IF;

    SELECT COUNT(*)
      INTO current_count
    FROM enrollments e
    WHERE e.section_id = NEW.section_id
      AND e.school_year_id = NEW.school_year_id
      AND e.is_deleted = 0
      AND (e.enrollment_status = 'Enrolled' OR e.enrollment_status IS NULL)
      AND e.enrollment_id <> OLD.enrollment_id;

    IF current_count >= max_cap THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Section is already at max capacity';
    END IF;
  END IF;
END
SQL
    );

    $conn->exec(<<<'SQL'
CREATE TRIGGER `trg_enrollments_bi_capacity_consistency` BEFORE INSERT ON `enrollments`
FOR EACH ROW BEGIN
  DECLARE current_count INT DEFAULT 0;
  DECLARE max_cap INT DEFAULT NULL;
  DECLARE sec_sy INT DEFAULT NULL;
  DECLARE sec_grade INT DEFAULT NULL;

  IF NEW.is_deleted = 0 AND (NEW.enrollment_status = 'Enrolled' OR NEW.enrollment_status IS NULL) THEN
    SELECT s.max_capacity, s.school_year_id, s.grade_level_id
      INTO max_cap, sec_sy, sec_grade
    FROM sections s
    WHERE s.section_id = NEW.section_id
      AND s.is_deleted = 0
    LIMIT 1;

    IF max_cap IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid section_id';
    END IF;

    IF NEW.school_year_id <> sec_sy THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Enrollment school_year_id does not match section school_year_id';
    END IF;

    IF NEW.grade_level_id <> sec_grade THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Enrollment grade_level_id does not match section grade_level_id';
    END IF;

    SELECT COUNT(*)
      INTO current_count
    FROM enrollments e
    WHERE e.section_id = NEW.section_id
      AND e.school_year_id = NEW.school_year_id
      AND e.is_deleted = 0
      AND (e.enrollment_status = 'Enrolled' OR e.enrollment_status IS NULL);

    IF current_count >= max_cap THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Section is already at max capacity';
    END IF;
  END IF;
END
SQL
    );

    echo "Enrollment triggers updated to skip validation for deleted/non-enrolled records.\n";
} catch (Exception $e) {
    fwrite(STDERR, "Trigger update failed: {$e->getMessage()}\n");
    exit(1);
}
