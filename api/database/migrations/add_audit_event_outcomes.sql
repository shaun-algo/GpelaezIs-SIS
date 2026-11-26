-- Audit event outcomes and security context.
-- Apply to a backed-up, disposable clone first. Do not run against a
-- configured or production database until the clone tests pass.

ALTER TABLE audit_logs
    ADD COLUMN event_type VARCHAR(40) NOT NULL DEFAULT 'DATA_CHANGE' AFTER action,
    ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'SUCCESS' AFTER event_type,
    ADD COLUMN reason_code VARCHAR(80) NULL AFTER status,
    ADD COLUMN target_type VARCHAR(100) NULL AFTER reason_code,
    ADD COLUMN request_id VARCHAR(128) NULL AFTER target_type,
    ADD COLUMN user_agent VARCHAR(512) NULL AFTER request_id,
    ADD COLUMN principal_hint VARCHAR(120) NULL AFTER user_agent,
    ADD COLUMN principal_hash CHAR(64) NULL AFTER principal_hint,
    ADD COLUMN metadata LONGTEXT NULL AFTER principal_hash,
    ADD KEY idx_audit_event_status_time (event_type, status, action_time),
    ADD KEY idx_audit_reason_time (reason_code, action_time),
    ADD KEY idx_audit_principal_time (principal_hash, action_time);

UPDATE audit_logs
SET event_type = 'DATA_CHANGE',
    status = 'SUCCESS',
    target_type = COALESCE(NULLIF(target_type, ''), table_name)
WHERE event_type IS NULL
   OR event_type = ''
   OR status IS NULL
   OR status = ''
   OR target_type IS NULL
   OR target_type = '';
