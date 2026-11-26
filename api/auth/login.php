<?php
require_once __DIR__ . '/../utils/cors.php';
header('Content-Type: application/json');

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/password_policy.php';
require_once __DIR__ . '/../utils/account_credentials.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';
require_once __DIR__ . '/../utils/audit.php';
require_once __DIR__ . '/../utils/notifications.php';

auth_start_session();
auth_send_no_cache_headers();

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function recordLoginEvent(PDO $conn, ?array $user, string $principal, string $reasonCode, string $status = 'FAILURE', array $metadata = []): void {
    $legacyUserId = $user && isset($user['legacy_user_id']) ? (int)$user['legacy_user_id'] : null;
    $metadata = ['account_match' => $user !== null] + $metadata;
    audit_log_event($conn, 'LOGIN', $status, [
        'event_type' => 'SECURITY',
        'table_name' => 'authentication',
        'record_id' => $legacyUserId ?: null,
        'target_type' => 'account',
        // A pre-authentication event has no authenticated actor. A successful
        // login becomes attributable only after credentials are verified.
        'actor_user_id' => $status === 'SUCCESS' && $legacyUserId ? $legacyUserId : null,
        'reason_code' => $reasonCode,
        'principal' => $principal,
        // Show the matched account name in the admin audit feed. Unknown
        // principals remain masked by audit_principal_values().
        'principal_hint' => $status !== 'SUCCESS' && $user
            ? (string)($user['username'] ?? '')
            : null,
        'metadata' => $metadata,
    ]);
}

function recordKnownLoginFailure(PDO $conn, array $user, string $principal, string $reasonCode): array {
    $result = [
        'failed_login_count' => (int)($user['failed_login_count'] ?? 0),
        'locked_until' => $user['locked_until'] ?? null,
        'locked' => false,
    ];

    try {
        $conn->beginTransaction();
        $result = account_credentials_record_login_failure(
            $conn,
            (string)$user['account_type'],
            (int)$user['actor_id'],
            isset($user['legacy_user_id']) ? (int)$user['legacy_user_id'] : null
        );
        $eventReason = !empty($result['locked']) ? 'ACCOUNT_LOCKED' : $reasonCode;
        recordLoginEvent($conn, $user, $principal, $eventReason, 'FAILURE', [
            'failed_login_count' => (int)($result['failed_login_count'] ?? 0),
            'locked_until' => $result['locked_until'] ?? null,
        ]);
        $conn->commit();
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        // Preserve a security event even if the optional counter update cannot
        // be written. Never include credentials in the event.
        recordLoginEvent($conn, $user, $principal, 'SYSTEM_ERROR', 'FAILURE');
    }

    return $result;
}

$data = getJsonInput();
$username = trim((string)($data['username'] ?? ''));
$password = (string)($data['password'] ?? '');

if ($username === '' || $password === '') {
    recordLoginEvent($conn, null, $username, 'MISSING_CREDENTIALS');
    respond(['success' => false, 'message' => 'Username and password are required.'], 422);
}

$versionSelect = password_policy_has_column($conn, 'auth_version') ? '(SELECT auth_version FROM users WHERE user_id=ac.legacy_user_id)' : '0';
$accountSql = account_credentials_derived_sql();
$stmt = $conn->prepare('SELECT ' . $versionSelect . ' AS auth_version, account_type, actor_id, legacy_user_id, username, password, role_id,
                               role_name, is_active, must_change_password, password_updated_at, failed_login_count, locked_until
    FROM (' . $accountSql . ') ac
    WHERE ac.username = :username AND ac.is_deleted = 0
    LIMIT 1');
$stmt->bindValue(':username', $username);
$stmt->execute();
$user = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$user) {
    recordLoginEvent($conn, null, $username, 'INVALID_CREDENTIALS');
    respond(['success' => false, 'message' => 'Invalid username or password.'], 401);
}

if (!empty($user['locked_until']) && strtotime((string)$user['locked_until']) > time()) {
    recordLoginEvent($conn, $user, $username, 'ACCOUNT_LOCKED', 'FAILURE', [
        'locked_until' => $user['locked_until'],
        'failed_login_count' => (int)($user['failed_login_count'] ?? 0),
    ]);
    respond(['success' => false, 'message' => 'Account temporarily locked. Try again later.'], 429);
}

if (!password_verify($password, (string)$user['password'])) {
    $failure = recordKnownLoginFailure($conn, $user, $username, 'INVALID_CREDENTIALS');
    if (!empty($failure['locked'])) {
        respond(['success' => false, 'message' => 'Account temporarily locked. Try again later.'], 429);
    }
    respond(['success' => false, 'message' => 'Invalid username or password.'], 401);
}

if ((int)$user['is_active'] !== 1) {
    recordLoginEvent($conn, $user, $username, 'ACCOUNT_INACTIVE');
    respond(['success' => false, 'message' => 'Account is inactive.'], 403);
}

$legacyUserId = isset($user['legacy_user_id']) ? (int)$user['legacy_user_id'] : 0;
if ($legacyUserId > 0 && auth_session_device_is_blocked($conn, $legacyUserId)) {
    recordLoginEvent($conn, $user, $username, 'DEVICE_BLOCKED', 'DENIED', [
        'device_control' => 'blocked_device_cookie',
    ]);
    respond([
        'success' => false,
        'message' => 'This device is blocked for this account. Use another device or contact an administrator.',
    ], 403);
}

// Record the successful login and reset the failure counter. Audit failure is
// best-effort so a logging outage does not become an authentication outage.
try {
    $conn->beginTransaction();
    account_credentials_record_login_success(
        $conn,
        (string)$user['account_type'],
        (int)$user['actor_id'],
        isset($user['legacy_user_id']) ? (int)$user['legacy_user_id'] : null
    );
    recordLoginEvent($conn, $user, $username, 'AUTHENTICATED', 'SUCCESS', [
        'account_type' => (string)$user['account_type'],
        'role_id' => (int)$user['role_id'],
    ]);
    $conn->commit();
} catch (Throwable $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    // Keep the legacy last-login behavior available if a credential-source
    // column or audit migration is temporarily unavailable.
    try {
        account_credentials_update_last_login(
            $conn,
            (string)$user['account_type'],
            (int)$user['actor_id'],
            isset($user['legacy_user_id']) ? (int)$user['legacy_user_id'] : null
        );
    } catch (Throwable $ignored) {
        // Login remains successful; operational logs can capture the error.
    }
}

session_regenerate_id(true);
$_SESSION['auth_version'] = (int)$user['auth_version'];
$_SESSION['user_id'] = isset($user['legacy_user_id']) ? (int)$user['legacy_user_id'] : 0;
$_SESSION['legacy_user_id'] = isset($user['legacy_user_id']) ? (int)$user['legacy_user_id'] : 0;
$_SESSION['account_type'] = (string)$user['account_type'];
$_SESSION['actor_id'] = (int)$user['actor_id'];
$_SESSION['username'] = $user['username'];
$_SESSION['role_id'] = (int)$user['role_id'];
$_SESSION['role_name'] = $user['role_name'];

$mustChangePassword = !empty($user['must_change_password']);
if (!$mustChangePassword && password_verify($user['username'], $user['password'])) {
    $mustChangePassword = true;
    try {
        account_credentials_mark_default_password(
            $conn,
            (string)$user['account_type'],
            (int)$user['actor_id'],
            isset($user['legacy_user_id']) ? (int)$user['legacy_user_id'] : null
        );
    } catch (Throwable $e) {
        // Login still succeeds; profile alert can be shown from the derived flag.
    }
}
$_SESSION['must_change_password'] = $mustChangePassword ? 1 : 0;

// Activity tracking / idle timeout support.
$_SESSION['last_activity'] = time();
$_SESSION['user_agent'] = (string)($_SERVER['HTTP_USER_AGENT'] ?? '');
$sessionDevice = auth_session_device_register(
    $conn,
    $legacyUserId,
    trim((string)($data['client_timezone'] ?? '')),
    is_array($data['client_location'] ?? null) ? $data['client_location'] : null
);
if ($sessionDevice && !empty($sessionDevice['new_device_pending'])) {
    $deviceLabel = auth_session_device_label((string)($sessionDevice['user_agent'] ?? ''));
    if (!empty($sessionDevice['is_new_device']) && !empty($sessionDevice['session_device_id'])) {
        notifications_create_for_user(
            $conn,
            $legacyUserId,
            'Announcement',
            'New device sign-in',
            'A new device signed in to your account: ' . $deviceLabel . '. Confirm whether this was you. If not, block the device and change your password.',
            'auth_session_devices',
            (int)$sessionDevice['session_device_id'],
            0,
            $legacyUserId
        );
    }
}

respond([
    'success' => true,
    'message' => 'Login successful',
    'data' => [
        'user_id' => isset($user['legacy_user_id']) ? (int)$user['legacy_user_id'] : 0,
        'legacy_user_id' => isset($user['legacy_user_id']) ? (int)$user['legacy_user_id'] : 0,
        'account_type' => (string)$user['account_type'],
        'actor_id' => (int)$user['actor_id'],
        'username' => $user['username'],
        'role_id' => (int)$user['role_id'],
        'role_name' => $user['role_name'],
        'must_change_password' => $mustChangePassword
    ]
]);
?>
