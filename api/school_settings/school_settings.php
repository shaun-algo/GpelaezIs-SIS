<?php
header('Content-Type: application/json');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function normalizeSettingValue(string $key, mixed $value): string {
    if ($key === 'session_timeout_minutes') {
        $minutes = (int)$value;
        if (!in_array($minutes, auth_session_timeout_options(), true)) {
            respond(['success' => false, 'message' => 'Choose a session duration of 5, 10, 15, 20, or 30 minutes.'], 422);
        }
        return (string)$minutes;
    }
    return (string)($value ?? '');
}

$operation = $_GET['operation'] ?? '';
$writeRoles = $operation === 'updateSetting' ? ['admin', 'learners'] : ['admin'];
$session = auth_enforce_roles($operation, ['admin', 'teacher', 'registrar', 'learners'], $writeRoles);
try {
    switch ($operation) {
        case 'getAllSettings':  getAllSettings($conn); break;
        case 'getSetting':     getSetting($conn); break;
        case 'updateSetting':  updateSetting($conn); break;
        case 'updateSettings': updateSettings($conn); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllSettings(PDO $conn): void {
    $stmt = $conn->prepare("SELECT setting_id, setting_key, setting_value, description, updated_at FROM school_settings WHERE is_deleted = 0 ORDER BY setting_id");
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    // Also return as key-value map for convenience
    $map = [];
    foreach ($rows as $r) { $map[$r['setting_key']] = $r['setting_value']; }
    respond(['rows' => $rows, 'map' => $map]);
}

function getSetting(PDO $conn): void {
    global $session;
    $key = $_GET['setting_key'] ?? '';
    if (!$key) { respond(['success' => false, 'message' => 'setting_key required'], 422); }
    $stmt = $conn->prepare("SELECT setting_id, setting_key, setting_value, description FROM school_settings WHERE setting_key = :key AND is_deleted = 0 LIMIT 1");
    $stmt->bindValue(':key', $key);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($key === 'session_timeout_minutes') {
        $schoolMinutes = auth_normalize_session_timeout_minutes($row['setting_value'] ?? null);
        $row = $row ?: [
            'setting_key' => $key,
            'setting_value' => (string)$schoolMinutes,
            'description' => 'School default auto end Session duration',
        ];
        $row['setting_value'] = (string)$schoolMinutes;
        $row['default_value'] = (string)$schoolMinutes;
        $row['allowed_values'] = auth_session_timeout_options();
        $row['can_update'] = in_array(($session['role_key'] ?? ''), ['admin', 'learners'], true);
        $row['setting_scope'] = 'school';
        $row['setting_source'] = 'school';
        $row['setting_scope_label'] = 'School default';

        if (($session['role_key'] ?? '') === 'learners') {
            $personalMinutes = getAccountSessionTimeout($conn, (int)($session['user_id'] ?? 0));
            if ($personalMinutes !== null) {
                $row['setting_value'] = (string)$personalMinutes;
                $row['description'] = 'This account auto end Session duration';
                $row['setting_scope'] = 'account';
                $row['setting_source'] = 'account';
                $row['setting_scope_label'] = 'This account';
            } else {
                $row['description'] = 'This account currently follows the school default';
            }
        }
    }
    respond($row ?: ['setting_key' => $key, 'setting_value' => null]);
}

function getAccountSessionTimeout(PDO $conn, int $userId): ?int {
    if ($userId <= 0) return null;
    try {
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
        return null;
    }
}

function updateSetting(PDO $conn): void {
    global $session;
    $data = getJsonInput();
    if (empty($data['setting_key'])) {
        respond(['success' => false, 'message' => 'setting_key is required'], 422);
    }
    $key = trim((string)$data['setting_key']);
    $value = normalizeSettingValue($key, $data['setting_value'] ?? '');
    $description = $data['description'] ?? null;

    if (($session['role_key'] ?? '') === 'learners') {
        if ($key !== 'session_timeout_minutes') {
            respond(['success' => false, 'message' => 'Learner accounts may only change their session duration.'], 403);
        }
        $userId = (int)($session['user_id'] ?? 0);
        if ($userId <= 0) {
            respond(['success' => false, 'message' => 'This account could not be identified.'], 422);
        }
        try {
            $stmt = $conn->prepare(
                'INSERT INTO account_settings (user_id, session_timeout_minutes)
                 VALUES (:user_id, :minutes)
                 ON DUPLICATE KEY UPDATE
                     session_timeout_minutes = VALUES(session_timeout_minutes),
                     updated_at = CURRENT_TIMESTAMP'
            );
            $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
            $stmt->bindValue(':minutes', (int)$value, PDO::PARAM_INT);
            $stmt->execute();
        } catch (Throwable $e) {
            respond(['success' => false, 'message' => 'Account session settings are not ready. Apply the account session settings migration first.'], 503);
        }
        $_SESSION['session_timeout_minutes'] = (int)$value;
        respond([
            'success' => true,
            'message' => 'Your session timeout was updated.',
            'setting_scope' => 'account',
            'setting_source' => 'account',
            'setting_scope_label' => 'This account',
            'allowed_values' => auth_session_timeout_options(),
            'setting_value' => (string)$value,
        ]);
    }

    if ($key === 'session_timeout_minutes' && ($description === null || $description === '')) {
        $description = 'Idle session timeout duration in minutes';
    }
    $userId = (int)($session['user_id'] ?? 0) ?: null;
    $stmt = $conn->prepare(
        'INSERT INTO school_settings (setting_key, setting_value, description, updated_by)
         VALUES (:key, :value, :desc, :uid)
         ON DUPLICATE KEY UPDATE
             setting_value = VALUES(setting_value),
             description = COALESCE(VALUES(description), description),
             updated_by = VALUES(updated_by)'
    );
    $stmt->bindValue(':key',   $key);
    $stmt->bindValue(':value', $value);
    $stmt->bindValue(':desc',  $description);
    $stmt->bindValue(':uid',   $userId, $userId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
    $stmt->execute();
    respond([
        'success' => true,
        'message' => 'Setting saved',
        'setting_scope' => $key === 'session_timeout_minutes' ? 'school' : null,
        'setting_source' => $key === 'session_timeout_minutes' ? 'school' : null,
        'setting_scope_label' => $key === 'session_timeout_minutes' ? 'School default' : null,
        'allowed_values' => $key === 'session_timeout_minutes' ? auth_session_timeout_options() : null,
        'setting_value' => $key === 'session_timeout_minutes' ? (string)auth_normalize_session_timeout_minutes($value) : $value,
    ]);
}

function updateSettings(PDO $conn): void {
    global $session;
    // Bulk save: accepts { settings: { school_name: "", school_id: "", ... }, updated_by: 1 }
    $data = getJsonInput();
    if (empty($data['settings']) || !is_array($data['settings'])) {
        respond(['success' => false, 'message' => 'settings object is required'], 422);
    }
    $userId = (int)($session['user_id'] ?? 0) ?: null;
    $stmt = $conn->prepare(
        'UPDATE school_settings SET setting_value = :value, updated_by = :uid WHERE setting_key = :key AND is_deleted = 0'
    );
    foreach ($data['settings'] as $key => $value) {
        $key = trim((string)$key);
        $value = normalizeSettingValue($key, $value);
        $stmt->bindValue(':key',   $key);
        $stmt->bindValue(':value', $value);
        $stmt->bindValue(':uid',   $userId, $userId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->execute();
    }
    respond(['success' => true, 'message' => 'Settings updated']);
}
?>
