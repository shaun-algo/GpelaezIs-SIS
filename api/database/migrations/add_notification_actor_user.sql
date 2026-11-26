-- Store the user who caused a notification so profile avatars remain accurate
-- for announcements and account-security state changes.
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS actor_user_id INT(11) DEFAULT NULL AFTER user_id,
    ADD INDEX IF NOT EXISTS idx_notif_actor (actor_user_id);
