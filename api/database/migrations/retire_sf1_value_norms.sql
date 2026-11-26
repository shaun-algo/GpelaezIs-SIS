-- Retire the unused SF1 value-normalization lookup.
-- Current import validation preserves LIS text as the source of truth and has
-- no active callers for the former normalization helper. Apply to the target
-- application database only after taking its normal backup.

DROP TABLE IF EXISTS sf1_value_norms;
