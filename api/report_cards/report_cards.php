<?php
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';
require_once __DIR__ . '/../utils/work_position_rules.php';
require_once __DIR__ . '/../services/GradingPolicyService.php';
require_once __DIR__ . '/../services/ReportCardTemplateService.php';
require_once __DIR__ . '/../services/GradeComputationService.php';

function respond($payload, int $code = 200): void {
    if (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8');
    }
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function tableExists(PDO $conn, string $table): bool {
    static $cache = [];
    if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) return false;
    if (array_key_exists($table, $cache)) return $cache[$table];
    $stmt = $conn->query("SHOW TABLES LIKE " . $conn->quote($table));
    $cache[$table] = (bool)$stmt->fetch(PDO::FETCH_NUM);
    return $cache[$table];
}

function columnExists(PDO $conn, string $table, string $column): bool {
    static $cache = [];
    if (!preg_match('/^[A-Za-z0-9_]+$/', $table) || !preg_match('/^[A-Za-z0-9_]+$/', $column)) return false;
    $key = $table . '.' . $column;
    if (array_key_exists($key, $cache)) return $cache[$key];
    $stmt = $conn->query("SHOW COLUMNS FROM `$table` LIKE " . $conn->quote($column));
    $cache[$key] = (bool)$stmt->fetch(PDO::FETCH_ASSOC);
    return $cache[$key];
}

function reportCardTemplateHistoryAvailable(PDO $conn): bool {
    return columnExists($conn, 'report_cards', 'template_schema_json')
        && columnExists($conn, 'report_cards', 'template_code')
        && columnExists($conn, 'report_cards', 'template_version')
        && columnExists($conn, 'report_cards', 'template_grading_mode');
}

function reportCardPeriodHistoryAvailable(PDO $conn): bool {
    return columnExists($conn, 'report_cards', 'periods_snapshot_json');
}

function reportCardTemplateHistorySelect(PDO $conn, string $alias = 'rc'): string {
    if (!reportCardTemplateHistoryAvailable($conn)) {
        return 'NULL AS template_id, NULL AS template_code, NULL AS template_version,
                NULL AS template_grading_mode, NULL AS template_schema_json,
                NULL AS template_bound_at, NULL AS periods_snapshot_json';
    }

    return $alias . '.template_id AS template_id,
            ' . $alias . '.template_code AS template_code,
            ' . $alias . '.template_version AS template_version,
            ' . $alias . '.template_grading_mode AS template_grading_mode,
            ' . $alias . '.template_schema_json AS template_schema_json,
            ' . $alias . '.template_bound_at AS template_bound_at,
            ' . $alias . '.periods_snapshot_json AS periods_snapshot_json';
}

function bindReportCardTemplate(PDO $conn, int $reportCardId, ?array $template): void {
    if ($reportCardId <= 0 || !$template || !reportCardTemplateHistoryAvailable($conn)) {
        return;
    }

    $schema = is_array($template['schema'] ?? null) ? $template['schema'] : [];
    $schemaJson = json_encode($schema, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($schemaJson === false) {
        throw new RuntimeException('Report-card template snapshot could not be encoded.');
    }

    $stmt = $conn->prepare(
        'UPDATE report_cards
         SET template_id = :template_id,
             template_code = :template_code,
             template_version = :template_version,
             template_grading_mode = :template_grading_mode,
             template_schema_json = :template_schema_json,
             template_bound_at = COALESCE(template_bound_at, NOW())
         WHERE report_card_id = :report_card_id'
    );
    $templateId = (int)($template['template_id'] ?? 0);
    $stmt->bindValue(':template_id', $templateId > 0 ? $templateId : null, $templateId > 0 ? PDO::PARAM_INT : PDO::PARAM_NULL);
    $stmt->bindValue(':template_code', (string)($template['template_code'] ?? ''));
    $stmt->bindValue(':template_version', max(1, (int)($template['version_no'] ?? 1)), PDO::PARAM_INT);
    $stmt->bindValue(':template_grading_mode', (string)($template['grading_mode'] ?? 'Numeric'));
    $stmt->bindValue(':template_schema_json', $schemaJson);
    $stmt->bindValue(':report_card_id', $reportCardId, PDO::PARAM_INT);
    $stmt->execute();
}

function bindReportCardPeriods(PDO $conn, int $reportCardId, array $periods): void {
    if ($reportCardId <= 0 || !$periods || !reportCardPeriodHistoryAvailable($conn)) {
        return;
    }

    $periodsJson = json_encode(array_values($periods), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($periodsJson === false) {
        throw new RuntimeException('Report-card period snapshot could not be encoded.');
    }

    $stmt = $conn->prepare(
        'UPDATE report_cards
         SET periods_snapshot_json = :periods_snapshot_json
         WHERE report_card_id = :report_card_id'
    );
    $stmt->bindValue(':periods_snapshot_json', $periodsJson);
    $stmt->bindValue(':report_card_id', $reportCardId, PDO::PARAM_INT);
    $stmt->execute();
}

function reportCardPeriodsFromSnapshot(?string $snapshotJson): array {
    $decoded = $snapshotJson ? json_decode($snapshotJson, true) : null;
    if (!is_array($decoded)) return [];

    $periods = [];
    foreach ($decoded as $period) {
        if (!is_array($period)) continue;
        $periodId = (int)($period['grading_period_id'] ?? 0);
        $periodNo = (int)($period['period_no'] ?? $period['quarter'] ?? 0);
        if ($periodNo <= 0) continue;
        $period['quarter'] = $periodNo;
        $period['grading_period_id'] = $periodId;
        $period['period_name'] = (string)($period['period_name'] ?? '');
        $periods[] = $period;
    }
    return $periods;
}

function resolveReportCardTemplateForEnrollment(PDO $conn, int $enrollmentId): ?array {
    if ($enrollmentId <= 0) return null;

    $stmt = $conn->prepare(
        'SELECT e.school_year_id, e.grade_level_id, gl.grade_name
         FROM enrollments e
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         WHERE e.enrollment_id = :enrollment_id AND e.is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
    $stmt->execute();
    $enrollment = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$enrollment) return null;

    $policy = GradingPolicyService::resolve(
        $conn,
        (int)($enrollment['school_year_id'] ?? 0),
        (int)($enrollment['grade_level_id'] ?? 0),
        $enrollment['grade_name'] ?? null
    );
    return ReportCardTemplateService::resolve(
        $conn,
        (int)($enrollment['school_year_id'] ?? 0),
        (int)($enrollment['grade_level_id'] ?? 0),
        (string)($policy['sf9_template_variant'] ?? ''),
        (string)($policy['grading_mode'] ?? 'Numeric')
    );
}

function resolveReportCardPeriodsForEnrollment(PDO $conn, int $enrollmentId): array {
    if ($enrollmentId <= 0) return [];

    $stmt = $conn->prepare(
        'SELECT e.school_year_id, e.grade_level_id, gl.grade_name, sy.grading_system_type
         FROM enrollments e
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         LEFT JOIN school_years sy ON sy.school_year_id = e.school_year_id
         WHERE e.enrollment_id = :enrollment_id AND e.is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
    $stmt->execute();
    $enrollment = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$enrollment) return [];

    $schoolYearId = (int)($enrollment['school_year_id'] ?? 0);
    $gradingPolicy = GradingPolicyService::resolve(
        $conn,
        $schoolYearId,
        (int)($enrollment['grade_level_id'] ?? 0),
        $enrollment['grade_name'] ?? null
    );
    $periods = $schoolYearId > 0
        ? getQuarterGradingPeriods($conn, $schoolYearId)
        : sf9_default_periods((string)($enrollment['grading_system_type'] ?? 'Quarterly'));
    if (!$periods) {
        $periods = sf9_default_periods((string)($enrollment['grading_system_type'] ?? 'Quarterly'));
    }
    return sf9_scope_periods_to_grading_policy($periods, $gradingPolicy);
}

function getEmployeeIdForUser(PDO $conn, int $userId): int {
    if ($userId <= 0) {
        respond(['success' => false, 'message' => 'Invalid session user'], 401);
    }
    $stmt = $conn->prepare('SELECT employee_id FROM employees WHERE user_id = :user_id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $stmt->execute();
    $eid = (int)($stmt->fetchColumn() ?: 0);
    if ($eid <= 0) {
        respond(['success' => false, 'message' => 'Teacher profile not found for this account'], 403);
    }
    return $eid;
}

function isTeacherLikeRole(array $session): bool {
    return in_array(strtolower((string)($session['role_key'] ?? '')), ['teacher', 'adviser', 'advisor'], true);
}

function reportCardIsLearnerSession(array $session): bool {
    return strtolower((string)($session['role_key'] ?? '')) === 'learners'
        || (int)($session['role_id'] ?? 0) === 10;
}

function learnerHasDescriptiveReportCard(PDO $conn, array $session, int $enrollmentId): bool {
    if (!reportCardIsLearnerSession($session) || $enrollmentId <= 0) {
        return false;
    }

    $stmt = $conn->prepare(
        'SELECT e.school_year_id, e.grade_level_id, gl.grade_name
         FROM enrollments e
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         WHERE e.enrollment_id = :enrollment_id
           AND e.is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
    $stmt->execute();
    $enrollment = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$enrollment) {
        return false;
    }

    $policy = GradingPolicyService::resolve(
        $conn,
        (int)($enrollment['school_year_id'] ?? 0),
        (int)($enrollment['grade_level_id'] ?? 0),
        $enrollment['grade_name'] ?? null
    );

    return strtolower((string)($policy['grading_mode'] ?? '')) === 'descriptive';
}

$operation = $_GET['operation'] ?? '';
$readRoles = in_array($operation, ['getMySF9Data', 'getMySF9SchoolYears'], true)
    ? ['admin', 'registrar', 'teacher', 'adviser', 'advisor', 'learners']
    : ['admin', 'registrar', 'teacher', 'adviser', 'advisor'];
$writeRoles = in_array($operation, ['saveSF9TermComments', 'saveSF9PaceRatings'], true)
    ? ['admin', 'teacher', 'adviser', 'advisor']
    : ['admin'];
$session = auth_enforce_roles($operation, $readRoles, $writeRoles);
try {
    switch ($operation) {
        case 'getAllReportCards': getAllReportCards($conn, $session); break;
        case 'getSF9Data': getSF9Data($conn, $session); break;
        case 'getSF9DataByEnrollment': getSF9DataByEnrollment($conn, $session); break;
        case 'getMySF9Data': getMySF9Data($conn, $session); break;
        case 'getMySF9SchoolYears': getMySF9SchoolYears($conn, $session); break;
        case 'getSF9Sections': getSF9Sections($conn, $session); break;
        case 'getSF9Roster': getSF9Roster($conn, $session); break;
        case 'saveSF9TermComments': saveSF9TermComments($conn, $session); break;
        case 'saveSF9PaceRatings': saveSF9PaceRatings($conn, $session); break;
        case 'createReportCard': createReportCard($conn); break;
        case 'updateReportCard': updateReportCard($conn); break;
        case 'deleteReportCard': deleteReportCard($conn); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function formatPersonName(?string $first, ?string $middle, ?string $last, ?string $ext = null): string {
    $first = trim((string)($first ?? ''));
    $middle = trim((string)($middle ?? ''));
    $last = trim((string)($last ?? ''));
    $ext = trim((string)($ext ?? ''));

    $parts = [];
    if ($last !== '') $parts[] = $last . ',';
    if ($first !== '') $parts[] = $first;
    if ($middle !== '') $parts[] = $middle;
    if ($ext !== '') $parts[] = $ext;
    return trim(implode(' ', $parts));
}

function getActivePrincipalName(PDO $conn): ?string {
    $stmt = $conn->query(
        'SELECT e.first_name, e.middle_name, e.last_name, e.name_extension, p.position_name
         FROM employees e
         JOIN users u ON u.user_id = e.user_id AND u.is_deleted = 0 AND u.is_active = 1
         JOIN positions p ON p.position_id = e.position_id AND p.is_deleted = 0
         WHERE e.is_deleted = 0
         ORDER BY e.employee_id'
    );
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        if (!work_position_is_principal($row['position_name'] ?? null)) continue;
        $name = formatPersonName(
            $row['first_name'] ?? null,
            $row['middle_name'] ?? null,
            $row['last_name'] ?? null,
            $row['name_extension'] ?? null
        );
        if ($name !== '') return $name;
    }
    return null;
}

function computeAge(?string $dob, ?string $asOfDate = null): ?int {
    $dob = trim((string)($dob ?? ''));
    if ($dob === '') return null;
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $dob)) return null;
    try {
        $birth = new DateTime($dob);
        $ref = $asOfDate ? new DateTime($asOfDate) : new DateTime();
        $diff = $birth->diff($ref);
        $age = (int)($diff->y ?? 0);
        return $age > 0 ? $age : 0;
    } catch (Throwable $_) {
        return null;
    }
}

function sf9_normalize_curriculum_level(?string $value): ?string {
    $v = strtolower(trim((string)($value ?? '')));
    if ($v === '') return null;
    if (in_array($v, ['elementary', 'elem', 'grade school'], true)) return 'elementary';
    if (in_array($v, ['jhs', 'junior high school', 'junior high'], true)) return 'jhs';
    if (in_array($v, ['shs', 'senior high school', 'senior high'], true)) return 'shs';
    if (str_contains($v, 'elementary')) return 'elementary';
    if (str_contains($v, 'junior')) return 'jhs';
    if (str_contains($v, 'senior')) return 'shs';
    return null;
}

function sf9_infer_curriculum_level(?string $configured, ?string $educationLevelName, ?string $gradeName): string {
    $fromConfigured = sf9_normalize_curriculum_level($configured);
    if ($fromConfigured !== null) return $fromConfigured;

    $fromEducation = sf9_normalize_curriculum_level($educationLevelName);
    if ($fromEducation !== null) return $fromEducation;

    if (preg_match('/(\d+)/', (string)($gradeName ?? ''), $m)) {
        $gradeNo = (int)$m[1];
        if ($gradeNo >= 11) return 'shs';
        if ($gradeNo >= 7) return 'jhs';
    }

    return 'elementary';
}

function sf9_compute_average(array $values): ?float {
    $numeric = [];
    foreach ($values as $value) {
        if ($value === null || $value === '' || $value === '--') continue;
        if (!is_numeric($value)) continue;
        $numeric[] = (float)$value;
    }
    if (!$numeric) return null;
    return round(array_sum($numeric) / count($numeric), 2);
}

function sf9_report_card_grade($value): ?int {
    if ($value === null || $value === '' || $value === '--' || !is_numeric($value)) {
        return null;
    }
    return max(60, min(100, (int)round((float)$value)));
}

function sf9_report_card_average(array $values): ?int {
    $numeric = [];
    foreach ($values as $value) {
        $grade = sf9_report_card_grade($value);
        if ($grade === null) {
            continue;
        }
        $numeric[] = $grade;
    }
    if (!$numeric) return null;
    return max(60, min(100, (int)round(array_sum($numeric) / count($numeric))));
}

function sf9_has_any_grade(array $row): bool {
    $keys = ['q1', 'q2', 'q3', 'q4', 'final_grade', 'final_rating'];
    foreach ($keys as $k) {
        if (!array_key_exists($k, $row)) continue;
        $v = $row[$k];
        if ($v === null) continue;
        if (is_string($v) && trim($v) === '') continue;
        if ($v === '--') continue;
        if (is_numeric($v)) return true;
        if (is_string($v)) return true;
    }
    return false;
}

function sf9_infer_subject_category(string $subjectName, ?string $subjectCode, string $curriculumLevel): string {
    $name = strtolower(trim($subjectName));
    $code = strtoupper(trim((string)($subjectCode ?? '')));

    if ($curriculumLevel === 'shs') {
        foreach ([
            'work immersion',
            'entrepreneurship',
            'inquiries',
            'investigation',
            'research',
            'specialized',
            'applied'
        ] as $needle) {
            if (str_contains($name, $needle)) {
                return 'Applied and Specialized Subjects';
            }
        }
        return 'Core Subjects';
    }

    if ($curriculumLevel === 'jhs') {
        $mapehNames = ['mapeh', 'music', 'arts', 'physical education', 'pe', 'health'];
        foreach ($mapehNames as $needle) {
            if (str_contains($name, $needle)) return 'MAPEH';
        }
        if (in_array($code, ['MAPEH', 'MUSIC', 'ARTS', 'PE', 'HEALTH'], true)) return 'MAPEH';
        if ($code === 'TLE' || str_contains($name, 'technology and livelihood')) return 'TLE';
        if ($code === 'VALUES' || str_contains($name, 'values education')) return 'Values Education';
        if ($code === 'ESP' || str_contains($name, 'pagpapakatao')) return 'Edukasyon sa Pagpapakatao';
        if ($code === 'AP' || str_contains($name, 'araling panlipunan')) return 'Araling Panlipunan';
        return 'Core Subjects';
    }

    return 'Learning Areas';
}

function sf9_subject_category_from_row(array $row, string $curriculumLevel): string {
    $areaName = trim((string)($row['learning_area_name'] ?? ''));
    $areaCode = trim((string)($row['learning_area_code'] ?? ''));

    // The shared VALUES learning area covers both the MATATAG Values
    // Education subject and the Grade 10 transition-year EsP subject. Keep
    // the report-card label faithful to the actual subject row instead of
    // exposing the mixed area label "Values Education (EsP)" for both.
    if (strtoupper($areaCode) === 'VALUES') {
        $subjectName = strtolower(trim((string)($row['subject_name'] ?? '')));
        if (str_contains($subjectName, 'values education')) return 'Values Education';
        if (str_contains($subjectName, 'pagpapakatao') || preg_match('/\besp\b/i', $subjectName)) {
            return 'Edukasyon sa Pagpapakatao';
        }
    }
    if ($areaName !== '') return $areaName;
    if ($areaCode !== '') return $areaCode;
    return sf9_infer_subject_category((string)($row['subject_name'] ?? ''), $row['subject_code'] ?? null, $curriculumLevel);
}

function sf9_is_mapeh_parent_row(array $row): bool {
    $area = strtoupper(trim((string)($row['learning_area_code'] ?? '')));
    $name = strtolower(trim((string)($row['subject_name'] ?? '')));
    if (str_contains($name, 'mapeh component')) return false;
    if (!str_contains($name, 'mapeh') && sf9_is_mapeh_component_name($name)) return false;
    return $area === 'MAPEH' || str_contains($name, 'mapeh');
}

function sf9_is_mapeh_component_name(?string $subjectName): bool {
    $name = strtolower(trim((string)$subjectName));
    if ($name === '') return false;
    if (str_contains($name, 'mapeh') && str_contains($name, 'component')) return true;
    if (str_contains($name, 'mapeh')) return false;
    return (bool)(
        preg_match('/\bmusic\s*(and|&)\s*arts?\b/i', $name)
        || preg_match('/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/i', $name)
        || preg_match('/\b(music|arts|physical education|health|pe|p\.e\.)\b/i', $name)
    );
}

function sf9_is_mapeh_component_row(array $row): bool {
    $area = strtoupper(trim((string)($row['learning_area_code'] ?? '')));
    $name = strtolower(trim((string)($row['subject_name'] ?? '')));
    if (str_contains($name, 'mapeh component')) return true;
    if (str_contains($name, 'mapeh')) return false;
    if ($area === 'MAPEH' && sf9_is_mapeh_component_name($name)) return true;
    if ($area === 'MAPEH' && !str_contains($name, 'mapeh')) return true;
    return sf9_is_mapeh_component_name($name);
}

function sf9_subject_key(?string $subjectCode, ?string $subjectName): string {
    $code = strtoupper(trim((string)($subjectCode ?? '')));
    if ($code !== '') return 'CODE:' . $code;
    $name = strtolower(trim((string)($subjectName ?? '')));
    $name = preg_replace('/\s+/', ' ', $name);
    return 'NAME:' . ($name ?? '');
}

function sf9_pick_best_subject_row(array $candidates, array $gradesByClass, array $finalByClass, array $quarters): array {
    // Prefer the class offering that actually has any quarterly grade or final grade saved.
    $best = $candidates[0];
    $bestScore = -1;
    $bestClassId = (int)($best['class_id'] ?? 0);
    foreach ($candidates as $c) {
        $cid = (int)($c['class_id'] ?? 0);
        $score = 0;
        if ($cid > 0) {
            foreach ($quarters as $q) {
                $gpId = (int)($q['grading_period_id'] ?? 0);
                if ($gpId > 0 && isset($gradesByClass[$cid]) && array_key_exists($gpId, $gradesByClass[$cid])) {
                    $val = $gradesByClass[$cid][$gpId];
                    if ($val !== null && $val !== '') $score += 1;
                }
            }
            if (isset($finalByClass[$cid])) {
                $fg = $finalByClass[$cid]['final_grade'] ?? null;
                if ($fg !== null && $fg !== '') $score += 2;
            }
        }
        // Tie-breaker: when scores are equal, prefer newer class offering (higher class_id).
        // This helps SF9 follow reassigned/latest offerings after updates.
        if ($score > $bestScore || ($score === $bestScore && $cid > $bestClassId)) {
            $bestScore = $score;
            $best = $c;
            $bestClassId = $cid;
        }
    }
    return $best;
}

function sf9_resolve_curriculum_id(PDO $conn, int $curriculumId, int $schoolYearId, int $gradeLevelId): int {
    // An enrollment curriculum_id is the historical snapshot for that learner.
    // It must win over the current school-year mapping so later setup changes
    // cannot make an older report card render with a different curriculum.
    if ($curriculumId > 0) {
        return $curriculumId;
    }

    if ($schoolYearId > 0 && $gradeLevelId > 0) {
        $stmt = $conn->prepare(
            'SELECT c.curriculum_id
             FROM curriculum_school_year_map m
             JOIN curricula c ON c.curriculum_id = m.curriculum_id AND c.is_deleted = 0
             LEFT JOIN curriculum_grade_levels cgl ON cgl.curriculum_id = c.curriculum_id
                AND cgl.grade_level_id = :gid
                AND cgl.is_deleted = 0
             WHERE m.school_year_id = :sy
               AND m.is_primary = 1
               AND m.is_deleted = 0
               AND (cgl.cgl_id IS NOT NULL OR NOT EXISTS (
                   SELECT 1 FROM curriculum_grade_levels any_cgl
                   WHERE any_cgl.curriculum_id = c.curriculum_id AND any_cgl.is_deleted = 0
               ))
             ORDER BY m.is_primary DESC, c.is_active DESC, c.effective_from DESC, c.curriculum_id DESC
             LIMIT 1'
        );
        $stmt->bindValue(':gid', $gradeLevelId, PDO::PARAM_INT);
        $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        $mapped = (int)($stmt->fetchColumn() ?: 0);
        if ($mapped > 0) {
            return $mapped;
        }
    }
    if ($schoolYearId > 0) {
        return 0;
    }
    if ($gradeLevelId > 0) {
        $stmt = $conn->prepare(
            'SELECT c.curriculum_id
             FROM curricula c
             JOIN curriculum_subjects cs ON cs.curriculum_id = c.curriculum_id
                AND cs.grade_level_id = :gid
                AND cs.is_deleted = 0
             WHERE c.is_deleted = 0
             ORDER BY c.is_active DESC, c.effective_from DESC, c.curriculum_id DESC
             LIMIT 1'
        );
        $stmt->bindValue(':gid', $gradeLevelId, PDO::PARAM_INT);
        $stmt->execute();
        return (int)($stmt->fetchColumn() ?: 0);
    }
    return 0;
}

function sf9_language_subject_label(string $subjectName): string {
    $name = strtolower(trim($subjectName));
    if ($name === '') return '';
    if (str_contains($name, 'mother tongue') || preg_match('/\bmtb(?:-?mle)?\b/i', $name)) return 'MTB-MLE';
    if (str_contains($name, 'filipino')) return 'Filipino';
    if (str_contains($name, 'english')) return 'English';
    return trim($subjectName);
}

function sf9_refine_language_area_labels(array $subjects): array {
    $languageIndexes = [];
    $languageLabels = [];
    foreach ($subjects as $index => $subject) {
        $areaCode = strtoupper(trim((string)($subject['learning_area_code'] ?? '')));
        $areaName = strtolower(trim((string)($subject['learning_area_name'] ?? '')));
        if ($areaCode !== 'LANG' && !str_contains($areaName, 'languages')) continue;

        $languageIndexes[] = $index;
        $label = sf9_language_subject_label((string)($subject['subject_name'] ?? ''));
        if ($label !== '') $languageLabels[$label] = true;
    }
    if (!$languageIndexes) return $subjects;

    $orderedLabels = [];
    foreach (['MTB-MLE', 'Filipino', 'English'] as $label) {
        if (isset($languageLabels[$label])) $orderedLabels[] = $label;
        unset($languageLabels[$label]);
    }
    foreach (array_keys($languageLabels) as $label) {
        $orderedLabels[] = $label;
    }

    $areaLabel = 'Languages';
    if ($orderedLabels) $areaLabel .= ' (' . implode(' / ', $orderedLabels) . ')';
    foreach ($languageIndexes as $index) {
        $subjects[$index]['learning_area_name'] = $areaLabel;
    }
    return $subjects;
}

function sf9_fetch_assigned_subjects(PDO $conn, int $sectionId, int $schoolYearId, int $gradeLevelId, int $curriculumId): array {
    $subjects = [];
    $curriculumRows = [];
    $curriculumSubjectIds = [];
    $curriculumMetaBySubject = [];
    $curriculumMetaByKey = [];
    $resolvedCurriculumId = sf9_resolve_curriculum_id($conn, $curriculumId, $schoolYearId, $gradeLevelId);
    $subjectCodeSelect = columnExists($conn, 'subjects', 'subject_code')
        ? 's.subject_code'
        : 'NULL AS subject_code';
    $learningAreaJoin = columnExists($conn, 'curriculum_subjects', 'learning_area_id')
        ? 'LEFT JOIN curriculum_learning_areas cla ON cla.area_id = cs.learning_area_id AND cla.is_deleted = 0'
        : '';
    $learningAreaSelect = columnExists($conn, 'curriculum_subjects', 'learning_area_id')
        ? "COALESCE(cla.area_code, '') AS learning_area_code, COALESCE(cla.area_name, '') AS learning_area_name"
        : "'' AS learning_area_code, '' AS learning_area_name";

    if ($resolvedCurriculumId > 0 && $gradeLevelId > 0) {
        $stmt = $conn->prepare(
            "SELECT 0 AS class_id, s.subject_id, {$subjectCodeSelect}, s.subject_name,
                    {$learningAreaSelect},
                    COALESCE(cs.sort_order, 9999) AS sort_order
             FROM curriculum_subjects cs
             JOIN subjects s ON s.subject_id = cs.subject_id
             {$learningAreaJoin}
             WHERE cs.curriculum_id = :cid
               AND cs.grade_level_id = :gid
               AND cs.is_deleted = 0
               AND s.is_deleted = 0
             ORDER BY COALESCE(cs.sort_order, 9999), s.subject_name"
        );
        $stmt->bindValue(':cid', $resolvedCurriculumId, PDO::PARAM_INT);
        $stmt->bindValue(':gid', $gradeLevelId, PDO::PARAM_INT);
        $stmt->execute();
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $subjectId = (int)($row['subject_id'] ?? 0);
            if ($subjectId <= 0) continue;
            $curriculumSubjectIds[$subjectId] = true;
            $curriculumMetaBySubject[$subjectId] = $row;
            $curriculumMetaByKey[sf9_subject_key($row['subject_code'] ?? null, $row['subject_name'] ?? null)] = $row;
            $curriculumRows[] = $row;
        }
    }

    $offeringRows = [];
    if ($sectionId > 0 && $schoolYearId > 0) {
        $stmt = $conn->prepare(
            "SELECT co.class_id, s.subject_id, {$subjectCodeSelect}, s.subject_name
             FROM class_offerings co
             JOIN subjects s ON s.subject_id = co.subject_id
             WHERE s.is_deleted = 0
               AND co.is_deleted = 0
               AND co.section_id = :sid
               AND co.school_year_id = :sy
             ORDER BY s.subject_name"
        );
        $stmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
        $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $subjectId = (int)($row['subject_id'] ?? 0);
            $subjectKey = sf9_subject_key($row['subject_code'] ?? null, $row['subject_name'] ?? null);
            if ($curriculumSubjectIds
                && $subjectId > 0
                && !isset($curriculumSubjectIds[$subjectId])
                && !isset($curriculumMetaByKey[$subjectKey])) {
                continue;
            }
            $curriculumMeta = $subjectId > 0 && isset($curriculumMetaBySubject[$subjectId])
                ? $curriculumMetaBySubject[$subjectId]
                : ($curriculumMetaByKey[$subjectKey] ?? null);
            if ($curriculumMeta) {
                $row = array_merge($row, [
                    'learning_area_code' => $curriculumMeta['learning_area_code'] ?? '',
                    'learning_area_name' => $curriculumMeta['learning_area_name'] ?? '',
                    'sort_order' => $curriculumMeta['sort_order'] ?? 9999,
                ]);
            } else {
                $row['learning_area_code'] = $row['learning_area_code'] ?? '';
                $row['learning_area_name'] = $row['learning_area_name'] ?? '';
                $row['sort_order'] = $row['sort_order'] ?? 9999;
            }
            $offeringRows[] = $row;
        }
    }

    if ($curriculumRows) {
        // Curriculum subjects are the authoritative preview rows. Offerings
        // only supply class IDs for grade lookup; a missing offering still
        // gets a blank row so the preview mirrors curriculum setup exactly.
        $offeringsBySubjectId = [];
        $offeringsByKey = [];
        foreach ($offeringRows as $row) {
            $subjectId = (int)($row['subject_id'] ?? 0);
            $subjectKey = sf9_subject_key($row['subject_code'] ?? null, $row['subject_name'] ?? null);
            if ($subjectId > 0) {
                $offeringsBySubjectId[$subjectId][] = $row;
            }
            if ($subjectKey !== 'NAME:') {
                $offeringsByKey[$subjectKey][] = $row;
            }
        }

        foreach ($curriculumRows as $curriculumRow) {
            $subjectId = (int)($curriculumRow['subject_id'] ?? 0);
            $subjectKey = sf9_subject_key($curriculumRow['subject_code'] ?? null, $curriculumRow['subject_name'] ?? null);
            $matchingOfferings = $subjectId > 0
                ? ($offeringsBySubjectId[$subjectId] ?? [])
                : ($offeringsByKey[$subjectKey] ?? []);
            if (!$matchingOfferings) {
                $curriculumRow['class_id'] = 0;
                $subjects[] = $curriculumRow;
                continue;
            }
            foreach ($matchingOfferings as $offering) {
                $subjects[] = array_merge($curriculumRow, $offering, [
                    'learning_area_code' => $curriculumRow['learning_area_code'] ?? '',
                    'learning_area_name' => $curriculumRow['learning_area_name'] ?? '',
                    'sort_order' => $curriculumRow['sort_order'] ?? 9999,
                ]);
            }
        }
    } else {
        // Preserve legacy behavior for enrollments without a curriculum setup.
        $subjects = $offeringRows;
    }

    usort($subjects, static function (array $a, array $b): int {
        $orderA = (int)($a['sort_order'] ?? 9999);
        $orderB = (int)($b['sort_order'] ?? 9999);
        if ($orderA !== $orderB) return $orderA <=> $orderB;
        return strcmp((string)($a['subject_name'] ?? ''), (string)($b['subject_name'] ?? ''));
    });

    return sf9_refine_language_area_labels($subjects);
}

function sf9_component_sort_case_sql(): string {
    return "CASE
        WHEN LOWER(s.subject_name) LIKE '%music and arts%' OR LOWER(s.subject_name) LIKE '%music & arts%' THEN 1
        WHEN LOWER(s.subject_name) LIKE '%physical education and health%' OR LOWER(s.subject_name) LIKE '%pe and health%' OR LOWER(s.subject_name) LIKE '%p.e. and health%' THEN 2
        WHEN LOWER(s.subject_name) LIKE '%music%' THEN 1
        WHEN LOWER(s.subject_name) LIKE '%arts%' THEN 2
        WHEN LOWER(s.subject_name) LIKE '%physical education%' OR LOWER(s.subject_name) REGEXP '(^|[^a-z])pe([^a-z]|$)' THEN 3
        WHEN LOWER(s.subject_name) LIKE '%health%' THEN 4
        ELSE 9
    END";
}

function sf9_component_sort_order_from_name(?string $subjectName): int {
    $name = strtolower(trim((string)$subjectName));
    if (str_contains($name, 'music and arts') || str_contains($name, 'music & arts')) return 1;
    if (str_contains($name, 'physical education and health')
        || str_contains($name, 'pe and health')
        || str_contains($name, 'p.e. and health')) return 2;
    if (str_contains($name, 'music')) return 1;
    if (str_contains($name, 'arts')) return 2;
    if (str_contains($name, 'physical education') || preg_match('/(^|[^a-z])pe([^a-z]|$)/', $name)) return 3;
    if (str_contains($name, 'health')) return 4;
    return 9;
}

function sf9_mapeh_component_key(?string $subjectName): string {
    $name = strtolower(trim((string)$subjectName));
    if ($name === '' || (str_contains($name, 'mapeh') && !str_contains($name, 'component'))) return '';
    if (preg_match('/\bmusic\s*(and|&)\s*arts?\b/i', $name)) return 'music_arts';
    if (preg_match('/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/i', $name)) return 'pe_health';
    if (preg_match('/\bmusic\b/i', $name)) return 'music';
    if (preg_match('/\barts?\b/i', $name)) return 'arts';
    if (preg_match('/\b(physical education|pe|p\.e\.)\b/i', $name)) return 'pe';
    if (preg_match('/\bhealth\b/i', $name)) return 'health';
    return '';
}

function sf9_pick_coherent_mapeh_components(array $rows): array {
    $byKey = [];
    $rowsByKey = [];
    foreach ($rows as $row) {
        $key = sf9_mapeh_component_key($row['subject_name'] ?? '');
        if ($key === '') continue;
        if (!isset($rowsByKey[$key])) $rowsByKey[$key] = [];
        $rowsByKey[$key][] = $row;
        $current = $byKey[$key] ?? null;
        if (!$current || (int)($row['class_id'] ?? 0) > (int)($current['class_id'] ?? 0)) {
            $byKey[$key] = $row;
        }
    }

    $candidateClassIds = static function (string $key) use ($rowsByKey): array {
        $classIds = [];
        foreach ($rowsByKey[$key] ?? [] as $row) {
            $classId = (int)($row['class_id'] ?? 0);
            if ($classId > 0) $classIds[] = $classId;
        }
        return array_values(array_unique($classIds));
    };

    $candidateGroup = static function (array $keys) use ($rowsByKey): array {
        $groups = [];
        foreach ($keys as $key) {
            $classIds = [];
            foreach ($rowsByKey[$key] ?? [] as $row) {
                $classId = (int)($row['class_id'] ?? 0);
                if ($classId > 0) $classIds[] = $classId;
            }
            $classIds = array_values(array_unique($classIds));
            if ($classIds) {
                $groups[] = ['_candidate_class_ids' => $classIds];
            }
        }
        return $groups;
    };

    $standaloneKeys = ['music', 'arts', 'pe', 'health'];
    if (count(array_intersect($standaloneKeys, array_keys($byKey))) === count($standaloneKeys)) {
        $music = $byKey['music'];
        $arts = $byKey['arts'];
        $pe = $byKey['pe'];
        $health = $byKey['health'];
        $music['_candidate_class_ids'] = $candidateClassIds('music');
        $arts['_candidate_class_ids'] = $candidateClassIds('arts');
        $pe['_candidate_class_ids'] = $candidateClassIds('pe');
        $health['_candidate_class_ids'] = $candidateClassIds('health');
        return [$music, $arts, $pe, $health];
    }

    $groupedKeys = ['music_arts', 'pe_health'];
    if (count(array_intersect($groupedKeys, array_keys($byKey))) === count($groupedKeys)) {
        $musicArts = $byKey['music_arts'];
        $peHealth = $byKey['pe_health'];
        $musicArts['_aggregate_components'] = $candidateGroup(['music', 'arts']);
        $peHealth['_aggregate_components'] = $candidateGroup(['pe', 'health']);
        return [$musicArts, $peHealth];
    }

    return [];
}

function sf9_collect_subject_class_ids(array $rows): array {
    $ids = [];
    $visit = static function (array $row) use (&$ids, &$visit): void {
        $classId = (int)($row['class_id'] ?? 0);
        if ($classId > 0) $ids[] = $classId;

        foreach (($row['_candidate_class_ids'] ?? []) as $candidateId) {
            $candidateId = (int)$candidateId;
            if ($candidateId > 0) $ids[] = $candidateId;
        }

        foreach (($row['_aggregate_components'] ?? []) as $component) {
            if (is_array($component)) {
                $visit($component);
            }
        }
    };

    foreach ($rows as $row) {
        if (is_array($row)) {
            $visit($row);
        }
    }
    return array_values(array_unique($ids));
}

function sf9_mapeh_curriculum_context(PDO $conn, int $curriculumId, int $gradeLevelId): array {
    if ($curriculumId <= 0 || $gradeLevelId <= 0) {
        return [
            'has_rows' => false,
            'has_parent' => false,
            'component_subject_ids' => [],
        ];
    }

    $stmt = $conn->prepare(
        "SELECT cs.subject_id, s.subject_name, COALESCE(cla.area_code, '') AS learning_area_code
         FROM curriculum_subjects cs
         JOIN subjects s ON s.subject_id = cs.subject_id AND s.is_deleted = 0
         LEFT JOIN curriculum_learning_areas cla ON cla.area_id = cs.learning_area_id AND cla.is_deleted = 0
         WHERE cs.curriculum_id = :cid
           AND cs.grade_level_id = :gid
           AND cs.is_deleted = 0
         ORDER BY COALESCE(cs.sort_order, 9999), s.subject_name"
    );
    $stmt->bindValue(':cid', $curriculumId, PDO::PARAM_INT);
    $stmt->bindValue(':gid', $gradeLevelId, PDO::PARAM_INT);
    $stmt->execute();

    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $hasParent = false;
    foreach ($rows as $row) {
        if (sf9_is_mapeh_parent_row($row)) {
            $hasParent = true;
            break;
        }
    }

    $ids = [];
    foreach ($rows as $row) {
        if (sf9_is_mapeh_parent_row($row)) continue;
        if (sf9_is_mapeh_component_row($row) || ($hasParent && sf9_is_mapeh_component_name($row['subject_name'] ?? ''))) {
            $ids[] = (int)($row['subject_id'] ?? 0);
        }
    }

    return [
        'has_rows' => !empty($rows),
        'has_parent' => $hasParent,
        'component_subject_ids' => array_values(array_unique(array_filter($ids, fn($id) => $id > 0))),
    ];
}

function sf9_mapeh_component_subject_ids_from_curriculum(PDO $conn, int $curriculumId, int $gradeLevelId): array {
    $context = sf9_mapeh_curriculum_context($conn, $curriculumId, $gradeLevelId);
    return $context['component_subject_ids'] ?? [];
}

function sf9_fetch_mapeh_component_subjects(PDO $conn, int $sectionId, int $schoolYearId, int $gradeLevelId = 0, int $curriculumId = 0): array {
    if ($sectionId <= 0 || $schoolYearId <= 0) return [];
    $subjectCodeSelect = columnExists($conn, 'subjects', 'subject_code')
        ? 's.subject_code'
        : 'NULL AS subject_code';
    $resolvedCurriculumId = sf9_resolve_curriculum_id($conn, $curriculumId, $schoolYearId, $gradeLevelId);
    $curriculumContext = sf9_mapeh_curriculum_context($conn, $resolvedCurriculumId, $gradeLevelId);
    $componentSubjectIds = $curriculumContext['component_subject_ids'] ?? [];

    // Do not infer MAPEH from stale component offerings when the selected
    // curriculum has subjects for this grade but does not assign MAPEH. The
    // curriculum rows are authoritative for the report-card subject list.
    if ($resolvedCurriculumId > 0
        && !empty($curriculumContext['has_rows'])
        && empty($curriculumContext['has_parent'])
        && !$componentSubjectIds) {
        return [];
    }

    if (!$componentSubjectIds) {
        $stmt = $conn->prepare(
            "SELECT co.class_id, s.subject_id, {$subjectCodeSelect}, s.subject_name,
                    'MAPEH' AS learning_area_code,
                    'MAPEH' AS learning_area_name,
                    " . sf9_component_sort_case_sql() . " AS sort_order
             FROM class_offerings co
             JOIN subjects s ON s.subject_id = co.subject_id
             WHERE s.is_deleted = 0
               AND co.is_deleted = 0
               AND co.section_id = :sid
               AND co.school_year_id = :sy
               AND (
                   LOWER(s.subject_name) LIKE '%mapeh component%'
                   OR LOWER(s.subject_name) LIKE '%music and arts%'
                   OR LOWER(s.subject_name) LIKE '%music & arts%'
                   OR LOWER(s.subject_name) LIKE '%physical education and health%'
                   OR LOWER(s.subject_name) LIKE '%pe and health%'
                   OR LOWER(s.subject_name) LIKE '%p.e. and health%'
                   OR s.subject_name IN ('Music', 'Arts', 'Physical Education', 'Health')
               )
             ORDER BY sort_order, co.class_id DESC"
        );
        $stmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
        $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        $isCurriculumAuthoritative = $resolvedCurriculumId > 0 && !empty($curriculumContext['has_rows']);
        foreach ($rows as &$row) {
            // These rows can still supply the MAPEH aggregate grade, but they
            // are not additional curriculum subjects when only the MAPEH
            // parent is configured.
            $row['is_curriculum_subject'] = !$isCurriculumAuthoritative;
        }
        unset($row);
        return sf9_pick_coherent_mapeh_components($rows);
    }

    $subjectPlaceholders = [];
    foreach ($componentSubjectIds as $idx => $_subjectId) {
        $subjectPlaceholders[] = ':component_subject_' . $idx;
    }
    $in = implode(',', $subjectPlaceholders);
    $stmt = $conn->prepare(
        "SELECT co.class_id, s.subject_id, {$subjectCodeSelect}, s.subject_name,
                'MAPEH' AS learning_area_code,
                'MAPEH' AS learning_area_name,
                " . sf9_component_sort_case_sql() . " AS sort_order
         FROM class_offerings co
         JOIN subjects s ON s.subject_id = co.subject_id
         WHERE s.is_deleted = 0
           AND co.is_deleted = 0
           AND co.section_id = :sid
           AND co.school_year_id = :sy
           AND co.subject_id IN ({$in})
         ORDER BY sort_order, s.subject_name"
    );
    $stmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    foreach ($componentSubjectIds as $idx => $subjectId) {
        $stmt->bindValue(':component_subject_' . $idx, $subjectId, PDO::PARAM_INT);
    }
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    // A curriculum subject may be configured before its class offering exists.
    // Add a zero-class placeholder so the fixed MAPEH component rows still
    // appear in the preview and receive grades once an offering is assigned.
    $existingSubjectIds = [];
    foreach ($rows as $row) {
        $subjectId = (int)($row['subject_id'] ?? 0);
        if ($subjectId > 0) $existingSubjectIds[$subjectId] = true;
    }
    $missingSubjectIds = array_values(array_filter(
        $componentSubjectIds,
        static fn(int $subjectId): bool => !isset($existingSubjectIds[$subjectId])
    ));
    if ($missingSubjectIds) {
        $missingPlaceholders = [];
        foreach ($missingSubjectIds as $idx => $_subjectId) {
            $missingPlaceholders[] = ':missing_component_subject_' . $idx;
        }
        $missingIn = implode(',', $missingPlaceholders);
        $missingStmt = $conn->prepare(
            "SELECT s.subject_id, {$subjectCodeSelect}, s.subject_name
             FROM subjects s
             WHERE s.is_deleted = 0
               AND s.subject_id IN ({$missingIn})"
        );
        foreach ($missingSubjectIds as $idx => $subjectId) {
            $missingStmt->bindValue(':missing_component_subject_' . $idx, $subjectId, PDO::PARAM_INT);
        }
        $missingStmt->execute();
        foreach ($missingStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $rows[] = [
                'class_id' => 0,
                'subject_id' => (int)($row['subject_id'] ?? 0),
                'subject_code' => $row['subject_code'] ?? null,
                'subject_name' => $row['subject_name'] ?? '',
                'learning_area_code' => 'MAPEH',
                'learning_area_name' => 'MAPEH',
                'sort_order' => sf9_component_sort_order_from_name($row['subject_name'] ?? null),
                'is_curriculum_subject' => true,
            ];
        }
    }

    foreach ($rows as &$row) {
        $row['is_curriculum_subject'] = true;
    }
    unset($row);

    return sf9_pick_coherent_mapeh_components($rows);
}

function sf9_build_grade_row(array $subject, array $quarters, array $gradesByClass, array $finalByClass, ?string $curriculumLevel = null): array {
    $cid = (int)($subject['class_id'] ?? 0);
    $row = [
        'class_id' => $cid,
        'subject_name' => (string)($subject['subject_name'] ?? ''),
        'subject_code' => $subject['subject_code'] ?? null,
        'q1' => null,
        'q2' => null,
        'q3' => null,
        'q4' => null,
        'final_grade' => null,
        'final_rating' => null,
        'remark' => null,
        'remarks' => null,
    ];
    if ($curriculumLevel !== null) {
        $row['category'] = sf9_subject_category_from_row($subject, $curriculumLevel);
    }
    if (!empty($subject['_aggregate_components']) && is_array($subject['_aggregate_components'])) {
        foreach ($quarters as $q) {
            $qNo = (int)($q['quarter'] ?? 0);
            $gpId = (int)($q['grading_period_id'] ?? 0);
            if ($qNo < 1 || $qNo > 4 || $gpId <= 0) continue;

            $ownValue = $cid > 0 ? sf9_report_card_grade(sf9_pick_latest_quarter_value([$cid], $gradesByClass, $gpId)) : null;
            if ($ownValue !== null) {
                $row['q' . $qNo] = $ownValue;
                continue;
            }

            $componentValues = [];
            foreach ($subject['_aggregate_components'] as $component) {
                $candidateClassIds = $component['_candidate_class_ids'] ?? [];
                if (!is_array($candidateClassIds)) $candidateClassIds = [];
                $value = sf9_pick_latest_quarter_value($candidateClassIds, $gradesByClass, $gpId);
                $grade = sf9_report_card_grade($value);
                if ($grade !== null) $componentValues[] = $grade;
            }
            if ($componentValues) {
                $row['q' . $qNo] = sf9_report_card_average($componentValues);
            }
        }
        $periodValues = array_map(static fn(array $period) => $row['q' . (int)($period['quarter'] ?? 0)] ?? null, $quarters);
        $allPeriodsPresent = !empty($periodValues) && count(array_filter($periodValues, static fn($value) => $value !== null && $value !== '')) === count($periodValues);
        $finalGrade = $allPeriodsPresent ? sf9_report_card_average($periodValues) : null;
        $row['final_grade'] = $finalGrade;
        $row['final_rating'] = $finalGrade;
        if ($finalGrade !== null) {
            $row['remark'] = $finalGrade >= 75 ? 'Passed' : 'Failed';
            $row['remarks'] = $row['remark'];
        }
        return $row;
    }
    if ($cid > 0) {
        $candidateClassIds = $subject['_candidate_class_ids'] ?? [$cid];
        if (!is_array($candidateClassIds) || !$candidateClassIds) {
            $candidateClassIds = [$cid];
        }
        foreach ($quarters as $q) {
            $qNo = (int)($q['quarter'] ?? 0);
            $gpId = (int)($q['grading_period_id'] ?? 0);
            if ($qNo >= 1 && $qNo <= 4 && $gpId > 0) {
                $row['q' . $qNo] = sf9_report_card_grade(sf9_pick_latest_quarter_value($candidateClassIds, $gradesByClass, $gpId));
            }
        }
    }
    $periodValues = array_map(static fn(array $period) => $row['q' . (int)($period['quarter'] ?? 0)] ?? null, $quarters);
    $allPeriodsPresent = !empty($periodValues) && count(array_filter($periodValues, static fn($value) => $value !== null && $value !== '')) === count($periodValues);
    $finalGrade = $allPeriodsPresent ? sf9_report_card_average($periodValues) : null;
    $row['final_grade'] = $finalGrade;
    $row['final_rating'] = $finalGrade;
    if ($finalGrade !== null) {
        $row['remark'] = $finalGrade >= 75 ? 'Passed' : 'Failed';
        $row['remarks'] = $row['remark'];
    }
    return $row;
}

function sf9_pick_latest_quarter_value(array $candidateClassIds, array $gradesByClass, int $gradingPeriodId) {
    if ($gradingPeriodId <= 0) return null;
    $ids = array_values(array_unique(array_map('intval', $candidateClassIds)));
    $bestRowId = -1;
    $bestValue = null;
    foreach ($ids as $cid) {
        if ($cid <= 0) continue;
        if (!isset($gradesByClass[$cid])) continue;
        if (!array_key_exists($gradingPeriodId, $gradesByClass[$cid])) continue;
        $entry = $gradesByClass[$cid][$gradingPeriodId];
        $rowId = (int)($entry['grade_id'] ?? 0);
        $val = $entry['quarterly_grade'] ?? null;
        if ($val === null || $val === '') continue;
        if ($rowId > $bestRowId) {
            $bestRowId = $rowId;
            $bestValue = $val;
        }
    }
    return $bestValue;
}

function sf9_pick_latest_final_value(array $candidateClassIds, array $finalByClass): array {
    $ids = array_values(array_unique(array_map('intval', $candidateClassIds)));
    $bestRowId = -1;
    $best = ['final_grade' => null, 'remark' => null];
    foreach ($ids as $cid) {
        if ($cid <= 0) continue;
        if (!isset($finalByClass[$cid])) continue;
        $entry = $finalByClass[$cid];
        $fg = $entry['final_grade'] ?? null;
        if ($fg === null || $fg === '') continue;
        $rowId = (int)($entry['final_grade_id'] ?? 0);
        if ($rowId > $bestRowId) {
            $bestRowId = $rowId;
            $best = [
                'final_grade' => $fg,
                'remark' => $entry['remark'] ?? null,
            ];
        }
    }
    return $best;
}

function sf9_observed_values_template(): array {
    return [
        'maka_diyos_1' => [
            'core_value' => 'Maka-Diyos',
            'behavior_statement' => "Expresses one's spiritual beliefs while respecting the spiritual beliefs of others",
            'q1' => '', 'q2' => '', 'q3' => '', 'q4' => ''
        ],
        'maka_diyos_2' => [
            'core_value' => 'Maka-Diyos',
            'behavior_statement' => 'Shows adherence to ethical principles by upholding truth in all undertakings',
            'q1' => '', 'q2' => '', 'q3' => '', 'q4' => ''
        ],
        'makatao_1' => [
            'core_value' => 'Makatao',
            'behavior_statement' => 'Is sensitive to individual, social and cultural differences; resists stereotyping people',
            'q1' => '', 'q2' => '', 'q3' => '', 'q4' => ''
        ],
        'makatao_2' => [
            'core_value' => 'Makatao',
            'behavior_statement' => 'Demonstrates contributions toward solidarity',
            'q1' => '', 'q2' => '', 'q3' => '', 'q4' => ''
        ],
        'makakalikasan_1' => [
            'core_value' => 'Makakalikasan',
            'behavior_statement' => 'Cares for the environment and utilizes resources wisely, judiciously and economically',
            'q1' => '', 'q2' => '', 'q3' => '', 'q4' => ''
        ],
        'makabansa_1' => [
            'core_value' => 'Makabansa',
            'behavior_statement' => 'Demonstrates pride in being a Filipino; exercises the rights and responsibilities of a Filipino citizen',
            'q1' => '', 'q2' => '', 'q3' => '', 'q4' => ''
        ],
        'makabansa_2' => [
            'core_value' => 'Makabansa',
            'behavior_statement' => 'Demonstrates appropriate behavior in carrying out activities in the school, community and country',
            'q1' => '', 'q2' => '', 'q3' => '', 'q4' => ''
        ],
    ];
}

function sf9_should_include_observed_values(array $gradingPolicy): bool {
    return strtolower((string)($gradingPolicy['grading_mode'] ?? '')) === 'descriptive';
}

function sf9_observed_values_for_enrollment(PDO $conn, int $enrollmentId, array $quarters): array {
    $template = sf9_observed_values_template();
    if ($enrollmentId <= 0
        || !tableExists($conn, 'learner_observed_values')
        || !tableExists($conn, 'observed_value_indicators')
        || !tableExists($conn, 'observed_value_core_values')) {
        return $template;
    }

    $periodToKey = [];
    foreach ($quarters as $period) {
        $periodId = (int)($period['grading_period_id'] ?? 0);
        $quarterNo = (int)($period['quarter'] ?? 0);
        if ($periodId > 0 && $quarterNo > 0) {
            $periodToKey[$periodId] = 'q' . $quarterNo;
        }
    }
    if (!$periodToKey) {
        return $template;
    }

    $placeholders = implode(',', array_fill(0, count($periodToKey), '?'));
    $stmt = $conn->prepare(
        "SELECT ovi.code,
                lov.grading_period_id,
                lov.rating_code
         FROM learner_observed_values lov
         JOIN observed_value_indicators ovi ON ovi.indicator_id = lov.indicator_id
                                      AND ovi.is_deleted = 0
         JOIN observed_value_core_values ovc ON ovc.core_value_id = ovi.core_value_id
                                      AND ovc.is_deleted = 0
         WHERE lov.enrollment_id = ?
           AND lov.grading_period_id IN ({$placeholders})
           AND lov.is_deleted = 0
         ORDER BY ovc.sort_order ASC, ovi.sort_order ASC"
    );
    $stmt->execute([$enrollmentId, ...array_keys($periodToKey)]);
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $code = strtolower((string)($row['code'] ?? ''));
        $periodKey = $periodToKey[(int)$row['grading_period_id']] ?? null;
        if ($periodKey === null || !isset($template[$code])) {
            continue;
        }
        $template[$code][$periodKey] = (string)($row['rating_code'] ?? '');
    }

    return $template;
}

function sf9_term_comments_for_enrollment(PDO $conn, int $enrollmentId, array $quarters): array {
    if ($enrollmentId <= 0 || !tableExists($conn, 'report_card_term_comments')) {
        return [];
    }

    $periodIds = array_values(array_filter(array_map(
        static fn(array $period): int => (int)($period['grading_period_id'] ?? 0),
        $quarters
    ), static fn(int $id): bool => $id > 0));
    if (!$periodIds) {
        return [];
    }

    $placeholders = implode(',', array_fill(0, count($periodIds), '?'));
    $stmt = $conn->prepare(
        "SELECT rctc.term_comment_id,
                rctc.grading_period_id,
                gp.period_no,
                gp.period_name,
                rctc.comment_text,
                rctc.updated_at
         FROM report_card_term_comments rctc
         JOIN grading_periods gp ON gp.grading_period_id = rctc.grading_period_id
         WHERE rctc.enrollment_id = ?
           AND rctc.grading_period_id IN ({$placeholders})
           AND rctc.is_deleted = 0
           AND gp.is_deleted = 0
         ORDER BY gp.period_no ASC, gp.grading_period_id ASC"
    );
    $stmt->execute([$enrollmentId, ...$periodIds]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $byPeriod = [];
    foreach ($rows as $row) {
        $byPeriod[(int)$row['grading_period_id']] = [
            'term_comment_id' => (int)($row['term_comment_id'] ?? 0),
            'grading_period_id' => (int)($row['grading_period_id'] ?? 0),
            'period_no' => (int)($row['period_no'] ?? 0),
            'period_name' => (string)($row['period_name'] ?? ''),
            'comment_text' => (string)($row['comment_text'] ?? ''),
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }

    $result = [];
    foreach ($quarters as $period) {
        $periodId = (int)($period['grading_period_id'] ?? 0);
        if ($periodId <= 0) continue;
        $result[] = $byPeriod[$periodId] ?? [
            'term_comment_id' => null,
            'grading_period_id' => $periodId,
            'period_no' => (int)($period['period_no'] ?? $period['quarter'] ?? 0),
            'period_name' => (string)($period['period_name'] ?? $period['label'] ?? ''),
            'comment_text' => '',
            'updated_at' => null,
        ];
    }
    return $result;
}

function sf9_pace_ratings_for_enrollment(PDO $conn, int $enrollmentId, array $quarters): array {
    if ($enrollmentId <= 0 || !tableExists($conn, 'sf9_pace_ratings')) {
        return [];
    }
    $periodIds = array_values(array_filter(array_map(
        static fn(array $period): int => (int)($period['grading_period_id'] ?? 0),
        $quarters
    ), static fn(int $id): bool => $id > 0));
    if (!$periodIds) return [];

    $placeholders = implode(',', array_fill(0, count($periodIds), '?'));
    $stmt = $conn->prepare(
        "SELECT grading_period_id, catalog_key, rating_code
         FROM sf9_pace_ratings
         WHERE enrollment_id = ?
           AND grading_period_id IN ({$placeholders})
           AND is_deleted = 0
         ORDER BY grading_period_id, catalog_key"
    );
    $stmt->execute([$enrollmentId, ...$periodIds]);
    return array_map(static fn(array $row): array => [
        'grading_period_id' => (int)($row['grading_period_id'] ?? 0),
        'catalog_key' => (string)($row['catalog_key'] ?? ''),
        'rating_code' => strtoupper((string)($row['rating_code'] ?? '')),
    ], $stmt->fetchAll(PDO::FETCH_ASSOC) ?: []);
}

function sf9_valid_date(?string $value): ?DateTime {
    if (!$value) {
        return null;
    }
    try {
        return new DateTime($value);
    } catch (Throwable $_) {
        return null;
    }
}

function sf9_months(?int $yearStart, ?int $yearEnd, ?string $dateStart = null, ?string $dateEnd = null): array {
    $startDate = sf9_valid_date($dateStart);
    $endDate = sf9_valid_date($dateEnd);
    if ($startDate && $endDate && $startDate <= $endDate) {
        $cursor = new DateTime($startDate->format('Y-m-01'));
        $last = new DateTime($endDate->format('Y-m-01'));
        $months = [];
        $guard = 0;
        while ($cursor <= $last && $guard < 12) {
            $months[] = [
                'label' => $cursor->format('M'),
                'year' => (int)$cursor->format('Y'),
                'month' => (int)$cursor->format('n'),
            ];
            $cursor->modify('+1 month');
            $guard++;
        }
        if ($months) {
            return $months;
        }
    }

    $ys = (int)($yearStart ?? 0);
    $ye = (int)($yearEnd ?? 0);
    if ($ys <= 0 || $ye <= 0) {
        $y = (int)date('Y');
        $ys = $y;
        $ye = $y + 1;
    }

    // Matches the common SF9 month header (Jun..Apr + Total)
    return [
        ['label' => 'Jun', 'year' => $ys, 'month' => 6],
        ['label' => 'Jul', 'year' => $ys, 'month' => 7],
        ['label' => 'Aug', 'year' => $ys, 'month' => 8],
        ['label' => 'Sep', 'year' => $ys, 'month' => 9],
        ['label' => 'Oct', 'year' => $ys, 'month' => 10],
        ['label' => 'Nov', 'year' => $ys, 'month' => 11],
        ['label' => 'Dec', 'year' => $ys, 'month' => 12],
        ['label' => 'Jan', 'year' => $ye, 'month' => 1],
        ['label' => 'Feb', 'year' => $ye, 'month' => 2],
        ['label' => 'Mar', 'year' => $ye, 'month' => 3],
        ['label' => 'Apr', 'year' => $ye, 'month' => 4],
    ];
}

function sf9_month_bounds(int $year, int $month): array {
    $start = sprintf('%04d-%02d-01', $year, $month);
    $end = date('Y-m-t', strtotime($start));
    return [$start, $end];
}

function sf9_clipped_month_bounds(int $year, int $month, ?string $dateStart = null, ?string $dateEnd = null): array {
    [$start, $end] = sf9_month_bounds($year, $month);
    $rangeStart = sf9_valid_date($dateStart);
    $rangeEnd = sf9_valid_date($dateEnd);
    if ($rangeStart && $rangeStart->format('Y-m-d') > $start) {
        $start = $rangeStart->format('Y-m-d');
    }
    if ($rangeEnd && $rangeEnd->format('Y-m-d') < $end) {
        $end = $rangeEnd->format('Y-m-d');
    }
    return [$start, $end];
}

function sf9_count_weekdays(string $startDate, string $endDate): int {
    try {
        $start = new DateTime($startDate);
        $end = (new DateTime($endDate))->modify('+1 day');
        if ($start >= $end) {
            return 0;
        }
        $count = 0;
        for ($d = clone $start; $d < $end; $d->modify('+1 day')) {
            $dow = (int)$d->format('N');
            if ($dow >= 1 && $dow <= 5) {
                $count++;
            }
        }
        return $count;
    } catch (Throwable $_) {
        return 0;
    }
}

function sf9_period_date_range(array $periods): array {
    $start = null;
    $end = null;
    foreach ($periods as $period) {
        $periodStart = sf9_valid_date($period['date_start'] ?? null);
        $periodEnd = sf9_valid_date($period['date_end'] ?? null);
        if ($periodStart && ($start === null || $periodStart < $start)) {
            $start = $periodStart;
        }
        if ($periodEnd && ($end === null || $periodEnd > $end)) {
            $end = $periodEnd;
        }
    }
    return [$start ? $start->format('Y-m-d') : null, $end ? $end->format('Y-m-d') : null];
}

function sf9_attendance_date_range(PDO $conn, int $enrollmentId): array {
    if ($enrollmentId <= 0) {
        return [null, null];
    }
    $stmt = $conn->prepare(
        "SELECT MIN(attendance_date) AS date_start, MAX(attendance_date) AS date_end
         FROM attendance
         WHERE enrollment_id = :eid
           AND is_deleted = 0
           AND (class_id IS NULL OR class_id = 0)
           AND session = 'AM'"
    );
    $stmt->bindValue(':eid', $enrollmentId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    return [$row['date_start'] ?? null, $row['date_end'] ?? null];
}

function countWeekdaysBetween(?string $startDate, ?string $endDate): int {
    $startDate = trim((string)($startDate ?? ''));
    $endDate = trim((string)($endDate ?? ''));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $startDate) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $endDate)) {
        return 0;
    }

    try {
        $start = new DateTime($startDate);
        $end = (new DateTime($endDate))->modify('+1 day');
        $count = 0;
        for ($d = clone $start; $d < $end; $d->modify('+1 day')) {
            $dow = (int)$d->format('N');
            if ($dow >= 1 && $dow <= 5) $count++;
        }
        return $count;
    } catch (Throwable $_) {
        return 0;
    }
}

function sf9_default_periods(string $gradingSystemType): array {
    $count = in_array($gradingSystemType, ['Three-Term', 'Trimester'], true) ? 3 : ($gradingSystemType === 'Semester' ? 2 : 4);
    $periods = [];
    for ($i = 1; $i <= $count; $i++) {
        $periods[] = [
            'quarter' => $i,
            'grading_period_id' => 0,
            'period_name' => '',
            'date_start' => null,
            'date_end' => null,
        ];
    }
    return $periods;
}

function getSchoolSettingsMap(PDO $conn): array {
    $stmt = $conn->prepare('SELECT setting_key, setting_value FROM school_settings WHERE is_deleted = 0');
    $stmt->execute();
    $map = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $k = (string)($r['setting_key'] ?? '');
        if ($k === '') continue;
        $map[$k] = $r['setting_value'] ?? null;
    }
    return $map;
}

/**
 * Resolve a public path relative to the current application mount point.
 *
 * The application can be served from / (PHP built-in server/Live Server) or
 * from /deped_capstone2 (Apache). Do not bake either deployment path into
 * report-card data, because the generated preview is rendered by the browser
 * on the current host.
 */
function sf9_public_app_prefix(): string {
    $script = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? $_SERVER['PHP_SELF'] ?? ''));
    $apiMarker = strpos($script, '/api/');
    if ($apiMarker === false) return '';

    $prefix = substr($script, 0, $apiMarker);
    return $prefix === '/' ? '' : rtrim($prefix, '/');
}

function sf9_logo_asset_url(string $filename): string {
    $filename = basename($filename);
    return sf9_public_app_prefix() . '/assets/img/logo/' . $filename;
}

function getQuarterGradingPeriods(PDO $conn, int $schoolYearId): array {
    $stmt = $conn->prepare(
        'SELECT grading_period_id, period_no, period_name, date_start, date_end
         FROM grading_periods
         WHERE school_year_id = :sy AND is_deleted = 0
         ORDER BY period_no ASC, grading_period_id ASC'
    );
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();

    return array_map(static fn(array $row): array => [
        'quarter' => (int)($row['period_no'] ?? 0),
        'grading_period_id' => (int)($row['grading_period_id'] ?? 0),
        'period_name' => (string)($row['period_name'] ?? ''),
        'date_start' => $row['date_start'] ?? null,
        'date_end' => $row['date_end'] ?? null,
    ], $stmt->fetchAll(PDO::FETCH_ASSOC));
}

function sf9_scope_periods_to_grading_policy(array $periods, array $gradingPolicy): array {
    return array_map(static function (array $period) use ($gradingPolicy): array {
        // The mode is stored once per School Year + Grade. Expose the resolved
        // value on every returned term so the report-card UI cannot fall back
        // to a different mode for one period.
        $period['grading_mode'] = $gradingPolicy['grading_mode'] ?? null;
        $period['sf9_template_variant'] = $gradingPolicy['sf9_template_variant'] ?? null;
        return $period;
    }, $periods);
}

function populateReportCardSnapshot(PDO $conn, int $reportCardId): void {
    $stmt = $conn->prepare(
        "SELECT rc.report_card_id, rc.enrollment_id, rc.grading_period_id,
                e.school_year_id, e.section_id,
                l.lrn,
                CONCAT(l.last_name, ', ', l.first_name,
                    CASE WHEN l.middle_name IS NULL OR l.middle_name = '' THEN '' ELSE CONCAT(' ', l.middle_name) END,
                    CASE WHEN l.name_extension IS NULL OR l.name_extension = '' THEN '' ELSE CONCAT(' ', l.name_extension) END
                ) AS learner_full_name,
                gl.grade_name,
                sec.section_name,
                sy.year_label,
                gp.date_start AS period_start,
                gp.date_end AS period_end
         FROM report_cards rc
         JOIN enrollments e ON e.enrollment_id = rc.enrollment_id
         JOIN learners l ON l.learner_id = e.learner_id
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         LEFT JOIN sections sec ON sec.section_id = e.section_id
         LEFT JOIN school_years sy ON sy.school_year_id = e.school_year_id
         LEFT JOIN grading_periods gp ON gp.grading_period_id = rc.grading_period_id
         WHERE rc.report_card_id = :report_card_id AND rc.is_deleted = 0
         LIMIT 1"
    );
    $stmt->bindValue(':report_card_id', $reportCardId, PDO::PARAM_INT);
    $stmt->execute();
    $header = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$header) {
        throw new Exception('Report card not found');
    }

    $gaStmt = $conn->prepare('SELECT general_average FROM general_averages WHERE enrollment_id = :enrollment_id AND is_deleted = 0 LIMIT 1');
    $gaStmt->bindValue(':enrollment_id', (int)$header['enrollment_id'], PDO::PARAM_INT);
    $gaStmt->execute();
    $generalAverage = $gaStmt->fetchColumn();

    $attStmt = $conn->prepare(
        "SELECT
            SUM(CASE WHEN status IN ('Half-day', 'HD') THEN 0.5
                     WHEN status IN ('Absent', 'Excused', 'NLPA') THEN 1
                     ELSE 0 END) AS days_absent,
            SUM(CASE WHEN status IN ('Present', 'Late', 'Cutting') THEN 1
                     WHEN status IN ('Half-day', 'HD') THEN 0.5
                     ELSE 0 END) AS days_present,
            SUM(CASE WHEN status IN ('Late', 'Cutting') THEN 1 ELSE 0 END) AS days_late
         FROM attendance
         WHERE enrollment_id = :enrollment_id
           AND grading_period_id = :grading_period_id
           AND (class_id IS NULL OR class_id = 0)
           AND session = 'AM'
           AND is_deleted = 0"
    );
    $attStmt->bindValue(':enrollment_id', (int)$header['enrollment_id'], PDO::PARAM_INT);
    $attStmt->bindValue(':grading_period_id', (int)$header['grading_period_id'], PDO::PARAM_INT);
    $attStmt->execute();
    $attRow = $attStmt->fetch(PDO::FETCH_ASSOC) ?: [];

    $daysAbsent = (float)($attRow['days_absent'] ?? 0);
    $daysPresent = (float)($attRow['days_present'] ?? 0);
    $daysLate = (int)($attRow['days_late'] ?? 0);

    // Present days are explicit attendance records. A blank/unrecorded day is
    // not inferred as present from the period calendar denominator.

    $upd = $conn->prepare(
        'UPDATE report_cards
         SET learner_name = :learner_name,
             lrn = :lrn,
             grade_level_name = :grade_level_name,
             section_name = :section_name,
             school_year_label = :school_year_label,
             general_average = :general_average,
             days_present = :days_present,
             days_absent = :days_absent,
             days_late = :days_late
         WHERE report_card_id = :report_card_id'
    );
    $upd->bindValue(':report_card_id', $reportCardId, PDO::PARAM_INT);
    $upd->bindValue(':learner_name', $header['learner_full_name']);
    $upd->bindValue(':lrn', $header['lrn']);
    $upd->bindValue(':grade_level_name', $header['grade_name']);
    $upd->bindValue(':section_name', $header['section_name']);
    $upd->bindValue(':school_year_label', $header['year_label']);
    if ($generalAverage === false || $generalAverage === null || $generalAverage === '') {
        $upd->bindValue(':general_average', null, PDO::PARAM_NULL);
    } else {
        $upd->bindValue(':general_average', $generalAverage);
    }

    $upd->bindValue(':days_present', $daysPresent);
    $upd->bindValue(':days_absent', $daysAbsent);
    $upd->bindValue(':days_late', $daysLate, PDO::PARAM_INT);
    $upd->execute();

    // Rebuild per-subject snapshot rows
    $del = $conn->prepare('DELETE FROM report_card_grades WHERE report_card_id = :report_card_id');
    $del->bindValue(':report_card_id', $reportCardId, PDO::PARAM_INT);
    $del->execute();

    $gradesStmt = $conn->prepare(
        "SELECT s.subject_name,
                g.quarterly_grade,
                fg.final_grade,
                fg.remark
         FROM class_offerings co
         JOIN subjects s ON s.subject_id = co.subject_id
         LEFT JOIN grades g
                ON g.enrollment_id = :grades_enrollment_id
               AND g.class_id = co.class_id
               AND g.grading_period_id = :grading_period_id
               AND g.is_deleted = 0
         LEFT JOIN final_grades fg
                ON fg.enrollment_id = :finals_enrollment_id
               AND fg.class_id = co.class_id
               AND fg.is_deleted = 0
         WHERE co.is_deleted = 0
           AND co.section_id = :section_id
           AND co.school_year_id = :school_year_id
           AND s.is_deleted = 0
         ORDER BY s.subject_name"
    );
    $gradesStmt->bindValue(':grades_enrollment_id', (int)$header['enrollment_id'], PDO::PARAM_INT);
    $gradesStmt->bindValue(':finals_enrollment_id', (int)$header['enrollment_id'], PDO::PARAM_INT);
    $gradesStmt->bindValue(':grading_period_id', (int)$header['grading_period_id'], PDO::PARAM_INT);
    $gradesStmt->bindValue(':section_id', (int)$header['section_id'], PDO::PARAM_INT);
    $gradesStmt->bindValue(':school_year_id', (int)$header['school_year_id'], PDO::PARAM_INT);
    $gradesStmt->execute();
    $rows = $gradesStmt->fetchAll(PDO::FETCH_ASSOC);

    if ($rows) {
        $ins = $conn->prepare(
            'INSERT INTO report_card_grades (report_card_id, subject_name, subject_code, quarterly_grade, final_grade, remark)
             VALUES (:report_card_id, :subject_name, :subject_code, :quarterly_grade, :final_grade, :remark)'
        );
        foreach ($rows as $r) {
            $ins->bindValue(':report_card_id', $reportCardId, PDO::PARAM_INT);
            $ins->bindValue(':subject_name', $r['subject_name']);
            $ins->bindValue(':subject_code', null, PDO::PARAM_NULL);

            if ($r['quarterly_grade'] === null || $r['quarterly_grade'] === '') {
                $ins->bindValue(':quarterly_grade', null, PDO::PARAM_NULL);
            } else {
                $ins->bindValue(':quarterly_grade', $r['quarterly_grade']);
            }
            if ($r['final_grade'] === null || $r['final_grade'] === '') {
                $ins->bindValue(':final_grade', null, PDO::PARAM_NULL);
            } else {
                $ins->bindValue(':final_grade', $r['final_grade']);
            }
            if ($r['remark'] === null || $r['remark'] === '') {
                $ins->bindValue(':remark', null, PDO::PARAM_NULL);
            } else {
                $ins->bindValue(':remark', $r['remark']);
            }

            $ins->execute();
        }
    }
}

function getAllReportCards(PDO $conn, array $session): void {
    $isTeacher = isTeacherLikeRole($session);
    $employeeId = $isTeacher ? getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0)) : 0;

    $sql = "SELECT rc.report_card_id, rc.enrollment_id, rc.grading_period_id, rc.generated_at, rc.generated_by, rc.file_path,
                   " . reportCardTemplateHistorySelect($conn, 'rc') . ",
                   CONCAT(l.last_name, ', ', l.first_name) AS learner_name,
                   gp.period_name,
                   u.username AS generated_by_name
            FROM report_cards rc
            JOIN enrollments e ON rc.enrollment_id = e.enrollment_id
            JOIN learners l ON e.learner_id = l.learner_id
            JOIN grading_periods gp ON rc.grading_period_id = gp.grading_period_id
            LEFT JOIN (" . user_identity_derived_sql() . ") u ON rc.generated_by = u.user_id
            WHERE rc.is_deleted = 0";

    if ($isTeacher) {
        $sql .= " AND EXISTS (
                    SELECT 1
                    FROM sections s
                    JOIN school_years sy ON sy.school_year_id = s.school_year_id AND sy.is_deleted = 0
                    WHERE s.section_id = e.section_id
                      AND s.school_year_id = e.school_year_id
                      AND s.is_deleted = 0
                      AND EXISTS (
                          SELECT 1
                          FROM class_offerings co
                          WHERE co.section_id = s.section_id
                            AND co.school_year_id = s.school_year_id
                            AND co.teacher_id = :teacher_id_offering
                            AND co.is_deleted = 0
                      )
                 )";
    }

    $sql .= " ORDER BY rc.report_card_id DESC";
    $stmt = $conn->prepare($sql);
    if ($isTeacher) {
        $stmt->bindValue(':teacher_id_offering', $employeeId, PDO::PARAM_INT);
    }
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function ensureTeacherCanAccessSection(PDO $conn, array $session, int $sectionId, int $schoolYearId = 0): void {
    if (!isTeacherLikeRole($session)) return;

    $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
    $sql = "SELECT 1
            FROM sections s
            JOIN school_years sy ON sy.school_year_id = s.school_year_id AND sy.is_deleted = 0
            WHERE s.section_id = :section_id
              AND s.is_deleted = 0
              AND EXISTS (
                  SELECT 1
                  FROM class_offerings co
                  WHERE co.section_id = s.section_id
                    AND co.school_year_id = s.school_year_id
                    AND co.teacher_id = :employee_id_offering
                    AND co.is_deleted = 0
              )";
    if ($schoolYearId > 0) {
        $sql .= " AND s.school_year_id = :school_year_id";
    }
    $sql .= " LIMIT 1";

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':employee_id_offering', $employeeId, PDO::PARAM_INT);
    if ($schoolYearId > 0) {
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    }
    $stmt->execute();
    if (!$stmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Access denied: You can only load report cards for sections assigned to you'], 403);
    }
}

function getSF9Data(PDO $conn, array $session): void {
    $reportCardId = (int)($_GET['report_card_id'] ?? 0);
    if ($reportCardId <= 0) {
        respond(['success' => false, 'message' => 'report_card_id is required'], 422);
    }

    $stmt = $conn->prepare(
        "SELECT rc.report_card_id,
                rc.enrollment_id,
                " . reportCardTemplateHistorySelect($conn, 'rc') . ",
                e.school_year_id,
                e.section_id,
                e.grade_level_id,
                e.curriculum_id,
                l.learner_id,
                l.user_id AS learner_user_id,
                l.lrn,
                l.first_name,
                l.middle_name,
                l.last_name,
                l.name_extension,
                l.gender,
                l.date_of_birth,
                gl.grade_name,
                sec.section_name,
                sec.adviser_id,
                sy.year_label,
                sy.year_start,
                sy.year_end,
                sy.date_start AS school_year_date_start,
                sy.date_end AS school_year_date_end,
                sy.grading_system_type
         FROM report_cards rc
         JOIN enrollments e ON e.enrollment_id = rc.enrollment_id
         JOIN learners l ON l.learner_id = e.learner_id
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         LEFT JOIN sections sec ON sec.section_id = e.section_id
         LEFT JOIN school_years sy ON sy.school_year_id = e.school_year_id
         WHERE rc.report_card_id = :rid AND rc.is_deleted = 0
         LIMIT 1"
    );
    $stmt->bindValue(':rid', $reportCardId, PDO::PARAM_INT);
    $stmt->execute();
    $h = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$h) {
        respond(['success' => false, 'message' => 'Report card not found'], 404);
    }
    if (($session['role_key'] ?? '') === 'learners') {
        if ((int)($h['learner_user_id'] ?? 0) !== (int)($session['user_id'] ?? 0)) {
            respond(['success' => false, 'message' => 'Not authorized for this report card'], 403);
        }
    }
    ensureTeacherCanAccessSection($conn, $session, (int)($h['section_id'] ?? 0), (int)($h['school_year_id'] ?? 0));
    // Keep persisted snapshot in sync whenever SF9 is opened.
    try {
        populateReportCardSnapshot($conn, $reportCardId);
    } catch (Throwable $_) {
        // Non-fatal: SF9 should still render from live tables.
    }

    $schoolYearId = (int)($h['school_year_id'] ?? 0);
    $sectionId = (int)($h['section_id'] ?? 0);
    $enrollmentId = (int)($h['enrollment_id'] ?? 0);
    $gradingPolicy = GradingPolicyService::resolve(
        $conn,
        $schoolYearId,
        (int)($h['grade_level_id'] ?? 0),
        $h['grade_name'] ?? null
    );
    $reportCardTemplate = ReportCardTemplateService::fromSnapshot($h);
    if (!$reportCardTemplate) {
        $reportCardTemplate = ReportCardTemplateService::resolve(
            $conn,
            $schoolYearId,
            (int)($h['grade_level_id'] ?? 0),
            $gradingPolicy['sf9_template_variant'],
            $gradingPolicy['grading_mode']
        );
        // Legacy rows predate template binding. Capture the best available
        // template once, so future reads no longer follow a newer version.
        bindReportCardTemplate($conn, $reportCardId, $reportCardTemplate);
    }

    $learnerName = formatPersonName($h['first_name'] ?? null, $h['middle_name'] ?? null, $h['last_name'] ?? null, $h['name_extension'] ?? null);
    $age = computeAge($h['date_of_birth'] ?? null, null);

    $adviserName = '';
    $adviserId = (int)($h['adviser_id'] ?? 0);
    if ($adviserId > 0) {
        $a = $conn->prepare('SELECT first_name, middle_name, last_name, name_extension FROM employees WHERE employee_id = :eid AND is_deleted = 0 LIMIT 1');
        $a->bindValue(':eid', $adviserId, PDO::PARAM_INT);
        $a->execute();
        $ar = $a->fetch(PDO::FETCH_ASSOC);
        if ($ar) {
            $adviserName = formatPersonName($ar['first_name'] ?? null, $ar['middle_name'] ?? null, $ar['last_name'] ?? null, $ar['name_extension'] ?? null);
        }
    }

    $settings = getSchoolSettingsMap($conn);
    $principalName = getActivePrincipalName($conn);
    // Default logo for SF9 header (frontend may override if needed)
    $defaultLogoUrl = sf9_logo_asset_url('logo.png');

    $quarters = reportCardPeriodsFromSnapshot($h['periods_snapshot_json'] ?? null);
    if (!$quarters) {
        $quarters = $schoolYearId > 0 ? getQuarterGradingPeriods($conn, $schoolYearId) : sf9_default_periods((string)($h['grading_system_type'] ?? 'Quarterly'));
        if (!$quarters) {
            $quarters = sf9_default_periods((string)($h['grading_system_type'] ?? 'Quarterly'));
        }
        $quarters = sf9_scope_periods_to_grading_policy($quarters, $gradingPolicy);
        // Legacy rows predate period binding. Capture the best available
        // period list once, while new cards bind it at creation time.
        bindReportCardPeriods($conn, $reportCardId, $quarters);
    }
    $quarterIds = array_values(array_filter(array_map(fn($q) => (int)($q['grading_period_id'] ?? 0), $quarters), fn($id) => $id > 0));

    // Curriculum subjects define the preview rows; active offerings only attach
    // class IDs used to read grades for this enrollment and school year.
    $subjects = sf9_fetch_assigned_subjects($conn, $sectionId, $schoolYearId, (int)($h['grade_level_id'] ?? 0), (int)($h['curriculum_id'] ?? 0));
    $mapehComponentSubjects = sf9_fetch_mapeh_component_subjects($conn, $sectionId, $schoolYearId, (int)($h['grade_level_id'] ?? 0), (int)($h['curriculum_id'] ?? 0));
    $classIds = sf9_collect_subject_class_ids(array_merge($subjects, $mapehComponentSubjects));

    $gradesByClass = []; // [class_id][grading_period_id] = ['grade_id'=>..,'quarterly_grade'=>..]
    if ($enrollmentId > 0 && $classIds && $quarterIds) {
        $inClass = implode(',', array_fill(0, count($classIds), '?'));
        $inQ = implode(',', array_fill(0, count($quarterIds), '?'));
        $sql = "SELECT g.grade_id, g.class_id, g.grading_period_id, g.quarterly_grade
                FROM grades g
                JOIN (
                    SELECT class_id, grading_period_id, MAX(grade_id) AS latest_grade_id
                    FROM grades
                    WHERE enrollment_id = ?
                      AND is_deleted = 0
                      AND class_id IN ({$inClass})
                      AND grading_period_id IN ({$inQ})
                    GROUP BY class_id, grading_period_id
                ) pick ON pick.latest_grade_id = g.grade_id";
        $g = $conn->prepare($sql);
        $i = 1;
        $g->bindValue($i++, $enrollmentId, PDO::PARAM_INT);
        foreach ($classIds as $cid) $g->bindValue($i++, $cid, PDO::PARAM_INT);
        foreach ($quarterIds as $qid) $g->bindValue($i++, $qid, PDO::PARAM_INT);
        $g->execute();
        foreach ($g->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $cid = (int)($r['class_id'] ?? 0);
            $qid = (int)($r['grading_period_id'] ?? 0);
            if ($cid <= 0 || $qid <= 0) continue;
            if (!isset($gradesByClass[$cid])) $gradesByClass[$cid] = [];
            $gradesByClass[$cid][$qid] = [
                'grade_id' => (int)($r['grade_id'] ?? 0),
                'quarterly_grade' => $r['quarterly_grade'],
            ];
        }
    }

    $finalByClass = []; // [class_id] = ['final_grade_id'=>..,'final_grade'=>...,'remark'=>...]
    if ($enrollmentId > 0 && $classIds) {
        $inClass = implode(',', array_fill(0, count($classIds), '?'));
        $sql = "SELECT fg.final_grade_id, fg.class_id, fg.final_grade, fg.remark
                FROM final_grades fg
                JOIN (
                    SELECT class_id, MAX(final_grade_id) AS latest_final_grade_id
                    FROM final_grades
                    WHERE enrollment_id = ?
                      AND is_deleted = 0
                      AND class_id IN ({$inClass})
                    GROUP BY class_id
                ) pick ON pick.latest_final_grade_id = fg.final_grade_id";
        $fg = $conn->prepare($sql);
        $i = 1;
        $fg->bindValue($i++, $enrollmentId, PDO::PARAM_INT);
        foreach ($classIds as $cid) $fg->bindValue($i++, $cid, PDO::PARAM_INT);
        $fg->execute();
        foreach ($fg->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $cid = (int)($r['class_id'] ?? 0);
            if ($cid <= 0) continue;
            $finalByClass[$cid] = [
                'final_grade_id' => (int)($r['final_grade_id'] ?? 0),
                'final_grade' => $r['final_grade'],
                'remark' => $r['remark'],
            ];
        }
    }

    // Deduplicate learning areas so one subject appears once.
    if ($subjects) {
        $bucketed = [];
        foreach ($subjects as $s) {
            $key = sf9_subject_key($s['subject_code'] ?? null, $s['subject_name'] ?? null);
            if (!isset($bucketed[$key])) $bucketed[$key] = [];
            $bucketed[$key][] = $s;
        }
        $deduped = [];
        foreach ($bucketed as $candidates) {
            $best = sf9_pick_best_subject_row($candidates, $gradesByClass, $finalByClass, $quarters);
            $best['_candidate_class_ids'] = array_values(array_filter(array_map(
                fn($x) => (int)($x['class_id'] ?? 0),
                $candidates
            ), fn($id) => $id > 0));
            $deduped[] = $best;
        }
        usort($deduped, static function (array $a, array $b): int {
            $orderA = (int)($a['sort_order'] ?? 9999);
            $orderB = (int)($b['sort_order'] ?? 9999);
            if ($orderA !== $orderB) return $orderA <=> $orderB;
            return strcmp((string)($a['subject_name'] ?? ''), (string)($b['subject_name'] ?? ''));
        });
        $subjects = $deduped;
    }

    $hasMapehParentSubject = false;
    foreach ($subjects as $s) {
        if (sf9_is_mapeh_parent_row($s)) {
            $hasMapehParentSubject = true;
            break;
        }
    }
    $mapehComponentKeys = [];
    if ($hasMapehParentSubject && $mapehComponentSubjects) {
        foreach ($mapehComponentSubjects as $component) {
            $mapehComponentKeys[sf9_subject_key($component['subject_code'] ?? null, $component['subject_name'] ?? null)] = true;
        }
    }

    $gradeRows = [];
    foreach ($subjects as $s) {
        $subjectKey = sf9_subject_key($s['subject_code'] ?? null, $s['subject_name'] ?? null);
        if ($hasMapehParentSubject && isset($mapehComponentKeys[$subjectKey]) && !sf9_is_mapeh_parent_row($s)) {
            continue;
        }
        $row = sf9_build_grade_row($s, $quarters, $gradesByClass, $finalByClass);
        if (sf9_is_mapeh_parent_row($s) && $mapehComponentSubjects) {
            $row['component_grades'] = array_map(
                static function (array $component) use ($quarters, $gradesByClass, $finalByClass): array {
                    $componentRow = sf9_build_grade_row($component, $quarters, $gradesByClass, $finalByClass);
                    $componentRow['is_curriculum_subject'] = !array_key_exists('is_curriculum_subject', $component)
                        || (bool)$component['is_curriculum_subject'];
                    return $componentRow;
                },
                $mapehComponentSubjects
            );
        }
        $gradeRows[] = $row;
    }

    $gaStmt = $conn->prepare('SELECT general_average FROM general_averages WHERE enrollment_id = :eid AND is_deleted = 0 LIMIT 1');
    $gaStmt->bindValue(':eid', $enrollmentId, PDO::PARAM_INT);
    $gaStmt->execute();
    $generalAverage = $gaStmt->fetchColumn();
    if ($generalAverage === false || $generalAverage === null || $generalAverage === '') {
        $generalAverage = null;
    }

    // Attendance record (monthly): prefer stored summaries, fallback to computed from raw attendance.
    $yearStart = isset($h['year_start']) ? (int)$h['year_start'] : null;
    $yearEnd = isset($h['year_end']) ? (int)$h['year_end'] : null;
    $schoolYearDateStart = $h['school_year_date_start'] ?? null;
    $schoolYearDateEnd = $h['school_year_date_end'] ?? null;
    if (!$schoolYearDateStart || !$schoolYearDateEnd) {
        [$periodDateStart, $periodDateEnd] = sf9_period_date_range($quarters);
        $schoolYearDateStart = $schoolYearDateStart ?: $periodDateStart;
        $schoolYearDateEnd = $schoolYearDateEnd ?: $periodDateEnd;
    }
    if ((!$schoolYearDateStart || !$schoolYearDateEnd) && $enrollmentId > 0) {
        [$attendanceDateStart, $attendanceDateEnd] = sf9_attendance_date_range($conn, $enrollmentId);
        $schoolYearDateStart = $schoolYearDateStart ?: $attendanceDateStart;
        $schoolYearDateEnd = $schoolYearDateEnd ?: $attendanceDateEnd;
    }

    $stored = [];
    if ($enrollmentId > 0 && $schoolYearId > 0) {
        $as = $conn->prepare(
            'SELECT month_no, total_school_days, days_present, days_absent, days_late, days_excused
             FROM attendance_monthly_summaries
             WHERE enrollment_id = :eid AND school_year_id = :sy AND is_deleted = 0'
        );
        $as->bindValue(':eid', $enrollmentId, PDO::PARAM_INT);
        $as->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $as->execute();
        foreach ($as->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $m = (int)($r['month_no'] ?? 0);
            if ($m < 1 || $m > 12) continue;
            $stored[$m] = $r;
        }
    }

    $months = sf9_months($yearStart, $yearEnd, $schoolYearDateStart, $schoolYearDateEnd);
    $attendanceMonths = [];
    $totSchool = 0;
    $totPresent = 0;
    $totAbsent = 0;
    $totLate = 0;

    foreach ($months as $m) {
        $monthNo = (int)$m['month'];
        $schoolDays = null;
        $present = null;
        $absent = null;
        $late = null;
        $closedDays = 0;

        if (isset($stored[$monthNo])) {
            $row = $stored[$monthNo];
            $schoolDays = (int)($row['total_school_days'] ?? 0);
            $present = (float)($row['days_present'] ?? 0);
            $absent = (float)($row['days_absent'] ?? 0);
            $late = (int)($row['days_late'] ?? 0);
        }

        if ($enrollmentId > 0) {
            [$start, $end] = sf9_clipped_month_bounds((int)$m['year'], $monthNo, $schoolYearDateStart, $schoolYearDateEnd);
            $att = $conn->prepare(
                "SELECT
                    SUM(CASE WHEN a.status IN ('P', 'Present', 'Official Business', 'Late', 'Cutting') THEN 1
                             WHEN a.status IN ('Half-day', 'HD') THEN 0.5
                             ELSE 0 END) AS days_present,
                    SUM(CASE WHEN a.status IN ('Half-day', 'HD') THEN 0.5
                             WHEN a.status IN ('Absent', 'Excused', 'NLPA') THEN 1
                             ELSE 0 END) AS days_absent,
                    SUM(CASE WHEN a.status IN ('Late', 'Cutting') THEN 1 ELSE 0 END) AS days_late,
                    COUNT(DISTINCT CASE WHEN a.status IN ('Holiday', 'No Classes') THEN a.attendance_date END) AS closed_days
                 FROM attendance a
                 WHERE a.enrollment_id = :eid
                   AND a.is_deleted = 0
                   AND (a.class_id IS NULL OR a.class_id = 0)
                   AND a.session = 'AM'
                   AND a.attendance_id = (
                       SELECT MAX(a2.attendance_id)
                       FROM attendance a2
                       WHERE a2.enrollment_id = a.enrollment_id
                         AND a2.attendance_date = a.attendance_date
                         AND (a2.class_id IS NULL OR a2.class_id = 0)
                         AND a2.session = 'AM'
                         AND a2.is_deleted = 0
                   )
                   AND a.attendance_date BETWEEN :start_date AND :end_date"
            );
            $att->bindValue(':eid', $enrollmentId, PDO::PARAM_INT);
            $att->bindValue(':start_date', $start);
            $att->bindValue(':end_date', $end);
            $att->execute();
            $ar = $att->fetch(PDO::FETCH_ASSOC) ?: [];
            if (!isset($stored[$monthNo])) {
                $present = (float)($ar['days_present'] ?? 0);
                $absent = (float)($ar['days_absent'] ?? 0);
                $late = (int)($ar['days_late'] ?? 0);
            }
            $closedDays = (int)($ar['closed_days'] ?? 0);
        }

        if ($schoolDays === null) {
            // Weekday count as safe default when no monthly summary exists.
            [$start, $end] = sf9_clipped_month_bounds((int)$m['year'], $monthNo, $schoolYearDateStart, $schoolYearDateEnd);
            $schoolDays = max(0, sf9_count_weekdays($start, $end) - $closedDays);
        }
        if ($present === null) {
            $present = 0.0;
        }

        $attendanceMonths[] = [
            'label' => $m['label'],
            'month_no' => $monthNo,
            'year' => (int)$m['year'],
            'total_school_days' => $schoolDays,
            'days_present' => $present,
            'days_absent' => $absent,
            'times_tardy' => $late,
        ];

        $totSchool += (int)$schoolDays;
        $totPresent += (float)($present ?? 0);
        $totAbsent += (float)($absent ?? 0);
        $totLate += (int)($late ?? 0);
    }

    $payload = [
        'success' => true,
        'report_card_id' => $reportCardId,
        'enrollment_id' => $enrollmentId,
        'learner' => [
            'name' => $learnerName,
            'lrn' => $h['lrn'] ?? null,
            'sex' => $h['gender'] ?? null,
            'date_of_birth' => $h['date_of_birth'] ?? null,
            'age' => $age,
        ],
        'enrollment' => [
            'grade_level' => $h['grade_name'] ?? null,
            'section' => $h['section_name'] ?? null,
            'school_year' => $h['year_label'] ?? null,
            'school_year_id' => $schoolYearId,
            'grading_system_type' => $h['grading_system_type'] ?? 'Quarterly',
            'section_id' => $sectionId,
            'grading_mode' => $gradingPolicy['grading_mode'],
            'sf9_template_variant' => $gradingPolicy['sf9_template_variant'],
            'supports_term_comments' => $gradingPolicy['supports_term_comments'],
        ],
        'template' => $reportCardTemplate,
        'school' => [
            'school_id' => $settings['school_id'] ?? ($settings['schoolId'] ?? null),
            'school_name' => $settings['school_name'] ?? ($settings['schoolName'] ?? null),
            'region' => $settings['region'] ?? ($settings['school_region'] ?? null),
            'division' => $settings['division'] ?? ($settings['school_division'] ?? null),
            'district' => $settings['district'] ?? ($settings['school_district'] ?? null),
            'school_head' => $principalName,
            'logo_url' => $settings['logo_url'] ?? ($settings['school_logo_url'] ?? $defaultLogoUrl),
            'deped_logo_url' => $settings['deped_logo_url'] ?? sf9_logo_asset_url('Seal_of_the_Department_of_Education_of_the_Philippines.png'),
        ],
        'adviser' => [
            'name' => $adviserName,
        ],
        'quarters' => $quarters,
        'grades' => $gradeRows,
        'general_average' => $generalAverage,
        'core_values' => sf9_should_include_observed_values($gradingPolicy)
            ? sf9_observed_values_for_enrollment($conn, $enrollmentId, $quarters)
            : [],
        'term_comments' => sf9_term_comments_for_enrollment($conn, $enrollmentId, $quarters),
        'pace_ratings' => strtolower((string)($gradingPolicy['grading_mode'] ?? '')) === 'descriptive'
            && strtoupper((string)($gradingPolicy['sf9_template_variant'] ?? '')) === 'G1'
                ? sf9_pace_ratings_for_enrollment($conn, $enrollmentId, $quarters)
                : [],
        'attendance' => [
            'months' => $attendanceMonths,
            'totals' => [
                'total_school_days' => $totSchool,
                'days_present' => $totPresent,
                'days_absent' => $totAbsent,
                'times_tardy' => $totLate,
            ]
        ],
    ];

    respond($payload);
}

function getSF9DataByEnrollment(PDO $conn, array $session): void {
    $enrollmentId = (int)($_GET['enrollment_id'] ?? 0);
    if ($enrollmentId <= 0) {
        respond(['success' => false, 'message' => 'enrollment_id is required'], 422);
    }

    $stmt = $conn->prepare(
        "SELECT e.enrollment_id,
                e.learner_id,
                e.school_year_id,
                e.section_id,
                e.grade_level_id,
                e.curriculum_id,
                l.lrn,
                l.first_name,
                l.middle_name,
                l.last_name,
                l.name_extension,
                l.gender,
                l.date_of_birth,
                gl.grade_name,
                l.mother_tongue,
                el.level_name AS education_level_name,
                sec.section_name,
                sec.adviser_id,
                sy.year_label,
                sy.year_start,
                sy.year_end,
                sy.date_start AS school_year_date_start,
                sy.date_end AS school_year_date_end,
                sy.grading_system_type
         FROM enrollments e
         JOIN learners l ON l.learner_id = e.learner_id
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         LEFT JOIN education_levels el ON el.education_level_id = gl.education_level_id
         LEFT JOIN sections sec ON sec.section_id = e.section_id
         LEFT JOIN school_years sy ON sy.school_year_id = e.school_year_id
         WHERE e.enrollment_id = :eid AND e.is_deleted = 0
         LIMIT 1"
    );
    $stmt->bindValue(':eid', $enrollmentId, PDO::PARAM_INT);
    $stmt->execute();
    $h = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$h) {
        respond(['success' => false, 'message' => 'Enrollment not found'], 404);
    }

    if (($session['role_key'] ?? '') === 'learners') {
        $uStmt = $conn->prepare('SELECT user_id FROM learners WHERE learner_id = :lid AND is_deleted = 0 LIMIT 1');
        $uStmt->bindValue(':lid', (int)($h['learner_id'] ?? 0), PDO::PARAM_INT);
        $uStmt->execute();
        $learnerUserId = (int)($uStmt->fetchColumn() ?: 0);
        if ($learnerUserId <= 0 || $learnerUserId !== (int)($session['user_id'] ?? 0)) {
            respond(['success' => false, 'message' => 'Not authorized for this report card'], 403);
        }
    }

    ensureTeacherCanAccessSection($conn, $session, (int)($h['section_id'] ?? 0), (int)($h['school_year_id'] ?? 0));

    $schoolYearId = (int)($h['school_year_id'] ?? 0);
    $sectionId = (int)($h['section_id'] ?? 0);
    $gradingPolicy = GradingPolicyService::resolve(
        $conn,
        $schoolYearId,
        (int)($h['grade_level_id'] ?? 0),
        $h['grade_name'] ?? null
    );
    $reportCardTemplate = ReportCardTemplateService::resolve(
        $conn,
        $schoolYearId,
        (int)($h['grade_level_id'] ?? 0),
        $gradingPolicy['sf9_template_variant'],
        $gradingPolicy['grading_mode']
    );

    $learnerName = formatPersonName($h['first_name'] ?? null, $h['middle_name'] ?? null, $h['last_name'] ?? null, $h['name_extension'] ?? null);
    $age = computeAge($h['date_of_birth'] ?? null, null);

    $adviserName = '';
    $adviserId = (int)($h['adviser_id'] ?? 0);
    if ($adviserId > 0) {
        $a = $conn->prepare('SELECT first_name, middle_name, last_name, name_extension FROM employees WHERE employee_id = :eid AND is_deleted = 0 LIMIT 1');
        $a->bindValue(':eid', $adviserId, PDO::PARAM_INT);
        $a->execute();
        $ar = $a->fetch(PDO::FETCH_ASSOC);
        if ($ar) {
            $adviserName = formatPersonName($ar['first_name'] ?? null, $ar['middle_name'] ?? null, $ar['last_name'] ?? null, $ar['name_extension'] ?? null);
        }
    }

    $settings = getSchoolSettingsMap($conn);
    $principalName = getActivePrincipalName($conn);
    $defaultLogoUrl = sf9_logo_asset_url('logo.png');
    $curriculumLevel = sf9_infer_curriculum_level(
        $settings['curriculum_level'] ?? null,
        $h['education_level_name'] ?? null,
        $h['grade_name'] ?? null
    );
    $quarters = $schoolYearId > 0 ? getQuarterGradingPeriods($conn, $schoolYearId) : sf9_default_periods((string)($h['grading_system_type'] ?? 'Quarterly'));
    if (!$quarters) {
        $quarters = sf9_default_periods((string)($h['grading_system_type'] ?? 'Quarterly'));
    }
    $quarters = sf9_scope_periods_to_grading_policy($quarters, $gradingPolicy);
    $quarterIds = array_values(array_filter(array_map(fn($q) => (int)($q['grading_period_id'] ?? 0), $quarters), fn($id) => $id > 0));

    $subjects = sf9_fetch_assigned_subjects($conn, $sectionId, $schoolYearId, (int)($h['grade_level_id'] ?? 0), (int)($h['curriculum_id'] ?? 0));
    $mapehComponentSubjects = sf9_fetch_mapeh_component_subjects($conn, $sectionId, $schoolYearId, (int)($h['grade_level_id'] ?? 0), (int)($h['curriculum_id'] ?? 0));
    $classIds = sf9_collect_subject_class_ids(array_merge($subjects, $mapehComponentSubjects));

    $gradesByClass = []; // [class_id][grading_period_id] = ['grade_id'=>..,'quarterly_grade'=>..]
    if ($enrollmentId > 0 && $classIds && $quarterIds) {
        $inClass = implode(',', array_fill(0, count($classIds), '?'));
        $inQ = implode(',', array_fill(0, count($quarterIds), '?'));
        $sql = "SELECT g.grade_id, g.class_id, g.grading_period_id, g.quarterly_grade
                FROM grades g
                JOIN (
                    SELECT class_id, grading_period_id, MAX(grade_id) AS latest_grade_id
                    FROM grades
                    WHERE enrollment_id = ?
                      AND is_deleted = 0
                      AND class_id IN ({$inClass})
                      AND grading_period_id IN ({$inQ})
                    GROUP BY class_id, grading_period_id
                ) pick ON pick.latest_grade_id = g.grade_id";
        $g = $conn->prepare($sql);
        $i = 1;
        $g->bindValue($i++, $enrollmentId, PDO::PARAM_INT);
        foreach ($classIds as $cid) $g->bindValue($i++, $cid, PDO::PARAM_INT);
        foreach ($quarterIds as $qid) $g->bindValue($i++, $qid, PDO::PARAM_INT);
        $g->execute();
        foreach ($g->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $cid = (int)($r['class_id'] ?? 0);
            $qid = (int)($r['grading_period_id'] ?? 0);
            if ($cid <= 0 || $qid <= 0) continue;
            if (!isset($gradesByClass[$cid])) $gradesByClass[$cid] = [];
            $gradesByClass[$cid][$qid] = [
                'grade_id' => (int)($r['grade_id'] ?? 0),
                'quarterly_grade' => $r['quarterly_grade'],
            ];
        }
    }

    $finalByClass = []; // [class_id] = ['final_grade_id'=>..,'final_grade'=>...,'remark'=>...]
    if ($enrollmentId > 0 && $classIds) {
        $inClass = implode(',', array_fill(0, count($classIds), '?'));
        $sql = "SELECT fg.final_grade_id, fg.class_id, fg.final_grade, fg.remark
                FROM final_grades fg
                JOIN (
                    SELECT class_id, MAX(final_grade_id) AS latest_final_grade_id
                    FROM final_grades
                    WHERE enrollment_id = ?
                      AND is_deleted = 0
                      AND class_id IN ({$inClass})
                    GROUP BY class_id
                ) pick ON pick.latest_final_grade_id = fg.final_grade_id";
        $fg = $conn->prepare($sql);
        $i = 1;
        $fg->bindValue($i++, $enrollmentId, PDO::PARAM_INT);
        foreach ($classIds as $cid) $fg->bindValue($i++, $cid, PDO::PARAM_INT);
        $fg->execute();
        foreach ($fg->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $cid = (int)($r['class_id'] ?? 0);
            if ($cid <= 0) continue;
            $finalByClass[$cid] = [
                'final_grade_id' => (int)($r['final_grade_id'] ?? 0),
                'final_grade' => $r['final_grade'],
                'remark' => $r['remark'],
            ];
        }
    }

    // Deduplicate learning areas (some sections may have multiple class offerings per subject)
    if ($subjects) {
        $bucketed = [];
        foreach ($subjects as $s) {
            $key = sf9_subject_key($s['subject_code'] ?? null, $s['subject_name'] ?? null);
            if (!isset($bucketed[$key])) $bucketed[$key] = [];
            $bucketed[$key][] = $s;
        }
        $deduped = [];
        foreach ($bucketed as $candidates) {
            $best = sf9_pick_best_subject_row($candidates, $gradesByClass, $finalByClass, $quarters);
            $best['_candidate_class_ids'] = array_values(array_filter(array_map(
                fn($x) => (int)($x['class_id'] ?? 0),
                $candidates
            ), fn($id) => $id > 0));
            $deduped[] = $best;
        }
        usort($deduped, static function (array $a, array $b): int {
            $orderA = (int)($a['sort_order'] ?? 9999);
            $orderB = (int)($b['sort_order'] ?? 9999);
            if ($orderA !== $orderB) return $orderA <=> $orderB;
            return strcmp((string)($a['subject_name'] ?? ''), (string)($b['subject_name'] ?? ''));
        });
        $subjects = $deduped;
    }

    $hasMapehParentSubject = false;
    foreach ($subjects as $s) {
        if (sf9_is_mapeh_parent_row($s)) {
            $hasMapehParentSubject = true;
            break;
        }
    }
    $mapehComponentKeys = [];
    if ($hasMapehParentSubject && $mapehComponentSubjects) {
        foreach ($mapehComponentSubjects as $component) {
            $mapehComponentKeys[sf9_subject_key($component['subject_code'] ?? null, $component['subject_name'] ?? null)] = true;
        }
    }

    $gradeRows = [];
    foreach ($subjects as $s) {
        $subjectKey = sf9_subject_key($s['subject_code'] ?? null, $s['subject_name'] ?? null);
        if ($hasMapehParentSubject && isset($mapehComponentKeys[$subjectKey]) && !sf9_is_mapeh_parent_row($s)) {
            continue;
        }
        $row = sf9_build_grade_row($s, $quarters, $gradesByClass, $finalByClass, $curriculumLevel);
        if (sf9_is_mapeh_parent_row($s) && $mapehComponentSubjects) {
            $row['component_grades'] = array_map(
                static function (array $component) use ($quarters, $gradesByClass, $finalByClass, $curriculumLevel): array {
                    $componentRow = sf9_build_grade_row($component, $quarters, $gradesByClass, $finalByClass, $curriculumLevel);
                    $componentRow['is_curriculum_subject'] = !array_key_exists('is_curriculum_subject', $component)
                        || (bool)$component['is_curriculum_subject'];
                    return $componentRow;
                },
                $mapehComponentSubjects
            );
        }
        $gradeRows[] = $row;
    }

    $gaStmt = $conn->prepare('SELECT general_average FROM general_averages WHERE enrollment_id = :eid AND is_deleted = 0 LIMIT 1');
    $gaStmt->bindValue(':eid', $enrollmentId, PDO::PARAM_INT);
    $gaStmt->execute();
    $generalAverage = $gaStmt->fetchColumn();
    if ($generalAverage === false || $generalAverage === null || $generalAverage === '') {
        $generalAverage = null;
    }

    $yearStart = isset($h['year_start']) ? (int)$h['year_start'] : null;
    $yearEnd = isset($h['year_end']) ? (int)$h['year_end'] : null;
    $schoolYearDateStart = $h['school_year_date_start'] ?? null;
    $schoolYearDateEnd = $h['school_year_date_end'] ?? null;
    if (!$schoolYearDateStart || !$schoolYearDateEnd) {
        [$periodDateStart, $periodDateEnd] = sf9_period_date_range($quarters);
        $schoolYearDateStart = $schoolYearDateStart ?: $periodDateStart;
        $schoolYearDateEnd = $schoolYearDateEnd ?: $periodDateEnd;
    }
    if ((!$schoolYearDateStart || !$schoolYearDateEnd) && $enrollmentId > 0) {
        [$attendanceDateStart, $attendanceDateEnd] = sf9_attendance_date_range($conn, $enrollmentId);
        $schoolYearDateStart = $schoolYearDateStart ?: $attendanceDateStart;
        $schoolYearDateEnd = $schoolYearDateEnd ?: $attendanceDateEnd;
    }

    $stored = [];
    if ($enrollmentId > 0 && $schoolYearId > 0) {
        $as = $conn->prepare(
            'SELECT month_no, total_school_days, days_present, days_absent, days_late, days_excused
             FROM attendance_monthly_summaries
             WHERE enrollment_id = :eid AND school_year_id = :sy AND is_deleted = 0'
        );
        $as->bindValue(':eid', $enrollmentId, PDO::PARAM_INT);
        $as->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $as->execute();
        foreach ($as->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $m = (int)($r['month_no'] ?? 0);
            if ($m < 1 || $m > 12) continue;
            $stored[$m] = $r;
        }
    }

    $months = sf9_months($yearStart, $yearEnd, $schoolYearDateStart, $schoolYearDateEnd);
    $attendanceMonths = [];
    $totSchool = 0;
    $totPresent = 0;
    $totAbsent = 0;
    $totLate = 0;

    foreach ($months as $m) {
        $monthNo = (int)$m['month'];
        $schoolDays = null;
        $present = null;
        $absent = null;
        $late = null;
        $closedDays = 0;

        if (isset($stored[$monthNo])) {
            $row = $stored[$monthNo];
            $schoolDays = (int)($row['total_school_days'] ?? 0);
            $present = (float)($row['days_present'] ?? 0);
            $absent = (float)($row['days_absent'] ?? 0);
            $late = (int)($row['days_late'] ?? 0);
        }

        if ($enrollmentId > 0) {
            [$start, $end] = sf9_clipped_month_bounds((int)$m['year'], $monthNo, $schoolYearDateStart, $schoolYearDateEnd);
            $att = $conn->prepare(
                "SELECT
                    SUM(CASE WHEN a.status IN ('P', 'Present', 'Official Business', 'Late', 'Cutting') THEN 1
                             WHEN a.status IN ('Half-day', 'HD') THEN 0.5
                             ELSE 0 END) AS days_present,
                    SUM(CASE WHEN a.status IN ('Half-day', 'HD') THEN 0.5
                             WHEN a.status IN ('Absent', 'Excused', 'NLPA') THEN 1
                             ELSE 0 END) AS days_absent,
                    SUM(CASE WHEN a.status IN ('Late', 'Cutting') THEN 1 ELSE 0 END) AS days_late,
                    COUNT(DISTINCT CASE WHEN a.status IN ('Holiday', 'No Classes') THEN a.attendance_date END) AS closed_days
                 FROM attendance a
                 WHERE a.enrollment_id = :eid
                   AND a.is_deleted = 0
                   AND (a.class_id IS NULL OR a.class_id = 0)
                   AND a.session = 'AM'
                   AND a.attendance_id = (
                       SELECT MAX(a2.attendance_id)
                       FROM attendance a2
                       WHERE a2.enrollment_id = a.enrollment_id
                         AND a2.attendance_date = a.attendance_date
                         AND (a2.class_id IS NULL OR a2.class_id = 0)
                         AND a2.session = 'AM'
                         AND a2.is_deleted = 0
                   )
                   AND a.attendance_date BETWEEN :start_date AND :end_date"
            );
            $att->bindValue(':eid', $enrollmentId, PDO::PARAM_INT);
            $att->bindValue(':start_date', $start);
            $att->bindValue(':end_date', $end);
            $att->execute();
            $ar = $att->fetch(PDO::FETCH_ASSOC) ?: [];
            if (!isset($stored[$monthNo])) {
                $present = (float)($ar['days_present'] ?? 0);
                $absent = (float)($ar['days_absent'] ?? 0);
                $late = (int)($ar['days_late'] ?? 0);
            }
            $closedDays = (int)($ar['closed_days'] ?? 0);
        }

        if ($schoolDays === null) {
            [$start, $end] = sf9_clipped_month_bounds((int)$m['year'], $monthNo, $schoolYearDateStart, $schoolYearDateEnd);
            $schoolDays = max(0, sf9_count_weekdays($start, $end) - $closedDays);
        }
        if ($present === null) {
            $present = 0.0;
        }

        $attendanceMonths[] = [
            'label' => $m['label'],
            'month_no' => $monthNo,
            'year' => (int)$m['year'],
            'total_school_days' => $schoolDays,
            'days_present' => $present,
            'days_absent' => $absent,
            'times_tardy' => $late,
        ];

        $totSchool += (int)$schoolDays;
        $totPresent += (float)($present ?? 0);
        $totAbsent += (float)($absent ?? 0);
        $totLate += (int)($late ?? 0);
    }

    $payload = [
        'success' => true,
        'report_card_id' => null,
        'enrollment_id' => $enrollmentId,
        'learner' => [
            'name' => $learnerName,
            'lrn' => $h['lrn'] ?? null,
            'sex' => $h['gender'] ?? null,
            'date_of_birth' => $h['date_of_birth'] ?? null,
            'age' => $age,
            'mother_tongue' => $h['mother_tongue'] ?? null,
        ],
        'enrollment' => [
            'grade_level' => $h['grade_name'] ?? null,
            'education_level' => $h['education_level_name'] ?? null,
            'section' => $h['section_name'] ?? null,
            'school_year' => $h['year_label'] ?? null,
            'school_year_id' => $schoolYearId,
            'grading_system_type' => $h['grading_system_type'] ?? 'Quarterly',
            'section_id' => $sectionId,
            'grading_mode' => $gradingPolicy['grading_mode'],
            'sf9_template_variant' => $gradingPolicy['sf9_template_variant'],
            'supports_term_comments' => $gradingPolicy['supports_term_comments'],
        ],
        'template' => $reportCardTemplate,
        'school' => [
            'school_id' => $settings['school_id'] ?? ($settings['schoolId'] ?? null),
            'school_name' => $settings['school_name'] ?? ($settings['schoolName'] ?? null),
            'name' => $settings['school_name'] ?? ($settings['schoolName'] ?? null),
            'region' => $settings['region'] ?? ($settings['school_region'] ?? null),
            'division' => $settings['division'] ?? ($settings['school_division'] ?? null),
            'district' => $settings['district'] ?? ($settings['school_district'] ?? null),
            'school_head' => $principalName,
            'principal_name' => $principalName,
            'principal_title' => 'Principal',
            // Fall back to project logo if none configured
            'logo_url' => ($settings['logo_url'] ?? ($settings['school_logo_url'] ?? ($settings['deped_logo_url'] ?? null))) ?: $defaultLogoUrl,
            'deped_logo_url' => $settings['deped_logo_url'] ?? sf9_logo_asset_url('Seal_of_the_Department_of_Education_of_the_Philippines.png'),
            'curriculum_level' => $curriculumLevel,
            'track_strand' => $settings['track_strand'] ?? ($settings['school_track_strand'] ?? null),
        ],
        'adviser' => [
            'name' => $adviserName,
        ],
        'quarters' => $quarters,
        'grades' => $gradeRows,
        'general_average' => $generalAverage,
        'core_values' => sf9_should_include_observed_values($gradingPolicy)
            ? sf9_observed_values_for_enrollment($conn, $enrollmentId, $quarters)
            : [],
        'term_comments' => sf9_term_comments_for_enrollment($conn, $enrollmentId, $quarters),
        'pace_ratings' => strtolower((string)($gradingPolicy['grading_mode'] ?? '')) === 'descriptive'
            && strtoupper((string)($gradingPolicy['sf9_template_variant'] ?? '')) === 'G1'
                ? sf9_pace_ratings_for_enrollment($conn, $enrollmentId, $quarters)
                : [],
        'attendance' => [
            'months' => $attendanceMonths,
            'totals' => [
                'total_school_days' => $totSchool,
                'days_present' => $totPresent,
                'days_absent' => $totAbsent,
                'times_tardy' => $totLate,
            ]
        ],
    ];

    respond($payload);
}

function getMySF9Data(PDO $conn, array $session): void {
    $userId = (int)($session['user_id'] ?? 0);
    if ($userId <= 0) {
        respond(['success' => false, 'message' => 'Not authenticated'], 401);
    }

    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $stmt = $conn->prepare(
        'SELECT e.enrollment_id
         FROM enrollments e
         JOIN learners l ON l.learner_id = e.learner_id
         WHERE l.user_id = :user_id
           AND e.is_deleted = 0
           AND l.is_deleted = 0
           ' . ($schoolYearId > 0 ? 'AND e.school_year_id = :school_year_id' : '') . '
         ORDER BY e.enrollment_id DESC
         LIMIT 1'
    );
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    if ($schoolYearId > 0) {
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    }
    $stmt->execute();
    $enrollmentId = (int)($stmt->fetchColumn() ?: 0);

    if ($enrollmentId <= 0) {
        respond(['success' => false, 'message' => $schoolYearId > 0 ? 'No report card enrollment found for the selected school year' : 'No enrollment found for this learner account'], 404);
    }

    // Learners may read the coded values saved for their own enrollment,
    // including descriptive/PACE ratings. The preview, print, and export
    // workflows remain protected by the staff-only operations below.
    $_GET['enrollment_id'] = $enrollmentId;
    getSF9DataByEnrollment($conn, $session);
}

function getMySF9SchoolYears(PDO $conn, array $session): void {
    $userId = (int)($session['user_id'] ?? 0);
    if ($userId <= 0) {
        respond(['success' => false, 'message' => 'Not authenticated'], 401);
    }

    $stmt = $conn->prepare(
        "SELECT DISTINCT
                sy.school_year_id,
                sy.year_label,
                sy.year_start,
                sy.year_end,
                sy.is_active,
                e.enrollment_id,
                gl.grade_name,
                sec.section_name
         FROM enrollments e
         JOIN learners l ON l.learner_id = e.learner_id
         JOIN school_years sy ON sy.school_year_id = e.school_year_id
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         LEFT JOIN sections sec ON sec.section_id = e.section_id
         WHERE l.user_id = :user_id
           AND e.is_deleted = 0
           AND l.is_deleted = 0
           AND sy.is_deleted = 0
         ORDER BY sy.year_start DESC, sy.school_year_id DESC, e.enrollment_id DESC"
    );
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function getSF9Sections(PDO $conn, array $session): void {
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $isTeacher = isTeacherLikeRole($session);
    $employeeId = $isTeacher ? getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0)) : 0;

    $sql = "SELECT s.section_id,
                   s.section_name,
                   s.grade_level_id,
                   gl.grade_name,
                   s.school_year_id,
                   sy.year_label,
                   sy.is_active,
                   sy.grading_system_type
            FROM sections s
            LEFT JOIN grade_levels gl ON gl.grade_level_id = s.grade_level_id
            JOIN school_years sy ON sy.school_year_id = s.school_year_id AND sy.is_deleted = 0
            WHERE s.is_deleted = 0";
    if ($isTeacher) {
        $sql .= " AND EXISTS (
                    SELECT 1
                    FROM class_offerings co
                    WHERE co.section_id = s.section_id
                      AND co.school_year_id = s.school_year_id
                      AND co.teacher_id = :employee_id_offering
                      AND co.is_deleted = 0
                  )";
    }
    if ($schoolYearId > 0) $sql .= ' AND s.school_year_id = :school_year_id';
    $sql .= ' ORDER BY sy.year_start DESC, sy.school_year_id DESC, gl.grade_name, s.section_name';

    $stmt = $conn->prepare($sql);
    if ($isTeacher) {
        $stmt->bindValue(':employee_id_offering', $employeeId, PDO::PARAM_INT);
    }
    if ($schoolYearId > 0) $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function getSF9Roster(PDO $conn, array $session): void {
    $sectionId = (int)($_GET['section_id'] ?? 0);
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    if ($sectionId <= 0) {
        respond(['success' => false, 'message' => 'section_id is required'], 422);
    }

    if ($schoolYearId <= 0) {
        // Prefer the section's configured school year; else fallback to active.
        $sy = $conn->prepare(
            'SELECT s.school_year_id
             FROM sections s
             JOIN school_years sy ON sy.school_year_id = s.school_year_id AND sy.is_deleted = 0
             WHERE s.section_id = :sid AND s.is_deleted = 0
             LIMIT 1'
        );
        $sy->bindValue(':sid', $sectionId, PDO::PARAM_INT);
        $sy->execute();
        $schoolYearId = (int)($sy->fetchColumn() ?? 0);
    }
    if ($schoolYearId <= 0) {
        $schoolYearId = (int)($conn->query("SELECT school_year_id FROM school_years WHERE is_active = 1 AND is_deleted = 0 ORDER BY year_start DESC LIMIT 1")->fetchColumn() ?? 0);
    }
    if ($schoolYearId <= 0) {
        respond(['success' => false, 'message' => 'Active school year not found'], 404);
    }

    ensureTeacherCanAccessSection($conn, $session, $sectionId, $schoolYearId);

    $sql = "SELECT e.enrollment_id,
                   e.learner_id,
                   e.school_year_id,
                   e.section_id,
                   e.grade_level_id,
                   l.lrn,
                   CONCAT(l.last_name, ', ', l.first_name,
                       CASE WHEN l.middle_name IS NULL OR l.middle_name = '' THEN '' ELSE CONCAT(' ', l.middle_name) END,
                       CASE WHEN l.name_extension IS NULL OR l.name_extension = '' THEN '' ELSE CONCAT(' ', l.name_extension) END
                   ) AS learner_name,
                   l.gender,
                   gl.grade_name,
                   sec.section_name,
                   sy.year_label,
                   ga.general_average
            FROM enrollments e
            JOIN learners l ON e.learner_id = l.learner_id
            LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
            JOIN sections sec ON sec.section_id = e.section_id AND sec.is_deleted = 0 AND sec.school_year_id = e.school_year_id
            JOIN school_years sy ON sy.school_year_id = e.school_year_id AND sy.is_deleted = 0
            LEFT JOIN general_averages ga ON ga.enrollment_id = e.enrollment_id AND ga.is_deleted = 0
            WHERE e.is_deleted = 0
              AND e.section_id = :sid
              AND e.school_year_id = :sy
            ORDER BY l.last_name, l.first_name";

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$row) {
        $gradingPolicy = GradingPolicyService::resolve(
            $conn,
            $schoolYearId,
            (int)($row['grade_level_id'] ?? 0),
            $row['grade_name'] ?? null
        );
        $row['grading_mode'] = $gradingPolicy['grading_mode'];
        $row['sf9_template_variant'] = $gradingPolicy['sf9_template_variant'];
    }
    unset($row);
    respond($rows);
}

function saveSF9TermComments(PDO $conn, array $session): void {
    if (!tableExists($conn, 'report_card_term_comments')) {
        respond(['success' => false, 'message' => 'Term-comments migration has not been applied yet'], 503);
    }

    $data = getJsonInput();
    $enrollmentId = (int)($data['enrollment_id'] ?? 0);
    $comments = $data['comments'] ?? [];
    if ($enrollmentId <= 0 || !is_array($comments)) {
        respond(['success' => false, 'message' => 'enrollment_id and comments are required'], 422);
    }

    $enrollmentStmt = $conn->prepare(
        'SELECT e.school_year_id, e.section_id, e.grade_level_id, gl.grade_name
         FROM enrollments e
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         WHERE e.enrollment_id = :enrollment_id AND e.is_deleted = 0
         LIMIT 1'
    );
    $enrollmentStmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
    $enrollmentStmt->execute();
    $enrollment = $enrollmentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$enrollment) {
        respond(['success' => false, 'message' => 'Enrollment not found'], 404);
    }

    ensureTeacherCanAccessSection(
        $conn,
        $session,
        (int)$enrollment['section_id'],
        (int)$enrollment['school_year_id']
    );
    $policy = GradingPolicyService::resolve(
        $conn,
        (int)$enrollment['school_year_id'],
        (int)$enrollment['grade_level_id'],
        $enrollment['grade_name'] ?? null
    );
    if (!$policy['supports_term_comments']) {
        respond(['success' => false, 'message' => 'Teacher term comments are enabled for numeric Grades 2-10 only'], 422);
    }

    $periodStmt = $conn->prepare(
        'SELECT gp.grading_period_id
         FROM grading_periods gp
         WHERE gp.grading_period_id = :grading_period_id
           AND gp.school_year_id = :school_year_id
           AND gp.is_deleted = 0
         LIMIT 1'
    );
    $upsert = $conn->prepare(
        'INSERT INTO report_card_term_comments
            (enrollment_id, grading_period_id, comment_text, recorded_by, updated_by, is_deleted, deleted_at)
         VALUES
            (:enrollment_id, :grading_period_id, :comment_text, :recorded_by, :updated_by, 0, NULL)
         ON DUPLICATE KEY UPDATE
            comment_text = VALUES(comment_text),
            updated_by = VALUES(updated_by),
            updated_at = CURRENT_TIMESTAMP,
            is_deleted = 0,
            deleted_at = NULL'
    );

    $normalizedComments = [];
    foreach ($comments as $comment) {
        if (!is_array($comment)) continue;
        $periodId = (int)($comment['grading_period_id'] ?? 0);
        if ($periodId <= 0) continue;
        $commentText = trim((string)($comment['comment_text'] ?? ''));
        if (mb_strlen($commentText) > 2000) {
            respond(['success' => false, 'message' => 'Each term comment must be 2,000 characters or fewer'], 422);
        }
        $normalizedComments[] = ['grading_period_id' => $periodId, 'comment_text' => $commentText];
    }

    $userId = (int)($session['user_id'] ?? 0) ?: null;
    try {
        $conn->beginTransaction();
        foreach ($normalizedComments as $comment) {
            $periodId = (int)$comment['grading_period_id'];
            $commentText = $comment['comment_text'];
            $periodStmt->bindValue(':grading_period_id', $periodId, PDO::PARAM_INT);
            $periodStmt->bindValue(':school_year_id', (int)$enrollment['school_year_id'], PDO::PARAM_INT);
            $periodStmt->execute();
            if (!$periodStmt->fetchColumn()) {
                throw new InvalidArgumentException('One or more grading periods do not belong to this school year');
            }

            $upsert->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
            $upsert->bindValue(':grading_period_id', $periodId, PDO::PARAM_INT);
            $upsert->bindValue(':comment_text', $commentText);
            $upsert->bindValue(':recorded_by', $userId, $userId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
            $upsert->bindValue(':updated_by', $userId, $userId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
            $upsert->execute();
        }
        $conn->commit();
    } catch (InvalidArgumentException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => $e->getMessage()], 422);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => 'Unable to save term comments: ' . $e->getMessage()], 500);
    }

    respond([
        'success' => true,
        'message' => 'Teacher term comments saved',
        'term_comments' => sf9_term_comments_for_enrollment($conn, $enrollmentId, getQuarterGradingPeriods($conn, (int)$enrollment['school_year_id'])),
    ]);
}

function saveSF9PaceRatings(PDO $conn, array $session): void {
    if (!tableExists($conn, 'sf9_pace_ratings')) {
        respond(['success' => false, 'message' => 'Grade 1 PACE ratings migration has not been applied yet'], 503);
    }

    $data = getJsonInput();
    $enrollmentId = (int)($data['enrollment_id'] ?? 0);
    $ratings = $data['ratings'] ?? null;
    if ($enrollmentId <= 0 || !is_array($ratings)) {
        respond(['success' => false, 'message' => 'enrollment_id and ratings are required'], 422);
    }
    if (count($ratings) > 1000) {
        respond(['success' => false, 'message' => 'Too many PACE ratings were submitted'], 422);
    }

    $enrollmentStmt = $conn->prepare(
        'SELECT e.school_year_id, e.section_id, e.grade_level_id, gl.grade_name
         FROM enrollments e
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         WHERE e.enrollment_id = :enrollment_id AND e.is_deleted = 0
         LIMIT 1'
    );
    $enrollmentStmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
    $enrollmentStmt->execute();
    $enrollment = $enrollmentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$enrollment) {
        respond(['success' => false, 'message' => 'Enrollment not found'], 404);
    }

    ensureTeacherCanAccessSection(
        $conn,
        $session,
        (int)$enrollment['section_id'],
        (int)$enrollment['school_year_id']
    );
    $policy = GradingPolicyService::resolve(
        $conn,
        (int)$enrollment['school_year_id'],
        (int)$enrollment['grade_level_id'],
        $enrollment['grade_name'] ?? null
    );
    $isGradeOne = preg_match('/^(?:grade\s*)?0*1$/i', trim((string)($enrollment['grade_name'] ?? ''))) === 1;
    if (!$isGradeOne
        || strtolower((string)($policy['grading_mode'] ?? '')) !== 'descriptive'
        || strtoupper((string)($policy['sf9_template_variant'] ?? '')) !== 'G1') {
        respond(['success' => false, 'message' => 'PACE rating entry is enabled for Grade 1 descriptive SF9 only'], 422);
    }

    $normalizedRatings = [];
    foreach ($ratings as $rating) {
        if (!is_array($rating)) continue;
        $periodId = (int)($rating['grading_period_id'] ?? 0);
        $catalogKey = trim((string)($rating['catalog_key'] ?? ''));
        $ratingCode = strtoupper(trim((string)($rating['rating_code'] ?? '')));
        if ($periodId <= 0 || $catalogKey === '') {
            respond(['success' => false, 'message' => 'Each PACE rating needs a grading period and catalog key'], 422);
        }
        // The official Grade 1 PACE template includes competency ranges such as
        // "3-5". Keep the key format strict while allowing that range notation.
        if (mb_strlen($catalogKey) > 180
            || !preg_match('/^g1_pace_(?:p[0-9]+_n[0-9]+(?:-[0-9]+)?_r[0-9]+_[LSRW]|lc[0-9]+_n[0-9]+(?:-[0-9]+)?_r[0-9]+)$/D', $catalogKey)) {
            respond(['success' => false, 'message' => 'A PACE catalog key is invalid'], 422);
        }
        if ($ratingCode !== '' && !in_array($ratingCode, ['A', 'B', 'C', 'D', 'E'], true)) {
            respond(['success' => false, 'message' => 'PACE ratings must be A, B, C, D, or E'], 422);
        }
        $normalizedRatings[$periodId . ':' . $catalogKey] = [
            'grading_period_id' => $periodId,
            'catalog_key' => $catalogKey,
            'rating_code' => $ratingCode,
        ];
    }

    $periodStmt = $conn->prepare(
        'SELECT grading_period_id, status
         FROM grading_periods
         WHERE grading_period_id = :grading_period_id
           AND school_year_id = :school_year_id
           AND period_no BETWEEN 1 AND 3
           AND is_deleted = 0
         LIMIT 1
         FOR UPDATE'
    );
    $upsert = $conn->prepare(
        'INSERT INTO sf9_pace_ratings
            (school_year_id, grade_level_id, enrollment_id, grading_period_id, catalog_key, rating_code,
             recorded_by, updated_by, is_deleted, deleted_at)
         VALUES
            (:school_year_id, :grade_level_id, :enrollment_id, :grading_period_id, :catalog_key, :rating_code,
             :recorded_by, :updated_by, 0, NULL)
         ON DUPLICATE KEY UPDATE
            rating_code = VALUES(rating_code),
            updated_by = VALUES(updated_by),
            updated_at = CURRENT_TIMESTAMP,
            is_deleted = 0,
            deleted_at = NULL'
    );
    $softDelete = $conn->prepare(
        'UPDATE sf9_pace_ratings
         SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, updated_by = :updated_by
         WHERE enrollment_id = :enrollment_id
           AND grading_period_id = :grading_period_id
           AND catalog_key = :catalog_key
           AND is_deleted = 0'
    );
    $userId = (int)($session['user_id'] ?? 0) ?: null;

    try {
        $conn->beginTransaction();
        foreach ($normalizedRatings as $rating) {
            $periodId = (int)$rating['grading_period_id'];
            $periodStmt->execute([
                ':grading_period_id' => $periodId,
                ':school_year_id' => (int)$enrollment['school_year_id'],
            ]);
            $period = $periodStmt->fetch(PDO::FETCH_ASSOC);
            $periodStmt->closeCursor();
            if (!$period) {
                throw new InvalidArgumentException('One or more grading periods do not belong to this school year');
            }
            if (strtoupper(trim((string)($period['status'] ?? ''))) !== 'OPEN') {
                throw new InvalidArgumentException('Grading period is not open for PACE encoding');
            }

            if ($rating['rating_code'] === '') {
                $softDelete->bindValue(':updated_by', $userId, $userId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
                $softDelete->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
                $softDelete->bindValue(':grading_period_id', $periodId, PDO::PARAM_INT);
                $softDelete->bindValue(':catalog_key', $rating['catalog_key']);
                $softDelete->execute();
                continue;
            }

            $upsert->bindValue(':school_year_id', (int)$enrollment['school_year_id'], PDO::PARAM_INT);
            $upsert->bindValue(':grade_level_id', (int)$enrollment['grade_level_id'], PDO::PARAM_INT);
            $upsert->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
            $upsert->bindValue(':grading_period_id', $periodId, PDO::PARAM_INT);
            $upsert->bindValue(':catalog_key', $rating['catalog_key']);
            $upsert->bindValue(':rating_code', $rating['rating_code']);
            $upsert->bindValue(':recorded_by', $userId, $userId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
            $upsert->bindValue(':updated_by', $userId, $userId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
            $upsert->execute();
        }
        $conn->commit();
    } catch (InvalidArgumentException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => $e->getMessage()], 422);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => 'Unable to save PACE ratings: ' . $e->getMessage()], 500);
    }

    // Saving the final missing PACE rating can make Grade 1 promotion-ready.
    // Run this after the rating transaction commits so a failed lifecycle
    // update cannot roll back an otherwise valid teacher save.
    $enrollmentCompleted = false;
    try {
        $enrollmentCompleted = (new GradeComputationService($conn))->autoCompleteIfEligible($enrollmentId);
    } catch (Throwable $e) {
        error_log('Grade 1 PACE completion check failed: ' . $e->getMessage());
    }

    $quarters = getQuarterGradingPeriods($conn, (int)$enrollment['school_year_id']);
    respond([
        'success' => true,
        'message' => 'Grade 1 PACE ratings saved',
        'enrollment_completed' => $enrollmentCompleted,
        'pace_ratings' => sf9_pace_ratings_for_enrollment($conn, $enrollmentId, $quarters),
    ]);
}

function createReportCard(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['enrollment_id']) || empty($data['grading_period_id'])) {
        respond(['success' => false, 'message' => 'Enrollment and grading period are required'], 422);
    }

    try {
        $conn->beginTransaction();
        $stmt = $conn->prepare('INSERT INTO report_cards (enrollment_id, grading_period_id, generated_by, file_path) VALUES (:enrollment_id, :grading_period_id, :generated_by, :file_path)');
        $stmt->bindValue(':enrollment_id', $data['enrollment_id'], PDO::PARAM_INT);
        $stmt->bindValue(':grading_period_id', $data['grading_period_id'], PDO::PARAM_INT);
        $stmt->bindValue(':generated_by', $data['generated_by'] ?? null, ($data['generated_by'] ?? null) === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->bindValue(':file_path', $data['file_path'] ?? null);
        $stmt->execute();

        $reportCardId = (int)$conn->lastInsertId();
        bindReportCardTemplate(
            $conn,
            $reportCardId,
            resolveReportCardTemplateForEnrollment($conn, (int)$data['enrollment_id'])
        );
        bindReportCardPeriods(
            $conn,
            $reportCardId,
            resolveReportCardPeriodsForEnrollment($conn, (int)$data['enrollment_id'])
        );
        populateReportCardSnapshot($conn, $reportCardId);

        $conn->commit();
        respond(['success' => true, 'message' => 'Report card created', 'report_card_id' => $reportCardId]);
    } catch (Exception $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => 'Error: ' . $e->getMessage()], 500);
    }
}

function updateReportCard(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['report_card_id']) || empty($data['enrollment_id']) || empty($data['grading_period_id'])) {
        respond(['success' => false, 'message' => 'Report card ID, enrollment, and grading period are required'], 422);
    }
    try {
        $conn->beginTransaction();
        $stmt = $conn->prepare('UPDATE report_cards SET enrollment_id = :enrollment_id, grading_period_id = :grading_period_id, generated_by = :generated_by, file_path = :file_path WHERE report_card_id = :report_card_id');
        $stmt->bindValue(':enrollment_id', $data['enrollment_id'], PDO::PARAM_INT);
        $stmt->bindValue(':grading_period_id', $data['grading_period_id'], PDO::PARAM_INT);
        $stmt->bindValue(':generated_by', $data['generated_by'] ?? null, ($data['generated_by'] ?? null) === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->bindValue(':file_path', $data['file_path'] ?? null);
        $stmt->bindValue(':report_card_id', $data['report_card_id'], PDO::PARAM_INT);
        $stmt->execute();

        bindReportCardTemplate(
            $conn,
            (int)$data['report_card_id'],
            resolveReportCardTemplateForEnrollment($conn, (int)$data['enrollment_id'])
        );
        bindReportCardPeriods(
            $conn,
            (int)$data['report_card_id'],
            resolveReportCardPeriodsForEnrollment($conn, (int)$data['enrollment_id'])
        );
        populateReportCardSnapshot($conn, (int)$data['report_card_id']);
        $conn->commit();
        respond(['success' => true, 'message' => 'Report card updated']);
    } catch (Exception $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => 'Error: ' . $e->getMessage()], 500);
    }
}

function deleteReportCard(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['report_card_id'])) {
        respond(['success' => false, 'message' => 'Report card ID is required'], 422);
    }
    $stmt = $conn->prepare('UPDATE report_cards SET is_deleted = 1, deleted_at = NOW() WHERE report_card_id = :report_card_id');
    $stmt->bindValue(':report_card_id', $data['report_card_id'], PDO::PARAM_INT);
    $stmt->execute();
    respond(['success' => true, 'message' => 'Report card deleted']);
}
?>
