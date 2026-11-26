<?php
header('Content-Type: application/json; charset=utf-8');

require_once __DIR__ . '/../utils/cors.php';
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../services/GradingPolicyService.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function policyTableExists(PDO $conn): bool {
    $stmt = $conn->query("SHOW TABLES LIKE 'school_year_grade_policies'");
    return (bool)$stmt->fetch(PDO::FETCH_NUM);
}

$operation = $_GET['operation'] ?? '';
$session = auth_enforce_roles($operation, ['admin'], ['admin']);

try {
    switch ($operation) {
        case 'getGradingPolicies': getGradingPolicies($conn); break;
        case 'saveGradingPolicy': saveGradingPolicy($conn, $session); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Throwable $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getGradingPolicies(PDO $conn): void {
    $rows = [];
    $stmt = $conn->query(
        "SELECT sy.school_year_id, sy.year_label, sy.grading_system_type, sy.is_active,
                gl.grade_level_id, gl.grade_name,
                p.grading_mode AS configured_grading_mode,
                p.sf9_template_variant AS configured_sf9_template_variant
         FROM school_years sy
         CROSS JOIN grade_levels gl
         LEFT JOIN school_year_grade_policies p
           ON p.school_year_id = sy.school_year_id
          AND p.grade_level_id = gl.grade_level_id
          AND p.is_deleted = 0
         WHERE sy.is_deleted = 0
           AND gl.grade_level_id BETWEEN 1 AND 3
           AND gl.is_deleted = 0
         ORDER BY sy.year_start DESC, sy.school_year_id DESC, gl.grade_level_id ASC"
    );
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $fallback = GradingPolicyService::fallback((int)$row['grade_level_id'], $row['grade_name']);
        $rows[] = [
            'school_year_id' => (int)$row['school_year_id'],
            'year_label' => $row['year_label'],
            'grading_system_type' => $row['grading_system_type'],
            'is_active' => (int)$row['is_active'],
            'grade_level_id' => (int)$row['grade_level_id'],
            'grade_name' => $row['grade_name'],
            'grading_mode' => $row['configured_grading_mode'] ?: $fallback['grading_mode'],
            'sf9_template_variant' => $row['configured_sf9_template_variant'] ?: $fallback['sf9_template_variant'],
            'is_explicit' => $row['configured_grading_mode'] !== null,
        ];
    }
    respond(['success' => true, 'rows' => $rows]);
}

function saveGradingPolicy(PDO $conn, array $session): void {
    if (!policyTableExists($conn)) {
        respond(['success' => false, 'message' => 'Grading-policy migration has not been applied yet'], 503);
    }

    $data = getJsonInput();
    $schoolYearId = (int)($data['school_year_id'] ?? 0);
    $gradeLevelId = (int)($data['grade_level_id'] ?? 0);
    $mode = strtolower(trim((string)($data['grading_mode'] ?? 'numeric')));
    if ($schoolYearId <= 0 || $gradeLevelId < 1 || $gradeLevelId > 3) {
        respond(['success' => false, 'message' => 'A school year and Grade 1-3 are required'], 422);
    }
    if (!in_array($mode, ['numeric', 'descriptive'], true)) {
        respond(['success' => false, 'message' => 'Grading mode must be Numeric or Descriptive'], 422);
    }

    $check = $conn->prepare(
        'SELECT sy.school_year_id, gl.grade_name
         FROM school_years sy
         JOIN grade_levels gl ON gl.grade_level_id = :grade_level_id AND gl.is_deleted = 0
         WHERE sy.school_year_id = :school_year_id AND sy.is_deleted = 0
         LIMIT 1'
    );
    $check->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $check->bindValue(':grade_level_id', $gradeLevelId, PDO::PARAM_INT);
    $check->execute();
    $existing = $check->fetch(PDO::FETCH_ASSOC);
    if (!$existing) {
        respond(['success' => false, 'message' => 'School year or grade level not found'], 404);
    }

    $fallback = GradingPolicyService::fallback($gradeLevelId, $existing['grade_name']);
    $userId = (int)($session['user_id'] ?? 0) ?: null;
    $stmt = $conn->prepare(
        'INSERT INTO school_year_grade_policies
            (school_year_id, grade_level_id, grading_mode, sf9_template_variant, is_deleted, deleted_at)
         VALUES (:school_year_id, :grade_level_id, :grading_mode, :sf9_template_variant, 0, NULL)
         ON DUPLICATE KEY UPDATE
            grading_mode = VALUES(grading_mode),
            sf9_template_variant = VALUES(sf9_template_variant),
            is_deleted = 0,
            deleted_at = NULL'
    );
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':grade_level_id', $gradeLevelId, PDO::PARAM_INT);
    $stmt->bindValue(':grading_mode', ucfirst($mode));
    $stmt->bindValue(':sf9_template_variant', $fallback['sf9_template_variant']);
    $stmt->execute();

    respond([
        'success' => true,
        'message' => 'Grading policy saved',
        'school_year_id' => $schoolYearId,
        'grade_level_id' => $gradeLevelId,
        'grading_mode' => ucfirst($mode),
        'sf9_template_variant' => $fallback['sf9_template_variant'],
        'updated_by' => $userId,
    ]);
}
