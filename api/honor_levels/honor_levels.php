<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
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

function isHonorLevelSeed(int $honorLevelId): bool {
    // These IDs are the established DepEd seed rows: With Highest Honors,
    // With High Honors, and With Honors. Their values remain editable, but
    // the records themselves must stay available to the ranking workflow.
    return in_array($honorLevelId, [1, 2, 3], true);
}

$operation = $_GET['operation'] ?? '';
// Archive names reuse the established soft-delete permissions and validations.
$operation = (['archiveHonorLevel' => 'deleteHonorLevel'])[$operation] ?? $operation;
$session = auth_enforce_roles($operation, ['admin', 'teacher'], ['admin']);
try {
    switch ($operation) {
        case 'getAllHonorLevels':  getAllHonorLevels($conn); break;
        case 'createHonorLevel':  createHonorLevel($conn); break;
        case 'updateHonorLevel':  updateHonorLevel($conn); break;
        case 'deleteHonorLevel':  deleteHonorLevel($conn); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (PDOException $e) {
    if ((string)$e->getCode() === '23000' && stripos($e->getMessage(), 'uq_honor_name') !== false) {
        respond(unique_name_error_payload('honor_name', 'Honor name'), 422);
    }
    error_log('Honor levels API database error: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to save the honor level. Please try again.'], 500);
} catch (Exception $e) {
    error_log('Honor levels API error: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to save the honor level. Please try again.'], 500);
}

function getAllHonorLevels(PDO $conn): void {
    $stmt = $conn->prepare('SELECT honor_level_id, honor_name, min_average, max_average, description FROM honor_levels WHERE is_deleted = 0 ORDER BY min_average DESC');
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}
function createHonorLevel(PDO $conn): void {
    respond([
        'success' => false,
        'message' => 'New honor levels cannot be added because the current honor classifications are system-defined reference records. Edit an existing level instead.'
    ], 409);
}
function updateHonorLevel(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['honor_level_id']) || empty($data['honor_name']) || !isset($data['min_average']) || !isset($data['max_average'])) {
        respond(['success' => false, 'message' => 'Honor name and min/max average are required'], 422);
    }
    $honorName = trim((string)$data['honor_name']);
    if (unique_name_exists($conn, 'honor_levels', 'honor_name', $honorName, 'honor_level_id', (int)$data['honor_level_id'])) {
        respond(unique_name_error_payload('honor_name', 'Honor name'), 422);
    }
    $stmt = $conn->prepare('UPDATE honor_levels SET honor_name = :honor_name, min_average = :min_average, max_average = :max_average, description = :description WHERE honor_level_id = :honor_level_id');
    $stmt->bindValue(':honor_name', $honorName);
    $stmt->bindValue(':min_average', $data['min_average']);
    $stmt->bindValue(':max_average', $data['max_average']);
    $stmt->bindValue(':description', $data['description'] ?? null);
    $stmt->bindValue(':honor_level_id', $data['honor_level_id'], PDO::PARAM_INT);
    $stmt->execute();
    respond(['success' => true, 'message' => 'Honor level updated']);
}
function deleteHonorLevel(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['honor_level_id'])) respond(['success' => false, 'message' => 'ID is required'], 422);
    $honorLevelId = (int)$data['honor_level_id'];
    if (isHonorLevelSeed($honorLevelId)) {
        respond([
            'success' => false,
            'message' => 'This seeded honor level is required by the ranking workflow and cannot be archived. Existing values may still be edited.'
        ], 409);
    }
    $stmt = $conn->prepare('UPDATE honor_levels SET is_deleted = 1, deleted_at = NOW() WHERE honor_level_id = :honor_level_id');
    $stmt->bindValue(':honor_level_id', $honorLevelId, PDO::PARAM_INT);
    $stmt->execute();
    respond(['success' => true, 'message' => 'Honor level archived']);
}
?>
