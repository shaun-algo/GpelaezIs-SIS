<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/work_position_rules.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function respondPositionNameTaken(string $message = 'Position name already taken. Choose a different position name.'): void {
    respond([
        'success' => false,
        'message' => $message,
        'errors' => ['position_name' => $message]
    ], 422);
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

$operation = $_GET['operation'] ?? '';
// Archive names reuse the established soft-delete permissions and validations.
$operation = (['archivePosition' => 'deletePosition'])[$operation] ?? $operation;
$session = auth_enforce_roles($operation, ['admin', 'teacher', 'registrar'], ['admin']);

try {
    switch ($operation) {
        case 'getAllPositions':
            getAllPositions($conn);
            break;
        case 'createPosition':
            createPosition($conn);
            break;
        case 'updatePosition':
            updatePosition($conn);
            break;
        case 'deletePosition':
            deletePosition($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllPositions(PDO $conn): void {
    $stmt = $conn->prepare('SELECT position_id, position_name, description FROM positions WHERE is_deleted = 0 ORDER BY position_name');
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function createPosition(PDO $conn): void {
    $data = getJsonInput();
    $positionName = normalizeInput($data['position_name'] ?? null);
    if (!$positionName) {
        respond(['success' => false, 'message' => 'Position name is required'], 422);
    }

    $conn->beginTransaction();
    try {
        work_position_assert_name_available($conn, $positionName);
        $stmt = $conn->prepare('INSERT INTO positions (position_name, description) VALUES (:position_name, :description)');
        $stmt->bindValue(':position_name', $positionName);
        $stmt->bindValue(':description', normalizeInput($data['description'] ?? null));
        $stmt->execute();
        $positionId = $conn->lastInsertId();
        $conn->commit();
    } catch (DomainException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        if (stripos($e->getMessage(), 'work position already exists') !== false) {
            respondPositionNameTaken();
        }
        respond(['success' => false, 'message' => $e->getMessage()], 409);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        if ((string)$e->getCode() === '23000') {
            respondPositionNameTaken();
        }
        throw $e;
    }

    respond(['success' => true, 'message' => 'Position created', 'position_id' => $positionId]);
}

function updatePosition(PDO $conn): void {
    $data = getJsonInput();
    $positionId = (int)($data['position_id'] ?? 0);
    $positionName = normalizeInput($data['position_name'] ?? null);
    if ($positionId <= 0 || !$positionName) {
        respond(['success' => false, 'message' => 'Position ID and name are required'], 422);
    }

    $conn->beginTransaction();
    try {
        $current = work_position_get($conn, $positionId, true);
        if (!$current || (int)$current['is_deleted'] === 1) {
            throw new DomainException('Position not found or already archived.');
        }
        work_position_assert_name_available($conn, $positionName, $positionId);
        if (work_position_is_principal($positionName)) {
            work_position_assert_proposed_principal_available($conn, $positionId);
        }
        $stmt = $conn->prepare('UPDATE positions SET position_name = :position_name, description = :description WHERE position_id = :position_id AND is_deleted = 0');
        $stmt->bindValue(':position_name', $positionName);
        $stmt->bindValue(':description', normalizeInput($data['description'] ?? null));
        $stmt->bindValue(':position_id', $positionId, PDO::PARAM_INT);
        $stmt->execute();
        $conn->commit();
    } catch (DomainException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        if (stripos($e->getMessage(), 'work position already exists') !== false) {
            respondPositionNameTaken();
        }
        respond(['success' => false, 'message' => $e->getMessage()], 409);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        if ((string)$e->getCode() === '23000') {
            respondPositionNameTaken();
        }
        throw $e;
    }

    respond(['success' => true, 'message' => 'Position updated']);
}

function deletePosition(PDO $conn): void {
    $data = getJsonInput();
    $positionId = (int)($data['position_id'] ?? 0);
    if ($positionId <= 0) {
        respond(['success' => false, 'message' => 'Position ID is required'], 422);
    }

    $conn->beginTransaction();
    try {
        $current = work_position_get($conn, $positionId, true);
        if (!$current || (int)$current['is_deleted'] === 1) {
            throw new DomainException('Position not found or already archived.');
        }
        work_position_assert_can_archive($conn, $positionId);
        $stmt = $conn->prepare('UPDATE positions SET is_deleted = 1, deleted_at = NOW() WHERE position_id = :position_id AND is_deleted = 0');
        $stmt->bindValue(':position_id', $positionId, PDO::PARAM_INT);
        $stmt->execute();
        $conn->commit();
    } catch (DomainException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => $e->getMessage()], 409);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }

    respond(['success' => true, 'message' => 'Position archived']);
}
?>
