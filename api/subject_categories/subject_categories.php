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
require_once __DIR__ . '/../utils/unique_name_validation.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

$operation = $_GET['operation'] ?? '';
$operation = (['archiveSubjectCategory' => 'deleteSubjectCategory'])[$operation] ?? $operation;
$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($operation === '' && $method === 'GET') {
    $operation = 'getAllSubjectCategories';
}

auth_enforce_roles($operation, ['admin', 'teacher'], ['admin']);

try {
    switch ($operation) {
        case 'getAllSubjectCategories':
            getAllSubjectCategories($conn);
            break;
        case 'createSubjectCategory':
            createSubjectCategory($conn);
            break;
        case 'updateSubjectCategory':
            updateSubjectCategory($conn);
            break;
        case 'reorderSubjectCategories':
            reorderSubjectCategories($conn);
            break;
        case 'deleteSubjectCategory':
            deleteSubjectCategory($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (PDOException $e) {
    if ((string)$e->getCode() === '23000') {
        respond([
            'success' => false,
            'message' => 'Subject category name or code already exists. Choose a different value.',
            'errors' => ['category_name' => 'Subject category name or code already exists.']
        ], 422);
    }
    error_log('Subject categories API database error: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to save the subject category. Please try again.'], 500);
} catch (Exception $e) {
    error_log('Subject categories API error: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to save the subject category. Please try again.'], 500);
}

function getAllSubjectCategories(PDO $conn): void {
    $activeOnly = filter_var($_GET['active_only'] ?? false, FILTER_VALIDATE_BOOLEAN);
    $where = 'is_deleted = 0' . ($activeOnly ? ' AND is_active = 1' : '');
    $stmt = $conn->query(
        'SELECT subject_category_id, category_code, category_name, description,
                sort_order, is_active, is_deleted, deleted_at
         FROM subject_categories
         WHERE ' . $where . '
         ORDER BY sort_order, category_name, subject_category_id'
    );
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function normalizeSubjectCategoryName($value): string {
    $name = trim((string)($value ?? ''));
    if ($name === '') {
        respond(['success' => false, 'message' => 'Category name is required.', 'errors' => ['category_name' => 'Category name is required.']], 422);
    }
    if (function_exists('mb_strlen') ? mb_strlen($name) > 150 : strlen($name) > 150) {
        respond(['success' => false, 'message' => 'Category name must be 150 characters or fewer.', 'errors' => ['category_name' => 'Category name is too long.']], 422);
    }
    return $name;
}

function normalizeSubjectCategoryCode(string $name): string {
    $code = strtoupper(trim((string)preg_replace('/[^A-Za-z0-9]+/', '_', $name), '_'));
    return substr($code !== '' ? $code : 'SUBJECT_CATEGORY', 0, 60);
}

function createSubjectCategory(PDO $conn): void {
    $data = getJsonInput();
    $name = normalizeSubjectCategoryName($data['category_name'] ?? null);
    if (unique_name_exists($conn, 'subject_categories', 'category_name', $name)) {
        respond(unique_name_error_payload('category_name', 'Subject category name'), 422);
    }

    $code = normalizeSubjectCategoryCode($name);
    $codeCheck = $conn->prepare('SELECT subject_category_id FROM subject_categories WHERE category_code = :code LIMIT 1');
    $codeCheck->execute([':code' => $code]);
    if ($codeCheck->fetchColumn()) {
        $code .= '_' . substr((string)time(), -6);
    }

    $sortValue = $data['sort_order'] ?? null;
    if ($sortValue === '' || $sortValue === null) {
        $nextOrder = $conn->query('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM subject_categories WHERE is_deleted = 0')->fetchColumn();
        $sortOrder = max(1, (int)$nextOrder);
    } else {
        $sortOrder = max(0, (int)$sortValue);
    }
    $stmt = $conn->prepare(
        'INSERT INTO subject_categories
            (category_code, category_name, description, sort_order, is_active)
         VALUES (:code, :name, :description, :sort_order, :is_active)'
    );
    $stmt->execute([
        ':code' => $code,
        ':name' => $name,
        ':description' => trim((string)($data['description'] ?? '')) ?: null,
        ':sort_order' => $sortOrder,
        ':is_active' => 1,
    ]);
    respond(['success' => true, 'message' => 'Subject category created', 'subject_category_id' => $conn->lastInsertId()]);
}

function updateSubjectCategory(PDO $conn): void {
    $data = getJsonInput();
    $id = filter_var($data['subject_category_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if (!$id) {
        respond(['success' => false, 'message' => 'Subject category ID is required.'], 422);
    }
    $name = normalizeSubjectCategoryName($data['category_name'] ?? null);
    if (unique_name_exists($conn, 'subject_categories', 'category_name', $name, 'subject_category_id', $id)) {
        respond(unique_name_error_payload('category_name', 'Subject category name'), 422);
    }
    $current = $conn->prepare('SELECT subject_category_id, sort_order FROM subject_categories WHERE subject_category_id = :id AND is_deleted = 0 LIMIT 1');
    $current->execute([':id' => $id]);
    $currentRow = $current->fetch(PDO::FETCH_ASSOC);
    if (!$currentRow) {
        respond(['success' => false, 'message' => 'Subject category not found.'], 404);
    }

    $sortValue = $data['sort_order'] ?? null;
    $sortOrder = $sortValue === '' || $sortValue === null
        ? (int)$currentRow['sort_order']
        : max(0, (int)$sortValue);
    $stmt = $conn->prepare(
        'UPDATE subject_categories
         SET category_name = :name,
             description = :description,
             sort_order = :sort_order,
             is_active = 1
         WHERE subject_category_id = :id AND is_deleted = 0'
    );
    $stmt->execute([
        ':name' => $name,
        ':description' => trim((string)($data['description'] ?? '')) ?: null,
        ':sort_order' => $sortOrder,
        ':id' => $id,
    ]);
    respond(['success' => true, 'message' => 'Subject category updated']);
}

function reorderSubjectCategories(PDO $conn): void {
    $data = getJsonInput();
    $rawOrder = $data['order'] ?? null;
    if (!is_array($rawOrder) || !$rawOrder) {
        respond(['success' => false, 'message' => 'Category order is required.'], 422);
    }

    $orderedIds = [];
    foreach ($rawOrder as $value) {
        $id = filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!$id || in_array($id, $orderedIds, true)) {
            respond(['success' => false, 'message' => 'Category order contains an invalid or duplicate category.'], 422);
        }
        $orderedIds[] = (int)$id;
    }

    $existingRows = $conn->query(
        'SELECT subject_category_id
         FROM subject_categories
         WHERE is_deleted = 0
         ORDER BY sort_order, category_name, subject_category_id'
    )->fetchAll(PDO::FETCH_COLUMN);
    $existingIds = array_map('intval', $existingRows);
    sort($existingIds);
    $submittedIds = $orderedIds;
    sort($submittedIds);
    if ($existingIds !== $submittedIds) {
        respond(['success' => false, 'message' => 'The category list changed. Reload the page and try again.'], 409);
    }

    $conn->beginTransaction();
    try {
        $stmt = $conn->prepare(
            'UPDATE subject_categories
             SET sort_order = :sort_order
             WHERE subject_category_id = :id AND is_deleted = 0'
        );
        foreach ($orderedIds as $index => $id) {
            $stmt->execute([
                ':sort_order' => $index + 1,
                ':id' => $id,
            ]);
        }
        $conn->commit();
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }

    respond(['success' => true, 'message' => 'Subject category order saved.']);
}

function deleteSubjectCategory(PDO $conn): void {
    $data = getJsonInput();
    $id = filter_var($data['subject_category_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if (!$id) {
        respond(['success' => false, 'message' => 'Subject category ID is required.'], 422);
    }

    $usage = $conn->prepare('SELECT COUNT(*) FROM subjects WHERE subject_category_id = :id AND is_deleted = 0');
    $usage->execute([':id' => $id]);
    if ((int)$usage->fetchColumn() > 0) {
        respond(['success' => false, 'message' => 'This category is assigned to active subjects. Reclassify those subjects before archiving the category.'], 409);
    }

    $stmt = $conn->prepare('UPDATE subject_categories SET is_deleted = 1, deleted_at = NOW(), is_active = 0 WHERE subject_category_id = :id AND is_deleted = 0');
    $stmt->execute([':id' => $id]);
    if ($stmt->rowCount() < 1) {
        respond(['success' => false, 'message' => 'Subject category not found.'], 404);
    }
    respond(['success' => true, 'message' => 'Subject category archived']);
}
?>
