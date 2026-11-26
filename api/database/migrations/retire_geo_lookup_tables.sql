-- Retire the unused PSGC lookup layer after the application has been switched
-- to LIS-provided text fields for birthplace and current address.
--
-- Apply only after the raw-text application refactor has passed clone testing.
-- The nullable *_id columns are intentionally retained in this migration as a
-- reversible compatibility shell; the application no longer reads or writes
-- them as geographic references.

ALTER TABLE learners
    DROP FOREIGN KEY fk_learners_birth_province;

ALTER TABLE learner_addresses
    DROP FOREIGN KEY fk_la_barangay,
    DROP FOREIGN KEY fk_la_city,
    DROP FOREIGN KEY fk_la_province;

DROP TABLE IF EXISTS geo_name_aliases;
DROP TABLE IF EXISTS geo_barangays;
DROP TABLE IF EXISTS geo_cities_municipalities;
DROP TABLE IF EXISTS geo_provinces;
