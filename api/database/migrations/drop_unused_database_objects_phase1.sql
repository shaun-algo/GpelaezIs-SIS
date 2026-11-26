-- Phase 1 database cleanup: remove unused diagnostic views and retired schema.
-- Backup taken before local execution:
-- api/database/backup/sql_backups/capstone_migration_pre_phase1_cleanup_20260827_193152.sql

DROP VIEW IF EXISTS `vw_learner_progression_candidates`;
DROP VIEW IF EXISTS `v_import_capacity_status`;
DROP VIEW IF EXISTS `v_import_orphan_addresses`;
DROP VIEW IF EXISTS `v_kindergarten_progression`;
DROP VIEW IF EXISTS `v_learner_data_quality`;
DROP VIEW IF EXISTS `v_mapeh_quarterly_averages`;
DROP VIEW IF EXISTS `v_migration_orphans`;
DROP VIEW IF EXISTS `v_report_card_subject_quarters`;

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `grade_component_summaries`;
DROP TABLE IF EXISTS `curriculum_grading_components`;
DROP TABLE IF EXISTS `enrollment_requirements`;
DROP TABLE IF EXISTS `learner_preferred_modalities`;
DROP TABLE IF EXISTS `learning_modalities`;
DROP TABLE IF EXISTS `learner_citizenships`;
DROP TABLE IF EXISTS `citizenships`;

SET FOREIGN_KEY_CHECKS = 1;
