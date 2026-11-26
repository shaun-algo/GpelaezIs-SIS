-- Retire the hidden Emergency Contacts feature.
-- The current production navigation does not expose this page and the clone
-- contains no emergency-contact rows. Apply only after confirming the target
-- deployment no longer needs this feature.

DROP TABLE IF EXISTS emergency_contacts;
