<?php
header('Content-Type: application/json; charset=utf-8');

require_once __DIR__ . '/../utils/cors.php';
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../services/TemplateSchemaService.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function templateTablesExist(PDO $conn): bool {
    try {
        $stmt = $conn->query("SHOW TABLES LIKE 'report_card_templates'");
        return (bool)$stmt->fetch(PDO::FETCH_NUM);
    } catch (Throwable $_) {
        return false;
    }
}

function requireTemplateTables(PDO $conn): void {
    if (!templateTablesExist($conn)) {
        respond(['success' => false, 'message' => 'Apply create_dynamic_report_card_templates.sql before using the template builder.'], 503);
    }
}

$operation = $_GET['operation'] ?? '';
$session = auth_enforce_roles($operation, ['admin'], ['admin']);

try {
    switch ($operation) {
        case 'getTemplateBuilderData': getTemplateBuilderData($conn); break;
        case 'saveTemplate': saveTemplate($conn, $session); break;
        case 'duplicateTemplate': duplicateTemplate($conn, $session); break;
        case 'publishTemplate': publishTemplate($conn, $session); break;
        case 'assignTemplate': assignTemplate($conn, $session); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Throwable $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getTemplateBuilderData(PDO $conn): void {
    requireTemplateTables($conn);

    $templateStmt = $conn->query(
        'SELECT template_id, template_code, template_name, grade_scope, grading_mode,
                version_no, status, schema_json, created_at, updated_at
         FROM report_card_templates
         WHERE is_deleted = 0
         ORDER BY template_code ASC, version_no DESC, template_id DESC'
    );
    $templates = [];
    foreach ($templateStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $templates[] = [
            'template_id' => (int)$row['template_id'],
            'template_code' => (string)$row['template_code'],
            'template_name' => (string)$row['template_name'],
            'grade_scope' => (string)$row['grade_scope'],
            'grading_mode' => (string)$row['grading_mode'],
            'version_no' => (int)$row['version_no'],
            'status' => (string)$row['status'],
            'schema' => TemplateSchemaService::decode($row['schema_json'] ?? '', $row['grading_mode'] ?? 'Numeric'),
            'created_at' => $row['created_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }

    $schoolYears = $conn->query(
        'SELECT school_year_id, year_label, is_active
         FROM school_years
         WHERE is_deleted = 0
         ORDER BY year_start DESC, school_year_id DESC'
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];
    foreach ($schoolYears as &$schoolYear) {
        $schoolYear['school_year_id'] = (int)$schoolYear['school_year_id'];
        $schoolYear['is_active'] = (int)$schoolYear['is_active'];
    }
    unset($schoolYear);

    $gradeLevels = $conn->query(
        'SELECT grade_level_id, grade_name
         FROM grade_levels
         WHERE is_deleted = 0
         ORDER BY grade_level_id ASC'
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];
    foreach ($gradeLevels as &$gradeLevel) {
        $gradeLevel['grade_level_id'] = (int)$gradeLevel['grade_level_id'];
    }
    unset($gradeLevel);

    $assignments = $conn->query(
        'SELECT a.assignment_id, a.school_year_id, a.grade_level_id, a.template_id,
                sy.year_label, gl.grade_name,
                t.template_code, t.template_name, t.version_no, t.status
         FROM report_card_template_assignments a
         JOIN school_years sy ON sy.school_year_id = a.school_year_id AND sy.is_deleted = 0
         JOIN grade_levels gl ON gl.grade_level_id = a.grade_level_id AND gl.is_deleted = 0
         JOIN report_card_templates t ON t.template_id = a.template_id AND t.is_deleted = 0
         WHERE a.is_deleted = 0
         ORDER BY sy.year_start DESC, a.grade_level_id ASC'
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];
    foreach ($assignments as &$assignment) {
        foreach (['assignment_id', 'school_year_id', 'grade_level_id', 'template_id', 'version_no'] as $key) {
            $assignment[$key] = (int)$assignment[$key];
        }
    }
    unset($assignment);

    respond([
        'success' => true,
        'templates' => $templates,
        'school_years' => $schoolYears,
        'grade_levels' => $gradeLevels,
        'assignments' => $assignments,
    ]);
}

function saveTemplate(PDO $conn, array $session): void {
    requireTemplateTables($conn);
    $data = getJsonInput();
    $templateId = (int)($data['template_id'] ?? 0);
    $name = trim((string)($data['template_name'] ?? ''));
    $code = strtoupper(trim((string)($data['template_code'] ?? '')));
    $scope = trim((string)($data['grade_scope'] ?? 'all')) ?: 'all';
    $mode = strtolower(trim((string)($data['grading_mode'] ?? 'numeric'))) === 'descriptive' ? 'Descriptive' : 'Numeric';
    $schema = is_array($data['schema'] ?? null) ? $data['schema'] : [];

    if ($name === '' || mb_strlen($name) > 180) {
        respond(['success' => false, 'message' => 'Template name is required and must be 180 characters or fewer.'], 422);
    }
    if (!preg_match('/^[A-Z0-9][A-Z0-9_-]{2,79}$/', $code)) {
        respond(['success' => false, 'message' => 'Template code must use 3-80 uppercase letters, numbers, underscores, or hyphens.'], 422);
    }
    if ($scope === '' || mb_strlen($scope) > 40) {
        respond(['success' => false, 'message' => 'Grade scope is required.'], 422);
    }

    $normalizedSchema = TemplateSchemaService::normalize($schema, $mode);
    $schemaJson = json_encode($normalizedSchema, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($schemaJson === false) {
        respond(['success' => false, 'message' => 'Template schema could not be encoded.'], 422);
    }

    $userId = (int)($session['user_id'] ?? 0) ?: null;
    if ($templateId > 0) {
        $existingStmt = $conn->prepare(
            'SELECT template_id, template_code, version_no, status
             FROM report_card_templates
             WHERE template_id = :template_id AND is_deleted = 0
             LIMIT 1'
        );
        $existingStmt->execute([':template_id' => $templateId]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if (!$existing) respond(['success' => false, 'message' => 'Template not found.'], 404);
        if (strcasecmp((string)$existing['status'], 'Draft') !== 0) {
            respond(['success' => false, 'message' => 'Published templates are immutable. Duplicate it to create a new draft version.'], 409);
        }

        $stmt = $conn->prepare(
            'UPDATE report_card_templates
             SET template_name = :template_name,
                 template_code = :template_code,
                 grade_scope = :grade_scope,
                 grading_mode = :grading_mode,
                 schema_json = :schema_json,
                 updated_by = :updated_by
             WHERE template_id = :template_id AND is_deleted = 0'
        );
        try {
            $stmt->execute([
                ':template_name' => $name,
                ':template_code' => $code,
                ':grade_scope' => $scope,
                ':grading_mode' => $mode,
                ':schema_json' => $schemaJson,
                ':updated_by' => $userId,
                ':template_id' => $templateId,
            ]);
        } catch (PDOException $e) {
            if ((int)$e->errorInfo[1] === 1062) respond(['success' => false, 'message' => 'That template code and version already exists.'], 409);
            throw $e;
        }
        respond(['success' => true, 'message' => 'Template draft saved.', 'template_id' => $templateId]);
    }

    $versionStmt = $conn->prepare('SELECT COALESCE(MAX(version_no), 0) FROM report_card_templates WHERE template_code = :template_code');
    $versionStmt->execute([':template_code' => $code]);
    $versionNo = (int)$versionStmt->fetchColumn() + 1;
    $stmt = $conn->prepare(
        'INSERT INTO report_card_templates
            (template_code, template_name, grade_scope, grading_mode, version_no, status, schema_json, created_by, updated_by)
         VALUES (:template_code, :template_name, :grade_scope, :grading_mode, :version_no, "Draft", :schema_json, :created_by, :updated_by)'
    );
    $stmt->execute([
        ':template_code' => $code,
        ':template_name' => $name,
        ':grade_scope' => $scope,
        ':grading_mode' => $mode,
        ':version_no' => $versionNo,
        ':schema_json' => $schemaJson,
        ':created_by' => $userId,
        ':updated_by' => $userId,
    ]);
    respond(['success' => true, 'message' => 'Template draft created.', 'template_id' => (int)$conn->lastInsertId(), 'version_no' => $versionNo]);
}

function duplicateTemplate(PDO $conn, array $session): void {
    requireTemplateTables($conn);
    $data = getJsonInput();
    $sourceId = (int)($data['template_id'] ?? 0);
    if ($sourceId <= 0) respond(['success' => false, 'message' => 'A source template is required.'], 422);

    $stmt = $conn->prepare(
        'SELECT template_code, template_name, grade_scope, grading_mode, schema_json
         FROM report_card_templates
         WHERE template_id = :template_id AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->execute([':template_id' => $sourceId]);
    $source = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$source) respond(['success' => false, 'message' => 'Source template not found.'], 404);

    $sourceCode = strtoupper((string)$source['template_code']);
    $versionStmt = $conn->prepare('SELECT COALESCE(MAX(version_no), 0) FROM report_card_templates WHERE template_code = :template_code');
    $versionStmt->execute([':template_code' => $sourceCode]);
    $versionNo = (int)$versionStmt->fetchColumn() + 1;
    $userId = (int)($session['user_id'] ?? 0) ?: null;
    $insert = $conn->prepare(
        'INSERT INTO report_card_templates
            (template_code, template_name, grade_scope, grading_mode, version_no, status, schema_json, created_by, updated_by)
         VALUES (:template_code, :template_name, :grade_scope, :grading_mode, :version_no, "Draft", :schema_json, :created_by, :updated_by)'
    );
    $insert->execute([
        ':template_code' => $sourceCode,
        ':template_name' => preg_replace('/\s+v\d+$/i', '', (string)$source['template_name']) . ' v' . $versionNo,
        ':grade_scope' => $source['grade_scope'],
        ':grading_mode' => $source['grading_mode'],
        ':version_no' => $versionNo,
        ':schema_json' => json_encode(TemplateSchemaService::decode($source['schema_json'], $source['grading_mode']), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ':created_by' => $userId,
        ':updated_by' => $userId,
    ]);
    respond(['success' => true, 'message' => 'Draft copy created.', 'template_id' => (int)$conn->lastInsertId(), 'version_no' => $versionNo]);
}

function publishTemplate(PDO $conn, array $session): void {
    requireTemplateTables($conn);
    $data = getJsonInput();
    $templateId = (int)($data['template_id'] ?? 0);
    if ($templateId <= 0) respond(['success' => false, 'message' => 'Template is required.'], 422);

    $stmt = $conn->prepare(
        'SELECT template_id, status, schema_json, grading_mode
         FROM report_card_templates
         WHERE template_id = :template_id AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->execute([':template_id' => $templateId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) respond(['success' => false, 'message' => 'Template not found.'], 404);
    $schema = TemplateSchemaService::decode($row['schema_json'] ?? '', $row['grading_mode'] ?? 'Numeric');
    if (empty($schema['columns']) || empty($schema['rows'])) {
        respond(['success' => false, 'message' => 'A template must contain at least one row and one column.'], 422);
    }
    $userId = (int)($session['user_id'] ?? 0) ?: null;
    $update = $conn->prepare(
        'UPDATE report_card_templates
         SET status = "Published", updated_by = :updated_by
         WHERE template_id = :template_id AND is_deleted = 0'
    );
    $update->execute([':updated_by' => $userId, ':template_id' => $templateId]);
    respond(['success' => true, 'message' => 'Template published.']);
}

function assignTemplate(PDO $conn, array $session): void {
    requireTemplateTables($conn);
    $data = getJsonInput();
    $schoolYearId = (int)($data['school_year_id'] ?? 0);
    $gradeLevelId = (int)($data['grade_level_id'] ?? 0);
    $templateId = (int)($data['template_id'] ?? 0);
    if ($schoolYearId <= 0 || $gradeLevelId <= 0 || $templateId <= 0) {
        respond(['success' => false, 'message' => 'School year, grade level, and template are required.'], 422);
    }

    $check = $conn->prepare(
        'SELECT
            (SELECT COUNT(*) FROM school_years WHERE school_year_id = :school_year_id AND is_deleted = 0) AS school_year_exists,
            (SELECT COUNT(*) FROM grade_levels WHERE grade_level_id = :grade_level_id AND is_deleted = 0) AS grade_exists,
            (SELECT COUNT(*) FROM report_card_templates WHERE template_id = :template_id AND status = "Published" AND is_deleted = 0) AS template_exists'
    );
    $check->execute([
        ':school_year_id' => $schoolYearId,
        ':grade_level_id' => $gradeLevelId,
        ':template_id' => $templateId,
    ]);
    $valid = $check->fetch(PDO::FETCH_ASSOC) ?: [];
    if ((int)($valid['school_year_exists'] ?? 0) !== 1 || (int)($valid['grade_exists'] ?? 0) !== 1) {
        respond(['success' => false, 'message' => 'School year or grade level not found.'], 404);
    }
    if ((int)($valid['template_exists'] ?? 0) !== 1) {
        respond(['success' => false, 'message' => 'Only published templates can be assigned.'], 422);
    }

    $userId = (int)($session['user_id'] ?? 0) ?: null;
    $stmt = $conn->prepare(
        'INSERT INTO report_card_template_assignments
            (school_year_id, grade_level_id, template_id, assigned_by, is_deleted, deleted_at)
         VALUES (:school_year_id, :grade_level_id, :template_id, :assigned_by, 0, NULL)
         ON DUPLICATE KEY UPDATE
            template_id = VALUES(template_id),
            assigned_by = VALUES(assigned_by),
            assigned_at = CURRENT_TIMESTAMP,
            is_deleted = 0,
            deleted_at = NULL'
    );
    $stmt->execute([
        ':school_year_id' => $schoolYearId,
        ':grade_level_id' => $gradeLevelId,
        ':template_id' => $templateId,
        ':assigned_by' => $userId,
    ]);
    respond(['success' => true, 'message' => 'Template assigned to the school year and grade.']);
}
