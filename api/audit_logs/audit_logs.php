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
require_once __DIR__ . '/../utils/account_identity_queries.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

$operation = $_GET['operation'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? '';

if ($operation === '' && $method === 'GET') {
    $operation = 'getAuditLogs';
}

/*
 * The full audit log remains admin-only. A signed-in user may request a
 * reduced view of their own actions for the Profile > My activities panel.
 */
if ($operation === 'getMyAuditLogs') {
    $session = auth_require();
    try {
        getMyAuditLogs(
            $conn,
            (int)($session['user_id'] ?? 0),
            (string)($_SESSION['username'] ?? '')
        );
    } catch (Throwable $e) {
        respond(['success' => false, 'message' => 'Unable to load your activity.'], 500);
    }
}

// A public profile may show a reduced, activity-only timeline. Keep this
// separate from the admin audit log and never return raw old/new values.
if ($operation === 'getPublicUserActivities') {
    $session = auth_require();
    try {
        getPublicUserActivities($conn);
    } catch (Throwable $e) {
        respond(['success' => false, 'message' => 'Unable to load profile activity.'], 500);
    }
}

$session = auth_require_roles(['admin']);

try {
    switch ($operation) {
        case 'getAuditLogs':
            getAuditLogs($conn);
            break;
        case 'getAuditLogById':
            getAuditLogById($conn);
            break;
        case 'getAuditLogFilters':
            getAuditLogFilters($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getMyAuditLogs(PDO $conn, int $userId, string $username = ''): void {
    if ($userId <= 0) {
        respond(['success' => false, 'message' => 'Not authenticated.'], 401);
    }

    $limit = max(1, min(50, (int)($_GET['limit'] ?? 10)));
    $offset = max(0, (int)($_GET['offset'] ?? 0));
    // Sign-in/sign-out history belongs to Settings > Account security. Keep
    // it out of the personal activity feed so audit and account history stay
    // easy to understand.
    $where = "user_id = :user_id AND action NOT IN ('LOGIN', 'LOGOUT')";

    $stmt = $conn->prepare(
        'SELECT audit_id, table_name, record_id, action, event_type, status, reason_code,
                target_type, metadata, old_values, new_values, action_time, user_agent
         FROM audit_logs
         WHERE ' . $where . '
         ORDER BY action_time DESC, audit_id DESC
         LIMIT :limit OFFSET :offset'
    );
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    // Fetch one extra row so the profile can reveal whether another page exists.
    $stmt->bindValue(':limit', $limit + 1, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();

    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $hasMore = count($rows) > $limit;
    if ($hasMore) {
        $rows = array_slice($rows, 0, $limit);
    }

    // Resolve role IDs into names before the self-audit reaches the browser.
    // This keeps entries like role_id=9 readable without exposing a second lookup.
    $roleIds = [];
    foreach ($rows as $row) {
        foreach (['old_values', 'new_values'] as $valueKey) {
            $values = json_decode((string)($row[$valueKey] ?? ''), true);
            if (is_array($values) && isset($values['role_id']) && is_numeric($values['role_id'])) {
                $roleIds[] = (int)$values['role_id'];
            }
        }
    }

    $roleNames = [];
    $roleIds = array_values(array_unique(array_filter($roleIds, static fn($id) => $id > 0)));
    if ($roleIds) {
        $placeholders = implode(',', array_fill(0, count($roleIds), '?'));
        $roleStmt = $conn->prepare("SELECT role_id, role_name FROM roles WHERE role_id IN ({$placeholders})");
        foreach ($roleIds as $index => $roleId) {
            $roleStmt->bindValue($index + 1, $roleId, PDO::PARAM_INT);
        }
        $roleStmt->execute();
        foreach ($roleStmt->fetchAll(PDO::FETCH_ASSOC) as $role) {
            $roleNames[(int)$role['role_id']] = (string)$role['role_name'];
        }
    }

    foreach ($rows as &$row) {
        foreach (['old_values', 'new_values', 'metadata'] as $valueKey) {
            $values = json_decode((string)($row[$valueKey] ?? ''), true);
            if (!is_array($values)) {
                $row[$valueKey] = null;
                continue;
            }
            if (isset($values['role_id']) && isset($roleNames[(int)$values['role_id']])) {
                $values['role_name'] = $values['role_name'] ?? $roleNames[(int)$values['role_id']];
            }
            $row[$valueKey] = $values;
        }
        $row['old_values'] = audit_sanitize_map((array)($row['old_values'] ?? []));
        $row['new_values'] = audit_sanitize_map((array)($row['new_values'] ?? []));
        $row['metadata'] = audit_sanitize_map((array)($row['metadata'] ?? []));
    }
    unset($row);

    respond([
        'success' => true,
        'data' => $rows,
        'has_more' => $hasMore
    ]);
}

function getPublicUserActivities(PDO $conn): void {
    $userId = (int)($_GET['user_id'] ?? 0);
    if ($userId <= 0) {
        respond(['success' => false, 'message' => 'A valid profile user is required.'], 422);
    }

    $profileStmt = $conn->prepare(
        'SELECT user_id
         FROM (' . user_identity_derived_sql() . ') u
         WHERE u.user_id = :user_id
           AND u.is_active = 1
           AND u.is_deleted = 0
         LIMIT 1'
    );
    $profileStmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $profileStmt->execute();
    if (!$profileStmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Profile not found.'], 404);
    }

    $limit = max(1, min(30, (int)($_GET['limit'] ?? 10)));
    $offset = max(0, (int)($_GET['offset'] ?? 0));
    $entityLabels = [
        'grades' => ['label' => 'grade', 'icon' => 'fa-chart-line'],
        'final_grades' => ['label' => 'final grade', 'icon' => 'fa-chart-line'],
        'attendance' => ['label' => 'attendance record', 'icon' => 'fa-calendar-check'],
        'announcements' => ['label' => 'post', 'icon' => 'fa-bullhorn'],
        'interventions' => ['label' => 'intervention', 'icon' => 'fa-hand-holding-heart'],
        'enrollments' => ['label' => 'enrollment', 'icon' => 'fa-user-plus'],
        'report_cards' => ['label' => 'report card', 'icon' => 'fa-file-lines'],
        'risk_assessments' => ['label' => 'risk assessment', 'icon' => 'fa-triangle-exclamation'],
        'class_records' => ['label' => 'class record', 'icon' => 'fa-book'],
        'class_offerings' => ['label' => 'class offering', 'icon' => 'fa-chalkboard-user'],
        'class_schedules' => ['label' => 'class schedule', 'icon' => 'fa-calendar-days'],
    ];
    $tableNames = array_keys($entityLabels);
    $tablePlaceholders = implode(',', array_map(
        static fn (int $index): string => ':activity_table_' . $index,
        array_keys($tableNames)
    ));

    $stmt = $conn->prepare(
        'SELECT a.audit_id, a.table_name, a.action, a.action_time,
                COALESCE(
                    NULLIF(TRIM(CONCAT_WS(\' \', e.first_name, e.last_name)), \'\'),
                    NULLIF(TRIM(CONCAT_WS(\' \', l.first_name, l.last_name)), \'\'),
                    u.username,
                    CONCAT(\'User #\', a.user_id)
                ) AS actor_name
         FROM audit_logs a
         LEFT JOIN (' . user_identity_derived_sql() . ') u ON u.user_id = a.user_id
         LEFT JOIN employees e ON e.user_id = a.user_id AND e.is_deleted = 0
         LEFT JOIN learners l ON l.user_id = a.user_id AND l.is_deleted = 0
         WHERE a.user_id = :user_id
           AND a.action NOT IN (\'LOGIN\', \'LOGOUT\')
           AND a.table_name IN (' . $tablePlaceholders . ')
         ORDER BY a.action_time DESC, a.audit_id DESC
         LIMIT :limit OFFSET :offset'
    );
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    foreach ($tableNames as $index => $tableName) {
        $stmt->bindValue(':activity_table_' . $index, $tableName, PDO::PARAM_STR);
    }
    $stmt->bindValue(':limit', $limit + 1, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();

    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $hasMore = count($rows) > $limit;
    if ($hasMore) $rows = array_slice($rows, 0, $limit);

    $activities = array_map(static function (array $row) use ($entityLabels): array {
        $tableName = (string)($row['table_name'] ?? '');
        $entity = $entityLabels[$tableName] ?? ['label' => 'account activity', 'icon' => 'fa-clock-rotate-left'];
        $actorName = trim((string)($row['actor_name'] ?? 'User')) ?: 'User';
        $action = strtoupper(trim((string)($row['action'] ?? '')));
        $verb = match ($action) {
            'INSERT', 'CREATE' => 'added',
            'DELETE', 'REMOVE' => 'removed',
            default => 'updated',
        };
        $tone = match ($action) {
            'INSERT', 'CREATE' => 'is-added',
            'DELETE', 'REMOVE' => 'is-removed',
            'UPDATE' => 'is-updated',
            default => 'is-recorded',
        };

        return [
            'audit_id' => (int)($row['audit_id'] ?? 0),
            'message' => $actorName . ' ' . $verb . ' ' . $entity['label'],
            'entity' => ucwords($entity['label']),
            'icon' => $entity['icon'],
            'tone' => $tone,
            'action_time' => $row['action_time'] ?? null,
        ];
    }, $rows);

    respond(['success' => true, 'data' => $activities, 'has_more' => $hasMore]);
}

function audit_enrich_role_names(PDO $conn, array &$rows): void {
    $roleIds = [];
    foreach ($rows as $row) {
        foreach (['old_values', 'new_values'] as $valueKey) {
            $values = json_decode((string)($row[$valueKey] ?? ''), true);
            if (is_array($values) && isset($values['role_id']) && is_numeric($values['role_id'])) {
                $roleIds[] = (int)$values['role_id'];
            }
        }
    }

    $roleIds = array_values(array_unique(array_filter($roleIds, static fn ($id) => $id > 0)));
    if (!$roleIds) return;

    $placeholders = implode(',', array_fill(0, count($roleIds), '?'));
    $roleStmt = $conn->prepare("SELECT role_id, role_name FROM roles WHERE role_id IN ({$placeholders})");
    foreach ($roleIds as $index => $roleId) {
        $roleStmt->bindValue($index + 1, $roleId, PDO::PARAM_INT);
    }
    $roleStmt->execute();
    $roleNames = [];
    foreach ($roleStmt->fetchAll(PDO::FETCH_ASSOC) as $role) {
        $roleNames[(int)$role['role_id']] = (string)$role['role_name'];
    }

    foreach ($rows as &$row) {
        foreach (['old_values', 'new_values'] as $valueKey) {
            $values = json_decode((string)($row[$valueKey] ?? ''), true);
            if (!is_array($values)) continue;
            $roleId = isset($values['role_id']) && is_numeric($values['role_id']) ? (int)$values['role_id'] : 0;
            if ($roleId > 0 && isset($roleNames[$roleId])) {
                $values['role_name'] = $values['role_name'] ?? $roleNames[$roleId];
                $row[$valueKey] = json_encode_utf8($values);
            }
        }
    }
    unset($row);
}

function getAuditLogs(PDO $conn): void {
    $page = max(1, (int)($_GET['page'] ?? 1));
    $perPage = max(1, min(100, (int)($_GET['perPage'] ?? 20)));
    $offset = ($page - 1) * $perPage;

    // Authentication history is intentionally presented in Account security,
    // not in the administrator's general activity audit.
    $where = ["a.action NOT IN ('LOGIN', 'LOGOUT')"];
    $params = [];

    // Filter by table_name
    if (!empty($_GET['table_name'])) {
        $where[] = 'a.table_name = :table_name';
        $params[':table_name'] = $_GET['table_name'];
    }

    // Filter by action
    if (!empty($_GET['action'])) {
        $where[] = 'a.action = :action';
        $params[':action'] = $_GET['action'];
    }

    // Filter by outcome and event family.
    if (!empty($_GET['status'])) {
        $where[] = 'a.status = :status';
        $params[':status'] = strtoupper((string)$_GET['status']);
    }
    if (!empty($_GET['event_type'])) {
        $where[] = 'a.event_type = :event_type';
        $params[':event_type'] = strtoupper((string)$_GET['event_type']);
    }

    // The plain-language feed uses a small set of stable activity groups.
    // Keep the mapping server-side so chips cannot turn into arbitrary SQL.
    $category = strtolower(trim((string)($_GET['category'] ?? '')));
    $categories = [
        'needs_attention' => "(a.status IN ('FAILURE', 'DENIED') OR a.action IN ('DELETE', 'ACCESS', 'SESSION', 'REPORT', 'DEACTIVATION_REQUEST'))",
        'changes' => "a.action IN ('CREATE', 'INSERT', 'UPDATE', 'PASSWORD_CHANGE', 'PASSWORD_RESET')",
        'deletions' => "a.action = 'DELETE'",
        'exports' => "a.action = 'EXPORT'",
    ];
    if (isset($categories[$category])) {
        $where[] = $categories[$category];
    }

    // Filter by user_id
    if (!empty($_GET['user_id'])) {
        $where[] = 'a.user_id = :user_id';
        $params[':user_id'] = (int)$_GET['user_id'];
    }

    // Filter by date range
    if (!empty($_GET['date_from'])) {
        $where[] = 'a.action_time >= :date_from';
        $params[':date_from'] = $_GET['date_from'] . ' 00:00:00';
    }
    if (!empty($_GET['date_to'])) {
        $where[] = 'a.action_time <= :date_to';
        $params[':date_to'] = $_GET['date_to'] . ' 23:59:59';
    }

    // Search
    if (!empty($_GET['search'])) {
        $where[] = "(u.username LIKE :search_username OR a.table_name LIKE :search_table OR a.action LIKE :search_action
                     OR a.status LIKE :search_status OR a.reason_code LIKE :search_reason
                     OR a.principal_hint LIKE :search_principal OR a.old_values LIKE :search_old
                     OR a.new_values LIKE :search_new OR a.metadata LIKE :search_metadata
                     OR EXISTS (SELECT 1 FROM employees search_employee
                                WHERE search_employee.user_id = a.user_id
                                  AND search_employee.is_deleted = 0
                                  AND CONCAT_WS(' ', search_employee.first_name, search_employee.last_name) LIKE :search_employee)
                     OR EXISTS (SELECT 1 FROM learners search_learner
                                WHERE search_learner.user_id = a.user_id
                                  AND search_learner.is_deleted = 0
                                  AND CONCAT_WS(' ', search_learner.first_name, search_learner.last_name) LIKE :search_learner)
                     OR CONCAT_WS(' ', matched_employee.first_name, matched_employee.last_name) LIKE :search_matched_employee
                     OR CONCAT_WS(' ', matched_learner.first_name, matched_learner.last_name) LIKE :search_matched_learner)";
        $params[':search_username'] = '%' . $_GET['search'] . '%';
        $params[':search_table'] = '%' . $_GET['search'] . '%';
        $params[':search_action'] = '%' . $_GET['search'] . '%';
        $params[':search_status'] = '%' . $_GET['search'] . '%';
        $params[':search_reason'] = '%' . $_GET['search'] . '%';
        $params[':search_principal'] = '%' . $_GET['search'] . '%';
        $params[':search_old'] = '%' . $_GET['search'] . '%';
        $params[':search_new'] = '%' . $_GET['search'] . '%';
        $params[':search_metadata'] = '%' . $_GET['search'] . '%';
        $params[':search_employee'] = '%' . $_GET['search'] . '%';
        $params[':search_learner'] = '%' . $_GET['search'] . '%';
        $params[':search_matched_employee'] = '%' . $_GET['search'] . '%';
        $params[':search_matched_learner'] = '%' . $_GET['search'] . '%';
    }

    $whereClause = implode(' AND ', $where);

    // Get total count
    $countSql = "SELECT COUNT(*)
                 FROM audit_logs a
                 LEFT JOIN (" . user_identity_derived_sql() . ") u ON a.user_id = u.user_id
                 LEFT JOIN (" . user_identity_derived_sql() . ") matched_identity
                        ON a.user_id IS NULL
                       AND a.action = 'LOGIN'
                       AND a.status = 'FAILURE'
                       AND a.principal_hash = SHA2(LOWER(matched_identity.username), 256)
                 LEFT JOIN employees matched_employee
                        ON matched_employee.user_id = matched_identity.user_id
                       AND matched_employee.is_deleted = 0
                 LEFT JOIN learners matched_learner
                        ON matched_learner.user_id = matched_identity.user_id
                       AND matched_learner.is_deleted = 0
                 WHERE {$whereClause}";
    $stmt = $conn->prepare($countSql);
    foreach ($params as $key => $val) {
        $stmt->bindValue($key, $val);
    }
    $stmt->execute();
    $totalRecords = (int)$stmt->fetchColumn();

    // Get paginated results
    $sql = "SELECT a.audit_id, a.user_id, u.username,
                   COALESCE(
                       NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), ''),
                       NULLIF(TRIM(CONCAT_WS(' ', l.first_name, l.last_name)), ''),
                       u.username,
                       CONCAT('User #', a.user_id)
                   ) AS actor_name,
                   NULLIF(TRIM(COALESCE(
                       NULLIF(TRIM(CONCAT_WS(' ', matched_employee.first_name, matched_employee.last_name)), ''),
                       NULLIF(TRIM(CONCAT_WS(' ', matched_learner.first_name, matched_learner.last_name)), ''),
                       matched_identity.username
                   )), '') AS matched_account_name,
                   a.table_name, a.record_id,
                   a.action, a.event_type, a.status, a.reason_code, a.target_type,
                   a.metadata, a.old_values, a.new_values, a.action_time, a.ip_address,
                   a.user_agent, a.principal_hint, a.request_id
            FROM audit_logs a
            LEFT JOIN (" . user_identity_derived_sql() . ") u ON a.user_id = u.user_id
            LEFT JOIN employees e ON e.user_id = a.user_id AND e.is_deleted = 0
            LEFT JOIN learners l ON l.user_id = a.user_id AND l.is_deleted = 0
            LEFT JOIN (" . user_identity_derived_sql() . ") matched_identity
                   ON a.user_id IS NULL
                  AND a.action = 'LOGIN'
                  AND a.status = 'FAILURE'
                  AND a.principal_hash = SHA2(LOWER(matched_identity.username), 256)
            LEFT JOIN employees matched_employee
                   ON matched_employee.user_id = matched_identity.user_id
                  AND matched_employee.is_deleted = 0
            LEFT JOIN learners matched_learner
                   ON matched_learner.user_id = matched_identity.user_id
                  AND matched_learner.is_deleted = 0
            WHERE {$whereClause}
            ORDER BY a.action_time DESC, a.audit_id DESC
            LIMIT :limit OFFSET :offset";
    $stmt = $conn->prepare($sql);
    foreach ($params as $key => $val) {
        $stmt->bindValue($key, $val);
    }
    $stmt->bindValue(':limit', $perPage, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();
    $records = $stmt->fetchAll(PDO::FETCH_ASSOC);
    audit_enrich_role_names($conn, $records);
    foreach ($records as &$record) {
        foreach (['old_values', 'new_values', 'metadata'] as $valueKey) {
            $values = json_decode((string)($record[$valueKey] ?? ''), true);
            $record[$valueKey] = is_array($values) ? json_encode_utf8(audit_sanitize_map($values)) : null;
        }
    }
    unset($record);

    // Keep the small summary independent from the current page so it remains
    // useful even when the first page only contains routine activity.
    $summaryStmt = $conn->query(
        "SELECT
            SUM(CASE WHEN action = 'LOGIN' AND status = 'FAILURE' THEN 1 ELSE 0 END) AS failed_sign_ins,
            SUM(CASE WHEN action = 'DELETE' THEN 1 ELSE 0 END) AS deletions,
            SUM(CASE WHEN action IN ('ACCESS', 'SESSION')
                       OR reason_code LIKE '%PERMISSION%'
                     THEN 1 ELSE 0 END) AS permission_changes,
            SUM(CASE WHEN action = 'REPORT' THEN 1 ELSE 0 END) AS reported_posts
         FROM audit_logs
         WHERE action_time >= DATE_SUB(NOW(), INTERVAL 30 DAY)
           AND action NOT IN ('LOGIN', 'LOGOUT')"
    );
    $summary = $summaryStmt->fetch(PDO::FETCH_ASSOC) ?: [];

    respond([
        'success' => true,
        'data' => $records,
        'quick_look' => [
            'failed_sign_ins' => (int)($summary['failed_sign_ins'] ?? 0),
            'deletions' => (int)($summary['deletions'] ?? 0),
            'permission_changes' => (int)($summary['permission_changes'] ?? 0),
            'reported_posts' => (int)($summary['reported_posts'] ?? 0),
            'window' => 'last 30 days'
        ],
        'pagination' => [
            'page' => $page,
            'perPage' => $perPage,
            'totalRecords' => $totalRecords,
            'totalPages' => max(1, (int)ceil($totalRecords / $perPage))
        ]
    ]);
}

function getAuditLogById(PDO $conn): void {
    $id = (int)($_GET['audit_id'] ?? 0);
    if (!$id) {
        respond(['success' => false, 'message' => 'audit_id is required'], 422);
    }

    $stmt = $conn->prepare(
        'SELECT a.audit_id, a.user_id, u.username,
                COALESCE(
                    NULLIF(TRIM(CONCAT_WS(\' \', e.first_name, e.last_name)), \'\'),
                    NULLIF(TRIM(CONCAT_WS(\' \', l.first_name, l.last_name)), \'\'),
                    u.username,
                    CONCAT(\'User #\', a.user_id)
                ) AS actor_name,
                a.table_name, a.record_id,
                a.action, a.event_type, a.status, a.reason_code, a.target_type,
                a.metadata, a.old_values, a.new_values, a.action_time, a.ip_address,
                a.user_agent, a.principal_hint, a.request_id
         FROM audit_logs a
         LEFT JOIN (' . user_identity_derived_sql() . ') u ON a.user_id = u.user_id
         LEFT JOIN employees e ON e.user_id = a.user_id AND e.is_deleted = 0
         LEFT JOIN learners l ON l.user_id = a.user_id AND l.is_deleted = 0
         WHERE a.audit_id = :audit_id
           AND a.action NOT IN (\'LOGIN\', \'LOGOUT\')'
    );
    $stmt->bindValue(':audit_id', $id, PDO::PARAM_INT);
    $stmt->execute();
    $record = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$record) {
        respond(['success' => false, 'message' => 'Audit log not found'], 404);
    }

    $recordRows = [$record];
    audit_enrich_role_names($conn, $recordRows);
    $record = $recordRows[0];

    foreach (['old_values', 'new_values', 'metadata'] as $valueKey) {
        $values = json_decode((string)($record[$valueKey] ?? ''), true);
        $record[$valueKey] = is_array($values) ? json_encode_utf8(audit_sanitize_map($values)) : null;
    }

    respond(['success' => true, 'data' => $record]);
}

function getAuditLogFilters(PDO $conn): void {
    // Get distinct table names
    $stmt = $conn->query("SELECT DISTINCT table_name FROM audit_logs WHERE action NOT IN ('LOGIN', 'LOGOUT') ORDER BY table_name");
    $tables = $stmt->fetchAll(PDO::FETCH_COLUMN);

    // Get distinct actions
    $stmt = $conn->query("SELECT DISTINCT action FROM audit_logs WHERE action NOT IN ('LOGIN', 'LOGOUT') ORDER BY action");
    $actions = $stmt->fetchAll(PDO::FETCH_COLUMN);

    $stmt = $conn->query("SELECT DISTINCT status FROM audit_logs WHERE action NOT IN ('LOGIN', 'LOGOUT') ORDER BY status");
    $statuses = $stmt->fetchAll(PDO::FETCH_COLUMN);

    $stmt = $conn->query("SELECT DISTINCT event_type FROM audit_logs WHERE action NOT IN ('LOGIN', 'LOGOUT') ORDER BY event_type");
    $eventTypes = $stmt->fetchAll(PDO::FETCH_COLUMN);

    // Get distinct users
    $stmt = $conn->query(
        'SELECT DISTINCT a.user_id,
                COALESCE(
                    NULLIF(TRIM(CONCAT_WS(\' \', e.first_name, e.last_name)), \'\'),
                    NULLIF(TRIM(CONCAT_WS(\' \', l.first_name, l.last_name)), \'\'),
                    u.username,
                    CONCAT(\'User #\', a.user_id)
                ) AS actor_name,
                u.username
         FROM audit_logs a
         LEFT JOIN (' . user_identity_derived_sql() . ') u ON a.user_id = u.user_id
         LEFT JOIN employees e ON e.user_id = a.user_id AND e.is_deleted = 0
         LEFT JOIN learners l ON l.user_id = a.user_id AND l.is_deleted = 0
         WHERE a.user_id IS NOT NULL
           AND a.action NOT IN (\'LOGIN\', \'LOGOUT\')
         ORDER BY actor_name'
    );
    $users = $stmt->fetchAll(PDO::FETCH_ASSOC);

    respond([
        'success' => true,
        'tables' => $tables,
        'actions' => $actions,
        'statuses' => $statuses,
        'event_types' => $eventTypes,
        'users' => $users
    ]);
}
?>
