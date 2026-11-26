-- Add structured family-member names while preserving legacy full_name values.
-- Existing rows are intentionally not guessed when full_name is ambiguous.
-- The API derives safe comma-formatted values on read and persists them when
-- the record is edited.

DELIMITER $$

DROP PROCEDURE IF EXISTS redesign_family_member_names$$

CREATE PROCEDURE redesign_family_member_names()
BEGIN
    DECLARE object_count INT DEFAULT 0;
    DECLARE orphan_count INT DEFAULT 0;

    SELECT COUNT(*) INTO object_count
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'name_extensions';
    IF object_count = 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Cannot redesign family member names: name_extensions table is missing';
    END IF;

    SELECT COUNT(*) INTO object_count
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'family_members'
       AND COLUMN_NAME = 'first_name';
    IF object_count = 0 THEN
        ALTER TABLE family_members ADD COLUMN first_name varchar(100) DEFAULT NULL AFTER full_name;
    END IF;

    SELECT COUNT(*) INTO object_count
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'family_members'
       AND COLUMN_NAME = 'middle_name';
    IF object_count = 0 THEN
        ALTER TABLE family_members ADD COLUMN middle_name varchar(100) DEFAULT NULL AFTER first_name;
    END IF;

    SELECT COUNT(*) INTO object_count
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'family_members'
       AND COLUMN_NAME = 'last_name';
    IF object_count = 0 THEN
        ALTER TABLE family_members ADD COLUMN last_name varchar(100) DEFAULT NULL AFTER middle_name;
    END IF;

    SELECT COUNT(*) INTO object_count
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'family_members'
       AND COLUMN_NAME = 'name_extension';
    IF object_count = 0 THEN
        ALTER TABLE family_members ADD COLUMN name_extension varchar(10) DEFAULT NULL AFTER last_name;
    END IF;

    SELECT COUNT(*) INTO orphan_count
      FROM family_members AS fm
      LEFT JOIN name_extensions AS ne ON ne.extension_name = fm.name_extension
     WHERE fm.name_extension IS NOT NULL AND ne.extension_id IS NULL;
    IF orphan_count > 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Cannot add family member name-extension FK: orphan values exist';
    END IF;

    SELECT COUNT(*) INTO object_count
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'family_members'
       AND INDEX_NAME = 'idx_family_member_name_extension';
    IF object_count = 0 THEN
        ALTER TABLE family_members ADD INDEX idx_family_member_name_extension (name_extension);
    END IF;

    SELECT COUNT(*) INTO object_count
      FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'family_members'
       AND CONSTRAINT_NAME = 'fk_family_members_name_extension'
       AND CONSTRAINT_TYPE = 'FOREIGN KEY';
    IF object_count = 0 THEN
        ALTER TABLE family_members
            ADD CONSTRAINT fk_family_members_name_extension
            FOREIGN KEY (name_extension)
            REFERENCES name_extensions (extension_name)
            ON DELETE RESTRICT
            ON UPDATE RESTRICT;
    END IF;
END$$

DELIMITER ;

CALL redesign_family_member_names();
DROP PROCEDURE IF EXISTS redesign_family_member_names;

