<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/recovery_helpers.php';
otp_bootstrap();

$data = otp_json_input();
$username = valid_username($data['username'] ?? null);
$code = trim((string)($data['otp'] ?? $data['code'] ?? ''));
if ($username === null) {
    json_response(['success' => false, 'message' => 'Enter your username.'], 422);
}
if (!preg_match('/^\d{6}$/D', $code)) {
    json_response(['success' => false, 'message' => 'Enter the 6-digit verification code.'], 422);
}

try {
    $conn = otp_db();
    $account = otp_find_account_by_username($conn, $username);
    if ($account === null) {
        otp_audit_event($conn, 'OTP_VERIFY', 'FAILURE', 'ACCOUNT_NOT_ELIGIBLE', null, $username);
        json_response(['success' => false, 'message' => 'That code is invalid or expired. Request a new code.'], 422);
    }
    $email = (string)$account['email'];
    $conn->beginTransaction();

    $stmt = $conn->prepare(
        'SELECT id, email, otp_hash, otp_expires_at, attempt_count, max_attempts, verified,
                (otp_expires_at <= UTC_TIMESTAMP()) AS is_expired
         FROM email_otps
         WHERE email = :email
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE'
    );
    $stmt->execute(['email' => $email]);
    $otp = $stmt->fetch();

    if (!$otp) {
        $conn->rollBack();
        otp_audit_event($conn, 'OTP_VERIFY', 'FAILURE', 'OTP_NOT_FOUND', $account, $username);
        json_response(['success' => false, 'message' => 'That code is invalid or expired. Request a new code.'], 422);
    }
    if ((int)$otp['verified'] === 1) {
        $conn->rollBack();
        otp_audit_event($conn, 'OTP_VERIFY', 'FAILURE', 'OTP_ALREADY_USED', $account, $username);
        json_response(['success' => false, 'message' => 'That code has already been used. Request a new code.'], 422);
    }
    if ((int)$otp['is_expired'] === 1) {
        $conn->rollBack();
        otp_audit_event($conn, 'OTP_VERIFY', 'FAILURE', 'OTP_EXPIRED', $account, $username);
        json_response(['success' => false, 'message' => 'That code has expired. Request a new code.'], 422);
    }
    if ((int)$otp['attempt_count'] >= (int)$otp['max_attempts']) {
        $conn->rollBack();
        otp_audit_event($conn, 'OTP_VERIFY', 'FAILURE', 'OTP_ATTEMPTS_EXHAUSTED', $account, $username);
        json_response(['success' => false, 'message' => 'Too many incorrect attempts. Request a new code.'], 429);
    }

    /* Count every code check before verifying it. A failed request is committed. */
    $conn->prepare('UPDATE email_otps SET attempt_count = attempt_count + 1 WHERE id = :id')
        ->execute(['id' => (int)$otp['id']]);

    if (!password_verify($code, (string)$otp['otp_hash'])) {
        $remaining = max(0, (int)$otp['max_attempts'] - ((int)$otp['attempt_count'] + 1));
        $message = $remaining > 0
            ? 'That code is incorrect. You have ' . $remaining . ' attempt' . ($remaining === 1 ? '' : 's') . ' left.'
            : 'That code is incorrect. Request a new code.';
        otp_audit_event($conn, 'OTP_VERIFY', 'FAILURE', $remaining > 0 ? 'OTP_INVALID' : 'OTP_ATTEMPTS_EXHAUSTED', $account, $username, [
            'remaining_attempts' => $remaining,
        ]);
        $conn->commit();
        json_response(['success' => false, 'message' => $message], 422);
    }

    $authVersion = 0;
    if (password_policy_has_column($conn, 'auth_version')) {
        $versionStmt = $conn->prepare('SELECT auth_version FROM users WHERE user_id = :user_id FOR UPDATE');
        $versionStmt->execute(['user_id' => (int)$account['legacy_user_id']]);
        $authVersion = (int)($versionStmt->fetchColumn() ?: 0);
    }

    /* Mark the row first. This makes the code single-use even if the browser retries. */
    $conn->prepare('UPDATE email_otps SET verified = 1 WHERE id = :id AND verified = 0')
        ->execute(['id' => (int)$otp['id']]);
    otp_audit_event($conn, 'OTP_VERIFY', 'SUCCESS', 'OTP_VERIFIED', $account, $username);
    $conn->commit();

    session_regenerate_id(true);
    $_SESSION['email_otp_password_reset'] = [
        'otp_id' => (int)$otp['id'],
        'email' => $email,
        'user_id' => (int)$account['legacy_user_id'],
        'auth_version' => $authVersion,
        'expires_at' => time() + 600,
        'csrf' => bin2hex(random_bytes(32)),
    ];

    json_response([
        'success' => true,
        'message' => 'Code verified. You can now choose a new password.',
        'reset_csrf' => $_SESSION['email_otp_password_reset']['csrf']
    ]);
} catch (Throwable $e) {
    if (isset($conn) && $conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    if (isset($conn) && $conn instanceof PDO) {
        otp_audit_event($conn, 'OTP_VERIFY', 'FAILURE', 'SYSTEM_ERROR', $account ?? null, $username);
    }
    error_log('Email OTP verification failed: ' . get_class($e));
    json_response(['success' => false, 'message' => 'Recovery is temporarily unavailable. Please try again later.'], 503);
}
