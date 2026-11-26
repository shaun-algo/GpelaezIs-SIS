DROP TRIGGER IF EXISTS recovery_learners_password_version;
DROP TRIGGER IF EXISTS recovery_users_password_version;
DROP TABLE IF EXISTS learner_recovery_requests;
DROP TABLE IF EXISTS recovery_mail_queue;
DROP TABLE IF EXISTS recovery_events;
DROP TABLE IF EXISTS recovery_rate_limits;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS recovery_contacts;
ALTER TABLE users DROP COLUMN IF EXISTS auth_version;
