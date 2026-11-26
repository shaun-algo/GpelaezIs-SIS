<?php
require_once __DIR__ . '/../utils/cors.php';
header('Content-Type: application/json');

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/password_policy.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

$session = auth_require();
$userId = (int)$session['user_id'];
$accountType = (string)($session['account_type'] ?? '');
$actorId = (int)($session['actor_id'] ?? 0);

if (($accountType === '' || $actorId <= 0) && $userId > 0) {
    try {
        $acctStmt = $conn->prepare('SELECT account_type, actor_id FROM (' . account_credentials_derived_sql() . ') ac WHERE ac.legacy_user_id = :user_id AND ac.is_deleted = 0 LIMIT 1');
        $acctStmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
        $acctStmt->execute();
        $acct = $acctStmt->fetch(PDO::FETCH_ASSOC);
        if ($acct) {
            $accountType = (string)$acct['account_type'];
            $actorId = (int)$acct['actor_id'];
            $_SESSION['account_type'] = $accountType;
            $_SESSION['actor_id'] = $actorId;
            $_SESSION['legacy_user_id'] = $userId;
        }
    } catch (Throwable $e) {
        // keep legacy-session fallback
    }
}
$firstName = '';
$lastName = '';
$gender = '';
$employeeId = null;
$positionId = null;
$positionName = '';
$learnerId = null;
$isAdviser = false;
$accountCreatedAt = null;

try {
    $createdStmt = $conn->prepare(
        'SELECT COALESCE(account_created_at, created_at) AS account_created_at
         FROM users
         WHERE user_id = :user_id AND is_deleted = 0
         LIMIT 1'
    );
    $createdStmt->execute([':user_id' => $userId]);
    $accountCreatedAt = $createdStmt->fetchColumn() ?: null;
} catch (Throwable $e) {
    $accountCreatedAt = null;
}

$roleKey = (string)($session['role_key'] ?? '');
$rk = strtolower(trim($roleKey));
$isLearner = ($rk === 'learners');

try {
    $stmt = $conn->prepare(
        'SELECT emp.employee_id,
                emp.first_name,
                emp.last_name,
                emp.gender,
                emp.position_id,
                p.position_name
         FROM employees emp
         LEFT JOIN positions p
                ON p.position_id = emp.position_id
               AND p.is_deleted = 0
         WHERE ' . ($accountType === 'employee' && $actorId > 0 ? 'emp.employee_id = :actor_id' : 'emp.user_id = :user_id') . '
           AND emp.is_deleted = 0
         LIMIT 1'
    );
    if ($accountType === 'employee' && $actorId > 0) {
        $stmt->bindValue(':actor_id', $actorId, PDO::PARAM_INT);
    } else {
        $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    }
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row) {
        $employeeId = isset($row['employee_id']) ? (int)$row['employee_id'] : null;
        $firstName = $row['first_name'] ?? '';
        $lastName = $row['last_name'] ?? '';
        $gender = $row['gender'] ?? '';
        $positionId = isset($row['position_id']) && $row['position_id'] !== null ? (int)$row['position_id'] : null;
        $positionName = $row['position_name'] ?? '';
    }
} catch (Exception $e) {
    $firstName = '';
    $lastName = '';
    $gender = '';
    $employeeId = null;
    $positionId = null;
    $positionName = '';
}

if ($isLearner) {
    try {
        $lStmt = $conn->prepare(
            'SELECT learner_id, first_name, last_name, gender
             FROM learners
             WHERE ' . ($accountType === 'learner' && $actorId > 0 ? 'learner_id = :actor_id' : 'user_id = :user_id') . ' AND is_deleted = 0
             LIMIT 1'
        );
        if ($accountType === 'learner' && $actorId > 0) {
            $lStmt->bindValue(':actor_id', $actorId, PDO::PARAM_INT);
        } else {
            $lStmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
        }
        $lStmt->execute();
        $lRow = $lStmt->fetch(PDO::FETCH_ASSOC);
        if ($lRow) {
            $learnerId = isset($lRow['learner_id']) ? (int)$lRow['learner_id'] : null;
            $firstName = $lRow['first_name'] ?? $firstName;
            $lastName = $lRow['last_name'] ?? $lastName;
            $gender = $lRow['gender'] ?? $gender;
        }
    } catch (Exception $e) {
        $learnerId = null;
    }
}

$fullName = trim($firstName . ' ' . $lastName);

// Derived privileges
$roleKey = (string)($session['role_key'] ?? '');
$rk = strtolower(trim($roleKey));
$isRegistrar = ($rk === 'registrar');
$isAdviser = ($rk === 'adviser' || $rk === 'advisor');

$canMonitorReports = in_array($rk, ['admin', 'registrar'], true);
$canExportHonorsYearLevel = in_array($rk, ['admin', 'registrar', 'adviser', 'advisor'], true);
$mustChangePassword = !empty($_SESSION['must_change_password']);

try {
    if ($accountType !== '' && $actorId > 0) {
        $pwStmt = $conn->prepare('SELECT must_change_password FROM (' . account_credentials_derived_sql() . ') ac WHERE ac.account_type = :account_type AND ac.actor_id = :actor_id AND ac.is_deleted = 0 LIMIT 1');
        $pwStmt->bindValue(':account_type', $accountType);
        $pwStmt->bindValue(':actor_id', $actorId, PDO::PARAM_INT);
        $pwStmt->execute();
        $mustChangePassword = ((int)($pwStmt->fetchColumn() ?: 0) === 1);
        $_SESSION['must_change_password'] = $mustChangePassword ? 1 : 0;
    }
} catch (Throwable $e) {
    // keep session-derived value
}

respond([
    'success' => true,
    'data' => [
        'user_id' => $userId,
        'legacy_user_id' => (int)($session['legacy_user_id'] ?? $userId),
        'account_type' => $accountType,
        'actor_id' => $actorId,
        'username' => $_SESSION['username'] ?? '',
        'role_id' => (int)($_SESSION['role_id'] ?? 0),
        'role_name' => $_SESSION['role_name'] ?? '',
        'role_key' => $roleKey,
        'first_name' => $firstName,
        'last_name' => $lastName,
        'gender' => $gender,
        'full_name' => $fullName,
        'employee_id' => $employeeId,
        'learner_id' => $learnerId,
        'position_id' => $positionId,
        'position_name' => $positionName,
        'is_adviser' => $isAdviser,
        'is_registrar' => $isRegistrar,
        'must_change_password' => $mustChangePassword,
        'account_created_at' => $accountCreatedAt,
        'session_device' => [
            'is_main_device' => !empty($session['is_main_device']),
        ],
        'presence' => [
            'is_online' => true,
            'last_seen_at' => date('Y-m-d H:i:s'),
            'last_login' => null,
            'last_seen_seconds_ago' => 0,
            'last_login_seconds_ago' => null,
        ],
        'session_idle_timeout_seconds' => (int)($session['session_idle_timeout_seconds'] ?? 1800),
        'session_last_activity' => (int)($session['session_last_activity'] ?? time()),
        'privileges' => [
            'can_monitor_reports' => $canMonitorReports,
            'can_export_honors_year_level' => $canExportHonorsYearLevel
        ]
    ]
]);
?>
