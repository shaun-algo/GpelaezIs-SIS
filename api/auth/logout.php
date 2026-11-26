<?php
header('Content-Type: application/json');
require_once __DIR__ . '/../utils/cors.php';
require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/account_credentials.php';
require_once __DIR__ . '/../utils/audit.php';

auth_start_session();

if (!headers_sent()) {
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
}

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

$userId = (int)($_SESSION['user_id'] ?? 0) ?: null;
audit_log_event($conn, 'LOGOUT', 'SUCCESS', [
    'event_type' => 'SECURITY',
    'table_name' => 'authentication',
    'record_id' => $userId,
    'target_type' => 'session',
    'actor_user_id' => $userId,
    'reason_code' => 'EXPLICIT_LOGOUT',
]);
try {
    if ($userId) {
        account_credentials_clear_last_seen_by_legacy_user($conn, $userId);
        if (auth_session_devices_available($conn)) {
            $sessionStmt = $conn->prepare(
                'UPDATE auth_session_devices
                 SET revoked_at = COALESCE(revoked_at, NOW())
                 WHERE user_id = :user_id AND session_hash = :session_hash'
            );
            $sessionStmt->execute([
                ':user_id' => $userId,
                ':session_hash' => auth_session_hash(),
            ]);
        }
    }
} catch (Throwable $ignored) {
    // Logout remains successful if the optional presence field is unavailable.
}
auth_logout();
respond(['success' => true, 'message' => 'Logged out']);
?>
