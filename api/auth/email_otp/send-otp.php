<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/recovery_helpers.php';
require_once __DIR__ . '/../../utils/password_recovery.php';
otp_bootstrap();

$data = otp_json_input();
$username = valid_username($data['username'] ?? null);
if ($username === null) {
    json_response(['success' => false, 'message' => 'Enter your username.'], 422);
}

try {
    $conn = otp_db();

    /* Learners do not self-recover by email. Create an adviser request instead,
     * without exposing a learner email or issuing a reset link. */
    $anyAccount = otp_find_account_by_identifier($conn, $username);
    if ($anyAccount && $anyAccount['account_type'] === 'learner') {
        $submission = learner_recovery_submit_request($conn, $anyAccount);
        if (!$submission['accepted']) {
            otp_audit_event($conn, 'RECOVERY_REQUEST', 'FAILURE', 'RATE_LIMITED', $anyAccount, $username, [
                'flow' => 'adviser',
            ]);
            header('Retry-After: ' . (int)$submission['retry_after']);
            json_response([
                'success' => false,
                'message' => 'Please wait before submitting another student recovery request.',
                'retry_after' => (int)$submission['retry_after']
            ], 429);
        }
        otp_audit_event($conn, 'RECOVERY_REQUEST', 'SUCCESS', 'ADVISER_REVIEW_REQUESTED', $anyAccount, $username, [
            'flow' => 'adviser',
            'request_state' => !empty($submission['created']) ? 'created' : 'already_pending',
        ]);
        json_response([
            'success' => true,
            'flow' => 'adviser',
            'message' => !empty($submission['created'])
                ? 'Your request is ready for adviser review. Contact your adviser in person to verify your identity and receive a private reset link.'
                : 'Your recovery request is already with your adviser. Contact them in person to verify your identity and receive a private reset link.',
            'request_state' => !empty($submission['created']) ? 'created' : 'already_pending',
            'retry_after' => 60
        ]);
    }

    $account = otp_find_account_by_username($conn, $username);

    /* Do not send or expose an address unless it belongs to an eligible employee account. */
    if ($account === null) {
        otp_audit_event($conn, 'OTP_SEND', 'FAILURE', 'ACCOUNT_NOT_ELIGIBLE', null, $username);
        usleep(120000);
        json_response(['success' => false, 'message' => 'We could not find an active account with a recovery email. Check your username or contact the school administrator.'], 422);
    }
    $email = (string)$account['email'];

    /* Serialize sends for one address so two first requests cannot bypass cooldown. */
    $lockName = 'email-otp:' . hash('sha256', $email);
    $lockStmt = $conn->prepare('SELECT GET_LOCK(:lock_name, 5)');
    $lockStmt->execute(['lock_name' => $lockName]);
    if ((int)$lockStmt->fetchColumn() !== 1) {
        otp_audit_event($conn, 'OTP_SEND', 'FAILURE', 'RATE_LIMITED', $account, $username);
        header('Retry-After: 5');
        json_response(['success' => false, 'message' => 'Please try again in a moment.', 'retry_after' => 5], 429);
    }

    $retryAfter = 0;
    $cooldownActive = false;
    $sendFailed = false;
    try {
        $conn->beginTransaction();
        $stmt = $conn->prepare(
            'SELECT GREATEST(0, 60 - TIMESTAMPDIFF(SECOND, last_sent_at, UTC_TIMESTAMP())) AS retry_after
             FROM email_otps
             WHERE email = :email
             ORDER BY id DESC
             LIMIT 1
             FOR UPDATE'
        );
        $stmt->execute(['email' => $email]);
        $retryAfter = (int)($stmt->fetchColumn() ?: 0);
        if ($retryAfter > 0) {
            $conn->rollBack();
            $cooldownActive = true;
        } else {
            $code = (string)random_int(100000, 999999);
            /* Store only a bcrypt hash. The plain six-digit code stays in this request. */
            $otpHash = password_hash($code, PASSWORD_BCRYPT);
            if ($otpHash === false) {
                throw new RuntimeException('OTP hashing failed.');
            }

            $stmt = $conn->prepare(
                'INSERT INTO email_otps
                    (email, otp_hash, otp_expires_at, attempt_count, max_attempts, last_sent_at, verified, created_at)
                 VALUES (:email, :otp_hash, UTC_TIMESTAMP() + INTERVAL 5 MINUTE, 0, 5, UTC_TIMESTAMP(), 0, UTC_TIMESTAMP())'
            );
            $stmt->execute(['email' => $email, 'otp_hash' => $otpHash]);

            /* Roll back the row if SMTP fails, so an undelivered code cannot block a resend. */
            otp_send_email($email, $code);
            $conn->commit();
        }
    } catch (Throwable $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        error_log('Email OTP send failed: ' . get_class($e));
        $sendFailed = true;
    } finally {
        $releaseStmt = $conn->prepare('SELECT RELEASE_LOCK(:lock_name)');
        $releaseStmt->execute(['lock_name' => $lockName]);
    }

    if ($sendFailed) {
        otp_audit_event($conn, 'OTP_SEND', 'FAILURE', 'DELIVERY_FAILED', $account, $username);
        json_response(['success' => false, 'message' => 'We could not send the verification code. Please try again later.'], 503);
    }
    if ($cooldownActive) {
        otp_audit_event($conn, 'OTP_SEND', 'FAILURE', 'RATE_LIMITED', $account, $username, [
            'retry_after' => $retryAfter,
        ]);
        header('Retry-After: ' . $retryAfter);
        json_response(['success' => false, 'message' => 'Please wait before requesting another code.', 'retry_after' => $retryAfter], 429);
    }

    otp_audit_event($conn, 'OTP_SEND', 'SUCCESS', 'OTP_SENT', $account, $username, [
        'retry_after' => 60,
    ]);
    json_response([
        'success' => true,
        'message' => 'A 6-digit verification code has been sent. It expires in 5 minutes.',
        'destination' => otp_mask_email($email),
        'retry_after' => 60
    ]);
} catch (Throwable $e) {
    if (isset($conn) && $conn instanceof PDO) {
        otp_audit_event($conn, 'OTP_SEND', 'FAILURE', 'SYSTEM_ERROR', null, $username);
    }
    error_log('Email OTP request failed: ' . get_class($e));
    json_response(['success' => false, 'message' => 'Recovery is temporarily unavailable. Please try again later.'], 503);
}
