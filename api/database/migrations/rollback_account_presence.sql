-- Rollback for add_account_presence.sql.
-- Run only on the same database where that migration was applied.

ALTER TABLE users
    DROP COLUMN IF EXISTS last_seen_at;

ALTER TABLE learners
    DROP COLUMN IF EXISTS last_seen_at;
