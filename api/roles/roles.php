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
require_once __DIR__ . '/../utils/unique_name_validation.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

$operation = $_GET['operation'] ?? '';
// Archive names reuse the established soft-delete permissions and validations.
$operation = (['archiveRole' => 'deleteRole'])[$operation] ?? $operation;
$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($operation === '' && $method === 'GET') {
    $operation = 'getAllRoles';
}

// Roles can be listed by staff; role management is admin-only.
$session = auth_enforce_roles($operation, ['admin', 'teacher', 'registrar'], ['admin']);

if ($method === 'GET' && $operation === 'getAllRoles') {
    getAllRoles($conn);
}

try {
    switch ($operation) {
        case 'getAllRoles':
            getAllRoles($conn);
            break;
        case 'createRole':
            createRole($conn);
            break;
        case 'updateRole':
            updateRole($conn);
            break;
        case 'deleteRole':
            deleteRole($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (PDOException $e) {
    if ((string)$e->getCode() === '23000' && stripos($e->getMessage(), 'uq_role_name') !== false) {
        respond(unique_name_error_payload('role_name', 'Role name'), 422);
    }
    error_log('Roles API database error: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to save the role. Please try again.'], 500);
} catch (Exception $e) {
    error_log('Roles API error: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to save the role. Please try again.'], 500);
}

function getAllRoles(PDO $conn): void {
    $seedIds = auth_backend_role_seed_ids();
    $placeholders = implode(',', array_fill(0, count($seedIds), '?'));
    $stmt = $conn->prepare('SELECT role_id, role_name FROM roles WHERE is_deleted = 0 AND role_id IN (' . $placeholders . ') ORDER BY role_name');
    $stmt->execute($seedIds);
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function createRole(PDO $conn): void {
    respond([
        'success' => false,
        'message' => 'New roles cannot be added because roles are backend-controlled seeds. Edit an existing seed using its exact backend key, ignoring case: admin, teacher, learners, or registrar.'
    ], 409);
}

function updateRole(PDO $conn): void {
    $data = getJsonInput();
    $roleId = (int)($data['role_id'] ?? 0);
    $roleName = trim((string)($data['role_name'] ?? ''));
    if ($roleId <= 0 || $roleName === '') {
        respond(['success' => false, 'message' => 'Role ID and name are required'], 422);
    }

    $expectedKey = auth_backend_role_key_for_id($roleId);
    if ($expectedKey === null) {
        respond(['success' => false, 'message' => 'Only backend-controlled role seeds can be edited.'], 409);
    }
    if (strtolower($roleName) !== $expectedKey) {
        respond([
            'success' => false,
            'message' => 'This seed must remain "' . $expectedKey . '"; letter case may vary, but the spelling cannot change.',
            'errors' => ['role_name' => 'Use ' . $expectedKey . ', ' . ucfirst($expectedKey) . ', or uppercase ' . strtoupper($expectedKey) . '.']
        ], 422);
    }
    if (unique_name_exists($conn, 'roles', 'role_name', $roleName, 'role_id', $roleId)) {
        respond(unique_name_error_payload('role_name', 'Role name'), 422);
    }

    $oldRow = audit_fetch_old($conn, 'roles', 'role_id', $roleId);
    if (!$oldRow || (int)($oldRow['is_deleted'] ?? 0) === 1) {
        respond(['success' => false, 'message' => 'Role seed not found or already archived.'], 404);
    }
    $stmt = $conn->prepare('UPDATE roles SET role_name = :role_name WHERE role_id = :role_id AND is_deleted = 0');
    $stmt->bindValue(':role_name', $roleName);
    $stmt->bindValue(':role_id', $roleId, PDO::PARAM_INT);
    $stmt->execute();

    audit_log($conn, 'roles', $roleId, 'UPDATE', $oldRow, ['role_id' => $roleId, 'role_name' => $roleName]);

    respond(['success' => true, 'message' => 'Role updated']);
}

function deleteRole(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['role_id'])) {
        respond(['success' => false, 'message' => 'Role ID is required'], 422);
    }

    if (auth_backend_role_key_for_id((int)$data['role_id']) !== null) {
        respond([
            'success' => false,
            'message' => 'This role is required to manage user access, so it cannot be archived. Please keep it active so permissions continue to work correctly. No changes were made.'
        ], 409);
    }

    $stmt = $conn->prepare('UPDATE roles SET is_deleted = 1, deleted_at = NOW() WHERE role_id = :role_id');
    $stmt->bindValue(':role_id', $data['role_id'], PDO::PARAM_INT);
    $stmt->execute();

    $oldRow = audit_fetch_old($conn, 'roles', 'role_id', (int)$data['role_id']);
    audit_log($conn, 'roles', (int)$data['role_id'], 'DELETE', $oldRow, null);

    respond(['success' => true, 'message' => 'Role archived']);
}
?>
