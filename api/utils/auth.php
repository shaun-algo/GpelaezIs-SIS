<?php
require_once __DIR__ . '/session_devices.php';
function auth_send_no_cache_headers(): void {
    if (headers_sent()) {
        return;
    }
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
}

function auth_session_timeout_options(): array {
    return [5, 10, 15, 20, 30];
}

function auth_default_session_timeout_minutes(): int {
    return 30;
}

function auth_normalize_session_timeout_minutes(mixed $value): int {
    $minutes = (int)$value;
    return in_array($minutes, auth_session_timeout_options(), true)
        ? $minutes
        : auth_default_session_timeout_minutes();
}

function auth_get_account_session_timeout_minutes(): ?int {
    if (auth_role_key_from_session() !== 'learners') {
        return null;
    }

    $sessionMinutes = (int)($_SESSION['session_timeout_minutes'] ?? 0);
    if ($sessionMinutes > 0) {
        return auth_normalize_session_timeout_minutes($sessionMinutes);
    }

    $userId = (int)($_SESSION['user_id'] ?? 0);
    if ($userId <= 0) {
        return null;
    }

    try {
        $dbPath = __DIR__ . '/../database/connection.php';
        if (!file_exists($dbPath)) {
            return null;
        }
        require $dbPath;
        if (!isset($conn) || !($conn instanceof PDO)) {
            return null;
        }
        $stmt = $conn->prepare(
            'SELECT session_timeout_minutes
             FROM account_settings
             WHERE user_id = :user_id
             LIMIT 1'
        );
        $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
        $stmt->execute();
        $value = $stmt->fetchColumn();
        return $value === false || $value === null
            ? null
            : auth_normalize_session_timeout_minutes($value);
    } catch (Throwable $e) {
        // The account-settings migration is additive. Fall back to the
        // school-wide setting until it has been applied on an older install.
        return null;
    }
}

function auth_get_idle_timeout_seconds(): int {
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }

    $accountMinutes = auth_get_account_session_timeout_minutes();
    if ($accountMinutes !== null) {
        $cached = $accountMinutes * 60;
        return $cached;
    }

    $settingSeconds = 0;
    try {
        $dbPath = __DIR__ . '/../database/connection.php';
        if (file_exists($dbPath)) {
            require $dbPath;
            if (isset($conn) && $conn instanceof PDO) {
                $stmt = $conn->prepare(
                    'SELECT setting_value
                     FROM school_settings
                     WHERE setting_key = "session_timeout_minutes"
                       AND is_deleted = 0
                     LIMIT 1'
                );
                $stmt->execute();
                $minutes = $stmt->fetchColumn();
                if ($minutes !== false && $minutes !== null) {
                    $settingSeconds = auth_normalize_session_timeout_minutes($minutes) * 60;
                }
            }
        }
    } catch (Throwable $e) {
        $settingSeconds = 0;
    }

    if ($settingSeconds > 0) {
        $cached = max(300, min(1800, $settingSeconds));
        return $cached;
    }

    $raw = getenv('AUTH_IDLE_TIMEOUT_SECONDS');
    $n = is_string($raw) ? (int)$raw : 0;
    $cached = $n > 0
        ? auth_normalize_session_timeout_minutes((int)round($n / 60)) * 60
        : auth_default_session_timeout_minutes() * 60;
    return $cached;
}

function auth_start_session(): void {
    if (session_status() === PHP_SESSION_NONE) {
        $isHttps = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
        if (!headers_sent()) {
            ini_set('session.use_strict_mode', '1');
            ini_set('session.use_only_cookies', '1');
            ini_set('session.use_trans_sid', '0');
            session_set_cookie_params([
                'path' => '/',
                'httponly' => true,
                'secure' => $isHttps,
                'samesite' => 'Lax'
            ]);
        }
        // Suppress warnings (we return our own JSON error if this fails).
        $ok = @session_start();
        if ($ok !== true) {
            http_response_code(500);
            if (!headers_sent()) {
                header('Content-Type: application/json');
            }
            echo json_encode([
                'success' => false,
                'message' => 'Session could not be started. Check PHP session save path permissions.'
            ]);
            exit;
        }
    }
}

function auth_logout(): void {
    auth_start_session();
    auth_send_no_cache_headers();

    $_SESSION = [];

    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(
            session_name(),
            '',
            time() - 42000,
            $params['path'] ?? '/',
            $params['domain'] ?? '',
            (bool)($params['secure'] ?? false),
            (bool)($params['httponly'] ?? true)
        );
    }

    @session_destroy();
}

function auth_abort(int $code, string $message): void {
    auth_send_no_cache_headers();
    try {
        // Endpoints commonly load the shared connection in global scope before
        // auth_require_roles() reaches this function. Import that connection
        // explicitly; otherwise PHP creates a local undefined $conn and the
        // denial event is silently lost.
        global $conn;
        require_once __DIR__ . '/audit.php';
        if (!isset($conn) || !($conn instanceof PDO)) {
            require __DIR__ . '/../database/connection.php';
        }
        $actorUserId = (int)($_SESSION['user_id'] ?? 0) ?: null;
        audit_log_event($conn, $code === 403 ? 'ACCESS' : 'SESSION', 'DENIED', [
            'event_type' => 'SECURITY',
            'table_name' => 'authorization',
            'record_id' => $actorUserId,
            'target_type' => 'endpoint',
            'actor_user_id' => $actorUserId,
            'reason_code' => $code === 403 ? 'AUTHORIZATION_DENIED' : 'AUTHENTICATION_REQUIRED',
            'metadata' => ['http_status' => $code],
        ]);
    } catch (Throwable $ignored) {
        // Authentication responses must remain available during a logging or
        // database outage. Operational error logging can capture the outage.
    }
    http_response_code($code);
    if (!headers_sent()) {
        header('Content-Type: application/json');
    }
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

function auth_backend_role_seed_map(): array {
    // These IDs are part of the existing authorization contract. New role
    // names must not be introduced until their backend permissions exist.
    return [
        7 => 'registrar',
        8 => 'admin',
        9 => 'teacher',
        10 => 'learners',
        11 => 'registrar',
    ];
}

function auth_backend_role_key_for_id(int $roleId): ?string {
    $key = auth_backend_role_seed_map()[$roleId] ?? null;
    return $key === null ? null : (string)$key;
}

function auth_backend_role_seed_ids(): array {
    return array_keys(auth_backend_role_seed_map());
}

function auth_normalize_role(string $roleName): string {
    // Role keys are exact backend identifiers; only letter case and outer
    // whitespace are normalized. For example, "administrative" is not admin.
    return strtolower(trim($roleName));
}

function auth_role_key_from_session(): string {
    $rid = (int)($_SESSION['role_id'] ?? 0);
    $seedKey = auth_backend_role_key_for_id($rid);
    if ($seedKey === null) return '';

    // A supported ID is valid only while its stored seed name still matches
    // the backend key, ignoring case. This prevents a renamed seed from
    // silently retaining the old authorization contract.
    return auth_normalize_role((string)($_SESSION['role_name'] ?? '')) === $seedKey
        ? $seedKey
        : '';
}

function auth_guard_session_freshness(): void {
    // Only enforce if a user is currently logged in.
    if (empty($_SESSION['user_id']) && empty($_SESSION['actor_id'])) {
        return;
    }

    $now = time();
    $timeout = auth_get_idle_timeout_seconds();

    $last = isset($_SESSION['last_activity']) ? (int)$_SESSION['last_activity'] : 0;
    if ($last > 0 && ($now - $last) > $timeout) {
        auth_logout();
        auth_abort(401, 'Session expired');
    }

    // Basic session binding (helps against stolen cookies).
    $ua = (string)($_SERVER['HTTP_USER_AGENT'] ?? '');
    if (!isset($_SESSION['user_agent'])) {
        $_SESSION['user_agent'] = $ua;
    } elseif ((string)$_SESSION['user_agent'] !== $ua) {
        auth_logout();
        auth_abort(401, 'Session invalidated');
    }

    // Activity tracking for timeout.
    $_SESSION['last_activity'] = $now;
}

function auth_require(): array {
    auth_start_session();
    auth_send_no_cache_headers();

    auth_guard_session_freshness();

    if (empty($_SESSION['user_id']) && empty($_SESSION['actor_id'])) {
        auth_abort(401, 'Not authenticated');
    }

    // Re-resolve by stable user_id on every request, including sessions from before migration.
    require_once __DIR__ . '/account_credentials.php';
    require __DIR__ . '/../database/connection.php';
    $account = account_credentials_find_by_legacy_user($conn, (int)($_SESSION['user_id'] ?? 0));
    if (!$account || (int)$account['is_deleted'] || (int)$account['is_active'] !== 1) {
        auth_logout();
        auth_abort(401, 'Account is unavailable. Please sign in again.');
    }

    $sessionDevice = auth_session_device_guard($conn, (int)$account['legacy_user_id']);
    if ($sessionDevice && (
        $sessionDevice['revoked_at'] !== null
        || $sessionDevice['blocked_at'] !== null
        || !empty($sessionDevice['session_replaced'])
    )) {
        $reasonCode = $sessionDevice['blocked_at'] !== null
            ? 'DEVICE_BLOCKED'
            : (!empty($sessionDevice['session_replaced']) ? 'SESSION_REPLACED' : 'SESSION_TERMINATED');
        try {
            require_once __DIR__ . '/audit.php';
            audit_log_event($conn, 'SESSION', 'DENIED', [
                'event_type' => 'SECURITY',
                'table_name' => 'auth_session_devices',
                'record_id' => (int)$sessionDevice['session_device_id'],
                'target_type' => 'session',
                'actor_user_id' => (int)$account['legacy_user_id'],
                'reason_code' => $reasonCode,
            ]);
        } catch (Throwable $ignored) {
            // A revocation must still be enforced if audit storage is unavailable.
        }
        auth_logout();
        auth_abort(401, $reasonCode === 'DEVICE_BLOCKED'
            ? 'This device is blocked for this account.'
            : ($reasonCode === 'SESSION_REPLACED'
                ? 'This browser signed in again. Please continue with the newest session.'
                : 'This login session was ended. Please sign in again.'));
    }
    auth_session_device_touch($conn, (int)$account['legacy_user_id']);

    if (password_policy_has_column($conn, 'auth_version')) {
        $versionStmt=$conn->prepare('SELECT auth_version FROM users WHERE user_id=?');
        $versionStmt->execute([(int)$account['legacy_user_id']]);
        if (!isset($_SESSION['auth_version']) || (int)$_SESSION['auth_version'] !== (int)$versionStmt->fetchColumn()) {
            auth_logout();
            auth_abort(401, 'Password changed. Please sign in again.');
        }
    }
    foreach (['account_type', 'actor_id', 'username', 'role_id', 'role_name', 'must_change_password'] as $field) {
        $_SESSION[$field] = $account[$field];
    }
    $_SESSION['legacy_user_id'] = (int)$account['legacy_user_id'];

    // Presence is a best-effort heartbeat. Throttle writes so a page with
    // several authenticated API calls does not update the account row for
    // every request.
    $lastSeenWrite = (int)($_SESSION['last_seen_write_at'] ?? 0);
    if (time() - $lastSeenWrite >= 60) {
        try {
            account_credentials_touch_last_seen(
                $conn,
                (string)$account['account_type'],
                (int)$account['actor_id'],
                (int)$account['legacy_user_id']
            );
            $_SESSION['last_seen_write_at'] = time();
        } catch (Throwable $e) {
            // Presence must never make an authenticated request fail.
        }
    }

    $roleKey = auth_role_key_from_session();

    return [
        'user_id' => (int)($_SESSION['user_id'] ?? 0),
        'legacy_user_id' => (int)($_SESSION['legacy_user_id'] ?? $_SESSION['user_id'] ?? 0),
        'account_type' => (string)($_SESSION['account_type'] ?? ''),
        'actor_id' => (int)($_SESSION['actor_id'] ?? 0),
        'role_id' => (int)($_SESSION['role_id'] ?? 0),
        'role_name' => (string)($_SESSION['role_name'] ?? ''),
        'role_key' => $roleKey,
        // Session management and security notifications are restricted to the
        // designated main device. Keep this server-derived value alongside
        // the authenticated session so every API can enforce the same rule.
        'is_main_device' => (bool)($sessionDevice['is_main_device'] ?? false),
        'session_idle_timeout_seconds' => auth_get_idle_timeout_seconds(),
        'session_last_activity' => (int)($_SESSION['last_activity'] ?? 0)
    ];
}

function auth_is_admin(array $session): bool {
    return ($session['role_key'] ?? '') === 'admin';
}

function auth_require_roles(array $allowedRoles): array {
    $session = auth_require();
    if (auth_is_admin($session)) {
        return $session;
    }
    $roleKey = $session['role_key'] ?? '';
    $allowed = array_map('strtolower', $allowedRoles);
    if (!in_array($roleKey, $allowed, true)) {
        auth_abort(403, 'Not authorized');
    }
    return $session;
}

function auth_is_read_operation(string $operation): bool {
    $op = strtolower(trim($operation));
    if ($op === '') {
        return false;
    }
    return str_starts_with($op, 'get') || str_starts_with($op, 'list') || str_starts_with($op, 'fetch');
}

function auth_enforce_roles(string $operation, array $readRoles, array $writeRoles): array {
    $session = auth_is_read_operation($operation)
        ? auth_require_roles($readRoles)
        : auth_require_roles($writeRoles);

    // Period dates are the source of truth for automatic open/close state.
    // Run this after authentication so every protected API request observes
    // the same lifecycle, regardless of which role or page made the request.
    $connection = $GLOBALS['conn'] ?? null;
    if ($connection instanceof PDO) {
        require_once __DIR__ . '/grading_period_lifecycle.php';
        try {
            sync_automatic_grading_period_statuses($connection);
        } catch (Throwable $e) {
            // A lifecycle sync must not turn an otherwise valid authenticated
            // request into a 500. The migration/schema check is defensive.
            error_log('Grading-period lifecycle sync failed: ' . $e->getMessage());
        }
    }

    return $session;
}
?>
