<?php
/**
 * Registrar read-only view of returnee enrollments.
 * The source import is authoritative; this endpoint does not approve, reject,
 * or rewrite the enrollment classification.
 */
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../utils/cors.php';
require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';

function rr_respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function rr_text($value, int $max = 100): ?string {
    $text = trim((string)($value ?? ''));
    if ($text === '') return null;
    return function_exists('mb_substr') ? mb_substr($text, 0, $max) : substr($text, 0, $max);
}

function rr_require_column(PDO $conn): void {
    $stmt = $conn->query("SHOW COLUMNS FROM enrollments LIKE 'entry_classification'");
    if (!$stmt->fetch(PDO::FETCH_ASSOC)) {
        rr_respond([
            'success' => false,
            'code' => 'RETURNEE_MIGRATION_REQUIRED',
            'message' => 'Enrollment classification is not installed. Apply add_returnee_import_workflow.sql first.'
        ], 503);
    }
}

function rr_base_sql(): string {
    return 'SELECT e.enrollment_id, e.learner_id, e.school_year_id, e.grade_level_id,
                   e.section_id, e.enrollment_date, e.enrollment_status,
                   e.entry_classification, e.enrollment_type_id,
                   sy.year_label, sy.year_start, gl.grade_name, sec.section_name,
                   et.type_name AS enrollment_type_name, l.lrn,
                   COALESCE(NULLIF(TRIM(CONCAT_WS(" ", l.first_name, l.middle_name, l.last_name, l.name_extension)), ""), l.full_name_raw) AS learner_name,
                   l.date_of_birth, l.sex
            FROM enrollments e
            JOIN learners l ON l.learner_id = e.learner_id
            LEFT JOIN school_years sy ON sy.school_year_id = e.school_year_id
            LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
            LEFT JOIN sections sec ON sec.section_id = e.section_id
            LEFT JOIN enrollment_types et ON et.enrollment_type_id = e.enrollment_type_id
            WHERE e.is_deleted = 0 AND e.entry_classification = "Returnee"';
}

function rr_get_enrollments(PDO $conn): void {
    $status = rr_text($_GET['status'] ?? null, 40);
    $q = rr_text($_GET['q'] ?? null, 100);
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $limit = min(100, max(1, (int)($_GET['limit'] ?? 100)));
    $where = [];
    $params = [];
    if ($status !== null && strtolower($status) !== 'all') {
        $where[] = ' AND e.enrollment_status = :status';
        $params[':status'] = $status;
    }
    if ($schoolYearId > 0) {
        $where[] = ' AND e.school_year_id = :school_year_id';
        $params[':school_year_id'] = $schoolYearId;
    }
    if ($q !== null) {
        $where[] = ' AND (l.lrn LIKE :q OR l.first_name LIKE :q2 OR l.middle_name LIKE :q3
                    OR l.last_name LIKE :q4 OR l.full_name_raw LIKE :q5)';
        foreach ([':q', ':q2', ':q3', ':q4', ':q5'] as $key) $params[$key] = '%' . $q . '%';
    }
    $from = rr_base_sql() . implode('', $where);
    $count = $conn->prepare('SELECT COUNT(*) FROM (' . $from . ') x');
    foreach ($params as $key => $value) $count->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    $count->execute();
    $total = (int)$count->fetchColumn();

    $stmt = $conn->prepare($from . ' ORDER BY sy.year_start DESC, learner_name ASC LIMIT :limit');
    foreach ($params as $key => $value) $stmt->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$row) {
        $row['enrollment_id'] = (int)$row['enrollment_id'];
        $row['learner_id'] = (int)$row['learner_id'];
    }
    unset($row);
    rr_respond(['success' => true, 'rows' => $rows, 'total' => $total]);
}

function rr_get_enrollment(PDO $conn): void {
    $enrollmentId = (int)($_GET['enrollment_id'] ?? 0);
    if ($enrollmentId <= 0) rr_respond(['success' => false, 'message' => 'enrollment_id is required'], 422);
    $stmt = $conn->prepare(rr_base_sql() . ' AND e.enrollment_id = :id LIMIT 1');
    $stmt->bindValue(':id', $enrollmentId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) rr_respond(['success' => false, 'message' => 'Returnee enrollment not found'], 404);

    $historyStmt = $conn->prepare(
        'SELECT e.enrollment_id, sy.year_label, sy.year_start, gl.grade_name,
                sec.section_name, e.enrollment_status, e.entry_classification,
                et.type_name AS enrollment_type_name, e.enrollment_date
         FROM enrollments e
         LEFT JOIN school_years sy ON sy.school_year_id = e.school_year_id
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         LEFT JOIN sections sec ON sec.section_id = e.section_id
         LEFT JOIN enrollment_types et ON et.enrollment_type_id = e.enrollment_type_id
         WHERE e.learner_id = :learner_id AND e.is_deleted = 0
         ORDER BY sy.year_start DESC, e.enrollment_id DESC'
    );
    $historyStmt->bindValue(':learner_id', (int)$row['learner_id'], PDO::PARAM_INT);
    $historyStmt->execute();
    rr_respond(['success' => true, 'enrollment' => $row, 'history' => $historyStmt->fetchAll(PDO::FETCH_ASSOC)]);
}

$operation = (string)($_GET['operation'] ?? '');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;
$session = auth_enforce_roles($operation, ['registrar'], ['registrar']);

try {
    rr_require_column($conn);
    switch ($operation) {
        case 'getReturneeEnrollments': rr_get_enrollments($conn); break;
        case 'getReturneeEnrollment': rr_get_enrollment($conn); break;
        default: rr_respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Throwable $e) {
    rr_respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}
