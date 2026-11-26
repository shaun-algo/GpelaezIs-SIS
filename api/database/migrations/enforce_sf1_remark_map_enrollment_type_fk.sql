-- Enforce the one safe relationship among the previously standalone tables.
-- sf1_remark_map.enrollment_type_name is an optional import mapping and matches
-- the unique enrollment_types.type_name key. Other standalone tables have no
-- compatible current FK columns and are intentionally left unchanged.
--
-- The preflight aborts if existing non-null mappings are orphaned. The migration
-- is repeatable: an existing constraint is not recreated.

DELIMITER $$

DROP PROCEDURE IF EXISTS enforce_sf1_remark_map_enrollment_type_fk$$

CREATE PROCEDURE enforce_sf1_remark_map_enrollment_type_fk()
BEGIN
    DECLARE orphan_count INT DEFAULT 0;
    DECLARE constraint_count INT DEFAULT 0;

    SELECT COUNT(*)
      INTO orphan_count
      FROM sf1_remark_map AS s
      LEFT JOIN enrollment_types AS e
        ON e.type_name = s.enrollment_type_name
     WHERE s.enrollment_type_name IS NOT NULL
       AND e.enrollment_type_id IS NULL;

    IF orphan_count > 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Cannot add FK: sf1_remark_map contains orphan enrollment_type_name values';
    END IF;

    SELECT COUNT(*)
      INTO constraint_count
      FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'sf1_remark_map'
       AND CONSTRAINT_NAME = 'fk_sf1_remark_map_enrollment_type_name'
       AND CONSTRAINT_TYPE = 'FOREIGN KEY';

    IF constraint_count = 0 THEN
        ALTER TABLE sf1_remark_map
            ADD CONSTRAINT fk_sf1_remark_map_enrollment_type_name
            FOREIGN KEY (enrollment_type_name)
            REFERENCES enrollment_types (type_name)
            ON DELETE SET NULL
            ON UPDATE CASCADE;
    END IF;
END$$

DELIMITER ;

CALL enforce_sf1_remark_map_enrollment_type_fk();
DROP PROCEDURE IF EXISTS enforce_sf1_remark_map_enrollment_type_fk;
