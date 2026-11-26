<?php
// Central audit-log helper.
// Data-change callers may keep using audit_log(). Security-sensitive flows
// should use audit_log_event() so action, status, reason, and context remain
// queryable independently.

require_once __DIR__ . '/auth.php';

/**
 * Write a successful business-data change to the audit_logs table.
 *
 * @param PDO    $conn      Active DB connection (same transaction).
 * @param string $tableName DB table that was modified (e.g. 'roles').
 * @param ?int   $recordId  Primary key of the affected row (null if N/A).
 * @param string $action    'INSERT', 'UPDATE', or 'DELETE'. Legacy INSERT is
 *                          normalized to CREATE for new rows.
 * @param ?array $oldValues Key-value map of the row BEFORE the change (null for INSERT).
 * @param ?array $newValues Key-value map of the row AFTER the change (null for DELETE).
 * @return bool  True on success.
 */
function audit_log(
    PDO $conn,
    string $tableName,
    ?int $recordId,
    string $action,
    ?array $oldValues = null,
    ?array $newValues = null
): bool {
    return audit_log_event($conn, $action, 'SUCCESS', [
        'event_type' => 'DATA_CHANGE',
        'table_name' => $tableName,
        'record_id' => $recordId,
        'target_type' => $tableName,
        'old_values' => $oldValues,
        'new_values' => $newValues,
    ]);
}

/**
 * Write a structured audit/security event.
 *
 * The table migration is intentionally additive, but it must be applied before
 * deploying this helper: the structured insert targets the new columns. If a
 * migration is missing, the helper fails safely and the caller's business
 * operation remains available while the audit-write failure is logged.
 *
 * Supported context keys: event_type, table_name, record_id, target_type,
 * actor_user_id, reason_code, principal, principal_hint, metadata,
 * old_values, new_values.
 */
function audit_log_event(PDO $conn, string $action, string $status = 'SUCCESS', array $context = []): bool {
    $action = audit_normalize_action($action);
    $status = audit_normalize_status($status);
    $eventType = strtoupper(trim((string)($context['event_type'] ?? '')));
    if ($eventType === '') {
        $eventType = in_array($action, ['CREATE', 'UPDATE', 'DELETE'], true)
            ? 'DATA_CHANGE'
            : 'SECURITY';
    }

    $tableName = trim((string)($context['table_name'] ?? ($eventType === 'SECURITY' ? 'authentication' : 'application')));
    $tableName = $tableName !== '' ? substr($tableName, 0, 100) : 'application';
    $targetType = trim((string)($context['target_type'] ?? ''));
    $targetType = $targetType !== '' ? substr($targetType, 0, 100) : null;
    $recordId = array_key_exists('record_id', $context) && $context['record_id'] !== null
        ? (int)$context['record_id']
        : null;

    $actorUserId = array_key_exists('actor_user_id', $context)
        ? ((int)$context['actor_user_id'] ?: null)
        : ((int)($_SESSION['user_id'] ?? 0) ?: null);
    $reasonCode = trim((string)($context['reason_code'] ?? ''));
    $reasonCode = $reasonCode !== '' ? substr(strtoupper($reasonCode), 0, 80) : null;
    $requestId = audit_request_id();
    $userAgent = trim((string)($_SERVER['HTTP_USER_AGENT'] ?? ''));
    $userAgent = $userAgent !== '' ? substr($userAgent, 0, 512) : null;
    $ipAddress = trim((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    $ipAddress = $ipAddress !== '' ? substr($ipAddress, 0, 45) : null;

    [$principalHint, $principalHash] = audit_principal_values(
        (string)($context['principal'] ?? ''),
        (string)($context['principal_hint'] ?? '')
    );

    $oldValues = array_key_exists('old_values', $context) && is_array($context['old_values'])
        ? audit_sanitize_map($context['old_values'])
        : null;
    $newValues = array_key_exists('new_values', $context) && is_array($context['new_values'])
        ? audit_sanitize_map($context['new_values'])
        : null;
    $metadata = array_key_exists('metadata', $context) && is_array($context['metadata'])
        ? audit_sanitize_map($context['metadata'])
        : null;

    $oldJson = $oldValues !== null ? json_encode_utf8($oldValues) : null;
    $newJson = $newValues !== null ? json_encode_utf8($newValues) : null;
    $metadataJson = $metadata !== null ? json_encode_utf8($metadata) : null;

    try {
        $stmt = $conn->prepare(
            'INSERT INTO audit_logs
                (user_id, table_name, record_id, action, event_type, status, reason_code,
                 target_type, request_id, user_agent, principal_hint, principal_hash,
                 metadata, old_values, new_values, action_time, ip_address)
             VALUES
                (:user_id, :table_name, :record_id, :action, :event_type, :status, :reason_code,
                 :target_type, :request_id, :user_agent, :principal_hint, :principal_hash,
                 :metadata, :old_values, :new_values, NOW(), :ip_address)'
        );
        $stmt->bindValue(':user_id', $actorUserId, $actorUserId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->bindValue(':table_name', $tableName);
        $stmt->bindValue(':record_id', $recordId, $recordId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->bindValue(':action', $action);
        $stmt->bindValue(':event_type', $eventType);
        $stmt->bindValue(':status', $status);
        $stmt->bindValue(':reason_code', $reasonCode, $reasonCode === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':target_type', $targetType, $targetType === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':request_id', $requestId, $requestId === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':user_agent', $userAgent, $userAgent === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':principal_hint', $principalHint, $principalHint === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':principal_hash', $principalHash, $principalHash === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':metadata', $metadataJson, $metadataJson === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':old_values', $oldJson, $oldJson === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':new_values', $newJson, $newJson === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':ip_address', $ipAddress, $ipAddress === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        return $stmt->execute();
    } catch (Throwable $e) {
        // Security logging must not turn an authentication outage into a
        // wider outage. The caller may separately alert on this server error.
        error_log('audit_log_event failed: ' . $e->getMessage());
        return false;
    }
}

function audit_normalize_action(string $action): string {
    $normalized = strtoupper(trim($action));
    return match ($normalized) {
        'INSERT' => 'CREATE',
        'REMOVE' => 'DELETE',
        default => substr($normalized !== '' ? $normalized : 'ACTIVITY', 0, 50),
    };
}

function audit_normalize_status(string $status): string {
    $normalized = strtoupper(trim($status));
    return match ($normalized) {
        'FAIL', 'FAILED', 'ERROR' => 'FAILURE',
        'FORBIDDEN', 'UNAUTHORIZED' => 'DENIED',
        default => substr($normalized !== '' ? $normalized : 'SUCCESS', 0, 20),
    };
}

function audit_request_id(): ?string {
    static $requestId = null;
    if ($requestId !== null) return $requestId;

    $incoming = trim((string)($_SERVER['HTTP_X_REQUEST_ID'] ?? ''));
    if ($incoming !== '' && preg_match('/^[A-Za-z0-9._:-]{1,128}$/D', $incoming)) {
        $requestId = $incoming;
        return $requestId;
    }

    try {
        $requestId = bin2hex(random_bytes(16));
    } catch (Throwable $e) {
        $requestId = null;
    }
    return $requestId;
}

function audit_principal_values(string $principal, string $providedHint = ''): array {
    $normalized = trim(function_exists('mb_strtolower') ? mb_strtolower($principal, 'UTF-8') : strtolower($principal));
    if ($normalized === '') return [null, null];

    $hint = trim($providedHint);
    if ($hint === '') {
        if (str_contains($normalized, '@')) {
            [$local, $domain] = array_pad(explode('@', $normalized, 2), 2, '');
            $hint = ($local !== '' ? substr($local, 0, 1) : '*') . '***@' . $domain;
        } else {
            $length = strlen($normalized);
            $hint = $length <= 2
                ? str_repeat('*', $length)
                : substr($normalized, 0, 1) . '***' . substr($normalized, -1);
        }
    }

    return [substr($hint, 0, 120), hash('sha256', $normalized)];
}

function audit_sensitive_key(string $key): bool {
    $normalized = strtolower(preg_replace('/[^a-z0-9]/i', '', $key));
    if ($normalized === '') return false;
    foreach (['password', 'passwd', 'token', 'otp', 'secret', 'api_key', 'apikey', 'authorization', 'cookie', 'sessionid', 'smtp'] as $needle) {
        if (str_contains($normalized, str_replace('_', '', $needle))) return true;
    }
    return in_array($normalized, ['encryptedpayload', 'privatekey', 'accesskey'], true);
}

function audit_sanitize_value(mixed $value, ?string $key = null, int $depth = 0): mixed {
    if ($key !== null && audit_sensitive_key($key)) return '[REDACTED]';
    if ($depth > 5) return '[TRUNCATED]';
    if (is_array($value)) {
        $result = [];
        foreach ($value as $childKey => $childValue) {
            $result[(string)$childKey] = audit_sanitize_value($childValue, (string)$childKey, $depth + 1);
        }
        return $result;
    }
    if (is_string($value) && strlen($value) > 4000) return substr($value, 0, 4000) . '...[TRUNCATED]';
    return $value;
}

function audit_sanitize_map(array $values): array {
    $sanitized = audit_sanitize_value($values);
    return is_array($sanitized) ? $sanitized : [];
}

/**
 * Convenience: fetch a single row by PK before an UPDATE/DELETE so we can
 * store the "old" values in the audit trail.
 *
 * @param PDO    $conn
 * @param string $tableName
 * @param string $pkColumn   Primary-key column name (e.g. 'role_id').
 * @param int    $pkValue
 * @return array|null  Associative row or null.
 */
function audit_fetch_old(PDO $conn, string $tableName, string $pkColumn, int $pkValue): ?array {
    try {
        // Whitelist: only allow known table/column combos to prevent injection.
        $allowed = [
            'announcements' => 'announcement_id',
            'roles' => 'role_id',
            'users' => 'user_id',
            'employees' => 'employee_id',
            'learners' => 'learner_id',
            'enrollments' => 'enrollment_id',
            'sections' => 'section_id',
            'subjects' => 'subject_id',
            'grade_levels' => 'grade_level_id',
            'school_years' => 'school_year_id',
            'positions' => 'position_id',
            'education_levels' => 'education_level_id',
            'civil_statuses' => 'civil_status_id',
            'religions' => 'religion_id',
            'family_relationships' => 'family_relationship_id',
            'name_extensions' => 'name_extension_id',
            'learner_statuses' => 'learner_status_id',
            'risk_levels' => 'risk_level_id',
            'risk_action_rules' => 'risk_action_rule_id',
            'honor_levels' => 'honor_level_id',
            'enrollment_types' => 'enrollment_type_id',
            'grading_period_statuses' => 'grading_period_status_id',
            'indigenous_groups' => 'indigenous_group_id',
            'intervention_statuses' => 'intervention_status_id',
            'mother_tongues' => 'mother_tongue_id',
            'notification_types' => 'notification_type_id',
            'subject_codes' => 'subject_code_id',
            'class_offerings' => 'class_id',
            'grades' => 'grade_id',
            'final_grades' => 'final_grade_id',
            'general_averages' => 'general_average_id',
            'attendance' => 'attendance_id',
            'family_members' => 'family_member_id',
            'interventions' => 'intervention_id',
            'risk_assessments' => 'risk_assessment_id',
            'risk_indicators' => 'risk_indicator_id',
            'report_cards' => 'report_card_id',
            'curricula' => 'curriculum_id',
            'grading_periods' => 'grading_period_id',
        ];

        if (!isset($allowed[$tableName]) || $allowed[$tableName] !== $pkColumn) {
            return null;
        }

        $stmt = $conn->prepare("SELECT * FROM `{$tableName}` WHERE `{$pkColumn}` = :pk AND is_deleted = 0 LIMIT 1");
        $stmt->bindValue(':pk', $pkValue, PDO::PARAM_INT);
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    } catch (Exception $e) {
        return null;
    }
}

/**
 * JSON encode that handles non-UTF8 gracefully.
 */
function json_encode_utf8(array $data): string {
    return json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
}
?>
