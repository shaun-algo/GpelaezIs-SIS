-- Account presence timestamps.
-- Apply to a backed-up, disposable clone first. The application treats an
-- account as online only when last_seen_at is recent; is_active remains the
-- account-enabled flag.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_seen_at DATETIME NULL AFTER last_login;

ALTER TABLE learners
    ADD COLUMN IF NOT EXISTS last_seen_at DATETIME NULL AFTER last_login;
