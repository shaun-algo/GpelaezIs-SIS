-- Rollback for add_audit_event_outcomes.sql.
-- Run only on the same database where that migration was applied.

ALTER TABLE audit_logs
    DROP KEY idx_audit_event_status_time,
    DROP KEY idx_audit_reason_time,
    DROP KEY idx_audit_principal_time,
    DROP COLUMN metadata,
    DROP COLUMN principal_hash,
    DROP COLUMN principal_hint,
    DROP COLUMN user_agent,
    DROP COLUMN request_id,
    DROP COLUMN target_type,
    DROP COLUMN reason_code,
    DROP COLUMN status,
    DROP COLUMN event_type;
