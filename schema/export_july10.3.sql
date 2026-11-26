-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: localhost
-- Generation Time: Jul 10, 2026 at 06:13 PM
-- Server version: 10.4.28-MariaDB
-- PHP Version: 8.0.28

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `capstone_migration`
--

-- --------------------------------------------------------

--
-- Table structure for table `announcements`
--

CREATE TABLE `announcements` (
  `announcement_id` int(11) NOT NULL,
  `title` varchar(200) NOT NULL,
  `body` text NOT NULL,
  `posted_by` int(11) NOT NULL,
  `target_role_id` int(11) DEFAULT NULL COMMENT 'NULL = visible to all roles',
  `published_at` datetime DEFAULT current_timestamp(),
  `expires_at` datetime DEFAULT NULL,
  `is_pinned` tinyint(1) DEFAULT 0,
  `attachment_url` varchar(500) DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='School-wide announcements — enrollment schedules, events, urgent notices';

-- --------------------------------------------------------

--
-- Table structure for table `attendance`
--

CREATE TABLE `attendance` (
  `attendance_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `class_id` int(11) DEFAULT NULL COMMENT 'NULL = whole-day homeroom; otherwise FK -> class_offerings.class_id',
  `grading_period_id` int(11) NOT NULL,
  `attendance_date` date NOT NULL,
  `session` enum('AM','PM') NOT NULL DEFAULT 'AM' COMMENT 'SF2: AM or PM half-day session',
  `nls_reason` enum('a1','a2','a3','a4','b1','b2','b3','b4','b5','b6','b7','c1','c2','c3','d1','d2','d3','e1','f') DEFAULT NULL COMMENT 'SF2 NLS reason code; only set when status = Absent',
  `transfer_note` varchar(255) DEFAULT NULL COMMENT 'SF2 Remarks: school name if learner was TRANSFERRED IN or OUT',
  `status` enum('Present','Absent','Late','Cutting','Excused','Official Business','HD') NOT NULL DEFAULT 'Present' COMMENT 'SF2: blank=Present X=Absent upper-half=Late lower-half=Cutting HD=Half-Day (0.5)',
  `remarks` varchar(255) DEFAULT NULL,
  `recorded_by` int(11) DEFAULT NULL,
  `recorded_at` datetime DEFAULT current_timestamp(),
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Daily or per-period attendance. class_id=0 means whole-day homeroom record.';

-- --------------------------------------------------------

--
-- Table structure for table `attendance_monthly_summaries`
--

CREATE TABLE `attendance_monthly_summaries` (
  `summary_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `month_no` tinyint(3) UNSIGNED NOT NULL COMMENT '1..12',
  `total_school_days` int(11) DEFAULT NULL,
  `days_present` decimal(5,1) DEFAULT 0.0 COMMENT 'Days present (can include 0.5 for half-days)',
  `days_absent` decimal(5,1) DEFAULT 0.0 COMMENT 'Days absent (can include 0.5 for half-days)',
  `days_late` int(11) DEFAULT 0,
  `days_excused` int(11) DEFAULT 0,
  `computed_by` int(11) DEFAULT NULL,
  `computed_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `audit_logs`
--

CREATE TABLE `audit_logs` (
  `audit_id` int(11) NOT NULL,
  `user_id` int(11) DEFAULT NULL,
  `table_name` varchar(100) NOT NULL,
  `record_id` int(11) DEFAULT NULL,
  `action` varchar(50) NOT NULL COMMENT 'INSERT, UPDATE, DELETE',
  `old_values` longtext DEFAULT NULL,
  `new_values` longtext DEFAULT NULL,
  `action_time` datetime DEFAULT current_timestamp(),
  `ip_address` varchar(45) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Tracks all data changes for accountability';

-- --------------------------------------------------------

--
-- Table structure for table `citizenships`
--

CREATE TABLE `citizenships` (
  `citizenship_id` int(11) NOT NULL,
  `country_name` varchar(100) NOT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `class_assessment_items`
--

CREATE TABLE `class_assessment_items` (
  `assessment_item_id` int(11) NOT NULL,
  `class_id` int(11) NOT NULL,
  `grading_period_id` int(11) NOT NULL,
  `component_code` enum('WW','PT','QE') NOT NULL,
  `assessment_title` varchar(200) NOT NULL,
  `max_score` decimal(7,2) NOT NULL,
  `assessment_date` date DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `class_offerings`
--

CREATE TABLE `class_offerings` (
  `class_id` int(11) NOT NULL,
  `subject_id` int(11) NOT NULL,
  `section_id` int(11) NOT NULL,
  `teacher_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Class offerings — subject + section + teacher per school year';

--
-- Triggers `class_offerings`
--
DELIMITER $$
CREATE TRIGGER `trg_class_offerings_au_sync_sched` AFTER UPDATE ON `class_offerings` FOR EACH ROW BEGIN
  IF NEW.teacher_id<>OLD.teacher_id THEN
    UPDATE class_schedules SET teacher_id=NEW.teacher_id WHERE class_id=NEW.class_id AND is_deleted=0;
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `class_offering_assignment_requests`
--

CREATE TABLE `class_offering_assignment_requests` (
  `request_id` int(11) NOT NULL,
  `section_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `requested_by_user_id` int(11) NOT NULL,
  `status` enum('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
  `note` varchar(255) DEFAULT NULL,
  `reviewed_by_user_id` int(11) DEFAULT NULL,
  `reviewed_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `class_offering_assignment_request_items`
--

CREATE TABLE `class_offering_assignment_request_items` (
  `request_item_id` int(11) NOT NULL,
  `request_id` int(11) NOT NULL,
  `subject_id` int(11) NOT NULL,
  `teacher_id` int(11) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `class_schedules`
--

CREATE TABLE `class_schedules` (
  `schedule_id` int(11) NOT NULL,
  `class_id` int(11) DEFAULT NULL,
  `teacher_id` int(11) DEFAULT NULL COMMENT 'Denormalized FK → employees.employee_id — copied from class_offerings for class schedules',
  `day_of_week` enum('Mon','Tue','Wed','Thu','Fri','Sat') NOT NULL,
  `start_time` time NOT NULL,
  `end_time` time NOT NULL,
  `schedule_type` enum('class','fixed_activity','teacher_activity') NOT NULL DEFAULT 'class',
  `activity_name` varchar(100) DEFAULT NULL,
  `school_year_id` int(11) NOT NULL,
  `section_id` int(11) NOT NULL,
  `notes` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  `is_active_slot` tinyint(1) GENERATED ALWAYS AS (case when `is_deleted` = 0 then 0 else NULL end) VIRTUAL COMMENT 'Allows soft-deleted rows to be re-inserted without unique-key collision'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Triggers `class_schedules`
--
DELIMITER $$
CREATE TRIGGER `trg_class_schedules_bi_guard` BEFORE INSERT ON `class_schedules` FOR EACH ROW BEGIN
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
       AND cs.day_of_week = NEW.day_of_week
       AND NEW.start_time < cs.end_time
       AND NEW.end_time   > cs.start_time;
    IF v_conflict > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Teacher already has a class in this time slot';
    END IF;
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_class_schedules_bu_guard` BEFORE UPDATE ON `class_schedules` FOR EACH ROW BEGIN
  DECLARE v_conflict INT DEFAULT 0;
  IF NEW.end_time <= NEW.start_time THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Schedule end_time must be after start_time';
  END IF;
  IF NEW.teacher_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_conflict
      FROM class_schedules cs
     WHERE cs.is_deleted = 0
       AND cs.schedule_id <> OLD.schedule_id
       AND cs.teacher_id  = NEW.teacher_id
       AND cs.day_of_week = NEW.day_of_week
       AND NEW.start_time < cs.end_time
       AND NEW.end_time   > cs.start_time;
    IF v_conflict > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Teacher already has a class in this time slot';
    END IF;
  END IF;
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `curricula`
--

CREATE TABLE `curricula` (
  `curriculum_id` int(11) NOT NULL,
  `curriculum_code` varchar(30) NOT NULL COMMENT 'e.g. K12-2013, MATATAG-2023',
  `curriculum_name` varchar(150) NOT NULL,
  `description` text DEFAULT NULL,
  `effective_from` year(4) NOT NULL,
  `effective_until` year(4) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `created_by` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Master list of DepEd curriculum editions';

-- --------------------------------------------------------

--
-- Table structure for table `curriculum_grade_levels`
--

CREATE TABLE `curriculum_grade_levels` (
  `cgl_id` int(11) NOT NULL,
  `curriculum_id` int(11) NOT NULL,
  `grade_level_id` int(11) NOT NULL,
  `sort_order` int(11) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Which grade levels are covered by a curriculum edition';

-- --------------------------------------------------------

--
-- Table structure for table `curriculum_grading_components`
--

CREATE TABLE `curriculum_grading_components` (
  `component_id` int(11) NOT NULL,
  `curriculum_id` int(11) NOT NULL,
  `grade_level_id` int(11) DEFAULT NULL COMMENT 'NULL = all grades in this curriculum',
  `component_code` varchar(30) NOT NULL COMMENT 'WW, PT, QE',
  `component_name` varchar(100) NOT NULL,
  `weight_percent` decimal(5,2) NOT NULL,
  `sort_order` int(11) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Grading component weights per curriculum (WW, PT, QE)';

-- --------------------------------------------------------

--
-- Table structure for table `curriculum_learning_areas`
--

CREATE TABLE `curriculum_learning_areas` (
  `area_id` int(11) NOT NULL,
  `curriculum_id` int(11) NOT NULL COMMENT 'FK → curricula.curriculum_id',
  `area_code` varchar(30) NOT NULL COMMENT 'Short code e.g. LANG, MATH, SCI, SOAPSS, TECHVOC, MAPEH, VALUES',
  `area_name` varchar(100) NOT NULL COMMENT 'Full display name e.g. Languages, Mathematics, Science',
  `sort_order` int(11) DEFAULT NULL COMMENT 'Display order on Report Card',
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Learning Area groupings per curriculum edition — used for SF9/Report Card display.';

-- --------------------------------------------------------

--
-- Table structure for table `curriculum_passing_marks`
--

CREATE TABLE `curriculum_passing_marks` (
  `passing_mark_id` int(11) NOT NULL,
  `curriculum_id` int(11) NOT NULL,
  `grade_level_id` int(11) DEFAULT NULL COMMENT 'NULL = all grade levels',
  `subject_id` int(11) DEFAULT NULL COMMENT 'NULL = all subjects',
  `passing_mark` decimal(5,2) NOT NULL DEFAULT 60.00,
  `notes` varchar(255) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  `floor_grade` decimal(5,2) NOT NULL DEFAULT 60.00,
  `report_card_passing_grade` decimal(5,2) NOT NULL DEFAULT 75.00
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Passing marks per curriculum, optionally per grade level or subject';

-- --------------------------------------------------------

--
-- Table structure for table `curriculum_school_year_map`
--

CREATE TABLE `curriculum_school_year_map` (
  `map_id` int(11) NOT NULL,
  `curriculum_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `is_primary` tinyint(1) NOT NULL DEFAULT 1 COMMENT '1 = default curriculum for this SY',
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Maps which curriculum is in effect for each school year';

-- --------------------------------------------------------

--
-- Table structure for table `curriculum_subjects`
--

CREATE TABLE `curriculum_subjects` (
  `curriculum_subject_id` int(11) NOT NULL,
  `curriculum_id` int(11) NOT NULL,
  `grade_level_id` int(11) NOT NULL,
  `subject_id` int(11) NOT NULL,
  `is_required` tinyint(1) NOT NULL DEFAULT 1 COMMENT '0 = elective',
  `weekly_minutes` int(11) DEFAULT NULL,
  `sort_order` int(11) DEFAULT NULL,
  `learning_area_id` int(11) DEFAULT NULL COMMENT 'FK → curriculum_learning_areas.area_id — groups subject under a learning area for SF9/Report Card display',
  `notes` varchar(255) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Subject-grade level assignments per curriculum edition';

-- --------------------------------------------------------

--
-- Table structure for table `deped_transmutation_table`
--

CREATE TABLE `deped_transmutation_table` (
  `transmutation_id` int(11) NOT NULL,
  `initial_grade_from` decimal(5,2) NOT NULL,
  `initial_grade_to` decimal(5,2) NOT NULL,
  `quarterly_grade` decimal(5,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `document_types`
--

CREATE TABLE `document_types` (
  `document_type_id` int(11) NOT NULL,
  `type_name` varchar(100) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Types of documents required — PSA Birth Certificate, Form 137, Form 138, etc.';

-- --------------------------------------------------------

--
-- Table structure for table `education_levels`
--

CREATE TABLE `education_levels` (
  `education_level_id` int(11) NOT NULL,
  `level_name` varchar(100) NOT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Education level — Elementary, Junior High School, Senior High School';

--
-- Triggers `education_levels`
--
DELIMITER $$
CREATE TRIGGER `trg_edu_levels_bi_no_shs` BEFORE INSERT ON `education_levels` FOR EACH ROW BEGIN
  IF LOWER(NEW.level_name) LIKE '%senior%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Senior High School is out of scope for this system';
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `emergency_contacts`
--

CREATE TABLE `emergency_contacts` (
  `emergency_contact_id` int(11) NOT NULL,
  `learner_id` int(11) NOT NULL,
  `contact_name` varchar(200) NOT NULL,
  `relationship` varchar(50) NOT NULL,
  `contact_number` varchar(20) DEFAULT NULL,
  `address` text DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Emergency contacts per learner';

-- --------------------------------------------------------

--
-- Table structure for table `employees`
--

CREATE TABLE `employees` (
  `employee_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `employee_number` varchar(50) NOT NULL,
  `first_name` varchar(100) NOT NULL,
  `middle_name` varchar(100) DEFAULT NULL,
  `last_name` varchar(100) NOT NULL,
  `name_extension` varchar(10) DEFAULT NULL COMMENT 'Jr., Sr., II, III …',
  `date_of_birth` date DEFAULT NULL,
  `gender` enum('Male','Female','Other') DEFAULT NULL,
  `contact_number` varchar(20) DEFAULT NULL,
  `email` varchar(150) DEFAULT NULL,
  `address` text DEFAULT NULL,
  `position_id` int(11) DEFAULT NULL,
  `date_hired` date DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Employee (teacher/staff) profiles linked to a user account';

-- --------------------------------------------------------

--
-- Table structure for table `enrollments`
--

CREATE TABLE `enrollments` (
  `enrollment_id` int(11) NOT NULL,
  `learner_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `grade_level_id` int(11) NOT NULL,
  `section_id` int(11) NOT NULL,
  `curriculum_id` int(11) DEFAULT NULL COMMENT 'FK to curricula — which curriculum this enrollment follows',
  `enrollment_type_id` int(11) DEFAULT NULL,
  `enrollment_date` date DEFAULT NULL,
  `enrollment_status` enum('Enrolled','Dropped','Transferred Out','Completed') NOT NULL DEFAULT 'Enrolled',
  `status_updated_at` datetime DEFAULT current_timestamp(),
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Learner enrollment records per school year';

--
-- Triggers `enrollments`
--
DELIMITER $$
CREATE TRIGGER `trg_enrollments_bi_capacity_consistency` BEFORE INSERT ON `enrollments` FOR EACH ROW BEGIN
  DECLARE current_count INT DEFAULT 0;
  DECLARE max_cap INT DEFAULT NULL;
  DECLARE sec_sy INT DEFAULT NULL;
  DECLARE sec_grade INT DEFAULT NULL;

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

  IF NEW.is_deleted = 0
     AND (NEW.enrollment_status = 'Enrolled' OR NEW.enrollment_status IS NULL)
     AND current_count >= max_cap THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Section is already at max capacity';
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_enrollments_bi_fill_curriculum` BEFORE INSERT ON `enrollments` FOR EACH ROW BEGIN
  DECLARE v_cur INT DEFAULT NULL;
  IF NEW.curriculum_id IS NULL THEN
    SELECT csym.curriculum_id INTO v_cur
    FROM curriculum_school_year_map csym
    WHERE csym.school_year_id = NEW.school_year_id
      AND csym.is_primary = 1 AND csym.is_deleted = 0
    LIMIT 1;
    SET NEW.curriculum_id = v_cur;
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_enrollments_bu_capacity_consistency` BEFORE UPDATE ON `enrollments` FOR EACH ROW BEGIN
  DECLARE current_count INT DEFAULT 0;
  DECLARE max_cap INT DEFAULT NULL;
  DECLARE sec_sy INT DEFAULT NULL;
  DECLARE sec_grade INT DEFAULT NULL;

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

  IF NEW.is_deleted = 0 AND (NEW.enrollment_status = 'Enrolled' OR NEW.enrollment_status IS NULL) THEN
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
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `enrollment_requirements`
--

CREATE TABLE `enrollment_requirements` (
  `requirement_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `grade_level_id` int(11) DEFAULT NULL COMMENT 'NULL = all grade levels',
  `document_type_id` int(11) NOT NULL,
  `is_mandatory` tinyint(1) DEFAULT 1,
  `notes` varchar(255) DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Document checklist per school year and grade level for enrollment';

-- --------------------------------------------------------

--
-- Table structure for table `enrollment_types`
--

CREATE TABLE `enrollment_types` (
  `enrollment_type_id` int(11) NOT NULL,
  `type_name` varchar(100) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Enrollment type — New, Returning, Transfer-In, Balik-Aral';

-- --------------------------------------------------------

--
-- Table structure for table `family_members`
--

CREATE TABLE `family_members` (
  `family_member_id` int(11) NOT NULL,
  `learner_id` int(11) NOT NULL,
  `full_name` varchar(200) NOT NULL,
  `full_name_raw` varchar(300) DEFAULT NULL COMMENT 'Original SF1 string (LAST, FIRST MIDDLE) for audit',
  `relationship` varchar(50) NOT NULL COMMENT 'Father, Mother, Legal Guardian …',
  `is_guardian` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = SF1 guardian-of-record for this learner',
  `date_of_birth` date DEFAULT NULL,
  `occupation` varchar(150) DEFAULT NULL,
  `contact_number` varchar(20) DEFAULT NULL,
  `monthly_income` decimal(12,2) DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Family background per learner';

--
-- Triggers `family_members`
--
DELIMITER $$
CREATE TRIGGER `trg_fm_bi_single_guardian` BEFORE INSERT ON `family_members` FOR EACH ROW BEGIN
  IF NEW.is_guardian = 1 AND NEW.is_deleted = 0 THEN
    IF EXISTS (SELECT 1 FROM family_members
               WHERE learner_id = NEW.learner_id AND is_guardian = 1 AND is_deleted = 0) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Learner already has a guardian-of-record; unset it first';
    END IF;
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `final_grades`
--

CREATE TABLE `final_grades` (
  `final_grade_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `class_id` int(11) NOT NULL,
  `final_grade` decimal(5,2) DEFAULT NULL,
  `remark` enum('Passed','Failed') NOT NULL DEFAULT 'Failed',
  `computed_by` int(11) DEFAULT NULL,
  `computed_at` datetime DEFAULT current_timestamp(),
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Final computed grade per subject per learner per school year';

--
-- Triggers `final_grades`
--
DELIMITER $$
CREATE TRIGGER `trg_final_grades_bi_deped_rules` BEFORE INSERT ON `final_grades` FOR EACH ROW BEGIN
  DECLARE v_quarter_count INT DEFAULT 0;

  IF NEW.final_grade IS NOT NULL AND NEW.final_grade < 60.00 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DepEd floor grade violation: final_grade must be >= 60';
  END IF;

  SELECT COUNT(DISTINCT gp.quarter_no)
    INTO v_quarter_count
  FROM grades g
  JOIN grading_periods gp ON gp.grading_period_id = g.grading_period_id
  WHERE g.enrollment_id = NEW.enrollment_id
    AND g.class_id = NEW.class_id
    AND g.is_deleted = 0
    AND gp.is_deleted = 0
    AND gp.quarter_no BETWEEN 1 AND 4
    AND g.quarterly_grade IS NOT NULL;

  IF v_quarter_count < 4 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot compute final grade: 4 quarterly grades are required';
  END IF;

  IF NEW.final_grade IS NOT NULL THEN
    SET NEW.remark = IF(NEW.final_grade >= 75.00, 'Passed', 'Failed');
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_final_grades_bu_deped_rules` BEFORE UPDATE ON `final_grades` FOR EACH ROW BEGIN
  DECLARE v_quarter_count INT DEFAULT 0;

  IF NEW.final_grade IS NOT NULL AND NEW.final_grade < 60.00 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DepEd floor grade violation: final_grade must be >= 60';
  END IF;

  SELECT COUNT(DISTINCT gp.quarter_no)
    INTO v_quarter_count
  FROM grades g
  JOIN grading_periods gp ON gp.grading_period_id = g.grading_period_id
  WHERE g.enrollment_id = NEW.enrollment_id
    AND g.class_id = NEW.class_id
    AND g.is_deleted = 0
    AND gp.is_deleted = 0
    AND gp.quarter_no BETWEEN 1 AND 4
    AND g.quarterly_grade IS NOT NULL;

  IF v_quarter_count < 4 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot update final grade: 4 quarterly grades are required';
  END IF;

  IF NEW.final_grade IS NOT NULL THEN
    SET NEW.remark = IF(NEW.final_grade >= 75.00, 'Passed', 'Failed');
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `final_grade_quarter_sources`
--

CREATE TABLE `final_grade_quarter_sources` (
  `source_id` int(11) NOT NULL,
  `final_grade_id` int(11) NOT NULL,
  `grade_id` int(11) NOT NULL,
  `quarter_no` tinyint(3) UNSIGNED NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `general_averages`
--

CREATE TABLE `general_averages` (
  `general_average_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `general_average` decimal(5,2) DEFAULT NULL,
  `computed_by` int(11) DEFAULT NULL,
  `computed_at` datetime DEFAULT current_timestamp(),
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Computed general average per learner per school year';

--
-- Triggers `general_averages`
--
DELIMITER $$
CREATE TRIGGER `trg_general_averages_bi_validate` BEFORE INSERT ON `general_averages` FOR EACH ROW BEGIN
  DECLARE v_expected DECIMAL(5,2);

  SELECT ROUND(AVG(fg.final_grade), 2)
    INTO v_expected
  FROM final_grades fg
  WHERE fg.enrollment_id = NEW.enrollment_id
    AND fg.is_deleted = 0
    AND fg.final_grade IS NOT NULL;

  IF NEW.general_average IS NULL THEN
    SET NEW.general_average = v_expected;
  END IF;

  IF v_expected IS NOT NULL AND ABS(NEW.general_average - v_expected) > 0.01 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'general_averages.general_average must equal AVG(final_grades.final_grade)';
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_general_averages_bu_validate` BEFORE UPDATE ON `general_averages` FOR EACH ROW BEGIN
  DECLARE v_expected DECIMAL(5,2);

  SELECT ROUND(AVG(fg.final_grade), 2)
    INTO v_expected
  FROM final_grades fg
  WHERE fg.enrollment_id = NEW.enrollment_id
    AND fg.is_deleted = 0
    AND fg.final_grade IS NOT NULL;

  IF NEW.general_average IS NULL THEN
    SET NEW.general_average = v_expected;
  END IF;

  IF v_expected IS NOT NULL AND ABS(NEW.general_average - v_expected) > 0.01 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'general_averages.general_average must equal AVG(final_grades.final_grade)';
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `geo_barangays`
--

CREATE TABLE `geo_barangays` (
  `barangay_id` int(11) NOT NULL,
  `city_municipality_id` int(11) NOT NULL,
  `psgc_code` varchar(20) DEFAULT NULL,
  `barangay_name` varchar(150) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `geo_cities_municipalities`
--

CREATE TABLE `geo_cities_municipalities` (
  `city_municipality_id` int(11) NOT NULL,
  `province_id` int(11) NOT NULL,
  `psgc_code` varchar(20) DEFAULT NULL,
  `city_municipality_name` varchar(150) NOT NULL,
  `is_city` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `geo_name_aliases`
--

CREATE TABLE `geo_name_aliases` (
  `geo_alias_id` int(11) NOT NULL,
  `geo_type` enum('province','city_municipality','barangay') NOT NULL,
  `alias` varchar(150) NOT NULL COMMENT 'lowercased+trimmed match key',
  `target_id` int(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Free-text SF1 geo names -> canonical geo_* rows; one indexed lookup replaces table scans';

-- --------------------------------------------------------

--
-- Table structure for table `geo_provinces`
--

CREATE TABLE `geo_provinces` (
  `province_id` int(11) NOT NULL,
  `psgc_code` varchar(20) DEFAULT NULL,
  `province_name` varchar(150) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `grades`
--

CREATE TABLE `grades` (
  `grade_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `class_id` int(11) NOT NULL,
  `grading_period_id` int(11) NOT NULL,
  `written_works` decimal(5,2) DEFAULT NULL,
  `performance_tasks` decimal(5,2) DEFAULT NULL,
  `quarterly_exam` decimal(5,2) DEFAULT NULL,
  `quarterly_grade` decimal(5,2) DEFAULT NULL,
  `encoded_by` int(11) DEFAULT NULL,
  `encoded_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  `initial_grade` decimal(5,2) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Per-subject quarterly grade entries';

--
-- Triggers `grades`
--
DELIMITER $$
CREATE TRIGGER `trg_grades_bi_deped_rules` BEFORE INSERT ON `grades` FOR EACH ROW BEGIN
  IF NEW.initial_grade IS NOT NULL AND NEW.initial_grade < 60.00 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DepEd floor grade violation: initial_grade must be >= 60';
  END IF;

  IF NEW.quarterly_grade IS NOT NULL AND NEW.quarterly_grade < 60.00 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DepEd floor grade violation: quarterly_grade must be >= 60';
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_grades_bu_deped_rules` BEFORE UPDATE ON `grades` FOR EACH ROW BEGIN
  IF NEW.initial_grade IS NOT NULL AND NEW.initial_grade < 60.00 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DepEd floor grade violation: initial_grade must be >= 60';
  END IF;

  IF NEW.quarterly_grade IS NOT NULL AND NEW.quarterly_grade < 60.00 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DepEd floor grade violation: quarterly_grade must be >= 60';
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `grade_component_summaries`
--

CREATE TABLE `grade_component_summaries` (
  `component_summary_id` int(11) NOT NULL,
  `grade_id` int(11) NOT NULL,
  `component_code` enum('WW','PT','QE') NOT NULL,
  `raw_score_total` decimal(9,2) NOT NULL,
  `highest_possible_total` decimal(9,2) NOT NULL,
  `percentage_score` decimal(6,2) NOT NULL,
  `weight_percent` decimal(5,2) NOT NULL,
  `weighted_score` decimal(7,2) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `grade_levels`
--

CREATE TABLE `grade_levels` (
  `grade_level_id` int(11) NOT NULL,
  `grade_name` varchar(50) NOT NULL,
  `education_level_id` int(11) NOT NULL,
  `sort_order` int(11) DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Grade levels — Grade 1 through Grade 10';

--
-- Triggers `grade_levels`
--
DELIMITER $$
CREATE TRIGGER `trg_grade_levels_bi_no_shs` BEFORE INSERT ON `grade_levels` FOR EACH ROW BEGIN
  IF NEW.grade_name LIKE '%11%' OR NEW.grade_name LIKE '%12%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Grades 11-12 (SHS) are out of scope for this system';
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `grade_level_aliases`
--

CREATE TABLE `grade_level_aliases` (
  `alias_id` int(11) NOT NULL,
  `grade_level_id` int(11) NOT NULL,
  `alias` varchar(50) NOT NULL COMMENT 'lowercased+trimmed match key'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Resolves any SF1/LIS grade spelling to the canonical grade_levels row';

-- --------------------------------------------------------

--
-- Table structure for table `grade_level_progression`
--

CREATE TABLE `grade_level_progression` (
  `grade_level_id` int(11) NOT NULL,
  `next_grade_level_id` int(11) DEFAULT NULL,
  `is_terminal` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='DepEd grade flow mapping used for promotion and re-enrollment';

-- --------------------------------------------------------

--
-- Table structure for table `grading_periods`
--

CREATE TABLE `grading_periods` (
  `grading_period_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `period_name` varchar(50) NOT NULL COMMENT 'e.g. 1st Quarter',
  `status` enum('Open','Submitted','Approved','Locked') NOT NULL DEFAULT 'Open',
  `date_start` date DEFAULT NULL,
  `date_end` date DEFAULT NULL,
  `locked_by` int(11) DEFAULT NULL,
  `locked_at` datetime DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  `quarter_no` tinyint(3) UNSIGNED DEFAULT NULL COMMENT '1..4 for quarterly grading'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Quarterly grading periods per school year with lock workflow';

-- --------------------------------------------------------

--
-- Table structure for table `honor_levels`
--

CREATE TABLE `honor_levels` (
  `honor_level_id` int(11) NOT NULL,
  `honor_name` varchar(100) NOT NULL,
  `min_average` decimal(5,2) DEFAULT NULL,
  `max_average` decimal(5,2) DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Honor level classification — With Highest Honors, With High Honors, With Honors';

-- --------------------------------------------------------

--
-- Table structure for table `import_logs`
--

CREATE TABLE `import_logs` (
  `import_id` int(11) NOT NULL,
  `imported_by` int(11) NOT NULL COMMENT 'FK → users.user_id — who uploaded the file',
  `school_id` int(11) DEFAULT NULL COMMENT 'FK -> schools.school_id: which school this batch targeted',
  `template_id` int(11) DEFAULT NULL COMMENT 'FK -> import_templates.template_id: detected SF1 template',
  `school_year_id` int(11) NOT NULL COMMENT 'FK → school_years.school_year_id — target SY for enrollment',
  `file_name` varchar(255) DEFAULT NULL COMMENT 'Original filename as uploaded',
  `file_size_kb` int(11) DEFAULT NULL COMMENT 'File size in kilobytes for reference',
  `total_rows` int(11) NOT NULL DEFAULT 0 COMMENT 'Total data rows parsed from file (excluding header)',
  `inserted` int(11) NOT NULL DEFAULT 0 COMMENT 'New learner + enrollment rows created',
  `updated` int(11) NOT NULL DEFAULT 0 COMMENT 'Existing learner rows updated (LRN matched)',
  `skipped` int(11) NOT NULL DEFAULT 0 COMMENT 'Rows skipped due to duplicate or no change',
  `errors` text DEFAULT NULL COMMENT 'JSON array of row-level errors: [{row:N, lrn:"...", message:"..."}]',
  `status` enum('Processing','Completed','Completed with Errors','Failed') NOT NULL DEFAULT 'Processing' COMMENT 'Overall batch status',
  `imported_at` datetime NOT NULL DEFAULT current_timestamp() COMMENT 'When the import was initiated',
  `completed_at` datetime DEFAULT NULL COMMENT 'When the import finished (success or fail)'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Audit trail for every LIS CSV/XLSX import batch. One row = one uploaded file.';

-- --------------------------------------------------------

--
-- Table structure for table `import_log_rows`
--

CREATE TABLE `import_log_rows` (
  `row_id` int(11) NOT NULL,
  `import_id` int(11) NOT NULL COMMENT 'FK → import_logs.import_id',
  `row_number` int(11) NOT NULL COMMENT 'Row index in the source file (1-based, after header)',
  `lrn` varchar(20) DEFAULT NULL COMMENT 'LRN from the source file row',
  `row_action` enum('Inserted','Updated','Skipped','Error') NOT NULL DEFAULT 'Error',
  `error_message` varchar(500) DEFAULT NULL COMMENT 'Human-readable reason if action = Error or Skipped',
  `raw_data` text DEFAULT NULL COMMENT 'JSON snapshot of the raw CSV/XLSX row for debugging'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Per-row detail log for LIS import batches.';

-- --------------------------------------------------------

--
-- Table structure for table `import_templates`
--

CREATE TABLE `import_templates` (
  `template_id` int(11) NOT NULL,
  `template_name` varchar(100) NOT NULL COMMENT 'e.g. LIS SF1',
  `version` varchar(20) NOT NULL COMMENT 'e.g. 2024, MATATAG-2023',
  `header_signature` longtext NOT NULL COMMENT 'JSON: ordered expected header labels for detection',
  `header_hash` char(64) DEFAULT NULL COMMENT 'SHA-256 of the normalized header row for fast exact match',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Header fingerprints so the app can auto-detect a genuine LIS SF1 file';

-- --------------------------------------------------------

--
-- Table structure for table `interventions`
--

CREATE TABLE `interventions` (
  `intervention_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `risk_assessment_id` int(11) NOT NULL,
  `intervention_type` varchar(150) DEFAULT NULL,
  `description` text DEFAULT NULL,
  `conducted_by` int(11) DEFAULT NULL,
  `conducted_at` datetime DEFAULT NULL,
  `follow_up_date` date DEFAULT NULL,
  `status` enum('Pending','Ongoing','Resolved','Escalated') NOT NULL DEFAULT 'Pending',
  `notes` text DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Intervention records for at-risk learners';

-- --------------------------------------------------------

--
-- Table structure for table `kindergarten_anecdotal_records`
--

CREATE TABLE `kindergarten_anecdotal_records` (
  `anecdotal_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `grading_period_id` int(11) NOT NULL,
  `observation_date` date NOT NULL,
  `narrative` text NOT NULL,
  `behavior_attitude_effort` text DEFAULT NULL,
  `recorded_by` int(11) DEFAULT NULL,
  `recorded_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Triggers `kindergarten_anecdotal_records`
--
DELIMITER $$
CREATE TRIGGER `trg_kg_anecdotal_bi_grade_guard` BEFORE INSERT ON `kindergarten_anecdotal_records` FOR EACH ROW BEGIN
  DECLARE v_grade_name VARCHAR(50);

  SELECT gl.grade_name INTO v_grade_name
  FROM enrollments e
  JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
  WHERE e.enrollment_id = NEW.enrollment_id
  LIMIT 1;

  IF v_grade_name <> 'Kindergarten' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Kindergarten anecdotal record is only valid for Kindergarten enrollments';
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `kindergarten_checklists`
--

CREATE TABLE `kindergarten_checklists` (
  `kg_checklist_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `grading_period_id` int(11) NOT NULL,
  `kg_standard_id` int(11) NOT NULL,
  `proficiency_status` enum('Not Yet Demonstrated','Emerging','Developing','Consistent') NOT NULL DEFAULT 'Not Yet Demonstrated',
  `remarks` varchar(255) DEFAULT NULL,
  `recorded_by` int(11) DEFAULT NULL,
  `recorded_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Triggers `kindergarten_checklists`
--
DELIMITER $$
CREATE TRIGGER `trg_kg_checklist_bi_grade_guard` BEFORE INSERT ON `kindergarten_checklists` FOR EACH ROW BEGIN
  DECLARE v_grade_name VARCHAR(50);

  SELECT gl.grade_name INTO v_grade_name
  FROM enrollments e
  JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
  WHERE e.enrollment_id = NEW.enrollment_id
  LIMIT 1;

  IF v_grade_name <> 'Kindergarten' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Kindergarten checklist is only valid for Kindergarten enrollments';
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `kindergarten_learning_standards`
--

CREATE TABLE `kindergarten_learning_standards` (
  `kg_standard_id` int(11) NOT NULL,
  `curriculum_id` int(11) NOT NULL,
  `domain_code` varchar(30) NOT NULL,
  `standard_code` varchar(50) NOT NULL,
  `standard_text` text NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `kindergarten_portfolios`
--

CREATE TABLE `kindergarten_portfolios` (
  `portfolio_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `grading_period_id` int(11) NOT NULL,
  `artifact_type` enum('Writing Sample','Activity Sheet','Artwork','Performance Output','Other') NOT NULL,
  `title` varchar(200) NOT NULL,
  `file_path` varchar(500) DEFAULT NULL,
  `notes` varchar(255) DEFAULT NULL,
  `uploaded_by` int(11) DEFAULT NULL,
  `uploaded_at` datetime NOT NULL DEFAULT current_timestamp(),
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Triggers `kindergarten_portfolios`
--
DELIMITER $$
CREATE TRIGGER `trg_kg_portfolio_bi_grade_guard` BEFORE INSERT ON `kindergarten_portfolios` FOR EACH ROW BEGIN
  DECLARE v_grade_name VARCHAR(50);

  SELECT gl.grade_name INTO v_grade_name
  FROM enrollments e
  JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
  WHERE e.enrollment_id = NEW.enrollment_id
  LIMIT 1;

  IF v_grade_name <> 'Kindergarten' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Kindergarten portfolio is only valid for Kindergarten enrollments';
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `kindergarten_quarterly_reports`
--

CREATE TABLE `kindergarten_quarterly_reports` (
  `kg_report_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `grading_period_id` int(11) NOT NULL,
  `learner_strengths` text DEFAULT NULL,
  `learner_needs_support` text DEFAULT NULL,
  `parent_conference_date` date DEFAULT NULL,
  `parent_conference_notes` text DEFAULT NULL,
  `prepared_by` int(11) DEFAULT NULL,
  `prepared_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Triggers `kindergarten_quarterly_reports`
--
DELIMITER $$
CREATE TRIGGER `trg_kg_report_bi_grade_guard` BEFORE INSERT ON `kindergarten_quarterly_reports` FOR EACH ROW BEGIN
  DECLARE v_grade_name VARCHAR(50);

  SELECT gl.grade_name INTO v_grade_name
  FROM enrollments e
  JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
  WHERE e.enrollment_id = NEW.enrollment_id
  LIMIT 1;

  IF v_grade_name <> 'Kindergarten' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Kindergarten quarterly report is only valid for Kindergarten enrollments';
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `learners`
--

CREATE TABLE `learners` (
  `learner_id` int(11) NOT NULL,
  `user_id` int(11) DEFAULT NULL,
  `lrn` varchar(20) NOT NULL COMMENT 'Learner Reference Number',
  `first_name` varchar(100) NOT NULL,
  `middle_name` varchar(100) DEFAULT NULL,
  `last_name` varchar(100) NOT NULL,
  `name_extension` varchar(10) DEFAULT NULL COMMENT 'Jr., Sr., II, III …',
  `full_name_raw` varchar(300) DEFAULT NULL COMMENT 'Original LIS SF1 "Name of Learner" string for audit (LAST, FIRST, MIDDLE)',
  `date_of_birth` date DEFAULT NULL,
  `birth_province_id` int(11) DEFAULT NULL COMMENT 'FK → geo_provinces. Province of birth for SF1 "BIRTH PLACE" column',
  `sex` enum('M','F') DEFAULT NULL COMMENT 'SF1 Sex column — strictly M or F. Auto-derived from gender on INSERT/UPDATE via trigger; can be manually overridden for non-binary learners requiring a legal SF1 sex marker',
  `gender` enum('Male','Female','Other') DEFAULT NULL,
  `religion` varchar(100) DEFAULT NULL,
  `mother_tongue` varchar(100) DEFAULT NULL,
  `indigenous_group` varchar(150) DEFAULT NULL COMMENT 'NULL if not indigenous',
  `is_indigenous` tinyint(1) DEFAULT 0,
  `completed` tinyint(1) DEFAULT 0,
  `is_permanent_same_as_current` tinyint(1) NOT NULL DEFAULT 1,
  `address` text DEFAULT NULL COMMENT 'Free-text current address for quick display',
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Learner (student) master profiles';

--
-- Triggers `learners`
--
DELIMITER $$
CREATE TRIGGER `trg_learners_bi_dob_guard` BEFORE INSERT ON `learners` FOR EACH ROW BEGIN
  IF NEW.date_of_birth IS NOT NULL
     AND (NEW.date_of_birth > CURDATE()
          OR NEW.date_of_birth < DATE_SUB(CURDATE(), INTERVAL 60 YEAR)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'date_of_birth out of plausible range (future or >60 years ago)';
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_learners_bi_ip_consistency` BEFORE INSERT ON `learners` FOR EACH ROW BEGIN
  IF NEW.indigenous_group IS NOT NULL AND TRIM(NEW.indigenous_group) <> '' THEN
    SET NEW.is_indigenous = 1;
  ELSEIF NEW.is_indigenous = 1 THEN
    SET NEW.is_indigenous = 0;
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_learners_bi_sync_sex_gender` BEFORE INSERT ON `learners` FOR EACH ROW BEGIN
  IF NEW.sex IS NULL AND NEW.gender IN ('Male','Female') THEN
    SET NEW.sex = IF(NEW.gender = 'Male', 'M', 'F');
  END IF;
  IF NEW.gender IS NULL AND NEW.sex IS NOT NULL THEN
    SET NEW.gender = IF(NEW.sex = 'M', 'Male', 'Female');
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_learners_bi_validate_lrn` BEFORE INSERT ON `learners` FOR EACH ROW BEGIN
  IF NEW.lrn IS NULL OR NEW.lrn NOT REGEXP '^[0-9]{12}$' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'LRN must be exactly 12 digits';
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_learners_bu_dob_guard` BEFORE UPDATE ON `learners` FOR EACH ROW BEGIN
  IF NEW.date_of_birth IS NOT NULL
     AND NEW.date_of_birth <> IFNULL(OLD.date_of_birth, '1000-01-01')
     AND (NEW.date_of_birth > CURDATE()
          OR NEW.date_of_birth < DATE_SUB(CURDATE(), INTERVAL 60 YEAR)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'date_of_birth out of plausible range (future or >60 years ago)';
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_learners_bu_ip_consistency` BEFORE UPDATE ON `learners` FOR EACH ROW BEGIN
  IF NEW.indigenous_group IS NOT NULL AND TRIM(NEW.indigenous_group) <> '' THEN
    SET NEW.is_indigenous = 1;
  ELSEIF NEW.is_indigenous = 1 THEN
    SET NEW.is_indigenous = 0;
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_learners_bu_sync_sex_gender` BEFORE UPDATE ON `learners` FOR EACH ROW BEGIN
  IF NEW.sex IS NULL AND NEW.gender IN ('Male','Female') THEN
    SET NEW.sex = IF(NEW.gender = 'Male', 'M', 'F');
  END IF;
  IF NEW.gender IS NULL AND NEW.sex IS NOT NULL THEN
    SET NEW.gender = IF(NEW.sex = 'M', 'Male', 'Female');
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_learners_bu_validate_lrn` BEFORE UPDATE ON `learners` FOR EACH ROW BEGIN
  IF NEW.lrn <> OLD.lrn THEN
    IF NEW.lrn IS NULL OR NEW.lrn NOT REGEXP '^[0-9]{12}$' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'LRN must be exactly 12 digits';
    END IF;
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `learner_addresses`
--

CREATE TABLE `learner_addresses` (
  `learner_address_id` int(11) NOT NULL,
  `learner_id` int(11) NOT NULL,
  `address_type` enum('CURRENT','PERMANENT') NOT NULL,
  `house_no` varchar(50) DEFAULT NULL,
  `street_name` varchar(150) DEFAULT NULL,
  `subdivision` varchar(150) DEFAULT NULL,
  `zip_code` varchar(10) DEFAULT NULL,
  `province_id` int(11) DEFAULT NULL,
  `city_municipality_id` int(11) DEFAULT NULL,
  `barangay_id` int(11) DEFAULT NULL,
  `country_name` varchar(100) NOT NULL DEFAULT 'Philippines',
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL,
  `active_type` char(9) GENERATED ALWAYS AS (case when `is_deleted` = 0 then `address_type` else NULL end) VIRTUAL COMMENT 'address_type when active, NULL when soft-deleted — drives uq_la_learner_active'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `learner_assessment_scores`
--

CREATE TABLE `learner_assessment_scores` (
  `assessment_score_id` int(11) NOT NULL,
  `assessment_item_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `raw_score` decimal(7,2) NOT NULL,
  `encoded_by` int(11) DEFAULT NULL,
  `encoded_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `learner_progression`
--

CREATE TABLE `learner_progression` (
  `progression_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `learner_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `current_grade_level_id` int(11) NOT NULL,
  `general_average` decimal(5,2) DEFAULT NULL,
  `final_status` enum('Promoted','Conditionally Promoted','Retained','Completed') NOT NULL COMMENT 'DepEd DO 8 s.2015: Promoted ≥75 all subjects; Conditionally Promoted = failed ≤2 subjects; Retained = failed >2; Completed = terminal grade',
  `next_grade_level_id` int(11) DEFAULT NULL,
  `remarks` varchar(255) DEFAULT NULL,
  `decided_at` datetime NOT NULL DEFAULT current_timestamp(),
  `is_processed` tinyint(1) NOT NULL DEFAULT 0,
  `processed_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `kg_checklist_completion_rate` decimal(5,2) DEFAULT NULL COMMENT 'Kindergarten: % of learning standards demonstrated (0-100)',
  `kg_portfolio_artifacts_count` int(11) DEFAULT NULL COMMENT 'Kindergarten: number of portfolio artifacts submitted',
  `progression_basis` enum('numerical_grades','kindergarten_checklists') DEFAULT 'numerical_grades' COMMENT 'Determines which metric drives the final_status decision'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Promotion and rollover decision per learner enrollment';

--
-- Triggers `learner_progression`
--
DELIMITER $$
CREATE TRIGGER `trg_kg_progression_basis_bi` BEFORE INSERT ON `learner_progression` FOR EACH ROW BEGIN
  DECLARE v_grade_name VARCHAR(50);

  SELECT gl.grade_name INTO v_grade_name
  FROM enrollments e
  JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
  WHERE e.enrollment_id = NEW.enrollment_id
  LIMIT 1;

  IF v_grade_name = 'Kindergarten' THEN
    SET NEW.progression_basis = 'kindergarten_checklists';
  ELSE
    SET NEW.progression_basis = 'numerical_grades';
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_kg_progression_basis_bu` BEFORE UPDATE ON `learner_progression` FOR EACH ROW BEGIN
  DECLARE v_grade_name VARCHAR(50);

  SELECT gl.grade_name INTO v_grade_name
  FROM enrollments e
  JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
  WHERE e.enrollment_id = NEW.enrollment_id
  LIMIT 1;

  IF v_grade_name = 'Kindergarten' THEN
    SET NEW.progression_basis = 'kindergarten_checklists';
  ELSE
    SET NEW.progression_basis = 'numerical_grades';
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_learner_progression_bi_status` BEFORE INSERT ON `learner_progression` FOR EACH ROW BEGIN
  DECLARE v_failed_count INT DEFAULT 0;
  DECLARE v_terminal TINYINT DEFAULT 0;
  DECLARE v_next_grade INT DEFAULT NULL;

  SELECT glp.is_terminal, glp.next_grade_level_id
    INTO v_terminal, v_next_grade
  FROM grade_level_progression glp
  WHERE glp.grade_level_id = NEW.current_grade_level_id
  LIMIT 1;

  SELECT COUNT(*)
    INTO v_failed_count
  FROM final_grades fg
  WHERE fg.enrollment_id = NEW.enrollment_id
    AND fg.is_deleted = 0
    AND fg.final_grade IS NOT NULL
    AND fg.final_grade < 75.00;

  IF v_terminal = 1 THEN
    SET NEW.final_status = 'Completed';
    SET NEW.next_grade_level_id = NULL;
  ELSEIF v_failed_count = 0 THEN
    SET NEW.final_status = 'Promoted';
    SET NEW.next_grade_level_id = v_next_grade;
  ELSEIF v_failed_count <= 2 THEN
    SET NEW.final_status = 'Conditionally Promoted';
    SET NEW.next_grade_level_id = v_next_grade;
  ELSE
    SET NEW.final_status = 'Retained';
    SET NEW.next_grade_level_id = NEW.current_grade_level_id;
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_learner_progression_bu_status` BEFORE UPDATE ON `learner_progression` FOR EACH ROW BEGIN
  DECLARE v_failed_count INT DEFAULT 0;
  DECLARE v_terminal TINYINT DEFAULT 0;
  DECLARE v_next_grade INT DEFAULT NULL;

  SELECT glp.is_terminal, glp.next_grade_level_id
    INTO v_terminal, v_next_grade
  FROM grade_level_progression glp
  WHERE glp.grade_level_id = NEW.current_grade_level_id
  LIMIT 1;

  SELECT COUNT(*)
    INTO v_failed_count
  FROM final_grades fg
  WHERE fg.enrollment_id = NEW.enrollment_id
    AND fg.is_deleted = 0
    AND fg.final_grade IS NOT NULL
    AND fg.final_grade < 75.00;

  IF v_terminal = 1 THEN
    SET NEW.final_status = 'Completed';
    SET NEW.next_grade_level_id = NULL;
  ELSEIF v_failed_count = 0 THEN
    SET NEW.final_status = 'Promoted';
    SET NEW.next_grade_level_id = v_next_grade;
  ELSEIF v_failed_count <= 2 THEN
    SET NEW.final_status = 'Conditionally Promoted';
    SET NEW.next_grade_level_id = v_next_grade;
  ELSE
    SET NEW.final_status = 'Retained';
    SET NEW.next_grade_level_id = NEW.current_grade_level_id;
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_prevent_kg_numerical_progression` BEFORE UPDATE ON `learner_progression` FOR EACH ROW BEGIN
  DECLARE v_grade_name VARCHAR(50);

  SELECT gl.grade_name INTO v_grade_name
  FROM enrollments e
  JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
  WHERE e.enrollment_id = NEW.enrollment_id
  LIMIT 1;

  IF v_grade_name = 'Kindergarten' AND NEW.progression_basis = 'kindergarten_checklists' THEN
    -- Ensure general_average is NULL for Kindergarten
    IF NEW.general_average IS NOT NULL THEN
      SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Kindergarten progression cannot use general_average. Use kg_checklist_completion_rate instead.';
    END IF;
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `notifications`
--

CREATE TABLE `notifications` (
  `notification_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `notification_type` enum('Grade Alert','Risk Flag','Intervention Due','Announcement','Grading Period') NOT NULL,
  `title` varchar(200) NOT NULL,
  `message` text NOT NULL,
  `is_read` tinyint(1) DEFAULT 0,
  `read_at` datetime DEFAULT NULL,
  `reference_table` varchar(50) DEFAULT NULL COMMENT 'e.g. risk_assessments, interventions',
  `reference_id` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='In-app per-user notifications — grade alerts, risk flags, intervention follow-ups';

-- --------------------------------------------------------

--
-- Table structure for table `permissions`
--

CREATE TABLE `permissions` (
  `permission_id` int(11) NOT NULL,
  `permission_code` varchar(100) NOT NULL COMMENT 'e.g. learners.import, grades.encode, promotion.run',
  `description` varchar(255) DEFAULT NULL,
  `module` varchar(50) DEFAULT NULL COMMENT 'Grouping for the admin UI',
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Fine-grained permissions bound to roles via role_permissions';

-- --------------------------------------------------------

--
-- Table structure for table `positions`
--

CREATE TABLE `positions` (
  `position_id` int(11) NOT NULL,
  `position_name` varchar(150) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Employee position lookup';

-- --------------------------------------------------------

--
-- Table structure for table `remedial_classes`
--

CREATE TABLE `remedial_classes` (
  `remedial_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL COMMENT 'FK → enrollments.enrollment_id — the SY enrollment this remedial applies to',
  `class_id` int(11) NOT NULL COMMENT 'FK → class_offerings.class_id — the failed subject offering',
  `final_grade_snapshot` decimal(5,2) NOT NULL COMMENT 'Copy of final_grades.final_grade at time of remedial assignment',
  `remedial_grade` decimal(5,2) DEFAULT NULL COMMENT 'Grade earned in the remedial class (NULL until graded)',
  `recomputed_grade` decimal(5,2) GENERATED ALWAYS AS (case when `remedial_grade` is not null then round((`final_grade_snapshot` + `remedial_grade`) / 2,2) else NULL end) VIRTUAL COMMENT '(final_grade_snapshot + remedial_grade) / 2 — auto-computed',
  `result` enum('Pending','Passed','Failed') NOT NULL DEFAULT 'Pending' COMMENT 'Set by application after remedial_grade is saved: Passed if recomputed ≥ 75',
  `recorded_by` int(11) DEFAULT NULL COMMENT 'FK → users.user_id — who recorded the remedial grade',
  `recorded_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Remedial class grades for Conditionally Promoted learners. Recomputed grade is auto-calculated.';

--
-- Triggers `remedial_classes`
--
DELIMITER $$
CREATE TRIGGER `trg_remedial_classes_bi_result` BEFORE INSERT ON `remedial_classes` FOR EACH ROW BEGIN
  IF NEW.remedial_grade IS NOT NULL THEN
    SET NEW.result = IF(((NEW.final_grade_snapshot + NEW.remedial_grade) / 2) >= 75.00, 'Passed', 'Failed');
  ELSE
    SET NEW.result = 'Pending';
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_remedial_classes_bu_result` BEFORE UPDATE ON `remedial_classes` FOR EACH ROW BEGIN
  IF NEW.remedial_grade IS NOT NULL THEN
    SET NEW.result = IF(((NEW.final_grade_snapshot + NEW.remedial_grade) / 2) >= 75.00, 'Passed', 'Failed');
  ELSE
    SET NEW.result = 'Pending';
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `report_cards`
--

CREATE TABLE `report_cards` (
  `report_card_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `grading_period_id` int(11) NOT NULL,
  `learner_name` varchar(300) DEFAULT NULL COMMENT 'Full name at generation time',
  `lrn` varchar(20) DEFAULT NULL,
  `grade_level_name` varchar(50) DEFAULT NULL,
  `section_name` varchar(100) DEFAULT NULL,
  `school_year_label` varchar(20) DEFAULT NULL,
  `general_average` decimal(5,2) DEFAULT NULL,
  `days_present` decimal(5,1) DEFAULT NULL,
  `days_absent` decimal(5,1) DEFAULT NULL,
  `days_late` decimal(5,1) DEFAULT NULL,
  `file_path` varchar(255) DEFAULT NULL COMMENT 'Path to generated PDF file',
  `generated_at` datetime DEFAULT current_timestamp(),
  `generated_by` int(11) DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Generated report card header — snapshot allows reprint without live joins';

--
-- Triggers `report_cards`
--
DELIMITER $$
CREATE TRIGGER `trg_report_cards_bi_sync_ga` BEFORE INSERT ON `report_cards` FOR EACH ROW BEGIN
  DECLARE v_ga DECIMAL(5,2);

  SELECT ga.general_average INTO v_ga
  FROM general_averages ga
  WHERE ga.enrollment_id = NEW.enrollment_id
    AND ga.is_deleted = 0
  LIMIT 1;

  IF v_ga IS NOT NULL THEN
    SET NEW.general_average = v_ga;
  END IF;
END
$$
DELIMITER ;
DELIMITER $$
CREATE TRIGGER `trg_report_cards_bu_sync_ga` BEFORE UPDATE ON `report_cards` FOR EACH ROW BEGIN
  DECLARE v_ga DECIMAL(5,2);

  SELECT ga.general_average INTO v_ga
  FROM general_averages ga
  WHERE ga.enrollment_id = NEW.enrollment_id
    AND ga.is_deleted = 0
  LIMIT 1;

  IF v_ga IS NOT NULL THEN
    SET NEW.general_average = v_ga;
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `report_card_grades`
--

CREATE TABLE `report_card_grades` (
  `rc_grade_id` int(11) NOT NULL,
  `report_card_id` int(11) NOT NULL,
  `subject_name` varchar(150) NOT NULL COMMENT 'Snapshot of subject name at generation time',
  `subject_code` varchar(50) DEFAULT NULL,
  `quarter_no` tinyint(3) UNSIGNED DEFAULT NULL,
  `quarterly_grade` decimal(5,2) DEFAULT NULL,
  `final_grade` decimal(5,2) DEFAULT NULL,
  `remark` enum('Passed','Failed') DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Per-subject grade snapshot per report card — enables full offline reprint';

-- --------------------------------------------------------

--
-- Table structure for table `risk_assessments`
--

CREATE TABLE `risk_assessments` (
  `risk_assessment_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `grading_period_id` int(11) NOT NULL,
  `risk_level_id` int(11) NOT NULL,
  `assessed_by` int(11) DEFAULT NULL,
  `assessed_at` datetime DEFAULT current_timestamp(),
  `notes` text DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Risk level assessment per learner per grading period';

-- --------------------------------------------------------

--
-- Table structure for table `risk_indicators`
--

CREATE TABLE `risk_indicators` (
  `indicator_id` int(11) NOT NULL,
  `risk_assessment_id` int(11) NOT NULL,
  `indicator_type` varchar(100) DEFAULT NULL COMMENT 'Attendance, Grade Drop, Behavioral …',
  `details` text DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Individual risk indicator flags tied to a risk assessment';

-- --------------------------------------------------------

--
-- Table structure for table `risk_levels`
--

CREATE TABLE `risk_levels` (
  `risk_level_id` int(11) NOT NULL,
  `risk_name` varchar(50) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `color_code` varchar(10) DEFAULT NULL COMMENT 'Hex color for UI e.g. #FF0000',
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Risk level classification — Low, Moderate, High, Critical';

-- --------------------------------------------------------

--
-- Table structure for table `roles`
--

CREATE TABLE `roles` (
  `role_id` int(11) NOT NULL,
  `role_name` varchar(100) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='System user roles — Admin, Teacher, Learner, etc.';

-- --------------------------------------------------------

--
-- Table structure for table `role_permissions`
--

CREATE TABLE `role_permissions` (
  `role_id` int(11) NOT NULL,
  `permission_id` int(11) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `created_by` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `schools`
--

CREATE TABLE `schools` (
  `school_id` int(11) NOT NULL,
  `deped_school_id` varchar(10) NOT NULL COMMENT 'e.g. 721045 (6-digit DepEd ID)',
  `school_name` varchar(200) NOT NULL COMMENT 'e.g. Kabacan National High School',
  `address` text DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `school_settings`
--

CREATE TABLE `school_settings` (
  `setting_id` int(11) NOT NULL,
  `setting_key` varchar(100) NOT NULL,
  `setting_value` text DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `updated_by` int(11) DEFAULT NULL,
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Global school configuration — used in report headers and form generation';

-- --------------------------------------------------------

--
-- Table structure for table `school_years`
--

CREATE TABLE `school_years` (
  `school_year_id` int(11) NOT NULL,
  `year_start` int(4) DEFAULT NULL,
  `year_end` int(4) DEFAULT NULL,
  `year_label` varchar(20) NOT NULL COMMENT 'e.g. 2025-2026',
  `date_start` date DEFAULT NULL,
  `date_end` date DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 0,
  `grading_system_type` enum('Quarterly') NOT NULL DEFAULT 'Quarterly' COMMENT 'K-G10 uses Quarterly only (SHS semesters removed)',
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Academic school years';

-- --------------------------------------------------------

--
-- Table structure for table `sections`
--

CREATE TABLE `sections` (
  `section_id` int(11) NOT NULL,
  `section_name` varchar(100) NOT NULL,
  `grade_level_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL COMMENT 'Sections are per school year',
  `adviser_id` int(11) DEFAULT NULL COMMENT 'Class adviser / homeroom teacher',
  `education_level_id` int(11) DEFAULT NULL COMMENT 'FK → education_levels. 1=Elementary (Grades 1-6), 2=JHS (Grades 7-10). Drives class offering logic.',
  `max_capacity` int(11) NOT NULL DEFAULT 45 COMMENT 'Max enrolled learners allowed',
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `section_rankings`
--

CREATE TABLE `section_rankings` (
  `ranking_id` int(11) NOT NULL,
  `enrollment_id` int(11) NOT NULL,
  `section_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `rank` int(11) DEFAULT NULL,
  `honor_level_id` int(11) DEFAULT NULL,
  `ranked_by` int(11) DEFAULT NULL,
  `ranked_at` datetime DEFAULT current_timestamp(),
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Section honor rankings per learner per school year';

-- --------------------------------------------------------

--
-- Table structure for table `sf1_import_staging`
--

CREATE TABLE `sf1_import_staging` (
  `staging_id` int(11) NOT NULL,
  `import_id` int(11) NOT NULL,
  `row_number` int(11) NOT NULL,
  `raw_lrn` varchar(50) DEFAULT NULL,
  `raw_name` varchar(300) DEFAULT NULL,
  `raw_sex` varchar(20) DEFAULT NULL,
  `raw_birth_date` varchar(50) DEFAULT NULL,
  `raw_birth_province` varchar(150) DEFAULT NULL,
  `raw_age_by_june` varchar(10) DEFAULT NULL,
  `raw_mother_tongue` varchar(100) DEFAULT NULL,
  `raw_ip_group` varchar(150) DEFAULT NULL,
  `raw_religion` varchar(100) DEFAULT NULL,
  `raw_house_street` varchar(200) DEFAULT NULL,
  `raw_barangay` varchar(150) DEFAULT NULL,
  `raw_municipality` varchar(150) DEFAULT NULL,
  `raw_province` varchar(150) DEFAULT NULL,
  `raw_father_name` varchar(300) DEFAULT NULL,
  `raw_mother_name` varchar(300) DEFAULT NULL,
  `raw_guardian_name` varchar(300) DEFAULT NULL,
  `raw_guardian_rel` varchar(50) DEFAULT NULL,
  `raw_contact_number` varchar(50) DEFAULT NULL,
  `raw_remarks` varchar(100) DEFAULT NULL,
  `raw_grade_level` varchar(50) DEFAULT NULL,
  `raw_section` varchar(100) DEFAULT NULL,
  `norm_lrn` char(12) DEFAULT NULL,
  `norm_last_name` varchar(100) DEFAULT NULL,
  `norm_first_name` varchar(100) DEFAULT NULL,
  `norm_middle_name` varchar(100) DEFAULT NULL,
  `norm_name_extension` varchar(10) DEFAULT NULL,
  `norm_sex` enum('M','F') DEFAULT NULL,
  `norm_birth_date` date DEFAULT NULL,
  `norm_contact_number` varchar(20) DEFAULT NULL,
  `resolved_grade_level_id` int(11) DEFAULT NULL,
  `resolved_section_id` int(11) DEFAULT NULL,
  `resolved_birth_province_id` int(11) DEFAULT NULL,
  `resolved_province_id` int(11) DEFAULT NULL,
  `resolved_city_municipality_id` int(11) DEFAULT NULL,
  `resolved_barangay_id` int(11) DEFAULT NULL,
  `resolved_learner_status` varchar(30) DEFAULT NULL,
  `resolved_enrollment_status` varchar(30) DEFAULT NULL,
  `resolved_enrollment_type_id` int(11) DEFAULT NULL,
  `matched_learner_id` int(11) DEFAULT NULL COMMENT 'existing learner by LRN incl. soft-deleted',
  `matched_enrollment_id` int(11) DEFAULT NULL,
  `validation_status` enum('Pending','Valid','Warning','Error') NOT NULL DEFAULT 'Pending',
  `planned_action` enum('Insert','Update','Revive','Skip','Reject') DEFAULT NULL,
  `messages` text DEFAULT NULL COMMENT 'JSON [{severity,field,message}]',
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='SF1 staging: whole file validated here BEFORE any live write';

-- --------------------------------------------------------

--
-- Table structure for table `sf1_remark_map`
--

CREATE TABLE `sf1_remark_map` (
  `remark_map_id` int(11) NOT NULL,
  `raw_remark` varchar(100) NOT NULL COMMENT 'lowercased+trimmed match key',
  `learner_status` enum('Enrolled','Temporarily Enrolled','Promoted','Conditionally Promoted','Retained','Transferred Out','Dropped','Graduated') DEFAULT 'Enrolled',
  `enrollment_status` enum('Enrolled','Dropped','Transferred Out','Completed') DEFAULT 'Enrolled',
  `enrollment_type_name` varchar(100) DEFAULT NULL COMMENT 'joined to enrollment_types.type_name at import'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='SF1 Remark/s -> internal statuses; single source of truth for server AND client preview';

-- --------------------------------------------------------

--
-- Table structure for table `sf1_value_norms`
--

CREATE TABLE `sf1_value_norms` (
  `norm_id` int(11) NOT NULL,
  `field_name` enum('religion','mother_tongue','relationship') NOT NULL,
  `raw_value` varchar(150) NOT NULL COMMENT 'lowercased+trimmed match key',
  `normalized_value` varchar(150) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `subjects`
--

CREATE TABLE `subjects` (
  `subject_id` int(11) NOT NULL,
  `subject_name` varchar(150) NOT NULL,
  `subject_code` varchar(50) NOT NULL COMMENT 'DepEd code e.g. MATH, ENG, FIL',
  `description` varchar(255) DEFAULT NULL,
  `is_specialist_assignable` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = subject can be assigned to a specialist teacher in Elementary (currently Math and Science).',
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Subject master list';

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `user_id` int(11) NOT NULL,
  `username` varchar(100) NOT NULL,
  `password` varchar(255) NOT NULL,
  `must_change_password` tinyint(1) NOT NULL DEFAULT 1 COMMENT 'Force change of the auto-generated default on first login',
  `password_updated_at` datetime DEFAULT NULL,
  `failed_login_count` int(11) NOT NULL DEFAULT 0,
  `locked_until` datetime DEFAULT NULL COMMENT 'Simple brute-force throttle for the shared learner/parent account',
  `role_id` int(11) NOT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  `last_login` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_deleted` tinyint(1) DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='System user accounts — all roles share this table';

-- --------------------------------------------------------

--
-- Stand-in structure for view `vw_learner_progression_candidates`
-- (See below for the actual view)
--
CREATE TABLE `vw_learner_progression_candidates` (
`progression_id` int(11)
,`enrollment_id` int(11)
,`learner_id` int(11)
,`source_school_year_id` int(11)
,`current_grade_level_id` int(11)
,`next_grade_level_id` int(11)
,`general_average` decimal(5,2)
,`final_status` enum('Promoted','Conditionally Promoted','Retained','Completed')
,`remarks` varchar(255)
,`is_processed` tinyint(1)
,`source_section_id` int(11)
,`source_section_name` varchar(100)
,`source_curriculum_id` int(11)
,`pending_remedial_count` bigint(21)
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_import_capacity_status`
-- (See below for the actual view)
--
CREATE TABLE `v_import_capacity_status` (
`section_id` int(11)
,`section_name` varchar(100)
,`grade_name` varchar(50)
,`year_label` varchar(20)
,`max_capacity` int(11)
,`enrolled_count` bigint(21)
,`slots_left` bigint(22)
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_import_orphan_addresses`
-- (See below for the actual view)
--
CREATE TABLE `v_import_orphan_addresses` (
`learner_address_id` int(11)
,`learner_id` int(11)
,`lrn` varchar(20)
,`learner_name` varchar(202)
,`address_type` enum('CURRENT','PERMANENT')
,`unresolved_text` varchar(150)
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_kindergarten_progression`
-- (See below for the actual view)
--
CREATE TABLE `v_kindergarten_progression` (
`progression_id` int(11)
,`enrollment_id` int(11)
,`learner_id` int(11)
,`grade_name` varchar(50)
,`kg_checklist_completion_rate` decimal(5,2)
,`kg_portfolio_artifacts_count` int(11)
,`progression_basis` enum('numerical_grades','kindergarten_checklists')
,`final_status` enum('Promoted','Conditionally Promoted','Retained','Completed')
,`next_grade_level_id` int(11)
,`decided_at` datetime
,`remarks` varchar(255)
,`total_checklist_entries` bigint(21)
,`total_portfolio_entries` bigint(21)
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_learner_data_quality`
-- (See below for the actual view)
--
CREATE TABLE `v_learner_data_quality` (
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_mapeh_quarterly_averages`
-- (See below for the actual view)
--
CREATE TABLE `v_mapeh_quarterly_averages` (
`enrollment_id` int(11)
,`grading_period_id` int(11)
,`mapeh_quarterly_grade` decimal(6,2)
,`components_count` bigint(21)
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_migration_orphans`
-- (See below for the actual view)
--
CREATE TABLE `v_migration_orphans` (
`fk` varchar(25)
,`record_id` int(11)
,`bad_value` int(11)
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_report_card_subject_quarters`
-- (See below for the actual view)
--
CREATE TABLE `v_report_card_subject_quarters` (
`report_card_id` int(11)
,`enrollment_id` int(11)
,`subject_name` varchar(150)
,`q1_grade` decimal(5,2)
,`q2_grade` decimal(5,2)
,`q3_grade` decimal(5,2)
,`q4_grade` decimal(5,2)
,`final_grade` decimal(5,2)
,`remark` enum('Passed','Failed')
);

-- --------------------------------------------------------

--
-- Structure for view `vw_learner_progression_candidates`
--
DROP TABLE IF EXISTS `vw_learner_progression_candidates`;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `vw_learner_progression_candidates`  AS SELECT `lp`.`progression_id` AS `progression_id`, `lp`.`enrollment_id` AS `enrollment_id`, `lp`.`learner_id` AS `learner_id`, `lp`.`school_year_id` AS `source_school_year_id`, `lp`.`current_grade_level_id` AS `current_grade_level_id`, `lp`.`next_grade_level_id` AS `next_grade_level_id`, `lp`.`general_average` AS `general_average`, `lp`.`final_status` AS `final_status`, `lp`.`remarks` AS `remarks`, `lp`.`is_processed` AS `is_processed`, `e`.`section_id` AS `source_section_id`, `sec`.`section_name` AS `source_section_name`, `e`.`curriculum_id` AS `source_curriculum_id`, (select count(0) from `remedial_classes` `rc` where `rc`.`enrollment_id` = `lp`.`enrollment_id` and `rc`.`is_deleted` = 0 and `rc`.`result` = 'Pending') AS `pending_remedial_count` FROM ((`learner_progression` `lp` join `enrollments` `e` on(`e`.`enrollment_id` = `lp`.`enrollment_id` and `e`.`is_deleted` = 0)) left join `sections` `sec` on(`sec`.`section_id` = `e`.`section_id`)) WHERE `lp`.`final_status` in ('Promoted','Conditionally Promoted','Retained') ;

-- --------------------------------------------------------

--
-- Structure for view `v_import_capacity_status`
--
DROP TABLE IF EXISTS `v_import_capacity_status`;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_import_capacity_status`  AS SELECT `s`.`section_id` AS `section_id`, `s`.`section_name` AS `section_name`, `gl`.`grade_name` AS `grade_name`, `sy`.`year_label` AS `year_label`, `s`.`max_capacity` AS `max_capacity`, count(`e`.`enrollment_id`) AS `enrolled_count`, `s`.`max_capacity`- count(`e`.`enrollment_id`) AS `slots_left` FROM (((`sections` `s` join `grade_levels` `gl` on(`gl`.`grade_level_id` = `s`.`grade_level_id`)) join `school_years` `sy` on(`sy`.`school_year_id` = `s`.`school_year_id`)) left join `enrollments` `e` on(`e`.`section_id` = `s`.`section_id` and `e`.`is_deleted` = 0 and `e`.`enrollment_status` = 'Enrolled')) WHERE `s`.`is_deleted` = 0 GROUP BY `s`.`section_id`, `s`.`section_name`, `gl`.`grade_name`, `sy`.`year_label`, `s`.`max_capacity` ;

-- --------------------------------------------------------

--
-- Structure for view `v_import_orphan_addresses`
--
DROP TABLE IF EXISTS `v_import_orphan_addresses`;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_import_orphan_addresses`  AS SELECT `la`.`learner_address_id` AS `learner_address_id`, `l`.`learner_id` AS `learner_id`, `l`.`lrn` AS `lrn`, concat(`l`.`last_name`,', ',`l`.`first_name`) AS `learner_name`, `la`.`address_type` AS `address_type`, `la`.`street_name` AS `unresolved_text` FROM (`learner_addresses` `la` join `learners` `l` on(`l`.`learner_id` = `la`.`learner_id` and `l`.`is_deleted` = 0)) WHERE `la`.`is_deleted` = 0 AND (`la`.`barangay_id` is null OR `la`.`city_municipality_id` is null OR `la`.`province_id` is null) ;

-- --------------------------------------------------------

--
-- Structure for view `v_kindergarten_progression`
--
DROP TABLE IF EXISTS `v_kindergarten_progression`;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_kindergarten_progression`  AS SELECT `lp`.`progression_id` AS `progression_id`, `lp`.`enrollment_id` AS `enrollment_id`, `e`.`learner_id` AS `learner_id`, `gl`.`grade_name` AS `grade_name`, `lp`.`kg_checklist_completion_rate` AS `kg_checklist_completion_rate`, `lp`.`kg_portfolio_artifacts_count` AS `kg_portfolio_artifacts_count`, `lp`.`progression_basis` AS `progression_basis`, `lp`.`final_status` AS `final_status`, `lp`.`next_grade_level_id` AS `next_grade_level_id`, `lp`.`decided_at` AS `decided_at`, `lp`.`remarks` AS `remarks`, (select count(0) from `kindergarten_checklists` `kc` where `kc`.`enrollment_id` = `lp`.`enrollment_id` and `kc`.`is_deleted` = 0) AS `total_checklist_entries`, (select count(0) from `kindergarten_portfolios` `kp` where `kp`.`enrollment_id` = `lp`.`enrollment_id` and `kp`.`is_deleted` = 0) AS `total_portfolio_entries` FROM ((`learner_progression` `lp` join `enrollments` `e` on(`e`.`enrollment_id` = `lp`.`enrollment_id`)) join `grade_levels` `gl` on(`gl`.`grade_level_id` = `e`.`grade_level_id`)) WHERE `gl`.`grade_name` = 'Kindergarten' ;

-- --------------------------------------------------------

--
-- Structure for view `v_learner_data_quality`
--
DROP TABLE IF EXISTS `v_learner_data_quality`;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_learner_data_quality`  AS SELECT `l`.`learner_id` AS `learner_id`, `l`.`lrn` AS `lrn`, concat(`l`.`last_name`,', ',`l`.`first_name`) AS `learner_name`, CASE WHEN `l`.`sex` is null THEN 'missing sex' END AS `q_sex`, CASE WHEN `l`.`date_of_birth` is null THEN 'missing DOB' END AS `q_dob`, CASE WHEN `l`.`birth_province_id` is null AND `l`.`birth_place_text` is null THEN 'missing birth place' END AS `q_birthplace`, CASE WHEN `l`.`contact_number` is not null AND !(`l`.`contact_number` regexp '^09[0-9]{9}$') THEN 'invalid contact' END AS `q_contact`, CASE WHEN !exists(select 1 from `family_members` `fm` where `fm`.`learner_id` = `l`.`learner_id` AND `fm`.`is_deleted` = 0 AND `fm`.`is_guardian` = 1 limit 1) THEN 'no guardian-of-record' END AS `q_guardian` FROM `learners` AS `l` WHERE `l`.`is_deleted` = 0 HAVING `q_sex` is not null OR `q_dob` is not null OR `q_birthplace` is not null OR `q_contact` is not null OR `q_guardian` is not null ;

-- --------------------------------------------------------

--
-- Structure for view `v_mapeh_quarterly_averages`
--
DROP TABLE IF EXISTS `v_mapeh_quarterly_averages`;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_mapeh_quarterly_averages`  AS SELECT `g`.`enrollment_id` AS `enrollment_id`, `g`.`grading_period_id` AS `grading_period_id`, round(avg(`g`.`quarterly_grade`),2) AS `mapeh_quarterly_grade`, count(0) AS `components_count` FROM (`grades` `g` join `class_offerings` `co` on(`co`.`class_id` = `g`.`class_id`)) WHERE `co`.`subject_id` in (13,14,15,16) AND `g`.`quarterly_grade` is not null AND `g`.`is_deleted` = 0 GROUP BY `g`.`enrollment_id`, `g`.`grading_period_id` ;

-- --------------------------------------------------------

--
-- Structure for view `v_migration_orphans`
--
DROP TABLE IF EXISTS `v_migration_orphans`;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_migration_orphans`  AS SELECT 'enrollments.curriculum_id' AS `fk`, `e`.`enrollment_id` AS `record_id`, `e`.`curriculum_id` AS `bad_value` FROM (`enrollments` `e` left join `curricula` `c` on(`c`.`curriculum_id` = `e`.`curriculum_id`)) WHERE `e`.`curriculum_id` is not null AND `c`.`curriculum_id` is null ;

-- --------------------------------------------------------

--
-- Structure for view `v_report_card_subject_quarters`
--
DROP TABLE IF EXISTS `v_report_card_subject_quarters`;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_report_card_subject_quarters`  AS SELECT `rc`.`report_card_id` AS `report_card_id`, `rc`.`enrollment_id` AS `enrollment_id`, `rcg`.`subject_name` AS `subject_name`, max(case when `rcg`.`quarter_no` = 1 then `rcg`.`quarterly_grade` end) AS `q1_grade`, max(case when `rcg`.`quarter_no` = 2 then `rcg`.`quarterly_grade` end) AS `q2_grade`, max(case when `rcg`.`quarter_no` = 3 then `rcg`.`quarterly_grade` end) AS `q3_grade`, max(case when `rcg`.`quarter_no` = 4 then `rcg`.`quarterly_grade` end) AS `q4_grade`, max(`rcg`.`final_grade`) AS `final_grade`, max(`rcg`.`remark`) AS `remark` FROM (`report_cards` `rc` join `report_card_grades` `rcg` on(`rcg`.`report_card_id` = `rc`.`report_card_id`)) GROUP BY `rc`.`report_card_id`, `rc`.`enrollment_id`, `rcg`.`subject_name` ;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `announcements`
--
ALTER TABLE `announcements`
  ADD PRIMARY KEY (`announcement_id`),
  ADD KEY `idx_ann_posted_by` (`posted_by`),
  ADD KEY `idx_ann_target_role` (`target_role_id`),
  ADD KEY `idx_published_at` (`published_at`);

--
-- Indexes for table `attendance`
--
ALTER TABLE `attendance`
  ADD PRIMARY KEY (`attendance_id`),
  ADD UNIQUE KEY `uq_sf2_attendance` (`enrollment_id`,`class_id`,`attendance_date`,`session`),
  ADD KEY `idx_att_enrollment` (`enrollment_id`),
  ADD KEY `idx_att_class` (`class_id`),
  ADD KEY `idx_att_period` (`grading_period_id`),
  ADD KEY `idx_att_date` (`attendance_date`),
  ADD KEY `idx_att_status` (`status`),
  ADD KEY `fk_att_recorded` (`recorded_by`);

--
-- Indexes for table `attendance_monthly_summaries`
--
ALTER TABLE `attendance_monthly_summaries`
  ADD PRIMARY KEY (`summary_id`),
  ADD UNIQUE KEY `uq_att_monthly` (`enrollment_id`,`school_year_id`,`month_no`),
  ADD KEY `idx_att_monthly_sy` (`school_year_id`,`month_no`),
  ADD KEY `fk_att_monthly_user` (`computed_by`);

--
-- Indexes for table `audit_logs`
--
ALTER TABLE `audit_logs`
  ADD PRIMARY KEY (`audit_id`),
  ADD KEY `idx_audit_user` (`user_id`),
  ADD KEY `idx_audit_table_record` (`table_name`,`record_id`),
  ADD KEY `idx_audit_action_time` (`action_time`);

--
-- Indexes for table `citizenships`
--
ALTER TABLE `citizenships`
  ADD PRIMARY KEY (`citizenship_id`),
  ADD UNIQUE KEY `uq_country_name` (`country_name`);

--
-- Indexes for table `class_assessment_items`
--
ALTER TABLE `class_assessment_items`
  ADD PRIMARY KEY (`assessment_item_id`),
  ADD KEY `idx_cai_class_period` (`class_id`,`grading_period_id`),
  ADD KEY `idx_cai_component` (`component_code`),
  ADD KEY `fk_cai_period` (`grading_period_id`),
  ADD KEY `fk_cai_created_by` (`created_by`);

--
-- Indexes for table `class_offerings`
--
ALTER TABLE `class_offerings`
  ADD PRIMARY KEY (`class_id`),
  ADD UNIQUE KEY `uq_class_offering` (`subject_id`,`section_id`,`teacher_id`,`school_year_id`),
  ADD KEY `idx_class_subject` (`subject_id`),
  ADD KEY `idx_class_section` (`section_id`),
  ADD KEY `idx_class_teacher` (`teacher_id`),
  ADD KEY `idx_class_sy` (`school_year_id`);

--
-- Indexes for table `class_offering_assignment_requests`
--
ALTER TABLE `class_offering_assignment_requests`
  ADD PRIMARY KEY (`request_id`),
  ADD KEY `idx_coar_section_sy` (`section_id`,`school_year_id`),
  ADD KEY `idx_coar_status` (`status`);

--
-- Indexes for table `class_offering_assignment_request_items`
--
ALTER TABLE `class_offering_assignment_request_items`
  ADD PRIMARY KEY (`request_item_id`),
  ADD UNIQUE KEY `uq_coari_request_subject` (`request_id`,`subject_id`),
  ADD KEY `idx_coari_request` (`request_id`),
  ADD KEY `idx_coari_subject_teacher` (`subject_id`,`teacher_id`);

--
-- Indexes for table `class_schedules`
--
ALTER TABLE `class_schedules`
  ADD PRIMARY KEY (`schedule_id`),
  ADD UNIQUE KEY `uq_class_schedule_slot` (`school_year_id`,`section_id`,`day_of_week`,`start_time`,`end_time`,`is_active_slot`),
  ADD KEY `idx_cs_class` (`class_id`),
  ADD KEY `idx_cs_school_year` (`school_year_id`),
  ADD KEY `idx_cs_section` (`section_id`),
  ADD KEY `idx_cs_day` (`day_of_week`),
  ADD KEY `idx_cs_teacher_day` (`teacher_id`,`day_of_week`),
  ADD KEY `idx_cs_day_time` (`day_of_week`,`start_time`,`end_time`);

--
-- Indexes for table `curricula`
--
ALTER TABLE `curricula`
  ADD PRIMARY KEY (`curriculum_id`),
  ADD UNIQUE KEY `uq_curriculum_code` (`curriculum_code`),
  ADD KEY `idx_cur_active` (`is_active`,`is_deleted`),
  ADD KEY `fk_cur_created_by` (`created_by`);

--
-- Indexes for table `curriculum_grade_levels`
--
ALTER TABLE `curriculum_grade_levels`
  ADD PRIMARY KEY (`cgl_id`),
  ADD UNIQUE KEY `uq_cgl_cur_grade` (`curriculum_id`,`grade_level_id`),
  ADD KEY `idx_cgl_curriculum` (`curriculum_id`),
  ADD KEY `idx_cgl_grade` (`grade_level_id`);

--
-- Indexes for table `curriculum_grading_components`
--
ALTER TABLE `curriculum_grading_components`
  ADD PRIMARY KEY (`component_id`),
  ADD UNIQUE KEY `uq_cgc_cur_grade_code` (`curriculum_id`,`grade_level_id`,`component_code`),
  ADD KEY `idx_cgc_curriculum` (`curriculum_id`),
  ADD KEY `idx_cgc_grade` (`grade_level_id`);

--
-- Indexes for table `curriculum_learning_areas`
--
ALTER TABLE `curriculum_learning_areas`
  ADD PRIMARY KEY (`area_id`),
  ADD UNIQUE KEY `uq_cla_curriculum_code` (`curriculum_id`,`area_code`),
  ADD KEY `idx_cla_curriculum` (`curriculum_id`);

--
-- Indexes for table `curriculum_passing_marks`
--
ALTER TABLE `curriculum_passing_marks`
  ADD PRIMARY KEY (`passing_mark_id`),
  ADD UNIQUE KEY `uq_cpm_cur_grade_subj` (`curriculum_id`,`grade_level_id`,`subject_id`),
  ADD KEY `idx_cpm_curriculum` (`curriculum_id`),
  ADD KEY `fk_cpm_grade_level` (`grade_level_id`),
  ADD KEY `fk_cpm_subject` (`subject_id`);

--
-- Indexes for table `curriculum_school_year_map`
--
ALTER TABLE `curriculum_school_year_map`
  ADD PRIMARY KEY (`map_id`),
  ADD UNIQUE KEY `uq_csym_cur_sy` (`curriculum_id`,`school_year_id`),
  ADD KEY `idx_csym_curriculum` (`curriculum_id`),
  ADD KEY `idx_csym_school_year` (`school_year_id`);

--
-- Indexes for table `curriculum_subjects`
--
ALTER TABLE `curriculum_subjects`
  ADD PRIMARY KEY (`curriculum_subject_id`),
  ADD UNIQUE KEY `uq_cs_cur_grade_subj` (`curriculum_id`,`grade_level_id`,`subject_id`),
  ADD KEY `idx_cs_curriculum` (`curriculum_id`),
  ADD KEY `idx_cs_grade` (`grade_level_id`),
  ADD KEY `idx_cs_subject` (`subject_id`),
  ADD KEY `idx_cs_learning_area` (`learning_area_id`);

--
-- Indexes for table `deped_transmutation_table`
--
ALTER TABLE `deped_transmutation_table`
  ADD PRIMARY KEY (`transmutation_id`),
  ADD UNIQUE KEY `uq_transmutation_range` (`initial_grade_from`,`initial_grade_to`);

--
-- Indexes for table `document_types`
--
ALTER TABLE `document_types`
  ADD PRIMARY KEY (`document_type_id`),
  ADD UNIQUE KEY `uq_document_type_name` (`type_name`);

--
-- Indexes for table `education_levels`
--
ALTER TABLE `education_levels`
  ADD PRIMARY KEY (`education_level_id`),
  ADD UNIQUE KEY `uq_level_name` (`level_name`);

--
-- Indexes for table `emergency_contacts`
--
ALTER TABLE `emergency_contacts`
  ADD PRIMARY KEY (`emergency_contact_id`),
  ADD KEY `idx_ec_learner` (`learner_id`);

--
-- Indexes for table `employees`
--
ALTER TABLE `employees`
  ADD PRIMARY KEY (`employee_id`),
  ADD UNIQUE KEY `uq_employee_user` (`user_id`),
  ADD UNIQUE KEY `uq_employee_number` (`employee_number`),
  ADD KEY `idx_emp_position` (`position_id`);

--
-- Indexes for table `enrollments`
--
ALTER TABLE `enrollments`
  ADD PRIMARY KEY (`enrollment_id`),
  ADD UNIQUE KEY `uq_learner_school_year` (`learner_id`,`school_year_id`),
  ADD KEY `idx_enroll_learner` (`learner_id`),
  ADD KEY `idx_enroll_sy` (`school_year_id`),
  ADD KEY `idx_enroll_grade` (`grade_level_id`),
  ADD KEY `idx_enroll_section` (`section_id`),
  ADD KEY `idx_enroll_curriculum` (`curriculum_id`),
  ADD KEY `idx_dash_composite` (`school_year_id`,`grade_level_id`,`section_id`),
  ADD KEY `fk_enroll_type_id` (`enrollment_type_id`);

--
-- Indexes for table `enrollment_requirements`
--
ALTER TABLE `enrollment_requirements`
  ADD PRIMARY KEY (`requirement_id`),
  ADD UNIQUE KEY `uq_er_sy_grade_doc` (`school_year_id`,`grade_level_id`,`document_type_id`),
  ADD KEY `idx_er_school_year` (`school_year_id`),
  ADD KEY `idx_er_grade_level` (`grade_level_id`),
  ADD KEY `idx_er_document_type` (`document_type_id`);

--
-- Indexes for table `enrollment_types`
--
ALTER TABLE `enrollment_types`
  ADD PRIMARY KEY (`enrollment_type_id`),
  ADD UNIQUE KEY `uq_enrollment_type_name` (`type_name`);

--
-- Indexes for table `family_members`
--
ALTER TABLE `family_members`
  ADD PRIMARY KEY (`family_member_id`),
  ADD UNIQUE KEY `uq_fm_learner_rel_name` (`learner_id`,`relationship`,`full_name`),
  ADD KEY `idx_family_learner` (`learner_id`);

--
-- Indexes for table `final_grades`
--
ALTER TABLE `final_grades`
  ADD PRIMARY KEY (`final_grade_id`),
  ADD UNIQUE KEY `uq_final_grade_enrollment_class` (`enrollment_id`,`class_id`),
  ADD KEY `idx_fg_class` (`class_id`),
  ADD KEY `idx_fg_computed_by` (`computed_by`);

--
-- Indexes for table `final_grade_quarter_sources`
--
ALTER TABLE `final_grade_quarter_sources`
  ADD PRIMARY KEY (`source_id`),
  ADD UNIQUE KEY `uq_fgqs_final_quarter` (`final_grade_id`,`quarter_no`),
  ADD UNIQUE KEY `uq_fgqs_final_gradeid` (`final_grade_id`,`grade_id`),
  ADD KEY `fk_fgqs_grade` (`grade_id`);

--
-- Indexes for table `general_averages`
--
ALTER TABLE `general_averages`
  ADD PRIMARY KEY (`general_average_id`),
  ADD UNIQUE KEY `uq_ga_enrollment` (`enrollment_id`),
  ADD KEY `idx_ga_school_year` (`school_year_id`),
  ADD KEY `idx_ga_computed_by` (`computed_by`);

--
-- Indexes for table `geo_barangays`
--
ALTER TABLE `geo_barangays`
  ADD PRIMARY KEY (`barangay_id`),
  ADD UNIQUE KEY `uq_geo_barangay_city_name` (`city_municipality_id`,`barangay_name`),
  ADD KEY `idx_geo_barangay_citymun` (`city_municipality_id`);

--
-- Indexes for table `geo_cities_municipalities`
--
ALTER TABLE `geo_cities_municipalities`
  ADD PRIMARY KEY (`city_municipality_id`),
  ADD UNIQUE KEY `uq_geo_citymun_prov_name` (`province_id`,`city_municipality_name`),
  ADD KEY `idx_geo_citymun_province` (`province_id`);

--
-- Indexes for table `geo_name_aliases`
--
ALTER TABLE `geo_name_aliases`
  ADD PRIMARY KEY (`geo_alias_id`),
  ADD UNIQUE KEY `uq_gna_type_alias` (`geo_type`,`alias`);

--
-- Indexes for table `geo_provinces`
--
ALTER TABLE `geo_provinces`
  ADD PRIMARY KEY (`province_id`),
  ADD UNIQUE KEY `uq_geo_provinces_name` (`province_name`),
  ADD UNIQUE KEY `uq_geo_provinces_psgc` (`psgc_code`);

--
-- Indexes for table `grades`
--
ALTER TABLE `grades`
  ADD PRIMARY KEY (`grade_id`),
  ADD UNIQUE KEY `uq_grade_entry` (`enrollment_id`,`class_id`,`grading_period_id`),
  ADD KEY `idx_grade_class` (`class_id`),
  ADD KEY `idx_grade_period` (`grading_period_id`),
  ADD KEY `fk_grades_encoder` (`encoded_by`);

--
-- Indexes for table `grade_component_summaries`
--
ALTER TABLE `grade_component_summaries`
  ADD PRIMARY KEY (`component_summary_id`),
  ADD UNIQUE KEY `uq_gcs_grade_component` (`grade_id`,`component_code`),
  ADD KEY `idx_gcs_grade` (`grade_id`);

--
-- Indexes for table `grade_levels`
--
ALTER TABLE `grade_levels`
  ADD PRIMARY KEY (`grade_level_id`),
  ADD UNIQUE KEY `uq_grade_name` (`grade_name`),
  ADD KEY `idx_grade_level_education` (`education_level_id`);

--
-- Indexes for table `grade_level_aliases`
--
ALTER TABLE `grade_level_aliases`
  ADD PRIMARY KEY (`alias_id`),
  ADD UNIQUE KEY `uq_gla_alias` (`alias`),
  ADD KEY `idx_gla_grade` (`grade_level_id`);

--
-- Indexes for table `grade_level_progression`
--
ALTER TABLE `grade_level_progression`
  ADD PRIMARY KEY (`grade_level_id`),
  ADD KEY `idx_glp_next_grade` (`next_grade_level_id`);

--
-- Indexes for table `grading_periods`
--
ALTER TABLE `grading_periods`
  ADD PRIMARY KEY (`grading_period_id`),
  ADD UNIQUE KEY `uq_period_school_year` (`school_year_id`,`period_name`),
  ADD UNIQUE KEY `uq_gp_school_year_quarter_no` (`school_year_id`,`quarter_no`),
  ADD KEY `idx_gp_locked_by` (`locked_by`);

--
-- Indexes for table `honor_levels`
--
ALTER TABLE `honor_levels`
  ADD PRIMARY KEY (`honor_level_id`),
  ADD UNIQUE KEY `uq_honor_name` (`honor_name`);

--
-- Indexes for table `import_logs`
--
ALTER TABLE `import_logs`
  ADD PRIMARY KEY (`import_id`),
  ADD KEY `idx_il_imported_by` (`imported_by`),
  ADD KEY `idx_il_school_year` (`school_year_id`),
  ADD KEY `idx_il_imported_at` (`imported_at`),
  ADD KEY `idx_il_status` (`status`),
  ADD KEY `fk_il_school` (`school_id`),
  ADD KEY `fk_il_template` (`template_id`);

--
-- Indexes for table `import_log_rows`
--
ALTER TABLE `import_log_rows`
  ADD PRIMARY KEY (`row_id`),
  ADD KEY `idx_ilr_import` (`import_id`),
  ADD KEY `idx_ilr_lrn` (`lrn`),
  ADD KEY `idx_ilr_action` (`row_action`);

--
-- Indexes for table `import_templates`
--
ALTER TABLE `import_templates`
  ADD PRIMARY KEY (`template_id`),
  ADD UNIQUE KEY `uq_template_name_version` (`template_name`,`version`),
  ADD KEY `idx_template_hash` (`header_hash`);

--
-- Indexes for table `interventions`
--
ALTER TABLE `interventions`
  ADD PRIMARY KEY (`intervention_id`),
  ADD KEY `idx_iv_enrollment` (`enrollment_id`),
  ADD KEY `idx_iv_risk` (`risk_assessment_id`),
  ADD KEY `idx_iv_conductor` (`conducted_by`);

--
-- Indexes for table `kindergarten_anecdotal_records`
--
ALTER TABLE `kindergarten_anecdotal_records`
  ADD PRIMARY KEY (`anecdotal_id`),
  ADD KEY `idx_kg_anecdotal_enrollment` (`enrollment_id`),
  ADD KEY `idx_kg_anecdotal_period` (`grading_period_id`);

--
-- Indexes for table `kindergarten_checklists`
--
ALTER TABLE `kindergarten_checklists`
  ADD PRIMARY KEY (`kg_checklist_id`),
  ADD UNIQUE KEY `uq_kg_checklist_unique` (`enrollment_id`,`grading_period_id`,`kg_standard_id`),
  ADD KEY `idx_kg_checklist_enrollment` (`enrollment_id`),
  ADD KEY `idx_kg_checklist_period` (`grading_period_id`),
  ADD KEY `idx_kg_checklist_standard` (`kg_standard_id`);

--
-- Indexes for table `kindergarten_learning_standards`
--
ALTER TABLE `kindergarten_learning_standards`
  ADD PRIMARY KEY (`kg_standard_id`),
  ADD UNIQUE KEY `uq_kg_std` (`curriculum_id`,`standard_code`),
  ADD KEY `idx_kg_std_curriculum` (`curriculum_id`);

--
-- Indexes for table `kindergarten_portfolios`
--
ALTER TABLE `kindergarten_portfolios`
  ADD PRIMARY KEY (`portfolio_id`),
  ADD KEY `idx_kg_portfolio_enrollment` (`enrollment_id`),
  ADD KEY `idx_kg_portfolio_period` (`grading_period_id`);

--
-- Indexes for table `kindergarten_quarterly_reports`
--
ALTER TABLE `kindergarten_quarterly_reports`
  ADD PRIMARY KEY (`kg_report_id`),
  ADD UNIQUE KEY `uq_kg_report_enrollment_period` (`enrollment_id`,`grading_period_id`),
  ADD KEY `idx_kg_report_period` (`grading_period_id`);

--
-- Indexes for table `learners`
--
ALTER TABLE `learners`
  ADD PRIMARY KEY (`learner_id`),
  ADD UNIQUE KEY `uq_learner_lrn` (`lrn`),
  ADD UNIQUE KEY `uq_learner_user` (`user_id`),
  ADD KEY `fk_learner_birth_province` (`birth_province_id`),
  ADD KEY `idx_learner_name` (`last_name`,`first_name`,`middle_name`);

--
-- Indexes for table `learner_addresses`
--
ALTER TABLE `learner_addresses`
  ADD PRIMARY KEY (`learner_address_id`),
  ADD UNIQUE KEY `uq_la_learner_active` (`learner_id`,`active_type`),
  ADD KEY `idx_la_learner` (`learner_id`),
  ADD KEY `idx_la_province` (`province_id`),
  ADD KEY `idx_la_citymun` (`city_municipality_id`),
  ADD KEY `idx_la_barangay` (`barangay_id`);

--
-- Indexes for table `learner_assessment_scores`
--
ALTER TABLE `learner_assessment_scores`
  ADD PRIMARY KEY (`assessment_score_id`),
  ADD UNIQUE KEY `uq_las_item_enrollment` (`assessment_item_id`,`enrollment_id`),
  ADD KEY `idx_las_enrollment` (`enrollment_id`);

--
-- Indexes for table `learner_progression`
--
ALTER TABLE `learner_progression`
  ADD PRIMARY KEY (`progression_id`),
  ADD UNIQUE KEY `uq_lp_enrollment` (`enrollment_id`),
  ADD KEY `idx_lp_learner_sy` (`learner_id`,`school_year_id`),
  ADD KEY `idx_lp_sy_processed` (`school_year_id`,`is_processed`),
  ADD KEY `idx_lp_next_grade` (`next_grade_level_id`),
  ADD KEY `fk_lp_current_grade` (`current_grade_level_id`);

--
-- Indexes for table `notifications`
--
ALTER TABLE `notifications`
  ADD PRIMARY KEY (`notification_id`),
  ADD KEY `idx_notif_user` (`user_id`),
  ADD KEY `idx_notif_read` (`is_read`);

--
-- Indexes for table `permissions`
--
ALTER TABLE `permissions`
  ADD PRIMARY KEY (`permission_id`),
  ADD UNIQUE KEY `uq_permission_code` (`permission_code`);

--
-- Indexes for table `positions`
--
ALTER TABLE `positions`
  ADD PRIMARY KEY (`position_id`),
  ADD UNIQUE KEY `uq_position_name` (`position_name`);

--
-- Indexes for table `remedial_classes`
--
ALTER TABLE `remedial_classes`
  ADD PRIMARY KEY (`remedial_id`),
  ADD UNIQUE KEY `uq_remedial_enrollment_class` (`enrollment_id`,`class_id`) COMMENT 'One remedial entry per subject per enrollment SY',
  ADD KEY `idx_rc_enrollment` (`enrollment_id`),
  ADD KEY `idx_rc_class` (`class_id`),
  ADD KEY `idx_rc_recorded_by` (`recorded_by`);

--
-- Indexes for table `report_cards`
--
ALTER TABLE `report_cards`
  ADD PRIMARY KEY (`report_card_id`),
  ADD UNIQUE KEY `uq_rc_enrollment_period` (`enrollment_id`,`grading_period_id`),
  ADD KEY `idx_rc_period` (`grading_period_id`),
  ADD KEY `idx_rc_generated_by` (`generated_by`);

--
-- Indexes for table `report_card_grades`
--
ALTER TABLE `report_card_grades`
  ADD PRIMARY KEY (`rc_grade_id`),
  ADD UNIQUE KEY `uq_rcg_card_subject_qtr` (`report_card_id`,`subject_name`,`quarter_no`),
  ADD KEY `idx_rcg_report_card` (`report_card_id`);

--
-- Indexes for table `risk_assessments`
--
ALTER TABLE `risk_assessments`
  ADD PRIMARY KEY (`risk_assessment_id`),
  ADD UNIQUE KEY `uq_risk_enrollment_period` (`enrollment_id`,`grading_period_id`),
  ADD KEY `idx_risk_period` (`grading_period_id`),
  ADD KEY `idx_risk_level` (`risk_level_id`),
  ADD KEY `idx_risk_assessed_by` (`assessed_by`);

--
-- Indexes for table `risk_indicators`
--
ALTER TABLE `risk_indicators`
  ADD PRIMARY KEY (`indicator_id`),
  ADD UNIQUE KEY `uq_ri_assessment_type` (`risk_assessment_id`,`indicator_type`),
  ADD KEY `idx_ri_assessment` (`risk_assessment_id`);

--
-- Indexes for table `risk_levels`
--
ALTER TABLE `risk_levels`
  ADD PRIMARY KEY (`risk_level_id`),
  ADD UNIQUE KEY `uq_risk_name` (`risk_name`);

--
-- Indexes for table `roles`
--
ALTER TABLE `roles`
  ADD PRIMARY KEY (`role_id`),
  ADD UNIQUE KEY `uq_role_name` (`role_name`);

--
-- Indexes for table `role_permissions`
--
ALTER TABLE `role_permissions`
  ADD PRIMARY KEY (`role_id`,`permission_id`),
  ADD KEY `idx_rp_permission` (`permission_id`),
  ADD KEY `idx_rp_created_by` (`created_by`);

--
-- Indexes for table `schools`
--
ALTER TABLE `schools`
  ADD PRIMARY KEY (`school_id`),
  ADD UNIQUE KEY `uq_deped_school_id` (`deped_school_id`);

--
-- Indexes for table `school_settings`
--
ALTER TABLE `school_settings`
  ADD PRIMARY KEY (`setting_id`),
  ADD UNIQUE KEY `uq_setting_key` (`setting_key`),
  ADD KEY `idx_ss_updated_by` (`updated_by`);

--
-- Indexes for table `school_years`
--
ALTER TABLE `school_years`
  ADD PRIMARY KEY (`school_year_id`);

--
-- Indexes for table `sections`
--
ALTER TABLE `sections`
  ADD PRIMARY KEY (`section_id`),
  ADD UNIQUE KEY `uq_section_grade_sy` (`grade_level_id`,`section_name`,`school_year_id`),
  ADD KEY `idx_section_grade_level` (`grade_level_id`),
  ADD KEY `idx_section_sy` (`school_year_id`),
  ADD KEY `idx_section_adviser` (`adviser_id`),
  ADD KEY `idx_section_education_level` (`education_level_id`);

--
-- Indexes for table `section_rankings`
--
ALTER TABLE `section_rankings`
  ADD PRIMARY KEY (`ranking_id`),
  ADD UNIQUE KEY `uq_ranking_enrollment` (`enrollment_id`),
  ADD KEY `idx_ranking_section_sy` (`section_id`,`school_year_id`),
  ADD KEY `idx_ranking_honor` (`honor_level_id`),
  ADD KEY `idx_ranking_ranked_by` (`ranked_by`),
  ADD KEY `fk_sr_school_year` (`school_year_id`);

--
-- Indexes for table `sf1_import_staging`
--
ALTER TABLE `sf1_import_staging`
  ADD PRIMARY KEY (`staging_id`),
  ADD UNIQUE KEY `uq_stg_import_row` (`import_id`,`row_number`),
  ADD KEY `idx_stg_import_status` (`import_id`,`validation_status`),
  ADD KEY `idx_stg_norm_lrn` (`norm_lrn`);

--
-- Indexes for table `sf1_remark_map`
--
ALTER TABLE `sf1_remark_map`
  ADD PRIMARY KEY (`remark_map_id`),
  ADD UNIQUE KEY `uq_srm_raw` (`raw_remark`);

--
-- Indexes for table `sf1_value_norms`
--
ALTER TABLE `sf1_value_norms`
  ADD PRIMARY KEY (`norm_id`),
  ADD UNIQUE KEY `uq_svn_field_raw` (`field_name`,`raw_value`);

--
-- Indexes for table `subjects`
--
ALTER TABLE `subjects`
  ADD PRIMARY KEY (`subject_id`),
  ADD UNIQUE KEY `uq_subject_code` (`subject_code`),
  ADD KEY `idx_subj_specialist` (`is_specialist_assignable`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`user_id`),
  ADD UNIQUE KEY `uq_username` (`username`),
  ADD KEY `idx_user_role` (`role_id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `announcements`
--
ALTER TABLE `announcements`
  MODIFY `announcement_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `attendance`
--
ALTER TABLE `attendance`
  MODIFY `attendance_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `attendance_monthly_summaries`
--
ALTER TABLE `attendance_monthly_summaries`
  MODIFY `summary_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `audit_logs`
--
ALTER TABLE `audit_logs`
  MODIFY `audit_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `citizenships`
--
ALTER TABLE `citizenships`
  MODIFY `citizenship_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `class_assessment_items`
--
ALTER TABLE `class_assessment_items`
  MODIFY `assessment_item_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `class_offerings`
--
ALTER TABLE `class_offerings`
  MODIFY `class_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `class_offering_assignment_requests`
--
ALTER TABLE `class_offering_assignment_requests`
  MODIFY `request_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `class_offering_assignment_request_items`
--
ALTER TABLE `class_offering_assignment_request_items`
  MODIFY `request_item_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `class_schedules`
--
ALTER TABLE `class_schedules`
  MODIFY `schedule_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `curricula`
--
ALTER TABLE `curricula`
  MODIFY `curriculum_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `curriculum_grade_levels`
--
ALTER TABLE `curriculum_grade_levels`
  MODIFY `cgl_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `curriculum_grading_components`
--
ALTER TABLE `curriculum_grading_components`
  MODIFY `component_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `curriculum_learning_areas`
--
ALTER TABLE `curriculum_learning_areas`
  MODIFY `area_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `curriculum_passing_marks`
--
ALTER TABLE `curriculum_passing_marks`
  MODIFY `passing_mark_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `curriculum_school_year_map`
--
ALTER TABLE `curriculum_school_year_map`
  MODIFY `map_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `curriculum_subjects`
--
ALTER TABLE `curriculum_subjects`
  MODIFY `curriculum_subject_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `deped_transmutation_table`
--
ALTER TABLE `deped_transmutation_table`
  MODIFY `transmutation_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `document_types`
--
ALTER TABLE `document_types`
  MODIFY `document_type_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `education_levels`
--
ALTER TABLE `education_levels`
  MODIFY `education_level_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `emergency_contacts`
--
ALTER TABLE `emergency_contacts`
  MODIFY `emergency_contact_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `employees`
--
ALTER TABLE `employees`
  MODIFY `employee_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `enrollments`
--
ALTER TABLE `enrollments`
  MODIFY `enrollment_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `enrollment_requirements`
--
ALTER TABLE `enrollment_requirements`
  MODIFY `requirement_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `enrollment_types`
--
ALTER TABLE `enrollment_types`
  MODIFY `enrollment_type_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `family_members`
--
ALTER TABLE `family_members`
  MODIFY `family_member_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `final_grades`
--
ALTER TABLE `final_grades`
  MODIFY `final_grade_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `final_grade_quarter_sources`
--
ALTER TABLE `final_grade_quarter_sources`
  MODIFY `source_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `general_averages`
--
ALTER TABLE `general_averages`
  MODIFY `general_average_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `geo_barangays`
--
ALTER TABLE `geo_barangays`
  MODIFY `barangay_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `geo_cities_municipalities`
--
ALTER TABLE `geo_cities_municipalities`
  MODIFY `city_municipality_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `geo_name_aliases`
--
ALTER TABLE `geo_name_aliases`
  MODIFY `geo_alias_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `geo_provinces`
--
ALTER TABLE `geo_provinces`
  MODIFY `province_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `grades`
--
ALTER TABLE `grades`
  MODIFY `grade_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `grade_component_summaries`
--
ALTER TABLE `grade_component_summaries`
  MODIFY `component_summary_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `grade_levels`
--
ALTER TABLE `grade_levels`
  MODIFY `grade_level_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `grade_level_aliases`
--
ALTER TABLE `grade_level_aliases`
  MODIFY `alias_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `grading_periods`
--
ALTER TABLE `grading_periods`
  MODIFY `grading_period_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `honor_levels`
--
ALTER TABLE `honor_levels`
  MODIFY `honor_level_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `import_logs`
--
ALTER TABLE `import_logs`
  MODIFY `import_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `import_log_rows`
--
ALTER TABLE `import_log_rows`
  MODIFY `row_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `import_templates`
--
ALTER TABLE `import_templates`
  MODIFY `template_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `interventions`
--
ALTER TABLE `interventions`
  MODIFY `intervention_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `kindergarten_anecdotal_records`
--
ALTER TABLE `kindergarten_anecdotal_records`
  MODIFY `anecdotal_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `kindergarten_checklists`
--
ALTER TABLE `kindergarten_checklists`
  MODIFY `kg_checklist_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `kindergarten_learning_standards`
--
ALTER TABLE `kindergarten_learning_standards`
  MODIFY `kg_standard_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `kindergarten_portfolios`
--
ALTER TABLE `kindergarten_portfolios`
  MODIFY `portfolio_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `kindergarten_quarterly_reports`
--
ALTER TABLE `kindergarten_quarterly_reports`
  MODIFY `kg_report_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `learners`
--
ALTER TABLE `learners`
  MODIFY `learner_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `learner_addresses`
--
ALTER TABLE `learner_addresses`
  MODIFY `learner_address_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `learner_assessment_scores`
--
ALTER TABLE `learner_assessment_scores`
  MODIFY `assessment_score_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `learner_progression`
--
ALTER TABLE `learner_progression`
  MODIFY `progression_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `notifications`
--
ALTER TABLE `notifications`
  MODIFY `notification_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `permissions`
--
ALTER TABLE `permissions`
  MODIFY `permission_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `positions`
--
ALTER TABLE `positions`
  MODIFY `position_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `remedial_classes`
--
ALTER TABLE `remedial_classes`
  MODIFY `remedial_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `report_cards`
--
ALTER TABLE `report_cards`
  MODIFY `report_card_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `report_card_grades`
--
ALTER TABLE `report_card_grades`
  MODIFY `rc_grade_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `risk_assessments`
--
ALTER TABLE `risk_assessments`
  MODIFY `risk_assessment_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `risk_indicators`
--
ALTER TABLE `risk_indicators`
  MODIFY `indicator_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `risk_levels`
--
ALTER TABLE `risk_levels`
  MODIFY `risk_level_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `roles`
--
ALTER TABLE `roles`
  MODIFY `role_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `schools`
--
ALTER TABLE `schools`
  MODIFY `school_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `school_settings`
--
ALTER TABLE `school_settings`
  MODIFY `setting_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `school_years`
--
ALTER TABLE `school_years`
  MODIFY `school_year_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `sections`
--
ALTER TABLE `sections`
  MODIFY `section_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `section_rankings`
--
ALTER TABLE `section_rankings`
  MODIFY `ranking_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `sf1_import_staging`
--
ALTER TABLE `sf1_import_staging`
  MODIFY `staging_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `sf1_remark_map`
--
ALTER TABLE `sf1_remark_map`
  MODIFY `remark_map_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `sf1_value_norms`
--
ALTER TABLE `sf1_value_norms`
  MODIFY `norm_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `subjects`
--
ALTER TABLE `subjects`
  MODIFY `subject_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `user_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `announcements`
--
ALTER TABLE `announcements`
  ADD CONSTRAINT `fk_ann_posted_by` FOREIGN KEY (`posted_by`) REFERENCES `users` (`user_id`),
  ADD CONSTRAINT `fk_ann_target_role` FOREIGN KEY (`target_role_id`) REFERENCES `roles` (`role_id`);

--
-- Constraints for table `attendance`
--
ALTER TABLE `attendance`
  ADD CONSTRAINT `fk_att_class` FOREIGN KEY (`class_id`) REFERENCES `class_offerings` (`class_id`),
  ADD CONSTRAINT `fk_att_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_att_period` FOREIGN KEY (`grading_period_id`) REFERENCES `grading_periods` (`grading_period_id`),
  ADD CONSTRAINT `fk_att_recorded` FOREIGN KEY (`recorded_by`) REFERENCES `users` (`user_id`);

--
-- Constraints for table `attendance_monthly_summaries`
--
ALTER TABLE `attendance_monthly_summaries`
  ADD CONSTRAINT `fk_att_monthly_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_att_monthly_sy` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`),
  ADD CONSTRAINT `fk_att_monthly_user` FOREIGN KEY (`computed_by`) REFERENCES `users` (`user_id`);

--
-- Constraints for table `audit_logs`
--
ALTER TABLE `audit_logs`
  ADD CONSTRAINT `fk_audit_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`);

--
-- Constraints for table `class_assessment_items`
--
ALTER TABLE `class_assessment_items`
  ADD CONSTRAINT `fk_cai_class` FOREIGN KEY (`class_id`) REFERENCES `class_offerings` (`class_id`),
  ADD CONSTRAINT `fk_cai_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`user_id`),
  ADD CONSTRAINT `fk_cai_period` FOREIGN KEY (`grading_period_id`) REFERENCES `grading_periods` (`grading_period_id`);

--
-- Constraints for table `class_offerings`
--
ALTER TABLE `class_offerings`
  ADD CONSTRAINT `fk_class_section` FOREIGN KEY (`section_id`) REFERENCES `sections` (`section_id`),
  ADD CONSTRAINT `fk_class_subject` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`subject_id`),
  ADD CONSTRAINT `fk_class_sy` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`),
  ADD CONSTRAINT `fk_class_teacher` FOREIGN KEY (`teacher_id`) REFERENCES `employees` (`employee_id`);

--
-- Constraints for table `class_schedules`
--
ALTER TABLE `class_schedules`
  ADD CONSTRAINT `fk_cs_class` FOREIGN KEY (`class_id`) REFERENCES `class_offerings` (`class_id`),
  ADD CONSTRAINT `fk_cs_school_year` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`),
  ADD CONSTRAINT `fk_cs_section` FOREIGN KEY (`section_id`) REFERENCES `sections` (`section_id`),
  ADD CONSTRAINT `fk_cs_teacher` FOREIGN KEY (`teacher_id`) REFERENCES `employees` (`employee_id`);

--
-- Constraints for table `curricula`
--
ALTER TABLE `curricula`
  ADD CONSTRAINT `fk_cur_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`user_id`);

--
-- Constraints for table `curriculum_grade_levels`
--
ALTER TABLE `curriculum_grade_levels`
  ADD CONSTRAINT `fk_cgl_curriculum` FOREIGN KEY (`curriculum_id`) REFERENCES `curricula` (`curriculum_id`),
  ADD CONSTRAINT `fk_cgl_grade_level` FOREIGN KEY (`grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`);

--
-- Constraints for table `curriculum_grading_components`
--
ALTER TABLE `curriculum_grading_components`
  ADD CONSTRAINT `fk_cgc_curriculum` FOREIGN KEY (`curriculum_id`) REFERENCES `curricula` (`curriculum_id`),
  ADD CONSTRAINT `fk_cgc_grade_level` FOREIGN KEY (`grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`);

--
-- Constraints for table `curriculum_learning_areas`
--
ALTER TABLE `curriculum_learning_areas`
  ADD CONSTRAINT `fk_cla_curriculum` FOREIGN KEY (`curriculum_id`) REFERENCES `curricula` (`curriculum_id`);

--
-- Constraints for table `curriculum_passing_marks`
--
ALTER TABLE `curriculum_passing_marks`
  ADD CONSTRAINT `fk_cpm_curriculum` FOREIGN KEY (`curriculum_id`) REFERENCES `curricula` (`curriculum_id`),
  ADD CONSTRAINT `fk_cpm_grade_level` FOREIGN KEY (`grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`),
  ADD CONSTRAINT `fk_cpm_subject` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`subject_id`),
  ADD CONSTRAINT `fk_cpm_subject_fk` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`subject_id`);

--
-- Constraints for table `curriculum_school_year_map`
--
ALTER TABLE `curriculum_school_year_map`
  ADD CONSTRAINT `fk_csym_curriculum` FOREIGN KEY (`curriculum_id`) REFERENCES `curricula` (`curriculum_id`),
  ADD CONSTRAINT `fk_csym_school_year` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`);

--
-- Constraints for table `curriculum_subjects`
--
ALTER TABLE `curriculum_subjects`
  ADD CONSTRAINT `fk_cs_curriculum` FOREIGN KEY (`curriculum_id`) REFERENCES `curricula` (`curriculum_id`),
  ADD CONSTRAINT `fk_cs_grade_level` FOREIGN KEY (`grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`),
  ADD CONSTRAINT `fk_cs_learning_area` FOREIGN KEY (`learning_area_id`) REFERENCES `curriculum_learning_areas` (`area_id`),
  ADD CONSTRAINT `fk_cs_subject` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`subject_id`);

--
-- Constraints for table `emergency_contacts`
--
ALTER TABLE `emergency_contacts`
  ADD CONSTRAINT `fk_ec_learner` FOREIGN KEY (`learner_id`) REFERENCES `learners` (`learner_id`) ON DELETE CASCADE;

--
-- Constraints for table `employees`
--
ALTER TABLE `employees`
  ADD CONSTRAINT `fk_employee_position` FOREIGN KEY (`position_id`) REFERENCES `positions` (`position_id`),
  ADD CONSTRAINT `fk_employee_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`);

--
-- Constraints for table `enrollments`
--
ALTER TABLE `enrollments`
  ADD CONSTRAINT `fk_enroll_curriculum` FOREIGN KEY (`curriculum_id`) REFERENCES `curricula` (`curriculum_id`),
  ADD CONSTRAINT `fk_enroll_grade` FOREIGN KEY (`grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`),
  ADD CONSTRAINT `fk_enroll_learner` FOREIGN KEY (`learner_id`) REFERENCES `learners` (`learner_id`),
  ADD CONSTRAINT `fk_enroll_section` FOREIGN KEY (`section_id`) REFERENCES `sections` (`section_id`),
  ADD CONSTRAINT `fk_enroll_sy` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`),
  ADD CONSTRAINT `fk_enroll_type` FOREIGN KEY (`enrollment_type_id`) REFERENCES `enrollment_types` (`enrollment_type_id`);

--
-- Constraints for table `enrollment_requirements`
--
ALTER TABLE `enrollment_requirements`
  ADD CONSTRAINT `fk_er_doctype` FOREIGN KEY (`document_type_id`) REFERENCES `document_types` (`document_type_id`),
  ADD CONSTRAINT `fk_er_grade` FOREIGN KEY (`grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`),
  ADD CONSTRAINT `fk_er_sy` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`);

--
-- Constraints for table `family_members`
--
ALTER TABLE `family_members`
  ADD CONSTRAINT `fk_fm_learner` FOREIGN KEY (`learner_id`) REFERENCES `learners` (`learner_id`);

--
-- Constraints for table `final_grades`
--
ALTER TABLE `final_grades`
  ADD CONSTRAINT `fk_fg_class` FOREIGN KEY (`class_id`) REFERENCES `class_offerings` (`class_id`),
  ADD CONSTRAINT `fk_fg_computed_by` FOREIGN KEY (`computed_by`) REFERENCES `users` (`user_id`),
  ADD CONSTRAINT `fk_fg_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`);

--
-- Constraints for table `final_grade_quarter_sources`
--
ALTER TABLE `final_grade_quarter_sources`
  ADD CONSTRAINT `fk_fgqs_final` FOREIGN KEY (`final_grade_id`) REFERENCES `final_grades` (`final_grade_id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_fgqs_grade` FOREIGN KEY (`grade_id`) REFERENCES `grades` (`grade_id`);

--
-- Constraints for table `general_averages`
--
ALTER TABLE `general_averages`
  ADD CONSTRAINT `fk_ga_computed_by` FOREIGN KEY (`computed_by`) REFERENCES `users` (`user_id`),
  ADD CONSTRAINT `fk_ga_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_ga_sy` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`);

--
-- Constraints for table `grades`
--
ALTER TABLE `grades`
  ADD CONSTRAINT `fk_grades_class` FOREIGN KEY (`class_id`) REFERENCES `class_offerings` (`class_id`),
  ADD CONSTRAINT `fk_grades_encoder` FOREIGN KEY (`encoded_by`) REFERENCES `users` (`user_id`),
  ADD CONSTRAINT `fk_grades_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_grades_period` FOREIGN KEY (`grading_period_id`) REFERENCES `grading_periods` (`grading_period_id`);

--
-- Constraints for table `grade_component_summaries`
--
ALTER TABLE `grade_component_summaries`
  ADD CONSTRAINT `fk_gcs_grade` FOREIGN KEY (`grade_id`) REFERENCES `grades` (`grade_id`) ON DELETE CASCADE;

--
-- Constraints for table `grade_levels`
--
ALTER TABLE `grade_levels`
  ADD CONSTRAINT `fk_grade_levels_edu` FOREIGN KEY (`education_level_id`) REFERENCES `education_levels` (`education_level_id`);

--
-- Constraints for table `grade_level_aliases`
--
ALTER TABLE `grade_level_aliases`
  ADD CONSTRAINT `fk_gla_grade` FOREIGN KEY (`grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`);

--
-- Constraints for table `grade_level_progression`
--
ALTER TABLE `grade_level_progression`
  ADD CONSTRAINT `fk_glp_grade` FOREIGN KEY (`grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`),
  ADD CONSTRAINT `fk_glp_next_grade` FOREIGN KEY (`next_grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`);

--
-- Constraints for table `grading_periods`
--
ALTER TABLE `grading_periods`
  ADD CONSTRAINT `fk_gp_locked_by` FOREIGN KEY (`locked_by`) REFERENCES `users` (`user_id`),
  ADD CONSTRAINT `fk_gp_sy` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`);

--
-- Constraints for table `import_logs`
--
ALTER TABLE `import_logs`
  ADD CONSTRAINT `fk_il_imported_by` FOREIGN KEY (`imported_by`) REFERENCES `users` (`user_id`),
  ADD CONSTRAINT `fk_il_school` FOREIGN KEY (`school_id`) REFERENCES `schools` (`school_id`),
  ADD CONSTRAINT `fk_il_sy` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`),
  ADD CONSTRAINT `fk_il_template` FOREIGN KEY (`template_id`) REFERENCES `import_templates` (`template_id`);

--
-- Constraints for table `import_log_rows`
--
ALTER TABLE `import_log_rows`
  ADD CONSTRAINT `fk_ilr_import` FOREIGN KEY (`import_id`) REFERENCES `import_logs` (`import_id`);

--
-- Constraints for table `interventions`
--
ALTER TABLE `interventions`
  ADD CONSTRAINT `fk_iv_conducted_by` FOREIGN KEY (`conducted_by`) REFERENCES `users` (`user_id`),
  ADD CONSTRAINT `fk_iv_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_iv_risk` FOREIGN KEY (`risk_assessment_id`) REFERENCES `risk_assessments` (`risk_assessment_id`);

--
-- Constraints for table `kindergarten_anecdotal_records`
--
ALTER TABLE `kindergarten_anecdotal_records`
  ADD CONSTRAINT `fk_kar_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_kar_period` FOREIGN KEY (`grading_period_id`) REFERENCES `grading_periods` (`grading_period_id`);

--
-- Constraints for table `kindergarten_checklists`
--
ALTER TABLE `kindergarten_checklists`
  ADD CONSTRAINT `fk_kc_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_kc_period` FOREIGN KEY (`grading_period_id`) REFERENCES `grading_periods` (`grading_period_id`),
  ADD CONSTRAINT `fk_kc_standard` FOREIGN KEY (`kg_standard_id`) REFERENCES `kindergarten_learning_standards` (`kg_standard_id`);

--
-- Constraints for table `kindergarten_learning_standards`
--
ALTER TABLE `kindergarten_learning_standards`
  ADD CONSTRAINT `fk_kls_curriculum` FOREIGN KEY (`curriculum_id`) REFERENCES `curricula` (`curriculum_id`);

--
-- Constraints for table `kindergarten_portfolios`
--
ALTER TABLE `kindergarten_portfolios`
  ADD CONSTRAINT `fk_kp_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_kp_period` FOREIGN KEY (`grading_period_id`) REFERENCES `grading_periods` (`grading_period_id`);

--
-- Constraints for table `kindergarten_quarterly_reports`
--
ALTER TABLE `kindergarten_quarterly_reports`
  ADD CONSTRAINT `fk_kqr_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_kqr_period` FOREIGN KEY (`grading_period_id`) REFERENCES `grading_periods` (`grading_period_id`);

--
-- Constraints for table `learners`
--
ALTER TABLE `learners`
  ADD CONSTRAINT `fk_learners_birth_province` FOREIGN KEY (`birth_province_id`) REFERENCES `geo_provinces` (`province_id`),
  ADD CONSTRAINT `fk_learners_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL;

--
-- Constraints for table `learner_addresses`
--
ALTER TABLE `learner_addresses`
  ADD CONSTRAINT `fk_la_barangay` FOREIGN KEY (`barangay_id`) REFERENCES `geo_barangays` (`barangay_id`),
  ADD CONSTRAINT `fk_la_city` FOREIGN KEY (`city_municipality_id`) REFERENCES `geo_cities_municipalities` (`city_municipality_id`),
  ADD CONSTRAINT `fk_la_learner` FOREIGN KEY (`learner_id`) REFERENCES `learners` (`learner_id`),
  ADD CONSTRAINT `fk_la_province` FOREIGN KEY (`province_id`) REFERENCES `geo_provinces` (`province_id`);

--
-- Constraints for table `learner_assessment_scores`
--
ALTER TABLE `learner_assessment_scores`
  ADD CONSTRAINT `fk_las_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_las_item` FOREIGN KEY (`assessment_item_id`) REFERENCES `class_assessment_items` (`assessment_item_id`) ON DELETE CASCADE;

--
-- Constraints for table `learner_progression`
--
ALTER TABLE `learner_progression`
  ADD CONSTRAINT `fk_lp_current_grade` FOREIGN KEY (`current_grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`),
  ADD CONSTRAINT `fk_lp_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_lp_learner` FOREIGN KEY (`learner_id`) REFERENCES `learners` (`learner_id`),
  ADD CONSTRAINT `fk_lp_next_grade` FOREIGN KEY (`next_grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`),
  ADD CONSTRAINT `fk_lp_sy` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`);

--
-- Constraints for table `notifications`
--
ALTER TABLE `notifications`
  ADD CONSTRAINT `fk_notif_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE;

--
-- Constraints for table `remedial_classes`
--
ALTER TABLE `remedial_classes`
  ADD CONSTRAINT `fk_rc_class` FOREIGN KEY (`class_id`) REFERENCES `class_offerings` (`class_id`),
  ADD CONSTRAINT `fk_rc_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_rc_recorded_by` FOREIGN KEY (`recorded_by`) REFERENCES `users` (`user_id`);

--
-- Constraints for table `report_cards`
--
ALTER TABLE `report_cards`
  ADD CONSTRAINT `fk_rptc_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_rptc_generated_by` FOREIGN KEY (`generated_by`) REFERENCES `users` (`user_id`),
  ADD CONSTRAINT `fk_rptc_period` FOREIGN KEY (`grading_period_id`) REFERENCES `grading_periods` (`grading_period_id`);

--
-- Constraints for table `report_card_grades`
--
ALTER TABLE `report_card_grades`
  ADD CONSTRAINT `fk_rcg_card` FOREIGN KEY (`report_card_id`) REFERENCES `report_cards` (`report_card_id`) ON DELETE CASCADE;

--
-- Constraints for table `risk_assessments`
--
ALTER TABLE `risk_assessments`
  ADD CONSTRAINT `fk_ra_assessed_by` FOREIGN KEY (`assessed_by`) REFERENCES `users` (`user_id`),
  ADD CONSTRAINT `fk_ra_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_ra_level` FOREIGN KEY (`risk_level_id`) REFERENCES `risk_levels` (`risk_level_id`),
  ADD CONSTRAINT `fk_ra_period` FOREIGN KEY (`grading_period_id`) REFERENCES `grading_periods` (`grading_period_id`);

--
-- Constraints for table `risk_indicators`
--
ALTER TABLE `risk_indicators`
  ADD CONSTRAINT `fk_ri_assessment` FOREIGN KEY (`risk_assessment_id`) REFERENCES `risk_assessments` (`risk_assessment_id`) ON DELETE CASCADE;

--
-- Constraints for table `role_permissions`
--
ALTER TABLE `role_permissions`
  ADD CONSTRAINT `fk_rp_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`user_id`),
  ADD CONSTRAINT `fk_rp_permission` FOREIGN KEY (`permission_id`) REFERENCES `permissions` (`permission_id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_rp_role` FOREIGN KEY (`role_id`) REFERENCES `roles` (`role_id`) ON DELETE CASCADE;

--
-- Constraints for table `sections`
--
ALTER TABLE `sections`
  ADD CONSTRAINT `fk_sections_adviser` FOREIGN KEY (`adviser_id`) REFERENCES `employees` (`employee_id`),
  ADD CONSTRAINT `fk_sections_edu` FOREIGN KEY (`education_level_id`) REFERENCES `education_levels` (`education_level_id`),
  ADD CONSTRAINT `fk_sections_grade` FOREIGN KEY (`grade_level_id`) REFERENCES `grade_levels` (`grade_level_id`),
  ADD CONSTRAINT `fk_sections_sy` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`);

--
-- Constraints for table `section_rankings`
--
ALTER TABLE `section_rankings`
  ADD CONSTRAINT `fk_sr_enrollment` FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments` (`enrollment_id`),
  ADD CONSTRAINT `fk_sr_honor` FOREIGN KEY (`honor_level_id`) REFERENCES `honor_levels` (`honor_level_id`),
  ADD CONSTRAINT `fk_sr_ranked_by` FOREIGN KEY (`ranked_by`) REFERENCES `users` (`user_id`),
  ADD CONSTRAINT `fk_sr_section` FOREIGN KEY (`section_id`) REFERENCES `sections` (`section_id`),
  ADD CONSTRAINT `fk_sr_sy` FOREIGN KEY (`school_year_id`) REFERENCES `school_years` (`school_year_id`);

--
-- Constraints for table `sf1_import_staging`
--
ALTER TABLE `sf1_import_staging`
  ADD CONSTRAINT `fk_stg_import` FOREIGN KEY (`import_id`) REFERENCES `import_logs` (`import_id`);

--
-- Constraints for table `users`
--
ALTER TABLE `users`
  ADD CONSTRAINT `fk_users_role` FOREIGN KEY (`role_id`) REFERENCES `roles` (`role_id`);
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
