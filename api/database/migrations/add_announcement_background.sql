-- Announcement background synchronization (additive)
-- Stores the selected fixed preset so every audience renders the same post theme.
-- NULL keeps older device-local posts compatible until their owner edits and saves them.

ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS message_background VARCHAR(255) DEFAULT NULL
  COMMENT 'Normalized announcement message background CSS';
