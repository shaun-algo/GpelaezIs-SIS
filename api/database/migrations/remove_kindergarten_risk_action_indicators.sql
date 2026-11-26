-- Kindergarten learner risk indicators are not supported in this system.
-- Soft-delete both catalog rows and any related action rules; safe to rerun.

UPDATE `risk_action_rules`
SET `is_active` = 0,
    `is_deleted` = 1,
    `deleted_at` = COALESCE(`deleted_at`, NOW())
WHERE `is_deleted` = 0
  AND `indicator_catalog_id` IN (
      SELECT `indicator_catalog_id`
      FROM `risk_indicator_catalog`
      WHERE `indicator_code` IN (
          'Kindergarten Checklist Below 50%',
          'Kindergarten Checklist Below 70%',
          'Kindergarten Checklist Below 80%',
          'No Kindergarten Checklist Data',
          'Few Portfolio Artifacts'
      )
  );

UPDATE `risk_indicator_catalog`
SET `is_active` = 0,
    `is_deleted` = 1,
    `deleted_at` = COALESCE(`deleted_at`, NOW())
WHERE `indicator_code` IN (
    'Kindergarten Checklist Below 50%',
    'Kindergarten Checklist Below 70%',
    'Kindergarten Checklist Below 80%',
    'No Kindergarten Checklist Data',
    'Few Portfolio Artifacts'
);
