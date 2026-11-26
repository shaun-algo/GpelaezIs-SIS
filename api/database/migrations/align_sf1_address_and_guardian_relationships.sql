-- Preserve exact SF1 address text when Barangay/City/Municipality cannot be
-- matched to PSGC IDs, and align guardian relationship labels to LIS values.

ALTER TABLE learner_addresses
  ADD COLUMN IF NOT EXISTS province_text VARCHAR(150) DEFAULT NULL AFTER province_id,
  ADD COLUMN IF NOT EXISTS city_municipality_text VARCHAR(150) DEFAULT NULL AFTER city_municipality_id,
  ADD COLUMN IF NOT EXISTS barangay_text VARCHAR(150) DEFAULT NULL AFTER barangay_id;

ALTER TABLE learners
  ADD COLUMN IF NOT EXISTS contact_number VARCHAR(20) DEFAULT NULL AFTER address;

UPDATE family_members
SET relationship = 'Parent'
WHERE is_guardian = 1
  AND is_deleted = 0
  AND LOWER(TRIM(relationship)) IN ('parent', 'father', 'mother', 'nanay', 'tatay', 'mama', 'papa');

UPDATE family_members
SET relationship = 'Relative'
WHERE is_guardian = 1
  AND is_deleted = 0
  AND LOWER(TRIM(relationship)) IN (
    'relative', 'grandparent', 'grandfather', 'grandmother', 'lolo', 'lola',
    'aunt', 'auntie', 'uncle', 'tita', 'tito', 'sibling', 'brother', 'sister',
    'cousin', 'niece', 'nephew', 'other'
  );

UPDATE family_members
SET relationship = 'Non-Relative'
WHERE is_guardian = 1
  AND is_deleted = 0
  AND LOWER(TRIM(relationship)) IN (
    'non-relative', 'non relative', 'nonrelative', 'not relative',
    'guardian', 'legal guardian', 'friend', 'neighbor', 'neighbour',
    'foster parent', 'institution', 'caregiver'
  );
