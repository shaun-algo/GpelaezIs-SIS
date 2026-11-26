-- Retire reference tables no longer used by the active DepEd workflow.
-- Kept intentionally:
--   document_types: still used by learner_documents / registration completion.
--   enrollment_types: still used by enrollments, LIS import, and promotion rollover.

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `enrollment_requirements`;
DROP TABLE IF EXISTS `learner_preferred_modalities`;
DROP TABLE IF EXISTS `learning_modalities`;
DROP TABLE IF EXISTS `learner_citizenships`;
DROP TABLE IF EXISTS `citizenships`;

SET FOREIGN_KEY_CHECKS = 1;
