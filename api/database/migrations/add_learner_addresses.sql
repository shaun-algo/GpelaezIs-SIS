-- Migration: Add normalized learner address storage
-- Purpose:
-- - Store DepEd-style Current + Permanent addresses without exploding the learners table with many columns.
-- - Preserve LIS-provided address text as the source of truth.
-- - Keep nullable *_id columns only as a legacy compatibility shell; do not add
--   foreign keys to retired PSGC lookup tables.

-- NOTE ABOUT ERROR #1005 / errno:150
-- The current application does not use PSGC foreign keys. Only the learner
-- ownership foreign key should be retained when this migration is applied.
--
-- This migration creates the table FIRST without foreign keys so it can run reliably.
-- Afterward, you may optionally add the foreign keys (see bottom of file).

-- Optional helper flag (for UI checkbox: "Permanent address same as current")
ALTER TABLE learners
  ADD COLUMN IF NOT EXISTS is_permanent_same_as_current TINYINT(1) NOT NULL DEFAULT 1
  COMMENT 'If 1, permanent address should be treated as same as current';

CREATE TABLE IF NOT EXISTS learner_addresses (
  learner_address_id INT AUTO_INCREMENT PRIMARY KEY,
  learner_id INT NOT NULL,
  address_type ENUM('CURRENT','PERMANENT') NOT NULL,

  house_no VARCHAR(50) DEFAULT NULL,
  street VARCHAR(150) DEFAULT NULL,
  street_name VARCHAR(150) DEFAULT NULL,
  subdivision VARCHAR(150) DEFAULT NULL,
  zip_code VARCHAR(10) DEFAULT NULL,

  province_id INT DEFAULT NULL,
  city_municipality_id INT DEFAULT NULL,
  barangay_id INT DEFAULT NULL,

  country_name VARCHAR(100) NOT NULL DEFAULT 'Philippines',

  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  deleted_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT NULL,

  UNIQUE KEY uq_learner_address_active (learner_id, address_type, is_deleted),
  KEY idx_learner_addresses_learner (learner_id),
  KEY idx_learner_addresses_province (province_id),
  KEY idx_learner_addresses_citymun (city_municipality_id),
  KEY idx_learner_addresses_barangay (barangay_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Optional: add the learner ownership foreign key after confirming prerequisites.
-- Prereq checks to run in phpMyAdmin SQL tab:
--   SHOW TABLE STATUS WHERE Name IN ('learners');
--   SHOW INDEX FROM learners;
-- If learners.learner_id is not indexed, add an index:
--   ALTER TABLE learners ADD INDEX idx_learners_learner_id (learner_id);
-- If any table engine is not InnoDB:
--   ALTER TABLE <table_name> ENGINE=InnoDB;
--
-- Then add the learner FK:
--   ALTER TABLE learner_addresses
--     ADD CONSTRAINT fk_learner_addresses_learner
--       FOREIGN KEY (learner_id) REFERENCES learners(learner_id)
--       ON UPDATE CASCADE ON DELETE RESTRICT;
