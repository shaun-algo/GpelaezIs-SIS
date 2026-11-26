<?php
header('Content-Type: application/json');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

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

$operation = $_GET['operation'] ?? '';
// Archive names reuse the established soft-delete permissions and validations.
$operation = (['archiveSubject' => 'deleteSubject'])[$operation] ?? $operation;
$session = auth_enforce_roles($operation, ['admin', 'teacher'], ['admin']);

try {
    switch ($operation) {
        case 'getAllSubjects':
            getAllSubjects($conn);
            break;
        case 'createSubject':
            createSubject($conn);
            break;
        case 'updateSubject':
            updateSubject($conn);
            break;
        case 'deleteSubject':
            deleteSubject($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (PDOException $e) {
    error_log('Subjects API database error: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to save the subject. Please try again.'], 500);
} catch (Exception $e) {
    error_log('Subjects API error: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to save the subject. Please try again.'], 500);
}

function getAllSubjects(PDO $conn): void {
    $sql = 'SELECT s.subject_id, s.subject_name, s.description,
                   s.subject_category_id,
                   sc.category_code,
                   sc.category_name,
                   sc.sort_order AS category_sort_order,
                   sc.is_active AS category_is_active
            FROM subjects s
            LEFT JOIN subject_categories sc
              ON sc.subject_category_id = s.subject_category_id
             AND sc.is_deleted = 0
            WHERE s.is_deleted = 0
            ORDER BY COALESCE(sc.sort_order, 999), s.subject_name';
    $stmt = $conn->prepare($sql);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function createSubject(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['subject_name'])) {
        respond(['success' => false, 'message' => 'subject_name is required'], 422);
    }
    $subjectName = trim((string)$data['subject_name']);
    if (unique_name_exists($conn, 'subjects', 'subject_name', $subjectName)) {
        respond(unique_name_error_payload('subject_name', 'Subject name'), 422);
    }

    $categoryId = resolveSubjectCategoryId($conn, $data['subject_category_id'] ?? null, $subjectName);
    $stmt = $conn->prepare('INSERT INTO subjects (subject_name, description, subject_category_id) VALUES (:subject_name, :description, :subject_category_id)');
    $stmt->bindValue(':subject_name', $subjectName);
    $stmt->bindValue(':description', trim((string)($data['description'] ?? '')) ?: null);
    $stmt->bindValue(':subject_category_id', $categoryId, $categoryId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
    $stmt->execute();

    respond(['success' => true, 'message' => 'Subject created', 'subject_id' => $conn->lastInsertId()]);
}

function updateSubject(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['subject_id']) || empty($data['subject_name'])) {
        respond(['success' => false, 'message' => 'subject_id and subject_name are required'], 422);
    }
    $subjectName = trim((string)$data['subject_name']);
    if (unique_name_exists($conn, 'subjects', 'subject_name', $subjectName, 'subject_id', (int)$data['subject_id'])) {
        respond(unique_name_error_payload('subject_name', 'Subject name'), 422);
    }

    $categoryId = resolveSubjectCategoryId($conn, $data['subject_category_id'] ?? null, $subjectName);
    $stmt = $conn->prepare('UPDATE subjects SET subject_name = :subject_name, description = :description, subject_category_id = :subject_category_id WHERE subject_id = :subject_id');
    $stmt->bindValue(':subject_name', $subjectName);
    $stmt->bindValue(':description', trim((string)($data['description'] ?? '')) ?: null);
    $stmt->bindValue(':subject_category_id', $categoryId, $categoryId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
    $stmt->bindValue(':subject_id', $data['subject_id'], PDO::PARAM_INT);
    $stmt->execute();

    respond(['success' => true, 'message' => 'Subject updated']);
}

function deleteSubject(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['subject_id'])) {
        respond(['success' => false, 'message' => 'Subject ID is required'], 422);
    }

    $stmt = $conn->prepare('UPDATE subjects SET is_deleted = 1, deleted_at = NOW() WHERE subject_id = :subject_id');
    $stmt->bindValue(':subject_id', $data['subject_id'], PDO::PARAM_INT);
    $stmt->execute();

    respond(['success' => true, 'message' => 'Subject archived']);
}

function resolveSubjectCategoryId(PDO $conn, $requestedId, string $subjectName): ?int {
    if ($requestedId !== null && $requestedId !== '') {
        $id = filter_var($requestedId, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!$id) {
            respond(['success' => false, 'message' => 'Choose a valid subject category.', 'errors' => ['subject_category_id' => 'Choose a valid subject category.']], 422);
        }
        $stmt = $conn->prepare('SELECT subject_category_id FROM subject_categories WHERE subject_category_id = :id AND is_deleted = 0 AND is_active = 1 LIMIT 1');
        $stmt->execute([':id' => $id]);
        if (!$stmt->fetchColumn()) {
            respond(['success' => false, 'message' => 'Choose an active subject category.', 'errors' => ['subject_category_id' => 'Choose an active subject category.']], 422);
        }
        return (int)$id;
    }

    // Keep curriculum quick-create backward compatible while still assigning
    // the canonical seed whenever the subject name is recognizable.
    $name = strtolower(trim((string)$subjectName));
    $code = null;
    if (preg_match('/filipino|english|mother tongue|reading|language|mathematics|(^|[^a-z])math([^a-z]|$)|science/', $name)) {
        $code = 'FOUNDATIONAL_CORE';
    } elseif (preg_match('/gmrc|good manners|right conduct|values education|edukasyon sa pagpapakatao|makabansa/', $name)) {
        $code = 'VALUES_CULTURAL';
    } elseif (preg_match('/araling panlipunan|social studies|(^|[^a-z])ap([^a-z]|$)|epp|tle|technology|livelihood|mapeh|music|arts|physical education|(^|[^a-z])p\.e\.([^a-z]|$)|(^|[^a-z])pe([^a-z]|$)|health/', $name)) {
        $code = 'SPECIALIZED_MULTIDISCIPLINARY';
    }
    if (!$code) return null;

    $stmt = $conn->prepare('SELECT subject_category_id FROM subject_categories WHERE category_code = :code AND is_deleted = 0 AND is_active = 1 LIMIT 1');
    $stmt->execute([':code' => $code]);
    $id = $stmt->fetchColumn();
    return $id === false ? null : (int)$id;
}
?>
