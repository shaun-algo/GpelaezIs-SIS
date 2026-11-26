<?php
require_once __DIR__ . '/account_credentials.php';
require_once __DIR__ . '/learner_recovery.php';
require_once __DIR__ . '/recovery_mail.php';
require_once __DIR__ . '/audit.php';

function recovery_json(array $body, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    echo json_encode($body);
    exit;
}

function recovery_input(PDO $conn, bool $allow_adviser_link = false): array {
    /* Adviser-issued learner links do not depend on SMTP being configured. */
    recovery_require_ready($conn, !$allow_adviser_link);
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        header('Allow: POST');
        recovery_json(['success' => false, 'message' => 'POST is required.'], 405);
    }
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '' && $origin !== recovery_origin()) {
        recovery_json(['success' => false, 'message' => 'Request origin is not allowed.'], 403);
    }
    if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') {
        recovery_json(['success' => false, 'message' => 'Send JSON.'], 415);
    }
    $raw = file_get_contents('php://input', false, null, 0, 4097);
    $data = strlen($raw) <= 4096 ? json_decode($raw, true) : null;
    if (!is_array($data)) recovery_json(['success' => false, 'message' => 'Invalid request.'], 400);
    foreach ($data as $value) {
        if (!is_string($value)) recovery_json(['success' => false, 'message' => 'Invalid request.'], 400);
    }
    return $data;
}

// One atomic UPSERT per bucket: parallel requests cannot evade the limit.
function recovery_rate_allow(PDO $conn, string $key, int $limit): bool {
    $bucket = hash('sha256', $key);
    $conn->beginTransaction();
    $stmt = $conn->prepare('INSERT INTO recovery_rate_limits (bucket, window_started, attempts)
        VALUES (?, NOW(), 1) ON DUPLICATE KEY UPDATE
        attempts = IF(window_started <= NOW() - INTERVAL 15 MINUTE, 1, attempts + 1),
        window_started = IF(window_started <= NOW() - INTERVAL 15 MINUTE, NOW(), window_started)');
    $stmt->execute([$bucket]);
    $stmt = $conn->prepare('SELECT attempts FROM recovery_rate_limits WHERE bucket = ?');
    $stmt->execute([$bucket]);
    $allowed = (int)$stmt->fetchColumn() <= $limit;
    $conn->commit();
    return $allowed;
}

function recovery_event(PDO $conn, ?int $userId, string $event): void {
    $conn->prepare('INSERT INTO recovery_events (user_id, event) VALUES (?, ?)')->execute([$userId, $event]);
    $action = str_starts_with($event, 'learner_request') ? 'RECOVERY_REQUEST' : 'PASSWORD_RESET';
    audit_log_event($conn, $action, 'SUCCESS', [
        'event_type' => 'SECURITY',
        'table_name' => 'authentication',
        'record_id' => $userId,
        'target_type' => 'account',
        'actor_user_id' => null,
        'reason_code' => strtoupper($event),
    ]);
}

function recovery_capture(PDO $conn, string $email, string $subject, string $body): void {
    recovery_queue_mail($conn,$email,$subject,$body);
}

function recovery_employee_email(PDO $conn, int $userId): ?string {
    $stmt = $conn->prepare('SELECT email FROM employees WHERE user_id=? AND is_deleted=0');
    $stmt->execute([$userId]);
    $email = trim((string)$stmt->fetchColumn());
    return filter_var($email, FILTER_VALIDATE_EMAIL) ? $email : null;
}

// Atomically reserve one request per identity per minute, including unknown IDs.
function recovery_resend_wait(PDO $conn, string $key): int {
    $bucket = hash('sha256', 'resend:' . $key);
    $conn->beginTransaction();
    $stmt = $conn->prepare('INSERT IGNORE INTO recovery_rate_limits (bucket,window_started,attempts) VALUES (?,NOW()-INTERVAL 60 SECOND,0)');
    $stmt->execute([$bucket]);
    $stmt = $conn->prepare('SELECT GREATEST(0,60-TIMESTAMPDIFF(SECOND,window_started,NOW())) FROM recovery_rate_limits WHERE bucket=? FOR UPDATE');
    $stmt->execute([$bucket]);
    $wait = (int)$stmt->fetchColumn();
    if (!$wait) $conn->prepare('UPDATE recovery_rate_limits SET window_started=NOW(),attempts=1 WHERE bucket=?')->execute([$bucket]);
    $conn->commit();
    return $wait;
}

function recovery_request(PDO $conn, string $username): void {
    $started = microtime(true);
    // Resolve the school identifier, preserving leading zeroes. Never trust a posted role.
    $learner = preg_match('/^[0-9]{12}$/D', $username) === 1;
    $stmt = $conn->prepare($learner
        ? 'SELECT user_id FROM learners WHERE lrn=? AND is_deleted=0'
        : 'SELECT user_id FROM employees WHERE employee_number=? AND is_deleted=0');
    $stmt->execute([$username]);
    $account = account_credentials_find_by_legacy_user($conn, (int)$stmt->fetchColumn());
    // Use stable identity for known accounts so case/collation aliases share a limit.
    $key = $account ? 'user:' . $account['legacy_user_id'] : 'name:' . mb_strtolower($username);
    $wait = recovery_resend_wait($conn, $key);
    if ($wait) {
        header('Retry-After: ' . $wait);
        recovery_json(['success'=>false,'message'=>'Please wait before requesting again.','retry_after'=>$wait],429);
    }
    $ipAllowed = recovery_rate_allow($conn, 'request-ip:' . ($_SERVER['REMOTE_ADDR'] ?? ''), 30);
    $accountAllowed = recovery_rate_allow($conn, 'request-account:' . $key, 3);
    if (!$ipAllowed || !$accountAllowed) {
        recovery_json(['success'=>false,'message'=>'Too many requests. Please try again in 15 minutes.','retry_after'=>900],429);
    }
    $notice = ['title'=>'Check your details','message'=>'No recovery email is available for these details. Contact the school office.'];
    if ($ipAllowed && $accountAllowed && $account && !(int)$account['is_deleted'] && (int)$account['is_active'] === 1) {
        $userId = (int)$account['legacy_user_id'];
        $conn->beginTransaction();
        $stmt = $conn->prepare('SELECT auth_version FROM users WHERE user_id = ? FOR UPDATE');
        $stmt->execute([$userId]);
        $version = (int)$stmt->fetchColumn();
        $email = recovery_employee_email($conn, $userId);
        // Recheck after locking: activation/deletion may have changed since lookup.
        $fresh = account_credentials_find_by_legacy_user($conn, $userId);
        if ($learner && $fresh && $fresh['account_type'] === 'learner' && !(int)$fresh['is_deleted'] && (int)$fresh['is_active'] === 1) {
            $created = learner_recovery_request($conn, $fresh, $version);
            $notice = $created
                ? ['title'=>'Request submitted','message'=>'Contact your adviser to verify your identity and get a reset link.']
                : ['title'=>'Request already submitted','message'=>'Your recovery request is already with your adviser. Contact them to verify your identity and get a reset link.'];
        } elseif (!$learner && $email && $fresh && $fresh['account_type'] !== 'learner' && !(int)$fresh['is_deleted'] && (int)$fresh['is_active'] === 1) {
            /* Employee self-recovery moved to the email OTP endpoint. Do not issue a second kind of link here. */
            $notice = ['title'=>'Use email verification','message'=>'Use the school-record email field on the forgot-password page to request a verification code.'];
        }
        $conn->commit();
    }
    // A bounded response floor helps hide eligibility in this synchronous local demo.
    // A deployed implementation needs asynchronous delivery and load/timing tests.
    $remaining = 250000 - (int)((microtime(true) - $started) * 1000000);
    if ($remaining > 0) usleep($remaining);
    recovery_json(['success' => true, 'message' => $notice['message'], 'title'=>$notice['title'], 'retry_after'=>60]);
}

function recovery_reset(PDO $conn, array $data): void {
    if (!recovery_rate_allow($conn, 'reset-ip:' . ($_SERVER['REMOTE_ADDR'] ?? ''), 30)) {
        recovery_json(['success' => false, 'message' => 'Too many attempts. Try again in 15 minutes.'], 429);
    }
    $token = $data['token'] ?? '';
    $invalid = ['success' => false, 'message' => 'This reset link is invalid or expired. Request a new link.'];
    if (!preg_match('/^[a-f0-9]{64}$/D', $token)) recovery_json($invalid, 400);
    $digest = hash('sha256', $token);
    $stmt = $conn->prepare('SELECT user_id FROM password_reset_tokens WHERE token_hash = ?');
    $stmt->execute([$digest]);
    $userId = (int)$stmt->fetchColumn();
    if (!$userId) recovery_json($invalid, 400);
    $conn->beginTransaction();
    // All requests for an account lock the identity first, including different tokens.
    $stmt = $conn->prepare('SELECT auth_version FROM users WHERE user_id = ? FOR UPDATE');
    $stmt->execute([$userId]);
    $version = (int)$stmt->fetchColumn();
    $stmt = $conn->prepare("SELECT * FROM password_reset_tokens WHERE token_hash = ? AND purpose='reset' AND consumed_at IS NULL AND expires_at > NOW() FOR UPDATE");
    $stmt->execute([$digest]);
    $record = $stmt->fetch();
    $email = recovery_employee_email($conn, $userId);
    $account = account_credentials_find_by_legacy_user($conn, $userId);
    if ($record && $record['delivery_kind'] !== 'adviser' && !recovery_mail_is_configured()) {
        $conn->rollBack();
        recovery_json(['success' => false, 'message' => 'This reset link is no longer available. Request a new link.'], 400);
    }
    if (!$record || !$account || (int)$account['is_deleted'] || (int)$account['is_active'] !== 1
        || (int)$record['auth_version'] !== $version
        || ($record['delivery_kind'] === 'email' && ($account['account_type'] === 'learner' || !$email || $email !== $record['email_snapshot']))
        || ($record['delivery_kind'] === 'adviser' && !learner_recovery_token_allowed($conn, $account, $record))) {
        $conn->rollBack();
        recovery_json($invalid, 400);
    }
    $new = $data['new_password'] ?? '';
    $errors = password_policy_validate_new_password($new, (string)$account['username']);
    if ($new !== ($data['confirm_password'] ?? '')) $errors[] = 'Passwords do not match.';
    if (password_verify($new, (string)$account['password'])) $errors[] = 'Choose a different password.';
    if ($errors) {
        $conn->rollBack();
        recovery_json(['success' => false, 'message' => implode(' ', $errors)], 422);
    }
    account_credentials_change_password($conn, $account['account_type'], (int)$account['actor_id'], $userId, password_hash($new, PASSWORD_BCRYPT));
    // The shared account-credential service bumps auth_version for every reset.
    $conn->prepare('UPDATE password_reset_tokens SET consumed_at=NOW() WHERE user_id=? AND consumed_at IS NULL')->execute([$userId]);
    recovery_event($conn, $userId, 'reset_completed');
    if ($record['delivery_kind'] === 'adviser') {
        $conn->prepare("UPDATE learner_recovery_requests SET status='completed' WHERE token_id=?")->execute([$record['id']]);
    } else {
        recovery_capture($conn, $email, 'Your password was changed', 'Your password was changed. All previous sessions have been signed out. Contact the school office if you did not make this change.');
    }
    $conn->commit();
    recovery_json(['success' => true, 'message' => 'Password reset successfully. Sign in with your new password.']);
}
