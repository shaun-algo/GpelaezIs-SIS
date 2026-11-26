-- Enforce the shared name-extension lookup without changing the existing
-- employee/learner VARCHAR columns or their API payload shape.
--
-- The preflight aborts if a current value is NULL-safe but not present in
-- name_extensions (including empty strings). The migration is repeatable:
-- correct existing constraints are not recreated, while old rules are repaired.

DELIMITER $$

DROP PROCEDURE IF EXISTS enforce_name_extension_lookup_fks$$

CREATE PROCEDURE enforce_name_extension_lookup_fks()
BEGIN
    DECLARE orphan_count INT DEFAULT 0;
    DECLARE constraint_count INT DEFAULT 0;
    DECLARE fk_delete_rule VARCHAR(20) DEFAULT '';
    DECLARE fk_update_rule VARCHAR(20) DEFAULT '';

    SELECT COUNT(*)
      INTO orphan_count
      FROM employees AS e
      LEFT JOIN name_extensions AS n
        ON n.extension_name = e.name_extension
     WHERE e.name_extension IS NOT NULL
       AND n.extension_id IS NULL;

    IF orphan_count > 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Cannot add FK: employees contains orphan name_extension values';
    END IF;

    SELECT COUNT(*)
      INTO orphan_count
      FROM learners AS l
      LEFT JOIN name_extensions AS n
        ON n.extension_name = l.name_extension
     WHERE l.name_extension IS NOT NULL
       AND n.extension_id IS NULL;

    IF orphan_count > 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Cannot add FK: learners contains orphan name_extension values';
    END IF;

    SELECT COUNT(*)
      INTO constraint_count
      FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'employees'
       AND CONSTRAINT_NAME = 'fk_employees_name_extension'
       AND CONSTRAINT_TYPE = 'FOREIGN KEY';

    IF constraint_count = 0 THEN
        ALTER TABLE employees
            ADD CONSTRAINT fk_employees_name_extension
            FOREIGN KEY (name_extension)
            REFERENCES name_extensions (extension_name)
            ON DELETE RESTRICT
            ON UPDATE RESTRICT;
    ELSE
        SELECT COALESCE(rc.DELETE_RULE, ''), COALESCE(rc.UPDATE_RULE, '')
          INTO fk_delete_rule, fk_update_rule
          FROM information_schema.REFERENTIAL_CONSTRAINTS AS rc
         WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
           AND rc.TABLE_NAME = 'employees'
           AND rc.CONSTRAINT_NAME = 'fk_employees_name_extension';

        IF fk_delete_rule <> 'RESTRICT' OR fk_update_rule <> 'RESTRICT' THEN
            ALTER TABLE employees
                DROP FOREIGN KEY fk_employees_name_extension;
            ALTER TABLE employees
                ADD CONSTRAINT fk_employees_name_extension
                FOREIGN KEY (name_extension)
                REFERENCES name_extensions (extension_name)
                ON DELETE RESTRICT
                ON UPDATE RESTRICT;
        END IF;
    END IF;

    SELECT COUNT(*)
      INTO constraint_count
      FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'learners'
       AND CONSTRAINT_NAME = 'fk_learners_name_extension'
       AND CONSTRAINT_TYPE = 'FOREIGN KEY';

    IF constraint_count = 0 THEN
        ALTER TABLE learners
            ADD CONSTRAINT fk_learners_name_extension
            FOREIGN KEY (name_extension)
            REFERENCES name_extensions (extension_name)
            ON DELETE RESTRICT
            ON UPDATE RESTRICT;
    ELSE
        SELECT COALESCE(rc.DELETE_RULE, ''), COALESCE(rc.UPDATE_RULE, '')
          INTO fk_delete_rule, fk_update_rule
          FROM information_schema.REFERENTIAL_CONSTRAINTS AS rc
         WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
           AND rc.TABLE_NAME = 'learners'
           AND rc.CONSTRAINT_NAME = 'fk_learners_name_extension';

        IF fk_delete_rule <> 'RESTRICT' OR fk_update_rule <> 'RESTRICT' THEN
            ALTER TABLE learners
                DROP FOREIGN KEY fk_learners_name_extension;
            ALTER TABLE learners
                ADD CONSTRAINT fk_learners_name_extension
                FOREIGN KEY (name_extension)
                REFERENCES name_extensions (extension_name)
                ON DELETE RESTRICT
                ON UPDATE RESTRICT;
        END IF;
    END IF;
END$$

DELIMITER ;

CALL enforce_name_extension_lookup_fks();
DROP PROCEDURE IF EXISTS enforce_name_extension_lookup_fks;
