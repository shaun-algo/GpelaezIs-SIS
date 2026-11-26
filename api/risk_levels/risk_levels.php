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

function rejectRiskLevelMutation(): void {
    respond([
        'success' => false,
        'message' => 'Risk levels are system-defined values used by automated assessment and cannot be added, edited, or archived.'
    ], 403);
}

$operation = $_GET['operation'] ?? '';
// Archive names reuse the established soft-delete permissions and validations.
$operation = (['archiveRiskLevel' => 'deleteRiskLevel'])[$operation] ?? $operation;
$session = auth_enforce_roles($operation, ['admin', 'teacher'], ['admin']);
try {
    switch ($operation) {
        case 'getAllRiskLevels':  getAllRiskLevels($conn); break;
        case 'createRiskLevel':  createRiskLevel($conn); break;
        case 'updateRiskLevel':  updateRiskLevel($conn); break;
        case 'deleteRiskLevel':  deleteRiskLevel($conn); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllRiskLevels(PDO $conn): void {
    $stmt = $conn->prepare('SELECT risk_level_id, risk_name FROM risk_levels WHERE is_deleted = 0 ORDER BY risk_level_id');
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}
function createRiskLevel(PDO $conn): void {
    rejectRiskLevelMutation();
}
function updateRiskLevel(PDO $conn): void {
    rejectRiskLevelMutation();
}
function deleteRiskLevel(PDO $conn): void {
    rejectRiskLevelMutation();
}
?>
