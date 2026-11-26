<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
otp_bootstrap();

$data = otp_json_input();
$newPassword = (string)($data['new_password'] ?? '');
$confirmPassword = (string)($data['confirm_password'] ?? '');
$csrf = (string)($data['csrf'] ?? '');
if ($newPassword === '' || $confirmPassword === '') {
    json_response(['success' => false, 'message' => 'New password and confirmation are required.'], 422);
}

$reset = $_SESSION['email_otp_password_reset'] ?? null;
if (!is_array($reset) || !hash_equals((string)($reset['csrf'] ?? ''), $csrf) || (int)($reset['expires_at'] ?? 0) < time()) {
    json_response(['success' => false, 'message' => 'Your verification session has expired. Request a new code.'], 401);
}
if ($newPassword !== $confirmPassword) {
    json_response(['success' => false, 'message' => 'New password and confirmation do not match.'], 422);
}

try {
    $conn = otp_db();
    $conn->beginTransaction();

    $identityLock = $conn->prepare('SELECT user_id FROM users WHERE user_id = :user_id FOR UPDATE');
    $identityLock->execute(['user_id' => (int)$reset['user_id']]);
    if (!$identityLock->fetchColumn()) {
        $conn->rollBack();
        otp_audit_event($conn, 'PASSWORD_RESET', 'FAILURE', 'ACCOUNT_NOT_FOUND', null, (string)($reset['email'] ?? ''));
        json_response(['success' => false, 'message' => 'Your verification session is no longer valid. Request a new code.'], 401);
    }

    $account = account_credentials_find_by_legacy_user($conn, (int)$reset['user_id']);
    $otpStmt = $conn->prepare(
        'SELECT id FROM email_otps
         WHERE id = :id AND email = :email AND verified = 1
         LIMIT 1
         FOR UPDATE'
    );
    $otpStmt->execute(['id' => (int)$reset['otp_id'], 'email' => (string)$reset['email']]);
    $verifiedOtpId = $otpStmt->fetchColumn();

    if (!$account || $account['account_type'] !== 'employee' || (int)$account['is_deleted'] !== 0 || (int)$account['is_active'] !== 1 || !$verifiedOtpId) {
        $conn->rollBack();
        otp_audit_event($conn, 'PASSWORD_RESET', 'FAILURE', 'VERIFICATION_SESSION_INVALID', $account ?: null, (string)($reset['email'] ?? ''));
        json_response(['success' => false, 'message' => 'Your verification session is no longer valid. Request a new code.'], 401);
    }

    if (password_policy_has_column($conn, 'auth_version')) {
        $versionStmt = $conn->prepare('SELECT auth_version FROM users WHERE user_id = :user_id');
        $versionStmt->execute(['user_id' => (int)$reset['user_id']]);
        if ((int)$versionStmt->fetchColumn() !== (int)($reset['auth_version'] ?? 0)) {
            $conn->rollBack();
            otp_audit_event($conn, 'PASSWORD_RESET', 'FAILURE', 'ACCOUNT_STATE_CHANGED', $account, (string)($account['username'] ?? ''));
            json_response(['success' => false, 'message' => 'Your verification session is no longer valid. Request a new code.'], 409);
        }
    }

    $errors = password_policy_validate_new_password($newPassword, (string)$account['username']);
    if (password_verify($newPassword, (string)$account['password'])) {
        $errors[] = 'Choose a password different from your current password.';
    }
    if ($errors) {
        $conn->rollBack();
        otp_audit_event($conn, 'PASSWORD_RESET', 'FAILURE', 'PASSWORD_POLICY_FAILED', $account, (string)($account['username'] ?? ''), [
            'error_count' => count($errors),
        ]);
        json_response(['success' => false, 'message' => implode(' ', $errors), 'errors' => $errors], 422);
    }

    $passwordHash = password_hash($newPassword, PASSWORD_BCRYPT);
    if ($passwordHash === false) {
        throw new RuntimeException('Password hashing failed.');
    }
    account_credentials_change_password(
        $conn,
        (string)$account['account_type'],
        (int)$account['actor_id'],
        (int)$account['legacy_user_id'],
        $passwordHash
    );
    otp_audit_event($conn, 'PASSWORD_RESET', 'SUCCESS', 'PASSWORD_RESET_COMPLETED', $account, (string)($account['username'] ?? ''));
    $conn->commit();

    /* Do not automatically sign the user in after a password reset. */
    $_SESSION = [];
    session_regenerate_id(true);
    json_response(['success' => true, 'message' => 'Password reset successfully. Sign in with your new password.']);
} catch (Throwable $e) {
    if (isset($conn) && $conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    if (isset($conn) && $conn instanceof PDO) {
        otp_audit_event($conn, 'PASSWORD_RESET', 'FAILURE', 'SYSTEM_ERROR', $account ?? null, (string)($reset['email'] ?? ''));
    }
    error_log('Email OTP password reset failed: ' . get_class($e));
    json_response(['success' => false, 'message' => 'Recovery is temporarily unavailable. Please try again later.'], 503);
}
