<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/audit.php';
require_once __DIR__ . '/../utils/password_policy.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';
require_once __DIR__ . '/../utils/account_credentials.php';
require_once __DIR__ . '/../utils/employee_integrity.php';
require_once __DIR__ . '/../utils/work_position_rules.php';
require_once __DIR__ . '/../utils/name_extension_errors.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

const USER_EMPLOYEE_FIELDS = ['employee_number', 'first_name', 'middle_name', 'last_name', 'name_extension',
    'date_of_birth', 'gender', 'contact_number', 'email', 'address', 'position_id', 'date_hired'];

$operation = $_GET['operation'] ?? '';
// Keep the legacy archive name mapped to the same reviewed soft-archive
// implementation so existing callers and the Users page share one path.
$operation = (['archiveUser' => 'deleteUser'])[$operation] ?? $operation;
$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($operation === '' && $method === 'GET') {
    $operation = 'getAllUsers';
}

// Preserve registrar employee-directory access while centralizing the module.
$session = auth_enforce_roles($operation, ['admin', 'registrar'], $operation === 'createUser' ? ['admin', 'registrar'] : ['admin']);

if ($method === 'GET' && $operation === 'getAllUsers') {
    getAllUsers($conn);
}

try {
    switch ($operation) {
        case 'getAllUsers':
            getAllUsers($conn);
            break;
        case 'createUser':
            createUser($conn);
            break;
        case 'updateUser':
            updateUser($conn);
            break;
        case 'deleteUser':
            deleteUser($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllUsers(PDO $conn): void {
    $stmt = $conn->query("SELECT u.user_id, u.username, u.role_id, r.role_name, u.is_active, u.created_at,
                                   e.employee_id, e.employee_number, e.first_name, e.middle_name, e.last_name, e.name_extension,
                                   e.date_of_birth, e.gender, e.contact_number, e.email, e.address, e.position_id, e.date_hired, p.position_name
                            FROM users u
                            LEFT JOIN employees e ON e.user_id = u.user_id
                            LEFT JOIN roles r ON r.role_id = u.role_id
                            LEFT JOIN positions p ON p.position_id = e.position_id
                            WHERE u.username IS NOT NULL AND u.is_deleted = 0
                              AND NOT EXISTS (SELECT 1 FROM learners l WHERE l.user_id = u.user_id)
                            AND " . (auth_role_key_from_session() === 'registrar' ? 'e.employee_id IS NOT NULL' : '1=1') . "
                            ORDER BY e.last_name, e.first_name, u.username");
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function validateStaffInput(PDO $conn, array $data, bool $creating): array {
    $username = trim((string)($creating ? ($data['employee_number'] ?? '') : ($data['username'] ?? '')));
    $roleId = (int)($data['role_id'] ?? 0);
    if ($username === '' || strlen($username) > 100 || !$roleId) {
        respond(['success' => false, 'message' => 'Employee number and System Role are required for a new user.'], 422);
    }
    $stmt = $conn->prepare('SELECT role_name FROM roles WHERE role_id = ? AND is_deleted = 0');
    $stmt->execute([$roleId]);
    $role = $stmt->fetchColumn();
    if (!$role || auth_normalize_role((string)$role) === 'learners') {
        respond(['success' => false, 'message' => 'Select a staff System Role. Manage learner accounts in Learners.'], 422);
    }
    return [$username, $roleId, $creating ? 1 : null];
}

function staffAccount(PDO $conn, int $userId): array {
    $stmt = $conn->prepare('SELECT u.user_id, u.username, u.role_id, u.is_active, u.is_deleted,
                                  e.employee_id
                           FROM users u LEFT JOIN employees e ON e.user_id = u.user_id
                           WHERE u.user_id = ? AND u.username IS NOT NULL AND u.is_deleted = 0
                             AND NOT EXISTS (SELECT 1 FROM learners l WHERE l.user_id = u.user_id)');
    $stmt->execute([$userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) respond(['success' => false, 'message' => 'Staff account not found.'], 404);
    return $row;
}



function unifiedEmployeeInput(PDO $conn, array $data, ?int $userId = null): ?array {
    $old = null;
    if ($userId) {
        $q = $conn->prepare('SELECT * FROM employees WHERE user_id = ?');
        $q->execute([$userId]);
        $old = $q->fetch(PDO::FETCH_ASSOC) ?: null;
    }
    $supplied = array_intersect_key($data, array_flip(USER_EMPLOYEE_FIELDS));
    // Existing standalone accounts can retain empty profile sections; adding details links a profile.
    if ($userId && (!$supplied || (!$old && !array_filter($supplied, fn($v) => $v !== null && trim((string)$v) !== '')))) return null;
    $validation = ei_validate_employee_payload($conn, array_merge($old ?? [], $data), !$old,
        $userId, $old ? (int)$old['employee_id'] : null);
    $profile = $validation['normalized'];
    if (!empty($profile['position_id'])) {
        $q = $conn->prepare('SELECT 1 FROM positions WHERE position_id = ? AND is_deleted = 0');
        $q->execute([$profile['position_id']]);
        if (!$q->fetchColumn()) $validation['errors']['position_id'] = 'Select an available position.';
    }
    if ($validation['errors']) respond(['success' => false, 'message' => 'Please correct the highlighted fields.', 'errors' => $validation['errors']], 422);
    return ['values' => $profile, 'old' => $old];
}

function saveUnifiedEmployee(PDO $conn, int $userId, ?array $profile): ?int {
    if ($profile === null) return null;
    $values = array_map(fn($f) => $profile['values'][$f] ?? null, USER_EMPLOYEE_FIELDS);
    $old = $profile['old'];
    if ($old) {
        $sets = implode(', ', array_map(fn($f) => "`$f` = ?", USER_EMPLOYEE_FIELDS));
        $q = $conn->prepare('UPDATE employees SET ' . $sets . ' WHERE user_id = ?');
        $q->execute(array_merge($values, [$userId]));
        $employeeId = (int)$old['employee_id'];
    } else {
        $columns = implode(', ', USER_EMPLOYEE_FIELDS);
        $marks = implode(', ', array_fill(0, count(USER_EMPLOYEE_FIELDS), '?'));
        $q = $conn->prepare("INSERT INTO employees (user_id, $columns) VALUES (?, $marks)");
        $q->execute(array_merge([$userId], $values));
        $employeeId = (int)$conn->lastInsertId();
    }
    audit_log($conn, 'employees', $employeeId, $old ? 'UPDATE' : 'INSERT', $old,
        array_intersect_key($profile['values'], array_flip(USER_EMPLOYEE_FIELDS)));
    return $employeeId;
}

function createUser(PDO $conn): void {
    $data = getJsonInput();
    [$username, $roleId, $isActive] = validateStaffInput($conn, $data, true);
    if (account_credentials_username_exists($conn, $username)) {
        respond(['success' => false, 'message' => 'Username already exists'], 409);
    }
    $profile = unifiedEmployeeInput($conn, $data);
    $conn->beginTransaction();
    try {
        work_position_assert_principal_available(
            $conn,
            $profile ? (int)($profile['values']['position_id'] ?? 0) : null
        );
        $stmt = $conn->prepare('INSERT INTO users (username, password, role_id, is_active, purpose, account_created_at, must_change_password)
                               VALUES (?, ?, ?, ?, ?, NOW(), 1)');
        $stmt->execute([$username, password_hash($username, PASSWORD_BCRYPT), $roleId, $isActive, $data['purpose'] ?? 'Staff account']);
        $userId = (int)$conn->lastInsertId();
        $employeeId = saveUnifiedEmployee($conn, $userId, $profile);
        audit_log($conn, 'users', $userId, 'INSERT', null, ['username' => $username, 'role_id' => $roleId, 'is_active' => $isActive]);
        $conn->commit();
    } catch (DomainException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => $e->getMessage(), 'errors' => ['position_id' => $e->getMessage()]], 409);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        if (is_name_extension_fk_violation($e)) respond(name_extension_fk_error_payload(), 422);
        if ((string)$e->getCode() === '23000') respond(['success' => false, 'message' => 'Username or employee number already exists, or a selected reference is invalid.'], 409);
        throw $e;
    }
    respond(['success' => true, 'message' => 'User created', 'user_id' => $userId, 'employee_id' => $employeeId]);
}

function updateUser(PDO $conn): void {
    $data = getJsonInput();
    $userId = (int)($data['user_id'] ?? 0);
    $old = staffAccount($conn, $userId);
    $data['username'] = $data['username'] ?? $old['username'];
    [$username, $roleId, $isActive] = validateStaffInput($conn, $data, false);
    // Account activation is controlled only by archive/restore actions.
    $isActive = (int)$old['is_active'];
    if ($userId === (int)($_SESSION['user_id'] ?? 0) && (!$isActive || $roleId !== (int)$old['role_id'])) {
        respond(['success' => false, 'message' => 'You cannot deactivate your own account or change your own role.'], 403);
    }
    $type = $old['employee_id'] ? 'employee' : 'system';
    $actorId = (int)($old['employee_id'] ?: $userId);
    if (account_credentials_username_exists($conn, $username, $type, $actorId)) {
        respond(['success' => false, 'message' => 'Username already exists'], 409);
    }
    $profile = unifiedEmployeeInput($conn, $data, $userId);
    $sql = 'UPDATE users SET username = ?, role_id = ?, is_active = ?';
    $params = [$username, $roleId, $isActive];
    if (!empty($data['password'])) {
        $sql .= ', password = ?, failed_login_count = 0, locked_until = NULL' . password_policy_default_update_sql($conn, 'users');
        $params[] = password_hash((string)$data['password'], PASSWORD_BCRYPT);
    }
    $sql .= ' WHERE user_id = ?';
    $params[] = $userId;
    $conn->beginTransaction();
    try {
        work_position_assert_principal_available(
            $conn,
            $profile ? (int)($profile['values']['position_id'] ?? 0) : null,
            $userId
        );
        $conn->prepare($sql)->execute($params);
        if (!empty($data['password'])) {
            app_integrity_bump_auth_version($conn, $userId);
        }
        saveUnifiedEmployee($conn, $userId, $profile);
        audit_log($conn, 'users', $userId, 'UPDATE', $old, ['username' => $username, 'role_id' => $roleId, 'is_active' => $isActive, 'password_reset' => !empty($data['password'])]);
        $conn->commit();
    } catch (DomainException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => $e->getMessage(), 'errors' => ['position_id' => $e->getMessage()]], 409);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        if (is_name_extension_fk_violation($e)) respond(name_extension_fk_error_payload(), 422);
        if ((string)$e->getCode() === '23000') respond(['success' => false, 'message' => 'Username or employee number already exists, or a selected reference is invalid.'], 409);
        throw $e;
    }
    respond(['success' => true, 'message' => 'User updated']);
}

function deleteUser(PDO $conn): void {
    $data = getJsonInput();
    $userId = (int)($data['user_id'] ?? 0);
    $old = staffAccount($conn, $userId);
    if ($userId === (int)($_SESSION['user_id'] ?? 0)) {
        respond(['success' => false, 'message' => 'You cannot archive your own account.'], 403);
    }
    $conn->beginTransaction();
    try {
        // Soft-archive the unified staff record while preserving historical foreign keys.
        account_identity_set_deleted($conn, $userId, true);
        $conn->prepare('UPDATE employees SET is_deleted = 1, deleted_at = NOW() WHERE user_id = ?')->execute([$userId]);
        audit_log($conn, 'users', $userId, 'DELETE', $old, null);
        $conn->commit();
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
    respond(['success' => true, 'message' => 'User archived']);
}
