<?php
header('Content-Type: application/json');
require_once __DIR__ . '/../utils/cors.php';

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';

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
$operation = (['archiveGradeLevel' => 'deleteGradeLevel'])[$operation] ?? $operation;
$session = auth_enforce_roles($operation, ['admin', 'teacher', 'registrar', 'learners'], ['admin']);

try {
    switch ($operation) {
        case 'getAllGradeLevels':
            getAllGradeLevels($conn);
            break;
        case 'createGradeLevel':
            createGradeLevel($conn);
            break;
        case 'updateGradeLevel':
            updateGradeLevel($conn);
            break;
        case 'deleteGradeLevel':
            deleteGradeLevel($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (ApplicationIntegrityException $e) {
    respond(['success' => false, 'message' => $e->getMessage()], $e->getCode());
} catch (PDOException $e) {
    if ((string)$e->getCode() === '23000' && stripos($e->getMessage(), 'uq_grade_name') !== false) {
        respond([
            'success' => false,
            'message' => 'Grade name already taken. Choose a different grade name.',
            'errors' => [
                'grade_name' => 'Grade name already taken. Choose a different grade name.'
            ]
        ], 422);
    }
    error_log('Grade levels API database error: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to save the grade level. Please try again.'], 500);
} catch (Exception $e) {
    error_log('Grade levels API error: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to save the grade level. Please try again.'], 500);
}

function gradeLevelNameTaken(PDO $conn, string $gradeName, ?int $ignoreGradeLevelId = null): bool {
    $sql = 'SELECT grade_level_id
            FROM grade_levels
            WHERE grade_name = :grade_name';
    if ($ignoreGradeLevelId !== null) {
        $sql .= ' AND grade_level_id <> :ignore_grade_level_id';
    }
    $sql .= ' LIMIT 1';

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':grade_name', $gradeName);
    if ($ignoreGradeLevelId !== null) {
        $stmt->bindValue(':ignore_grade_level_id', $ignoreGradeLevelId, PDO::PARAM_INT);
    }
    $stmt->execute();
    return (bool)$stmt->fetchColumn();
}

function respondGradeLevelNameTaken(): void {
    respond([
        'success' => false,
        'message' => 'Grade name already taken. Choose a different grade name.',
        'errors' => [
            'grade_name' => 'Grade name already taken. Choose a different grade name.'
        ]
    ], 422);
}

function getAllGradeLevels(PDO $conn): void {
    $sql = 'SELECT gl.grade_level_id, gl.grade_name, gl.education_level_id, gl.sort_order, el.level_name
            FROM grade_levels gl
            LEFT JOIN education_levels el ON gl.education_level_id = el.education_level_id
            WHERE gl.is_deleted = 0
            ORDER BY COALESCE(gl.sort_order, gl.grade_level_id), gl.grade_level_id';
    $stmt = $conn->prepare($sql);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function createGradeLevel(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['grade_name']) || empty($data['education_level_id'])) {
        respond(['success' => false, 'message' => 'Grade name and education level are required'], 422);
    }

    $gradeName = app_integrity_validate_grade_level_name((string)$data['grade_name']);
    if (gradeLevelNameTaken($conn, $gradeName)) {
        respondGradeLevelNameTaken();
    }
    $stmt = $conn->prepare('INSERT INTO grade_levels (grade_name, education_level_id) VALUES (:grade_name, :education_level_id)');
    $stmt->bindValue(':grade_name', $gradeName);
    $stmt->bindValue(':education_level_id', $data['education_level_id'], PDO::PARAM_INT);
    $stmt->execute();

    respond(['success' => true, 'message' => 'Grade level created', 'grade_level_id' => $conn->lastInsertId()]);
}

function updateGradeLevel(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['grade_level_id']) || empty($data['grade_name']) || empty($data['education_level_id'])) {
        respond(['success' => false, 'message' => 'Grade level ID, name, and education level are required'], 422);
    }

    $gradeName = app_integrity_validate_grade_level_name((string)$data['grade_name']);
    if (gradeLevelNameTaken($conn, $gradeName, (int)$data['grade_level_id'])) {
        respondGradeLevelNameTaken();
    }
    $stmt = $conn->prepare('UPDATE grade_levels SET grade_name = :grade_name, education_level_id = :education_level_id WHERE grade_level_id = :grade_level_id');
    $stmt->bindValue(':grade_name', $gradeName);
    $stmt->bindValue(':education_level_id', $data['education_level_id'], PDO::PARAM_INT);
    $stmt->bindValue(':grade_level_id', $data['grade_level_id'], PDO::PARAM_INT);
    $stmt->execute();

    respond(['success' => true, 'message' => 'Grade level updated']);
}

function deleteGradeLevel(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['grade_level_id'])) {
        respond(['success' => false, 'message' => 'Grade level ID is required'], 422);
    }

    $stmt = $conn->prepare('UPDATE grade_levels SET is_deleted = 1, deleted_at = NOW() WHERE grade_level_id = :grade_level_id');
    $stmt->bindValue(':grade_level_id', $data['grade_level_id'], PDO::PARAM_INT);
    $stmt->execute();

    respond(['success' => true, 'message' => 'Grade level archived']);
}
?>
