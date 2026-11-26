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
require_once __DIR__ . '/../utils/employee_integrity.php';
require_once __DIR__ . '/../utils/password_policy.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';
require_once __DIR__ . '/../utils/account_credentials.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';
require_once __DIR__ . '/../utils/work_position_rules.php';
require_once __DIR__ . '/../utils/name_extension_errors.php';

function requireAuth(): int {
    $session = auth_require();
    return (int)($session['user_id'] ?? 0);
}

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function normalizeInput($value) {
    if ($value === null) {
        return null;
    }
    if (is_string($value)) {
        $trimmed = trim($value);
        return $trimmed === '' ? null : $trimmed;
    }
    return $value;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

$operation = $_GET['operation'] ?? '';
// Archive names reuse the established soft-delete permissions and validations.
$operation = (['archiveEmployee' => 'deleteEmployee'])[$operation] ?? $operation;

// Employee self-service: allow teachers/admin to view/update their own record.
if ($operation === 'getMyEmployee' || $operation === 'updateMyEmployee') {
    // Self-service profile updates should be available to any authenticated employee account.
    // Learner accounts do not have an employee record.
    $session = auth_require();
    if (($session['role_key'] ?? '') === 'learners') {
        respond(['success' => false, 'message' => 'Not authorized'], 403);
    }
} else {
    $readRoles = ['admin', 'teacher'];
    $writeRoles = ['admin'];

    if (in_array($operation, ['getAllEmployees', 'getActivePrincipal', 'createEmployee'], true)) {
        $readRoles[] = 'registrar';
    }
    if ($operation === 'createEmployee') {
        $writeRoles[] = 'registrar';
    }

    $session = auth_enforce_roles($operation, $readRoles, $writeRoles);
}

try {
    switch ($operation) {
        case 'getAllEmployees':
            getAllEmployees($conn);
            break;
        case 'getActivePrincipal':
            getActivePrincipal($conn);
            break;
        case 'getMyEmployee':
            getMyEmployee($conn);
            break;
        case 'createEmployee':
            createEmployee($conn);
            break;
        case 'updateEmployee':
            updateEmployee($conn);
            break;
        case 'updateMyEmployee':
            updateMyEmployee($conn);
            break;
        case 'deleteEmployee':
            deleteEmployee($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllEmployees(PDO $conn): void {
    $sql = 'SELECT e.employee_id, e.user_id, e.employee_number, e.first_name, e.middle_name, e.last_name, e.name_extension,
                   e.date_of_birth, e.gender, e.contact_number, e.email, e.address, e.position_id, e.date_hired,
                   p.position_name, u.username, u.role_id, r.role_name
            FROM employees e
            JOIN users u ON u.user_id = e.user_id
            LEFT JOIN positions p ON e.position_id = p.position_id
            LEFT JOIN roles r ON u.role_id = r.role_id
            WHERE e.is_deleted = 0
            ORDER BY e.employee_number';
    $stmt = $conn->prepare($sql);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function getActivePrincipal(PDO $conn): void {
    // The School Head is identified by the employee's Work Position. The
    // account's System Role is intentionally not part of this lookup.
    $sql = 'SELECT e.employee_id, e.user_id, e.employee_number, e.first_name, e.middle_name, e.last_name, e.name_extension,
                   e.position_id, p.position_name, u.username
            FROM employees e
            JOIN users u ON u.user_id = e.user_id
                         AND u.is_deleted = 0
                         AND u.is_active = 1
            JOIN positions p ON p.position_id = e.position_id
                             AND p.is_deleted = 0
            WHERE e.is_deleted = 0
              AND LOWER(TRIM(p.position_name)) = :work_position
            ORDER BY e.employee_id
            LIMIT 1';
    $stmt = $conn->prepare($sql);
    $stmt->execute(['work_position' => 'principal']);
    respond($stmt->fetch(PDO::FETCH_ASSOC) ?: null);
}

function getMyEmployee(PDO $conn): void {
    $userId = requireAuth();

    $sql = 'SELECT e.employee_id, e.user_id, e.employee_number, e.first_name, e.middle_name, e.last_name, e.name_extension,
                   e.date_of_birth, e.gender, e.contact_number, e.email, e.address, e.position_id, e.date_hired,
                   p.position_name, u.username, u.role_id, r.role_name
            FROM employees e
            JOIN users u ON u.user_id = e.user_id
            LEFT JOIN positions p ON e.position_id = p.position_id
            LEFT JOIN roles r ON u.role_id = r.role_id
            WHERE e.is_deleted = 0 AND e.user_id = :user_id
            LIMIT 1';

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        // Check if user exists and get basic user info for admins without employee records
        $userSql = 'SELECT u.user_id, u.username, u.role_id, u.role_name
                   FROM (' . user_identity_derived_sql() . ') u
                   LEFT JOIN roles r ON u.role_id = r.role_id
                   WHERE u.user_id = :user_id AND u.is_deleted = 0
                   LIMIT 1';

        $userStmt = $conn->prepare($userSql);
        $userStmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
        $userStmt->execute();
        $userInfo = $userStmt->fetch(PDO::FETCH_ASSOC);

        if ($userInfo && ($userInfo['role_name'] === 'admin' || $userInfo['role_name'] === 'Administrator')) {
            // Admin user without employee record - return basic user info
            respond(['success' => true, 'data' => [
                'employee_id' => null,
                'user_id' => $userInfo['user_id'],
                'employee_number' => $userInfo['username'],
                'first_name' => 'System',
                'last_name' => 'Administrator',
                'middle_name' => '',
                'name_extension' => '',
                'date_of_birth' => null,
                'gender' => '',
                'contact_number' => '',
                'email' => '',
                'address' => '',
                'position_id' => null,
                'date_hired' => null,
                'position_name' => 'System Administrator',
                'username' => $userInfo['username'],
                'role_id' => $userInfo['role_id'],
                'role_name' => $userInfo['role_name']
            ], 'message' => 'Admin user without employee record']);
        }

        // Return success with null data for other users without employee records
        respond(['success' => true, 'data' => null, 'message' => 'No employee record found for this user']);
    }

    respond(['success' => true, 'data' => $row]);
}

function createEmployee(PDO $conn): void {
    $data = getJsonInput();

    $validation = ei_validate_employee_payload($conn, $data, true);
    if (!$validation['valid']) {
        respond(['success' => false, 'message' => 'Please correct the highlighted fields.', 'errors' => $validation['errors']], 422);
    }

    $data = $validation['normalized'];
    $employeeNumber = $data['employee_number'];

    $conn->beginTransaction();

    try {
        work_position_assert_principal_available($conn, (int)($data['position_id'] ?? 0));
        $passwordHash = password_hash((string)$employeeNumber, PASSWORD_BCRYPT);
        $userId = account_identity_create($conn, (int)$data['role_id']);
        if (account_credentials_username_exists($conn, $employeeNumber)) {
            throw new RuntimeException('Username already exists.', 23000);
        }
        $account = $conn->prepare('UPDATE users SET username = ?, password = ?, account_created_at = NOW() WHERE user_id = ?');
        $account->execute([$employeeNumber, $passwordHash, $userId]);
        // The former users password trigger invalidated sessions whenever the
        // initial employee credential was written through this path.
        app_integrity_bump_auth_version($conn, $userId);

        $stmt = $conn->prepare('INSERT INTO employees (user_id, employee_number, first_name, middle_name, last_name, name_extension, date_of_birth, gender, contact_number, email, address, position_id, date_hired)
            VALUES (:user_id, :employee_number, :first_name, :middle_name, :last_name, :name_extension, :date_of_birth, :gender, :contact_number, :email, :address, :position_id, :date_hired)');
        $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
        $stmt->bindValue(':employee_number', $employeeNumber);
        $stmt->bindValue(':first_name', $data['first_name']);
        $stmt->bindValue(':middle_name', $data['middle_name']);
        $stmt->bindValue(':last_name', $data['last_name']);
        $stmt->bindValue(':name_extension', $data['name_extension']);
        $stmt->bindValue(':date_of_birth', $data['date_of_birth']);
        $stmt->bindValue(':gender', $data['gender']);
        $stmt->bindValue(':contact_number', $data['contact_number']);
        $stmt->bindValue(':email', $data['email']);
        $stmt->bindValue(':address', $data['address']);
        $stmt->bindValue(':position_id', $data['position_id']);
        $stmt->bindValue(':date_hired', $data['date_hired']);
        $stmt->execute();

        $employeeId = $conn->lastInsertId();

        audit_log($conn, 'employees', (int)$employeeId, 'INSERT', null, [
            'employee_id' => (int)$employeeId,
            'employee_number' => $employeeNumber,
            'first_name' => $data['first_name'],
            'last_name' => $data['last_name'],
        ]);

        $conn->commit();

        respond(['success' => true, 'message' => 'Employee created', 'employee_id' => $employeeId, 'user_id' => $userId]);
    } catch (DomainException $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        respond(['success' => false, 'message' => $e->getMessage(), 'errors' => ['position_id' => $e->getMessage()]], 409);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        if (is_name_extension_fk_violation($e)) {
            respond(name_extension_fk_error_payload(), 422);
        }
        if ((string)$e->getCode() === '23000') {
            respond(['success' => false, 'message' => 'Duplicate employee record. Employee number may already be in use.', 'errors' => ['employee_number' => 'Employee number already in use.']], 409);
        }
        throw $e;
    }
}

function updateEmployee(PDO $conn): void {
    $data = getJsonInput();

    if (empty($data['employee_id'])) {
        respond(['success' => false, 'message' => 'Employee ID is required'], 422);
    }

    $employeeId = (int)$data['employee_id'];

    $empStmt = $conn->prepare('SELECT user_id, employee_number, name_extension FROM employees WHERE employee_id = :employee_id AND is_deleted = 0 LIMIT 1');
    $empStmt->bindValue(':employee_id', $employeeId, PDO::PARAM_INT);
    $empStmt->execute();
    $employee = $empStmt->fetch(PDO::FETCH_ASSOC);
    if (!$employee) {
        respond(['success' => false, 'message' => 'Employee not found'], 404);
    }

    $userId = (int)$employee['user_id'];

    // The employee UI no longer edits name extensions. Preserve any legacy
    // value when older records are updated through the remaining fields.
    if (!array_key_exists('name_extension', $data)) {
        $data['name_extension'] = $employee['name_extension'];
    }

    $validation = ei_validate_employee_payload($conn, $data, false, $userId, $employeeId);
    if (!$validation['valid']) {
        respond(['success' => false, 'message' => 'Please correct the highlighted fields.', 'errors' => $validation['errors']], 422);
    }

    $data = $validation['normalized'];
    $employeeNumber = $data['employee_number'];

    $conn->beginTransaction();

    try {
        work_position_assert_principal_available($conn, (int)($data['position_id'] ?? 0), $userId);
        $stmt = $conn->prepare('UPDATE employees SET employee_number = :employee_number, first_name = :first_name, middle_name = :middle_name, last_name = :last_name,
            name_extension = :name_extension, date_of_birth = :date_of_birth, gender = :gender, contact_number = :contact_number, email = :email, address = :address,
            position_id = :position_id, date_hired = :date_hired
            WHERE employee_id = :employee_id');
        $stmt->bindValue(':employee_number', $employeeNumber);
        $stmt->bindValue(':first_name', $data['first_name']);
        $stmt->bindValue(':middle_name', $data['middle_name']);
        $stmt->bindValue(':last_name', $data['last_name']);
        $stmt->bindValue(':name_extension', $data['name_extension']);
        $stmt->bindValue(':date_of_birth', $data['date_of_birth']);
        $stmt->bindValue(':gender', $data['gender']);
        $stmt->bindValue(':contact_number', $data['contact_number']);
        $stmt->bindValue(':email', $data['email']);
        $stmt->bindValue(':address', $data['address']);
        $stmt->bindValue(':position_id', $data['position_id']);
        $stmt->bindValue(':date_hired', $data['date_hired']);
        $stmt->bindValue(':employee_id', $employeeId, PDO::PARAM_INT);
        $stmt->execute();

        $oldRow = audit_fetch_old($conn, 'employees', 'employee_id', $employeeId);
        audit_log($conn, 'employees', $employeeId, 'UPDATE', $oldRow, [
            'employee_id' => $employeeId,
            'employee_number' => $employeeNumber,
            'first_name' => $data['first_name'],
            'last_name' => $data['last_name'],
        ]);

        $stmtUser = $conn->prepare('UPDATE users SET role_id = COALESCE(:role_id, role_id) WHERE user_id = :user_id');
        $stmtUser->bindValue(':role_id', $data['role_id'] ?? null);
        $stmtUser->bindValue(':user_id', $userId, PDO::PARAM_INT);
        $stmtUser->execute();

        $conn->commit();

        respond(['success' => true, 'message' => 'Employee updated']);
    } catch (DomainException $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        respond(['success' => false, 'message' => $e->getMessage(), 'errors' => ['position_id' => $e->getMessage()]], 409);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        if (is_name_extension_fk_violation($e)) {
            respond(name_extension_fk_error_payload(), 422);
        }
        if ((string)$e->getCode() === '23000') {
            respond(['success' => false, 'message' => 'Duplicate employee record. Employee number may already be in use.', 'errors' => ['employee_number' => 'Employee number already in use.']], 409);
        }
        throw $e;
    }
}

function updateMyEmployee(PDO $conn): void {
    $userId = requireAuth();
    $input = getJsonInput();

    $employeeId = $input['employee_id'] ?? null;
    $employeeIdInt = $employeeId ? (int)$employeeId : 0;

    if ($employeeIdInt <= 0) {
        respond(['success' => false, 'message' => 'No employee profile record found for update'], 422);
    }

    $stmtCheck = $conn->prepare('SELECT employee_id FROM employees WHERE employee_id = :employee_id AND user_id = :user_id AND is_deleted = 0');
    $stmtCheck->bindValue(':employee_id', $employeeIdInt, PDO::PARAM_INT);
    $stmtCheck->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $stmtCheck->execute();
    if (!$stmtCheck->fetch()) {
        respond(['success' => false, 'message' => 'Employee record not found or not owned by you'], 403);
    }

    $validation = ei_validate_employee_self_update($input);
    if (!$validation['valid']) {
        respond(['success' => false, 'message' => 'Please correct the highlighted fields.', 'errors' => $validation['errors']], 422);
    }

    $data = $validation['normalized'];

    $updateFields = [];
    $params = [':user_id' => $userId, ':employee_id' => $employeeIdInt];

    foreach (['first_name', 'middle_name', 'last_name', 'name_extension', 'date_of_birth', 'gender', 'contact_number', 'email', 'address', 'position_id', 'date_hired'] as $field) {
        if (array_key_exists($field, $data)) {
            $updateFields[] = "$field = :$field";
            $params[":$field"] = $data[$field];
        }
    }

    if (empty($updateFields)) {
        respond(['success' => true, 'message' => 'No changes made']);
    }

    $sql = 'UPDATE employees SET ' . implode(', ', $updateFields) . ' WHERE employee_id = :employee_id AND user_id = :user_id';

    $conn->beginTransaction();
    try {
        if (array_key_exists('position_id', $data)) {
            work_position_assert_principal_available($conn, (int)($data['position_id'] ?? 0), $userId);
        }
        $stmt = $conn->prepare($sql);
        $stmt->execute($params);
        $conn->commit();
    } catch (DomainException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => $e->getMessage(), 'errors' => ['position_id' => $e->getMessage()]], 409);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }

    respond(['success' => true, 'message' => 'Profile updated successfully']);
}

function deleteEmployee(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['employee_id'])) {
        respond(['success' => false, 'message' => 'Employee ID is required'], 422);
    }

    $employeeId = (int)$data['employee_id'];

    $session = auth_require();

    $empStmt = $conn->prepare('SELECT user_id FROM employees WHERE employee_id = :employee_id AND is_deleted = 0 LIMIT 1');
    $empStmt->bindValue(':employee_id', $employeeId, PDO::PARAM_INT);
    $empStmt->execute();
    $userId = $empStmt->fetchColumn();

    if (!$userId) {
        respond(['success' => false, 'message' => 'Employee not found'], 404);
    }

    $userId = (int)$userId;

    // Prevent an employee from deleting their own record while they are logged in.
    if ($userId === (int)$session['user_id']) {
        respond(['success' => false, 'message' => 'You cannot archive your own employee record.'], 403);
    }

    $conn->beginTransaction();

    try {
        $stmt = $conn->prepare('UPDATE employees SET is_deleted = 1, deleted_at = NOW() WHERE employee_id = :employee_id');
        $stmt->bindValue(':employee_id', $employeeId, PDO::PARAM_INT);
        $stmt->execute();

        // Deactivate the linked user account so the archived employee cannot log in,
        // while keeping the user record intact for audit / reference purposes.
        account_identity_set_deleted($conn, $userId, true);


        $oldRow = audit_fetch_old($conn, 'employees', 'employee_id', $employeeId);
        audit_log($conn, 'employees', $employeeId, 'DELETE', $oldRow, null);

        $conn->commit();

        respond(['success' => true, 'message' => 'Employee archived']);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        throw $e;
    }
}
?>
