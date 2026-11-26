<?php
require_once __DIR__ . '/../utils/cors.php';
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'POST is required.']);
    exit;
}

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/password_policy.php';
require_once __DIR__ . '/../utils/account_credentials.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';
require_once __DIR__ . '/../utils/audit.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function recordPasswordChangeEvent(PDO $conn, array $session, string $status, string $reasonCode, array $metadata = []): void {
    $userId = (int)($session['legacy_user_id'] ?? $session['user_id'] ?? 0) ?: null;
    audit_log_event($conn, 'PASSWORD_CHANGE', $status, [
        'event_type' => 'SECURITY',
        'table_name' => 'authentication',
        'record_id' => $userId,
        'target_type' => 'account',
        'actor_user_id' => $userId,
        'reason_code' => $reasonCode,
        'metadata' => $metadata,
    ]);
}

$session = auth_require();
$data = getJsonInput();

$currentPassword = (string)($data['current_password'] ?? '');
$newPassword = (string)($data['new_password'] ?? '');
$confirmPassword = (string)($data['confirm_password'] ?? '');

if ($currentPassword === '' || $newPassword === '' || $confirmPassword === '') {
    recordPasswordChangeEvent($conn, $session, 'FAILURE', 'MISSING_CREDENTIALS');
    respond(['success' => false, 'message' => 'Current password, new password, and confirmation are required.'], 422);
}
if ($newPassword !== $confirmPassword) {
    recordPasswordChangeEvent($conn, $session, 'FAILURE', 'PASSWORD_CONFIRMATION_MISMATCH');
    respond(['success' => false, 'message' => 'New password and confirmation do not match.'], 422);
}

$accountType = (string)($session['account_type'] ?? '');
$actorId = (int)($session['actor_id'] ?? 0);
$legacyUserId = (int)($session['legacy_user_id'] ?? $session['user_id'] ?? 0);

if (($accountType === '' || $actorId <= 0) && $legacyUserId > 0) {
    $stmt = $conn->prepare('SELECT account_type, actor_id, legacy_user_id, username, password
                            FROM (' . account_credentials_derived_sql() . ') ac
                            WHERE ac.legacy_user_id = :legacy_user_id
                              AND ac.is_deleted = 0
                            LIMIT 1');
    $stmt->bindValue(':legacy_user_id', $legacyUserId, PDO::PARAM_INT);
} else {
    $stmt = $conn->prepare('SELECT account_type, actor_id, legacy_user_id, username, password
                            FROM (' . account_credentials_derived_sql() . ') ac
                            WHERE ac.account_type = :account_type
                              AND ac.actor_id = :actor_id
                              AND ac.is_deleted = 0
                            LIMIT 1');
    $stmt->bindValue(':account_type', $accountType);
    $stmt->bindValue(':actor_id', $actorId, PDO::PARAM_INT);
}
$stmt->execute();
$user = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$user || !password_verify($currentPassword, (string)$user['password'])) {
    recordPasswordChangeEvent($conn, $session, 'FAILURE', 'CURRENT_PASSWORD_INVALID');
    respond(['success' => false, 'message' => 'Current password is incorrect.'], 401);
}

$errors = password_policy_validate_new_password($newPassword, (string)$user['username'], $currentPassword);
if ($errors) {
    recordPasswordChangeEvent($conn, $session, 'FAILURE', 'PASSWORD_POLICY_FAILED', ['error_count' => count($errors)]);
    respond([
        'success' => false,
        'message' => implode(' ', $errors),
        'errors' => $errors
    ], 422);
}

$conn->beginTransaction();
$identityLock=$conn->prepare('SELECT user_id FROM users WHERE user_id=? FOR UPDATE');
$identityLock->execute([(int)$user['legacy_user_id']]);
$fresh=account_credentials_find_by_legacy_user($conn,(int)$user['legacy_user_id']);
if (!$fresh || (int)$fresh['is_deleted'] || (int)$fresh['is_active'] !== 1 || !password_verify($currentPassword,$fresh['password'])) {
    $conn->rollBack();
    recordPasswordChangeEvent($conn, $session, 'FAILURE', 'ACCOUNT_STATE_CHANGED');
    respond(['success'=>false,'message'=>'Your password has changed. Please sign in again.'],409);
}
$passwordHash = password_hash($newPassword, PASSWORD_BCRYPT);
account_credentials_change_password($conn, (string)$user['account_type'], (int)$user['actor_id'], (int)($user['legacy_user_id'] ?? $legacyUserId), $passwordHash);

if (password_policy_has_column($conn, 'auth_version')) {
    $versionStmt=$conn->prepare('SELECT auth_version FROM users WHERE user_id=?');
    $versionStmt->execute([(int)$user['legacy_user_id']]);
    $_SESSION['auth_version']=(int)$versionStmt->fetchColumn();
}
$conn->commit();
$_SESSION['must_change_password'] = 0;
$_SESSION['account_type'] = (string)$user['account_type'];
$_SESSION['actor_id'] = (int)$user['actor_id'];
$_SESSION['legacy_user_id'] = (int)($user['legacy_user_id'] ?? $legacyUserId);

recordPasswordChangeEvent($conn, $_SESSION, 'SUCCESS', 'PASSWORD_CHANGED');
respond(['success' => true, 'message' => 'Password changed successfully.']);
?>
