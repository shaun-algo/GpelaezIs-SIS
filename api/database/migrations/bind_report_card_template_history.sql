-- Preserve the exact report-card template used when a report card is created.
--
-- The fields are intentionally nullable so older report_cards rows remain
-- readable during rollout. New and updated rows are populated by
-- api/report_cards/report_cards.php. No foreign key is added for template_id:
-- historical cards must remain printable even if a template is later retired.

ALTER TABLE `report_cards`
    ADD COLUMN IF NOT EXISTS `template_id` int(11) DEFAULT NULL
        COMMENT 'Template identity resolved at report-card generation time'
        AFTER `grading_period_id`,
    ADD COLUMN IF NOT EXISTS `template_code` varchar(80) DEFAULT NULL
        COMMENT 'Immutable template code captured at generation time'
        AFTER `template_id`,
    ADD COLUMN IF NOT EXISTS `template_version` int(11) DEFAULT NULL
        COMMENT 'Immutable template version captured at generation time'
        AFTER `template_code`,
    ADD COLUMN IF NOT EXISTS `template_grading_mode` varchar(30) DEFAULT NULL
        COMMENT 'Resolved grading mode captured with the template snapshot'
        AFTER `template_version`,
    ADD COLUMN IF NOT EXISTS `template_schema_json` longtext DEFAULT NULL
        COMMENT 'Normalized template schema snapshot used for historical reprint'
        AFTER `template_grading_mode`,
    ADD COLUMN IF NOT EXISTS `template_bound_at` datetime DEFAULT NULL
        COMMENT 'When the template snapshot was bound to this report card'
        AFTER `template_schema_json`,
    ADD COLUMN IF NOT EXISTS `periods_snapshot_json` longtext DEFAULT NULL
        COMMENT 'Resolved grading-period metadata captured for historical reprint'
        AFTER `template_bound_at`;

ALTER TABLE `report_cards`
    ADD KEY IF NOT EXISTS `idx_rc_template_history` (`template_code`, `template_version`);
