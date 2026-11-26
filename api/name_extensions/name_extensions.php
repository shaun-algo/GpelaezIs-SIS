<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

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

$operation = $_GET['operation'] ?? '';
$session = auth_enforce_roles($operation, ['admin', 'teacher', 'registrar'], ['admin']);
try {
    switch ($operation) {
        case 'getAllNameExtensions':  getAllNameExtensions($conn); break;
        case 'createNameExtension':  createNameExtension($conn); break;
        case 'updateNameExtension':  updateNameExtension($conn); break;
        case 'deleteNameExtension':  deleteNameExtension($conn); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (PDOException $e) {
    if ((string)$e->getCode() === '23000') {
        $message = 'Name extension already taken. Choose a different extension.';
        respond([
            'success' => false,
            'message' => $message,
            'errors' => ['extension_name' => $message]
        ], 422);
    }
    error_log('Name extensions API database error: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to save the name extension. Please try again.'], 500);
} catch (Exception $e) {
    error_log('Name extensions API error: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to save the name extension. Please try again.'], 500);
}

function getAllNameExtensions(PDO $conn): void {
    // Prefer the lookup table when an installed schema provides it. Some
    // older deployments do not have this table, so retain the fixed values
    // as a compatibility fallback for those installations.
    try {
        $tableCheck = $conn->prepare("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'name_extensions'");
        $tableCheck->execute();
        if ((int)$tableCheck->fetchColumn() > 0) {
            $stmt = $conn->query('SELECT extension_id, extension_name FROM name_extensions WHERE is_deleted = 0 ORDER BY extension_id');
            $rows = [];
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $name = trim((string)($row['extension_name'] ?? ''));
                if ($name === '') continue;
                $rows[] = [
                    'extension_id' => (string)($row['extension_id'] ?? ''),
                    'extension_name' => $name,
                ];
            }
            array_unshift($rows, ['extension_id' => '', 'extension_name' => '']);
            respond($rows);
        }
    } catch (Throwable $e) {
        // Fall through to the compatibility values below without exposing
        // schema details to the browser.
    }

    $rows = [
        ['extension_id' => '',    'extension_name' => ''],
        ['extension_id' => 'Jr.', 'extension_name' => 'Jr.'],
        ['extension_id' => 'Sr.', 'extension_name' => 'Sr.'],
        ['extension_id' => 'II',  'extension_name' => 'II'],
        ['extension_id' => 'III', 'extension_name' => 'III'],
        ['extension_id' => 'IV',  'extension_name' => 'IV'],
    ];
    respond($rows);
}
function normalizeNameExtension($value): ?string {
    $name = trim((string)($value ?? ''));
    if ($name === '') {
        respond(['success' => false, 'message' => 'Name extension is required.'], 422);
    }
    if (function_exists('mb_strlen') ? mb_strlen($name) > 10 : strlen($name) > 10) {
        respond(['success' => false, 'message' => 'Name extension must be 10 characters or fewer.'], 422);
    }
    if (!preg_match("/^[\\p{L}0-9\\s\\-'\\.]+$/u", $name)) {
        respond(['success' => false, 'message' => 'Name extension contains invalid characters.'], 422);
    }
    return $name;
}

function requireNameExtensionsTable(PDO $conn): void {
    $stmt = $conn->prepare("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'name_extensions'");
    $stmt->execute();
    if ((int)$stmt->fetchColumn() < 1) {
        respond(['success' => false, 'message' => 'Name Extensions lookup is not installed. Apply the name extensions migration first.'], 503);
    }
}

function createNameExtension(PDO $conn): void {
    requireNameExtensionsTable($conn);
    $data = getJsonInput();
    $name = normalizeNameExtension($data['extension_name'] ?? null);

    $existing = $conn->prepare('SELECT extension_id, is_deleted FROM name_extensions WHERE extension_name = :extension_name LIMIT 1');
    $existing->bindValue(':extension_name', $name);
    $existing->execute();
    $row = $existing->fetch(PDO::FETCH_ASSOC);
    if ($row) {
        if ((int)$row['is_deleted'] === 1) {
            $restore = $conn->prepare('UPDATE name_extensions SET is_deleted = 0, deleted_at = NULL WHERE extension_id = :extension_id');
            $restore->bindValue(':extension_id', $row['extension_id'], PDO::PARAM_INT);
            $restore->execute();
            respond(['success' => true, 'message' => 'Name extension restored', 'extension_id' => $row['extension_id']]);
        }
        $message = 'Name extension already taken. Choose a different extension.';
        respond([
            'success' => false,
            'message' => $message,
            'errors' => ['extension_name' => $message]
        ], 422);
    }

    $stmt = $conn->prepare('INSERT INTO name_extensions (extension_name) VALUES (:extension_name)');
    $stmt->bindValue(':extension_name', $name);
    $stmt->execute();
    respond(['success' => true, 'message' => 'Name extension created', 'extension_id' => $conn->lastInsertId()]);
}

function updateNameExtension(PDO $conn): void {
    requireNameExtensionsTable($conn);
    $data = getJsonInput();
    $id = filter_var($data['extension_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if (!$id) respond(['success' => false, 'message' => 'A valid name extension ID is required.'], 422);
    $name = normalizeNameExtension($data['extension_name'] ?? null);

    $currentStmt = $conn->prepare('SELECT extension_name, is_deleted FROM name_extensions WHERE extension_id = :extension_id LIMIT 1');
    $currentStmt->bindValue(':extension_id', $id, PDO::PARAM_INT);
    $currentStmt->execute();
    $current = $currentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$current || (int)$current['is_deleted'] === 1) {
        respond(['success' => false, 'message' => 'Name extension not found.'], 404);
    }

    $duplicate = $conn->prepare('SELECT extension_id FROM name_extensions WHERE extension_name = :extension_name AND extension_id <> :extension_id LIMIT 1');
    $duplicate->bindValue(':extension_name', $name);
    $duplicate->bindValue(':extension_id', $id, PDO::PARAM_INT);
    $duplicate->execute();
    if ($duplicate->fetchColumn()) {
        $message = 'Name extension already taken. Choose a different extension.';
        respond([
            'success' => false,
            'message' => $message,
            'errors' => ['extension_name' => $message]
        ], 422);
    }

    $oldName = trim((string)$current['extension_name']);
    if ($oldName !== $name) {
        $usage = $conn->prepare('SELECT
            (SELECT COUNT(*) FROM employees WHERE name_extension = :old_employee) +
            (SELECT COUNT(*) FROM learners WHERE name_extension = :old_learner)');
        $usage->bindValue(':old_employee', $oldName);
        $usage->bindValue(':old_learner', $oldName);
        $usage->execute();
        if ((int)$usage->fetchColumn() > 0) {
            respond(['success' => false, 'message' => 'This extension is already used by existing records. Keep its name or create a new extension.'], 409);
        }
    }

    $stmt = $conn->prepare('UPDATE name_extensions SET extension_name = :extension_name WHERE extension_id = :extension_id');
    $stmt->bindValue(':extension_name', $name);
    $stmt->bindValue(':extension_id', $id, PDO::PARAM_INT);
    $stmt->execute();
    respond(['success' => true, 'message' => 'Name extension updated']);
}

function deleteNameExtension(PDO $conn): void {
    requireNameExtensionsTable($conn);
    $data = getJsonInput();
    $id = filter_var($data['extension_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if (!$id) respond(['success' => false, 'message' => 'A valid name extension ID is required.'], 422);

    $stmt = $conn->prepare('UPDATE name_extensions SET is_deleted = 1, deleted_at = NOW() WHERE extension_id = :extension_id AND is_deleted = 0');
    $stmt->bindValue(':extension_id', $id, PDO::PARAM_INT);
    $stmt->execute();
    if ($stmt->rowCount() < 1) respond(['success' => false, 'message' => 'Name extension not found.'], 404);
    respond(['success' => true, 'message' => 'Name extension archived']);
}
?>
