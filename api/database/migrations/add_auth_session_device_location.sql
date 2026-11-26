-- Preserve the approximate location label for each account/device row.
-- The application prefers server-side IP geolocation, then uses an explicitly
-- permitted browser location to reverse-geocode a place. It stores only the
-- resulting city/region/country label and never stores coordinates.
ALTER TABLE auth_session_devices
    ADD COLUMN IF NOT EXISTS location_label VARCHAR(160) DEFAULT NULL AFTER user_agent;
