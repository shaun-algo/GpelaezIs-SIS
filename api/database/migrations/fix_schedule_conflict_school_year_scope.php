<?php

require_once __DIR__ . '/../connection.php';

try {
    $conn->exec("DROP TRIGGER IF EXISTS `trg_class_schedules_bi_guard`");
    $conn->exec("DROP TRIGGER IF EXISTS `trg_class_schedules_bu_guard`");

    $conn->exec(<<<'SQL'
CREATE TRIGGER `trg_class_schedules_bi_guard` BEFORE INSERT ON `class_schedules`
FOR EACH ROW BEGIN
  DECLARE v_conflict INT DEFAULT 0;
  IF NEW.class_id IS NOT NULL AND NEW.teacher_id IS NULL THEN
    SET NEW.teacher_id = (SELECT teacher_id FROM class_offerings WHERE class_id = NEW.class_id);
  END IF;
  IF NEW.end_time <= NEW.start_time THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Schedule end_time must be after start_time';
  END IF;
  IF NEW.teacher_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_conflict
      FROM class_schedules cs
     WHERE cs.is_deleted = 0
       AND cs.teacher_id = NEW.teacher_id
       AND cs.school_year_id = NEW.school_year_id
       AND cs.day_of_week = NEW.day_of_week
       AND NEW.start_time < cs.end_time
       AND NEW.end_time   > cs.start_time;
    IF v_conflict > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Teacher already has a class in this time slot';
    END IF;
  END IF;
END
SQL
    );

    $conn->exec(<<<'SQL'
CREATE TRIGGER `trg_class_schedules_bu_guard` BEFORE UPDATE ON `class_schedules`
FOR EACH ROW BEGIN
  DECLARE v_conflict INT DEFAULT 0;
  IF NEW.end_time <= NEW.start_time THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Schedule end_time must be after start_time';
  END IF;
  IF NEW.teacher_id IS NOT NULL AND
     (OLD.teacher_id IS NULL OR NEW.teacher_id <> OLD.teacher_id OR
      OLD.start_time <> NEW.start_time OR OLD.end_time <> NEW.end_time OR
      OLD.day_of_week <> NEW.day_of_week) THEN
    SELECT COUNT(*) INTO v_conflict
      FROM class_schedules cs
     WHERE cs.is_deleted = 0
       AND cs.schedule_id <> OLD.schedule_id
       AND cs.teacher_id  = NEW.teacher_id
       AND cs.school_year_id = NEW.school_year_id
       AND cs.day_of_week = NEW.day_of_week
       AND NEW.start_time < cs.end_time
       AND NEW.end_time   > cs.start_time;
    IF v_conflict > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Teacher already has a class in this time slot';
    END IF;
  END IF;
END
SQL
    );

    echo "Class schedule triggers updated to scope teacher conflicts by school_year_id.\n";
} catch (Exception $e) {
    fwrite(STDERR, "Trigger update failed: {$e->getMessage()}\n");
    exit(1);
}
