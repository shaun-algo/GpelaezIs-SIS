<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') exit(0);

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/audit.php';
require_once __DIR__ . '/../utils/notifications.php';

function account_security_respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function account_security_reason_labels(): array {
    return [
        'RETIREMENT' => 'Retirement',
        'TRANSFER' => 'Transfer to another school',
        'CAREER_CHANGE' => 'Career change',
        'HEALTH_PERSONAL' => 'Health or personal reasons',
        'EXTENDED_LEAVE' => 'Extended leave',
        'OTHER' => 'Other',
    ];
}

function account_security_expire_pending_requests(PDO $conn): void {
    // A request that has waited a full week is closed automatically. It stays
    // in the administrator archive, but it no longer blocks a fresh request.
    try {
        $stmt = $conn->prepare(
            "UPDATE account_deactivation_requests
             SET status = 'CANCELLED', reviewed_at = NOW(),
                 reviewer_note = 'Automatically closed after seven days without review'
             WHERE status = 'PENDING'
               AND is_deleted = 0
               AND requested_at < DATE_SUB(NOW(), INTERVAL 7 DAY)"
        );
        $stmt->execute();
    } catch (Throwable $ignored) {
        // Reads and authentication should remain available if the optional
        // archive cleanup cannot run during a transient database issue.
    }
}

function account_security_body(): array {
    $raw = file_get_contents('php://input');
    $body = json_decode($raw ?: '', true);
    return is_array($body) ? $body : $_POST;
}

function account_security_is_learner(array $session): bool {
    $accountType = strtolower(trim((string)($session['account_type'] ?? '')));
    $roleKey = strtolower(trim((string)($session['role_key'] ?? '')));
    $roleName = strtolower(trim((string)($session['role_name'] ?? '')));
    $roleId = (int)($session['role_id'] ?? 0);

    return $accountType === 'learner'
        || str_contains($roleKey, 'learner')
        || str_contains($roleKey, 'student')
        || str_contains($roleName, 'learner')
        || str_contains($roleName, 'student')
        || $roleId === 10;
}

function account_security_is_employee(array $session): bool {
    return strtolower(trim((string)($session['account_type'] ?? ''))) === 'employee'
        && !account_security_is_learner($session);
}

function account_security_verify_admin_password(PDO $conn, array $session, string $password): bool {
    $password = (string)$password;
    if ($password === '') return false;

    $stmt = $conn->prepare(
        'SELECT password
         FROM users
         WHERE user_id = :user_id AND is_active = 1 AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->execute([':user_id' => (int)($session['user_id'] ?? 0)]);
    $hash = (string)($stmt->fetchColumn() ?: '');
    return $hash !== '' && password_verify($password, $hash);
}

function account_security_employee(PDO $conn, int $userId): ?array {
    $stmt = $conn->prepare(
        'SELECT u.user_id, u.username, COALESCE(u.account_created_at, u.created_at) AS account_created_at,
                e.employee_id,
                NULLIF(TRIM(CONCAT_WS(\' \', e.first_name, e.middle_name, e.last_name, e.name_extension)), \'\') AS full_name
         FROM users u
         LEFT JOIN employees e ON e.user_id = u.user_id AND e.is_deleted = 0
         WHERE u.user_id = :user_id AND u.is_deleted = 0
         LIMIT 1'
    );
    $stmt->execute([':user_id' => $userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row || empty($row['employee_id'])) return null;
    $row['full_name'] = trim((string)($row['full_name'] ?? '')) ?: (string)($row['username'] ?? 'Account');
    return $row;
}

function account_security_request_row(PDO $conn, int $userId, ?int $requestId = null): ?array {
    $where = 'r.user_id = :user_id AND r.is_deleted = 0';
    $params = [':user_id' => $userId];
    if ($requestId !== null && $requestId > 0) {
        $where .= ' AND r.request_id = :request_id';
        $params[':request_id'] = $requestId;
    }
    $stmt = $conn->prepare(
        'SELECT r.request_id, r.user_id, r.employee_id, r.reason_code, r.reason_other,
                r.status, r.requested_at, r.reviewed_at, r.reviewed_by, r.reviewer_note
         FROM account_deactivation_requests r
         WHERE ' . $where . '
         ORDER BY r.requested_at DESC, r.request_id DESC
         LIMIT 1'
    );
    $stmt->execute($params);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    $labels = account_security_reason_labels();
    $row['reason_label'] = $labels[(string)$row['reason_code']] ?? 'Other';
    return $row;
}

function account_security_next_request_available_at(PDO $conn, int $userId): ?string {
    $stmt = $conn->prepare(
        "SELECT DATE_ADD(requested_at, INTERVAL 7 DAY) AS available_at
         FROM account_deactivation_requests
         WHERE user_id = :user_id
           AND is_deleted = 0
           AND requested_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
         ORDER BY requested_at DESC, request_id DESC
         LIMIT 1"
    );
    $stmt->execute([':user_id' => $userId]);
    $value = $stmt->fetchColumn();
    return $value ? (string)$value : null;
}

function account_security_sessions(PDO $conn, int $userId, string $username): array {
    if ($userId <= 0) return [];

    if (auth_session_devices_available($conn) && auth_session_devices_modern_available($conn)) {
        $locationSelect = auth_session_device_location_available($conn) ? 'location_label' : 'NULL AS location_label';
        $stmt = $conn->prepare(
            'SELECT session_device_id, session_hash, device_fingerprint, user_agent,
                    ' . $locationSelect . ', is_main_device, trusted_at, new_device_pending,
                    created_at, last_seen_at, revoked_at, blocked_at,
                    TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) AS last_seen_age_seconds
             FROM auth_session_devices
             WHERE user_id = :user_id
             ORDER BY last_seen_at DESC, session_device_id DESC
             LIMIT 50'
        );
        $stmt->execute([':user_id' => $userId]);
        $currentSessionHash = auth_session_hash();
        $devices = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $sessionHash = (string)($row['session_hash'] ?? '');
            $createdAt = $row['created_at'] ?? null;
            $lastSeenAt = $row['last_seen_at'] ?? $createdAt;
            $lastSeenAgeSeconds = max(0, (int)($row['last_seen_age_seconds'] ?? 0));
            $isBlocked = $row['blocked_at'] !== null;
            $isActive = !$isBlocked && $row['revoked_at'] === null;
            $isCurrent = $isActive && $sessionHash !== '' && hash_equals($currentSessionHash, $sessionHash);
            $devices[] = [
                'session_device_id' => (int)($row['session_device_id'] ?? 0),
                'session_key' => $sessionHash,
                'status' => $isBlocked ? 'BLOCKED' : ($isActive ? 'ACTIVE' : 'SIGNED_OUT'),
                'status_label' => $isBlocked ? 'Blocked' : ($isActive ? 'Active' : 'Signed out'),
                'action_time' => $lastSeenAt,
                'action_age_seconds' => $lastSeenAgeSeconds,
                'created_at' => $createdAt,
                'last_seen_at' => $lastSeenAt,
                'user_agent' => trim((string)($row['user_agent'] ?? '')),
                'device_label' => auth_session_device_label((string)($row['user_agent'] ?? '')),
                'location_label' => trim((string)($row['location_label'] ?? '')) ?: null,
                'is_main_device' => (int)($row['is_main_device'] ?? 0) === 1,
                'trusted_at' => $row['trusted_at'] ?? null,
                'new_device_pending' => (int)($row['new_device_pending'] ?? 0) === 1,
                'is_active' => $isActive,
                'is_blocked' => $isBlocked,
                'is_current' => $isCurrent,
            ];
        }

        // A newly signed-in secondary device is not trusted yet. It may see
        // its own active row so the page remains understandable, but it must
        // not receive the account-wide device report or security labels. The
        // main device can review and confirm it; after confirmation, the
        // trusted secondary device may read the full report again.
        $currentDevice = null;
        foreach ($devices as $device) {
            if (!empty($device['is_current'])) {
                $currentDevice = $device;
                break;
            }
        }
        if ($currentDevice && empty($currentDevice['is_main_device']) && !empty($currentDevice['new_device_pending'])) {
            return array_values(array_filter($devices, static function (array $device): bool {
                return !empty($device['is_current']);
            }));
        }
        return $devices;
    }

    // Keep the audit-history view as a safe compatibility fallback until the
    // session-device migration is applied to an existing installation.
    $principalHash = hash('sha256', strtolower(trim($username)));
    $stmt = $conn->prepare(
        "SELECT audit_id, action, status, reason_code, action_time, user_agent, ip_address, metadata,
                TIMESTAMPDIFF(SECOND, action_time, NOW()) AS action_age_seconds
         FROM audit_logs
         WHERE (
             user_id = :user_id
             OR (action = 'LOGIN' AND status = 'FAILURE' AND principal_hash = :principal_hash)
         )
           AND action IN ('LOGIN', 'LOGOUT')
         ORDER BY action_time DESC, audit_id DESC
         LIMIT 200"
    );
    $stmt->execute([
        ':user_id' => $userId,
        ':principal_hash' => $principalHash,
    ]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $groups = [];
    foreach ($rows as $row) {
        $userAgent = trim((string)($row['user_agent'] ?? ''));
        $ipAddress = trim((string)($row['ip_address'] ?? ''));
        // A stable user-agent groups the same browser or phone even when a
        // mobile network changes its IP. If it is unavailable, use the IP;
        // never expose either value to the Settings UI.
        if ($userAgent !== '') {
            $fingerprint = 'device:' . hash('sha256', preg_replace('/\s+/', ' ', strtolower($userAgent)));
        } elseif ($ipAddress !== '') {
            $fingerprint = 'network:' . hash('sha256', $ipAddress);
        } else {
            $fingerprint = 'event:' . (int)($row['audit_id'] ?? 0);
        }

        if (!isset($groups[$fingerprint])) {
            $groups[$fingerprint] = [
                'action' => (string)($row['action'] ?? ''),
                'status' => (string)($row['status'] ?? ''),
                'reason_code' => $row['reason_code'] ?? null,
                'action_time' => $row['action_time'] ?? null,
                'action_age_seconds' => max(0, (int)($row['action_age_seconds'] ?? 0)),
                'user_agent' => $userAgent,
                'event_count' => 0,
                'history' => [],
            ];
        }

        $groups[$fingerprint]['event_count']++;
        if (count($groups[$fingerprint]['history']) < 20) {
            $groups[$fingerprint]['history'][] = [
                'action' => (string)($row['action'] ?? ''),
                'status' => (string)($row['status'] ?? ''),
                'reason_code' => $row['reason_code'] ?? null,
                'action_time' => $row['action_time'] ?? null,
                'action_age_seconds' => max(0, (int)($row['action_age_seconds'] ?? 0)),
            ];
        }
    }

    return array_values(array_slice($groups, 0, 20));
}

function account_security_session_action(PDO $conn, array $session): void {
    if (!auth_session_devices_available($conn) || !auth_session_devices_modern_available($conn)) {
        account_security_respond([
            'success' => false,
            'message' => 'Device session controls are not available yet. Apply the account session migration first.',
        ], 503);
    }

    $body = account_security_body();
    $action = strtolower(trim((string)($body['action'] ?? '')));
    $sessionKey = strtolower(trim((string)($body['session_key'] ?? '')));
    if (!in_array($action, ['terminate', 'block'], true) || !preg_match('/^[a-f0-9]{64}$/', $sessionKey)) {
        account_security_respond(['success' => false, 'message' => 'Choose a valid login session action.'], 422);
    }

    // The main device is the only session allowed to control other login
    // sessions. The frontend hides the control everywhere else, but keep the
    // authorization check here so a non-main device cannot call this endpoint
    // directly.
    if (empty($session['is_main_device'])) {
        account_security_respond([
            'success' => false,
            'message' => 'Only the main device can manage login sessions.',
        ], 403);
    }

    $userId = (int)($session['user_id'] ?? 0);
    $currentSessionKey = auth_session_hash();
    if (hash_equals($currentSessionKey, $sessionKey)) {
        account_security_respond([
            'success' => false,
            'message' => 'This is the device you are currently using. Use Log out to end it.',
        ], 409);
    }

    try {
        $conn->beginTransaction();
        $targetStmt = $conn->prepare(
            'SELECT session_device_id, user_id, session_hash, device_fingerprint,
                    user_agent, revoked_at, blocked_at
             FROM auth_session_devices
             WHERE user_id = :user_id AND session_hash = :session_hash
             LIMIT 1 FOR UPDATE'
        );
        $targetStmt->execute([':user_id' => $userId, ':session_hash' => $sessionKey]);
        $target = $targetStmt->fetch(PDO::FETCH_ASSOC);
        if (!$target) {
            $conn->rollBack();
            account_security_respond(['success' => false, 'message' => 'That login session is no longer available.'], 404);
        }
        if ($target['blocked_at'] !== null || $target['revoked_at'] !== null) {
            $conn->rollBack();
            account_security_respond(['success' => false, 'message' => 'That login session has already ended.'], 409);
        }

        if ($action === 'block') {
            $update = $conn->prepare(
                'UPDATE auth_session_devices
                 SET blocked_at = NOW(), revoked_at = NOW()
                 WHERE user_id = :user_id AND device_fingerprint = :device_fingerprint
                   AND revoked_at IS NULL AND blocked_at IS NULL'
            );
            $update->execute([
                ':user_id' => $userId,
                ':device_fingerprint' => (string)$target['device_fingerprint'],
            ]);
            audit_log_event($conn, 'DEVICE_BLOCKED', 'SUCCESS', [
                'event_type' => 'ACCOUNT_SECURITY',
                'table_name' => 'auth_session_devices',
                'record_id' => (int)$target['session_device_id'],
                'target_type' => 'device',
                'actor_user_id' => $userId,
                'reason_code' => 'USER_REPORTED_DEVICE',
                'metadata' => ['terminated_sessions' => (int)$update->rowCount()],
            ]);
        } else {
            $update = $conn->prepare(
                'UPDATE auth_session_devices
                 SET revoked_at = NOW()
                 WHERE user_id = :user_id AND session_hash = :session_hash
                   AND revoked_at IS NULL AND blocked_at IS NULL'
            );
            $update->execute([':user_id' => $userId, ':session_hash' => $sessionKey]);
            audit_log_event($conn, 'SESSION_TERMINATED', 'SUCCESS', [
                'event_type' => 'ACCOUNT_SECURITY',
                'table_name' => 'auth_session_devices',
                'record_id' => (int)$target['session_device_id'],
                'target_type' => 'session',
                'actor_user_id' => $userId,
                'reason_code' => 'USER_TERMINATED_SESSION',
            ]);
        }
        $conn->commit();
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        account_security_respond(['success' => false, 'message' => 'The login-session action could not be completed right now.'], 500);
    }

    account_security_respond([
        'success' => true,
        'message' => $action === 'block'
            ? 'Device blocked. Its active sessions were ended.'
            : 'The login session was terminated.',
    ]);
}

function account_security_resolve_new_device(PDO $conn, array $session): void {
    if (!auth_session_devices_available($conn) || !auth_session_devices_modern_available($conn)) {
        account_security_respond(['success' => false, 'message' => 'Device confirmation is not available yet. Apply the account session migration first.'], 503);
    }

    if (empty($session['is_main_device'])) {
        account_security_respond([
            'success' => false,
            'message' => 'Only the main device can confirm a new login device.',
        ], 403);
    }

    $body = account_security_body();
    $decision = strtolower(trim((string)($body['decision'] ?? '')));
    $targetSessionHash = strtolower(trim((string)($body['session_key'] ?? '')));
    if (!in_array($decision, ['yes', 'no'], true) || !preg_match('/^[a-f0-9]{64}$/', $targetSessionHash)) {
        account_security_respond(['success' => false, 'message' => 'Choose Yes or No to confirm this device.'], 422);
    }

    $userId = (int)($session['user_id'] ?? 0);
    $device = null;
    try {
        $conn->beginTransaction();
        $deviceStmt = $conn->prepare(
            'SELECT session_device_id, user_id, device_fingerprint, user_agent,
                    is_main_device, trusted_at, new_device_pending, revoked_at, blocked_at
             FROM auth_session_devices
             WHERE user_id = :user_id AND session_hash = :session_hash
             LIMIT 1 FOR UPDATE'
        );
        $deviceStmt->execute([':user_id' => $userId, ':session_hash' => $targetSessionHash]);
        $device = $deviceStmt->fetch(PDO::FETCH_ASSOC);
        if (!$device) {
            $conn->rollBack();
            account_security_respond(['success' => false, 'message' => 'This login device is no longer available.'], 409);
        }
        if ($device['blocked_at'] !== null || $device['revoked_at'] !== null) {
            $conn->rollBack();
            account_security_respond(['success' => false, 'message' => 'This login device is no longer active.'], 409);
        }
        if ((int)$device['is_main_device'] === 1) {
            $conn->rollBack();
            account_security_respond(['success' => false, 'message' => 'The main device does not need confirmation.'], 409);
        }
        if ((int)$device['new_device_pending'] !== 1) {
            $conn->rollBack();
            account_security_respond(['success' => true, 'message' => 'This device was already confirmed.', 'data' => ['confirmed' => true]]);
        }

        if ($decision === 'yes') {
            $update = $conn->prepare(
                'UPDATE auth_session_devices
                 SET trusted_at = NOW(), new_device_pending = 0
                 WHERE session_device_id = :session_device_id'
            );
            $update->execute([':session_device_id' => (int)$device['session_device_id']]);
            audit_log_event($conn, 'DEVICE_CONFIRMED', 'SUCCESS', [
                'event_type' => 'ACCOUNT_SECURITY',
                'table_name' => 'auth_session_devices',
                'record_id' => (int)$device['session_device_id'],
                'target_type' => 'device',
                'actor_user_id' => $userId,
                'reason_code' => 'NEW_DEVICE_CONFIRMED',
            ]);
        } else {
            $update = $conn->prepare(
                'UPDATE auth_session_devices
                 SET blocked_at = NOW(), revoked_at = NOW(), new_device_pending = 0
                 WHERE session_device_id = :session_device_id'
            );
            $update->execute([':session_device_id' => (int)$device['session_device_id']]);
            audit_log_event($conn, 'DEVICE_BLOCKED', 'SUCCESS', [
                'event_type' => 'ACCOUNT_SECURITY',
                'table_name' => 'auth_session_devices',
                'record_id' => (int)$device['session_device_id'],
                'target_type' => 'device',
                'actor_user_id' => $userId,
                'reason_code' => 'NEW_DEVICE_NOT_RECOGNIZED',
            ]);
        }
        $conn->commit();
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        account_security_respond(['success' => false, 'message' => 'The device confirmation could not be saved right now.'], 500);
    }

    // Keep the account notification unread until the user explicitly opens or
    // marks it read. Notification read state is shared across account devices,
    // so resolving the prompt here would hide the warning from the other
    // already-signed-in device.

    if ($decision === 'no') {
        account_security_respond([
            'success' => true,
            'blocked' => true,
            'message' => 'The new device was blocked. If this was not you, change your password.',
            'data' => ['device_label' => auth_session_device_label((string)($device['user_agent'] ?? ''))],
        ]);
    }

    account_security_respond([
        'success' => true,
        'confirmed' => true,
        'message' => 'This device is now confirmed for your account.',
        'data' => ['device_label' => auth_session_device_label((string)($device['user_agent'] ?? ''))],
    ]);
}

function account_security_profile(PDO $conn, array $session): array {
    account_security_expire_pending_requests($conn);
    $userId = (int)($session['user_id'] ?? 0);
    $stmt = $conn->prepare(
        'SELECT u.user_id, u.username, COALESCE(u.account_created_at, u.created_at) AS account_created_at,
                u.is_active,
                COALESCE(
                    NULLIF(TRIM(CONCAT_WS(\' \', e.first_name, e.middle_name, e.last_name, e.name_extension)), \'\'),
                    NULLIF(TRIM(CONCAT_WS(\' \', l.first_name, l.middle_name, l.last_name)), \'\'),
                    u.username
                ) AS full_name
         FROM users u
         LEFT JOIN employees e ON e.user_id = u.user_id AND e.is_deleted = 0
         LEFT JOIN learners l ON l.user_id = u.user_id AND l.is_deleted = 0
         WHERE u.user_id = :user_id AND u.is_deleted = 0
         LIMIT 1'
    );
    $stmt->execute([':user_id' => $userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $data = [
        'account_created_at' => $row['account_created_at'] ?? null,
        'full_name' => trim((string)($row['full_name'] ?? '')),
        'account_type' => (string)($session['account_type'] ?? ''),
        'role_key' => (string)($session['role_key'] ?? ''),
        'role_name' => (string)($session['role_name'] ?? ''),
        'is_active' => (int)($row['is_active'] ?? 0) === 1,
        'sessions' => account_security_sessions($conn, $userId, (string)($row['username'] ?? $_SESSION['username'] ?? '')),
    ];
    // Deactivation is an employee workflow. Do not return request records or
    // reason choices to learners, even though the shared Settings page calls
    // this endpoint for every signed-in account type.
    if (account_security_is_employee($session)) {
        $request = account_security_request_row($conn, $userId);
        $data['deactivation_request'] = $request && strtoupper((string)$request['status']) === 'PENDING' ? $request : null;
        $data['deactivation_available_at'] = account_security_next_request_available_at($conn, $userId);
        $data['deactivation_reasons'] = account_security_reason_labels();
    }
    return $data;
}

function account_security_admin_requests(PDO $conn): void {
    account_security_expire_pending_requests($conn);
    $limit = max(1, min(100, (int)($_GET['limit'] ?? 50)));
    $status = strtoupper(trim((string)($_GET['status'] ?? 'PENDING')));
    $allowed = ['PENDING', 'APPROVED', 'DECLINED', 'CANCELLED', 'ALL'];
    if (!in_array($status, $allowed, true)) $status = 'PENDING';

    $where = 'r.is_deleted = 0';
    $params = [];
    if ($status !== 'ALL') {
        $where .= ' AND r.status = :status';
        $params[':status'] = $status;
    }

    $stmt = $conn->prepare(
        'SELECT r.request_id, r.user_id, r.employee_id, r.reason_code, r.reason_other,
                r.status, r.requested_at, r.reviewed_at, r.reviewed_by, r.reviewer_note,
                COALESCE(NULLIF(TRIM(CONCAT_WS(\' \', e.first_name, e.middle_name, e.last_name, e.name_extension)), \'\'), u.username) AS full_name,
                u.username, u.is_active, COALESCE(u.account_created_at, u.created_at) AS account_created_at
         FROM account_deactivation_requests r
         JOIN users u ON u.user_id = r.user_id
         JOIN employees e ON e.employee_id = r.employee_id AND e.is_deleted = 0
         WHERE ' . $where . '
         ORDER BY CASE WHEN r.status = \'PENDING\' THEN 0 ELSE 1 END, r.requested_at DESC, r.request_id DESC
         LIMIT :limit'
    );
    foreach ($params as $key => $value) $stmt->bindValue($key, $value);
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $labels = account_security_reason_labels();
    foreach ($rows as &$row) {
        $row['full_name'] = trim((string)($row['full_name'] ?? '')) ?: (string)($row['username'] ?? 'Account');
        $row['reason_label'] = $labels[(string)$row['reason_code']] ?? 'Other';
    }
    unset($row);
    account_security_respond(['success' => true, 'data' => $rows]);
}

function account_security_create_request(PDO $conn, array $session): void {
    if (!account_security_is_employee($session)) {
        account_security_respond(['success' => false, 'message' => 'Only employee accounts can request deactivation.'], 403);
    }

    $employee = account_security_employee($conn, (int)$session['user_id']);
    if (!$employee) account_security_respond(['success' => false, 'message' => 'Employee account details were not found.'], 422);

    $body = account_security_body();
    $reason = strtoupper(trim((string)($body['reason_code'] ?? '')));
    $other = trim((string)($body['reason_other'] ?? ''));
    $labels = account_security_reason_labels();
    if (!isset($labels[$reason])) account_security_respond(['success' => false, 'message' => 'Choose a reason for the request.'], 422);
    if ($reason === 'OTHER' && $other === '') account_security_respond(['success' => false, 'message' => 'Please briefly explain the other reason.'], 422);
    $other = $other !== '' ? substr($other, 0, 500) : null;

    account_security_expire_pending_requests($conn);

    try {
        $conn->beginTransaction();
        // Lock the account row while checking the seven-day window so two
        // quick submissions cannot both pass the policy at the same time.
        $lock = $conn->prepare('SELECT user_id FROM users WHERE user_id = :user_id FOR UPDATE');
        $lock->execute([':user_id' => (int)$session['user_id']]);

        $existing = $conn->prepare(
            "SELECT request_id, status, requested_at,
                    DATE_ADD(requested_at, INTERVAL 7 DAY) AS available_at
             FROM account_deactivation_requests
             WHERE user_id = :user_id
               AND is_deleted = 0
               AND (status = 'PENDING' OR requested_at >= DATE_SUB(NOW(), INTERVAL 7 DAY))
             ORDER BY requested_at DESC, request_id DESC
             LIMIT 1"
        );
        $existing->execute([':user_id' => (int)$session['user_id']]);
        $recentRequest = $existing->fetch(PDO::FETCH_ASSOC);
        if ($recentRequest && strtoupper((string)$recentRequest['status']) === 'PENDING') {
            $conn->rollBack();
            account_security_respond(['success' => false, 'message' => 'You already have a request waiting for review.'], 409);
        }
        if ($recentRequest) {
            $conn->rollBack();
            account_security_respond([
                'success' => false,
                'message' => 'You can send another request after the seven-day waiting period.',
                'data' => [
                    'status' => $recentRequest['status'],
                    'requested_at' => $recentRequest['requested_at'],
                    'available_at' => $recentRequest['available_at'],
                ],
            ], 429);
        }

        $stmt = $conn->prepare(
            "INSERT INTO account_deactivation_requests
                (user_id, employee_id, reason_code, reason_other, status)
             VALUES (:user_id, :employee_id, :reason_code, :reason_other, 'PENDING')"
        );
        $stmt->execute([
            ':user_id' => (int)$session['user_id'],
            ':employee_id' => (int)$employee['employee_id'],
            ':reason_code' => $reason,
            ':reason_other' => $other,
        ]);
        $requestId = (int)$conn->lastInsertId();
        audit_log_event($conn, 'DEACTIVATION_REQUEST', 'SUCCESS', [
            'event_type' => 'ACCOUNT_SECURITY',
            'table_name' => 'account_deactivation_requests',
            'record_id' => $requestId,
            'target_type' => 'account',
            'actor_user_id' => (int)$session['user_id'],
            'reason_code' => $reason,
            'metadata' => ['reason_label' => $labels[$reason]],
        ]);
        $conn->commit();
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        account_security_respond(['success' => false, 'message' => 'The request could not be submitted right now.'], 500);
    }

    $adminRoleId = notifications_get_role_id($conn, 'admin');
    if ($adminRoleId !== null) {
        notifications_create_for_role(
            $conn,
            $adminRoleId,
            'Announcement',
            'Account deactivation requested',
            $employee['full_name'] . ' requested account deactivation. Review the request in Settings.',
            'account_deactivation_requests',
            $requestId,
            (int)$session['user_id'],
            null,
            (int)$session['user_id']
        );
    }

    account_security_respond([
        'success' => true,
        'message' => 'Your request was sent to an administrator for review.',
        'data' => account_security_request_row($conn, (int)$session['user_id'], $requestId),
    ], 201);
}

function account_security_cancel_request(PDO $conn, array $session): void {
    if (!account_security_is_employee($session)) {
        account_security_respond(['success' => false, 'message' => 'Only employee accounts can manage deactivation requests.'], 403);
    }
    $request = account_security_request_row($conn, (int)$session['user_id']);
    if (!$request || $request['status'] !== 'PENDING') {
        account_security_respond(['success' => false, 'message' => 'There is no pending request to cancel.'], 409);
    }
    $stmt = $conn->prepare(
        "UPDATE account_deactivation_requests
         SET status = 'CANCELLED', reviewed_at = NOW(), reviewed_by = :reviewed_by,
             reviewer_note = 'Cancelled by the account owner'
         WHERE request_id = :request_id AND user_id = :user_id AND status = 'PENDING'
           AND requested_at >= DATE_SUB(NOW(), INTERVAL 10 SECOND)"
    );
    $stmt->execute([
        ':reviewed_by' => (int)$session['user_id'],
        ':request_id' => (int)$request['request_id'],
        ':user_id' => (int)$session['user_id'],
    ]);
    if ($stmt->rowCount() !== 1) {
        account_security_respond(['success' => false, 'message' => 'The 10-second undo window has ended.'], 409);
    }
    audit_log_event($conn, 'DEACTIVATION_REQUEST', 'SUCCESS', [
        'event_type' => 'ACCOUNT_SECURITY',
        'table_name' => 'account_deactivation_requests',
        'record_id' => (int)$request['request_id'],
        'target_type' => 'account',
        'actor_user_id' => (int)$session['user_id'],
        'reason_code' => 'REQUEST_CANCELLED',
    ]);
    account_security_respond(['success' => true, 'message' => 'Your request was cancelled.']);
}

function account_security_review_request(PDO $conn, array $session): void {
    $body = account_security_body();
    $requestId = (int)($body['request_id'] ?? 0);
    $decision = strtoupper(trim((string)($body['decision'] ?? '')));
    $note = trim((string)($body['reviewer_note'] ?? ''));
    $adminPassword = (string)($body['admin_password'] ?? '');
    if ($requestId <= 0 || !in_array($decision, ['APPROVE', 'DECLINE'], true)) {
        account_security_respond(['success' => false, 'message' => 'A request and review decision are required.'], 422);
    }
    if ((int)$session['user_id'] <= 0) account_security_respond(['success' => false, 'message' => 'Not authenticated.'], 401);
    if ($adminPassword === '') {
        account_security_respond(['success' => false, 'message' => 'Re-enter your administrator password to continue.'], 422);
    }
    if (!account_security_verify_admin_password($conn, $session, $adminPassword)) {
        audit_log_event($conn, 'DEACTIVATION_REQUEST_REVIEW', 'FAILURE', [
            'event_type' => 'ACCOUNT_SECURITY',
            'table_name' => 'account_deactivation_requests',
            'record_id' => $requestId,
            'target_type' => 'account',
            'actor_user_id' => (int)$session['user_id'],
            'reason_code' => 'REAUTHENTICATION_FAILED',
            'metadata' => ['decision' => $decision],
        ]);
        account_security_respond(['success' => false, 'message' => 'Password confirmation was not accepted.'], 403);
    }

    try {
        $conn->beginTransaction();
        $stmt = $conn->prepare(
            "SELECT r.*, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.middle_name, e.last_name, e.name_extension)), ''), u.username) AS full_name,
                    u.username
             FROM account_deactivation_requests r
             JOIN users u ON u.user_id = r.user_id
             JOIN employees e ON e.employee_id = r.employee_id AND e.is_deleted = 0
             WHERE r.request_id = :request_id AND r.is_deleted = 0
             LIMIT 1 FOR UPDATE"
        );
        $stmt->execute([':request_id' => $requestId]);
        $request = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$request || $request['status'] !== 'PENDING') {
            $conn->rollBack();
            account_security_respond(['success' => false, 'message' => 'This request is no longer waiting for review.'], 409);
        }
        if ((int)$request['user_id'] === (int)$session['user_id']) {
            $conn->rollBack();
            account_security_respond(['success' => false, 'message' => 'Another administrator must review this request.'], 422);
        }

        $nextStatus = $decision === 'APPROVE' ? 'APPROVED' : 'DECLINED';
        $note = $note !== '' ? substr($note, 0, 500) : null;
        $update = $conn->prepare(
            'UPDATE account_deactivation_requests
             SET status = :status, reviewed_at = NOW(), reviewed_by = :reviewed_by, reviewer_note = :reviewer_note
             WHERE request_id = :request_id AND status = \'PENDING\''
        );
        $update->execute([
            ':status' => $nextStatus,
            ':reviewed_by' => (int)$session['user_id'],
            ':reviewer_note' => $note,
            ':request_id' => $requestId,
        ]);

        if ($decision === 'APPROVE') {
            $deactivate = $conn->prepare('UPDATE users SET is_active = 0 WHERE user_id = :user_id AND is_deleted = 0');
            $deactivate->execute([':user_id' => (int)$request['user_id']]);
        }

        audit_log_event($conn, 'DEACTIVATION_REQUEST_REVIEW', 'SUCCESS', [
            'event_type' => 'ACCOUNT_SECURITY',
            'table_name' => 'account_deactivation_requests',
            'record_id' => $requestId,
            'target_type' => 'account',
            'actor_user_id' => (int)$session['user_id'],
            'reason_code' => $decision === 'APPROVE' ? 'REQUEST_APPROVED' : 'REQUEST_DECLINED',
            'metadata' => [
                'decision' => $decision,
                'requester_user_id' => (int)$request['user_id'],
                'reviewer_note_provided' => $note !== null,
            ],
        ]);
        if ($decision === 'APPROVE') {
            audit_log_event($conn, 'ACCOUNT_DEACTIVATED', 'SUCCESS', [
                'event_type' => 'ACCOUNT_SECURITY',
                'table_name' => 'users',
                'record_id' => (int)$request['user_id'],
                'target_type' => 'account',
                'actor_user_id' => (int)$session['user_id'],
                'reason_code' => 'DEACTIVATION_REQUEST_APPROVED',
                'old_values' => ['is_active' => 1],
                'new_values' => ['is_active' => 0],
            ]);
        }
        $conn->commit();
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        account_security_respond(['success' => false, 'message' => 'The review could not be saved right now.'], 500);
    }

    $title = $decision === 'APPROVE' ? 'Account deactivation approved' : 'Account deactivation request update';
    $message = $decision === 'APPROVE'
        ? 'Your account deactivation request was approved. You can no longer sign in.'
        : 'Your account deactivation request was not approved.' . ($note ? ' Note: ' . $note : '');
    notifications_create_for_user(
        $conn,
        (int)$request['user_id'],
        'Announcement',
        $title,
        $message,
        'account_deactivation_requests',
        $requestId,
        0,
        (int)$session['user_id']
    );
    account_security_respond(['success' => true, 'message' => $decision === 'APPROVE' ? 'The account was deactivated.' : 'The request was declined.']);
}

function account_security_reactivate_request(PDO $conn, array $session): void {
    $body = account_security_body();
    $requestId = (int)($body['request_id'] ?? 0);
    $adminPassword = (string)($body['admin_password'] ?? '');
    if ($requestId <= 0) {
        account_security_respond(['success' => false, 'message' => 'A request is required.'], 422);
    }
    if ($adminPassword === '') {
        account_security_respond(['success' => false, 'message' => 'Re-enter your administrator password to continue.'], 422);
    }
    if (!account_security_verify_admin_password($conn, $session, $adminPassword)) {
        audit_log_event($conn, 'ACCOUNT_REACTIVATION', 'FAILURE', [
            'event_type' => 'ACCOUNT_SECURITY',
            'table_name' => 'account_deactivation_requests',
            'record_id' => $requestId,
            'target_type' => 'account',
            'actor_user_id' => (int)$session['user_id'],
            'reason_code' => 'REAUTHENTICATION_FAILED',
        ]);
        account_security_respond(['success' => false, 'message' => 'Password confirmation was not accepted.'], 403);
    }

    try {
        $conn->beginTransaction();
        $stmt = $conn->prepare(
            'SELECT r.request_id, r.user_id, r.status, u.is_active
             FROM account_deactivation_requests r
             JOIN users u ON u.user_id = r.user_id AND u.is_deleted = 0
             WHERE r.request_id = :request_id AND r.is_deleted = 0
             LIMIT 1 FOR UPDATE'
        );
        $stmt->execute([':request_id' => $requestId]);
        $request = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$request || strtoupper((string)$request['status']) !== 'APPROVED') {
            $conn->rollBack();
            account_security_respond(['success' => false, 'message' => 'Only approved deactivation requests can be reactivated.'], 409);
        }
        if ((int)$request['is_active'] === 1) {
            $conn->rollBack();
            account_security_respond(['success' => false, 'message' => 'This account is already active.'], 409);
        }

        $update = $conn->prepare('UPDATE users SET is_active = 1 WHERE user_id = :user_id AND is_deleted = 0');
        $update->execute([':user_id' => (int)$request['user_id']]);
        audit_log_event($conn, 'ACCOUNT_REACTIVATED', 'SUCCESS', [
            'event_type' => 'ACCOUNT_SECURITY',
            'table_name' => 'users',
            'record_id' => (int)$request['user_id'],
            'target_type' => 'account',
            'actor_user_id' => (int)$session['user_id'],
            'reason_code' => 'DEACTIVATION_ARCHIVE_REACTIVATED',
            'old_values' => ['is_active' => 0],
            'new_values' => ['is_active' => 1],
            'metadata' => ['request_id' => $requestId],
        ]);
        $conn->commit();
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        account_security_respond(['success' => false, 'message' => 'The account could not be reactivated right now.'], 500);
    }

    notifications_create_for_user(
        $conn,
        (int)$request['user_id'],
        'Announcement',
        'Account reactivated',
        'Your account has been reactivated by an administrator.',
        'account_deactivation_requests',
        $requestId,
        0,
        (int)$session['user_id']
    );
    account_security_respond(['success' => true, 'message' => 'The account was reactivated.']);
}

$operation = trim((string)($_GET['operation'] ?? 'getAccountSecurity'));
$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

if ($operation === 'getAccountSecurity') {
    $session = auth_require();
    account_security_respond(['success' => true, 'data' => account_security_profile($conn, $session)]);
}

if ($operation === 'manageSession' && $method === 'POST') {
    $session = auth_require();
    account_security_session_action($conn, $session);
}

if ($operation === 'resolveNewDevice' && $method === 'POST') {
    $session = auth_require();
    account_security_resolve_new_device($conn, $session);
}

if ($operation === 'getDeactivationRequests') {
    auth_require_roles(['admin']);
    account_security_admin_requests($conn);
}

if ($operation === 'requestDeactivation' && $method === 'POST') {
    $session = auth_require();
    account_security_create_request($conn, $session);
}

if ($operation === 'cancelDeactivation' && $method === 'POST') {
    $session = auth_require();
    account_security_cancel_request($conn, $session);
}

if ($operation === 'reviewDeactivation' && $method === 'POST') {
    $session = auth_require_roles(['admin']);
    account_security_review_request($conn, $session);
}

if ($operation === 'reactivateAccount' && $method === 'POST') {
    $session = auth_require_roles(['admin']);
    account_security_reactivate_request($conn, $session);
}

account_security_respond(['success' => false, 'message' => 'Invalid operation.'], 400);
