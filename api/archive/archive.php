<?php
require_once __DIR__ . '/../utils/cors.php';
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/audit.php';
require_once __DIR__ . '/service.php';
header('Content-Type: application/json');
$session = auth_require_roles(['admin']);

function archive_response(array $data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data, JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

try {
    $modules = archive_modules($conn);
    $operation = $_GET['operation'] ?? 'list';
    if ($operation === 'modules') {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') archive_response(['success' => false, 'message' => 'Use GET.'], 405);
        $_SESSION['masterfile_archive_csrf'] ??= bin2hex(random_bytes(32));
        archive_response(['success' => true, 'modules' => $modules, 'csrf' => $_SESSION['masterfile_archive_csrf']]);
    }
    $table = $_GET['module'] ?? '';
    if (!isset($modules[$table])) archive_response(['success' => false, 'message' => 'Unknown masterfile archive.'], 404);
    $module = $modules[$table];
    if ($operation === 'restore') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') archive_response(['success' => false, 'message' => 'Use POST to restore.'], 405);
        $data = json_decode(file_get_contents('php://input'), true) ?: [];
        if (!isset($_SESSION['masterfile_archive_csrf']) || !is_string($data['csrf'] ?? null) || !hash_equals($_SESSION['masterfile_archive_csrf'], $data['csrf'])) {
            archive_response(['success' => false, 'message' => 'Refresh the archive and try again.'], 403);
        }
        if (!$module['restore']) archive_response(['success' => false, 'message' => 'Use the existing module editor to reinstate this record with its required validation.'], 409);
        $id = filter_var($data['id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!$id) archive_response(['success' => false, 'message' => 'A valid record ID is required.'], 422);
        archive_restore($conn, $table, $module, $id);
        $message = in_array($table, ['users', 'employees'], true)
            ? 'Staff account restored and reactivated.'
            : 'Record restored. Related archived records remain in their own archives.';
        archive_response(['success' => true, 'message' => $message]);
    }
    if ($operation !== 'list') archive_response(['success' => false, 'message' => 'Unknown operation.'], 400);
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') archive_response(['success' => false, 'message' => 'Use GET.'], 405);
    $search = substr(trim((string)($_GET['search'] ?? '')), 0, 120);
    $page = max(1, min(100000, (int)($_GET['page'] ?? 1)));
    $where = 'is_deleted = 1';
    // The staff Users masterfile excludes credential-free learner identities.
    if ($table === 'users') $where .= ' AND username IS NOT NULL';
    $params = [];
    if ($search !== '') {
        $searchPattern = '%' . $search . '%';
        $searchClauses = array_map(fn($field) => "CAST(`$field` AS CHAR) LIKE ?", $module['fields']);
        $params = array_fill(0, count($module['fields']), $searchPattern);
        if ($table === 'users') {
            $searchClauses[] = "EXISTS (
                SELECT 1
                FROM employees archive_employee_search
                WHERE archive_employee_search.user_id = users.user_id
                  AND CONCAT_WS(' ',
                      NULLIF(TRIM(archive_employee_search.first_name), ''),
                      NULLIF(TRIM(archive_employee_search.middle_name), ''),
                      NULLIF(TRIM(archive_employee_search.last_name), ''),
                      NULLIF(TRIM(archive_employee_search.name_extension), '')
                  ) LIKE ?
            )";
            $params[] = $searchPattern;
            $searchClauses[] = "EXISTS (
                SELECT 1
                FROM employees archive_position_search
                LEFT JOIN positions archive_position ON archive_position.position_id = archive_position_search.position_id
                WHERE archive_position_search.user_id = users.user_id
                  AND archive_position.position_name LIKE ?
            )";
            $params[] = $searchPattern;
        }
        $where .= ' AND (' . implode(' OR ', $searchClauses) . ')';
    }
    $count = $conn->prepare("SELECT COUNT(*) FROM `$table` WHERE $where");
    $count->execute($params);
    $total = (int)$count->fetchColumn();
    $page = min($page, max(1, (int)ceil($total / 8)));
    $offset = ($page - 1) * 8;
    $fields = implode(', ', array_map(fn($field) => "`$field`", $module['fields']));
    if ($table === 'users') {
        // Resolve the stored role even if the role itself has been archived.
        $fields .= ', (SELECT r.role_name FROM roles r WHERE r.role_id = users.role_id) AS role_name';
        // Users store the login name separately from the staff profile. Show the
        // linked person's full name in the archive instead of exposing username.
        $fields .= ", (SELECT NULLIF(TRIM(CONCAT_WS(' ',
            NULLIF(TRIM(e.first_name), ''),
            NULLIF(TRIM(e.middle_name), ''),
            NULLIF(TRIM(e.last_name), ''),
            NULLIF(TRIM(e.name_extension), '')
        )), '') FROM employees e WHERE e.user_id = users.user_id ORDER BY e.employee_id DESC LIMIT 1) AS full_name";
        $fields .= ", (SELECT p.position_name FROM employees e
            LEFT JOIN positions p ON p.position_id = e.position_id
            WHERE e.user_id = users.user_id
            ORDER BY e.employee_id DESC LIMIT 1) AS position_name";
    }
    $stmt = $conn->prepare("SELECT $fields FROM `$table` WHERE $where ORDER BY deleted_at DESC, `{$module['pk']}` DESC LIMIT 8 OFFSET $offset");
    $stmt->execute($params);
    archive_response(['success' => true, 'records' => $stmt->fetchAll(PDO::FETCH_ASSOC), 'total' => $total, 'page' => $page, 'pages' => max(1, (int)ceil($total / 8))]);
} catch (DomainException $e) {
    archive_response(['success' => false, 'message' => $e->getMessage()], 409);
} catch (PDOException $e) {
    error_log('Masterfile archive: ' . $e->getMessage());
    archive_response(['success' => false, 'message' => 'This record conflicts with current records or a database rule. Review the active masterfile before restoring.'], 409);
} catch (Throwable $e) {
    error_log('Masterfile archive: ' . $e->getMessage());
    archive_response(['success' => false, 'message' => 'Unable to complete the archive request. Please try again.'], 500);
}
