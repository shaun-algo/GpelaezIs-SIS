<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';

function respond($payload, int $code = 200): void {
    ini_set('serialize_precision', '-1');
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function requireGradeMonitoringRole(): array {
    $session = auth_require();
    $role = strtolower((string)($session['role_key'] ?? ''));
    $roleName = strtolower((string)($session['role_name'] ?? ''));
    if ($role === 'admin' || $role === 'registrar' || $role === 'principal' || str_contains($roleName, 'principal')) {
        return $session;
    }
    auth_abort(403, 'Not authorized');
}

function getIntParam(string $key): int {
    return max(0, (int)($_GET[$key] ?? 0));
}

function columnExists(PDO $conn, string $tableName, string $columnName): bool {
    static $cache = [];
    $key = $tableName . '.' . $columnName;
    if (isset($cache[$key])) return $cache[$key];
    $stmt = $conn->prepare('SELECT 1 FROM information_schema.columns
                            WHERE table_schema = DATABASE()
                              AND table_name = :table_name
                              AND column_name = :column_name
                            LIMIT 1');
    $stmt->bindValue(':table_name', $tableName);
    $stmt->bindValue(':column_name', $columnName);
    $stmt->execute();
    return $cache[$key] = (bool)$stmt->fetchColumn();
}

$operation = $_GET['operation'] ?? 'getGradeMonitoring';
requireGradeMonitoringRole();

try {
    switch ($operation) {
        case 'getGradeMonitoring':
            getGradeMonitoring($conn);
            break;
        case 'getGradeMonitoringAudit':
            getGradeMonitoringAudit($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getActiveSchoolYearId(PDO $conn): int {
    $stmt = $conn->query('SELECT school_year_id FROM school_years WHERE is_active = 1 AND is_deleted = 0 ORDER BY year_start DESC, school_year_id DESC LIMIT 1');
    return (int)($stmt->fetchColumn() ?: 0);
}

function getSchoolYears(PDO $conn): array {
    $stmt = $conn->query('SELECT school_year_id, year_label, is_active FROM school_years WHERE is_deleted = 0 ORDER BY year_start DESC, school_year_id DESC');
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function getGradingPeriods(PDO $conn, int $schoolYearId): array {
    $stmt = $conn->prepare('SELECT grading_period_id, period_name, period_no, status, date_start, date_end
                            FROM grading_periods
                            WHERE school_year_id = :sy AND is_deleted = 0
                            ORDER BY period_no ASC, grading_period_id ASC');
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function getMonitoringGradeLevels(PDO $conn, int $schoolYearId, int $curriculumId): array {
    if ($curriculumId <= 0) return [];

    $whereSql = implode(' AND ', [
        'co.is_deleted = 0',
        'sec.is_deleted = 0',
        'sub.is_deleted = 0',
        'co.school_year_id = :school_year_id',
        buildCurriculumSubjectFilterSql($curriculumId)
    ]);
    $sql = "SELECT DISTINCT gl.grade_level_id, gl.grade_name, gl.sort_order
            FROM class_offerings co
            JOIN subjects sub ON sub.subject_id = co.subject_id
            JOIN sections sec ON sec.section_id = co.section_id
            JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id
            WHERE {$whereSql}
            ORDER BY COALESCE(gl.sort_order, gl.grade_level_id), gl.grade_level_id";
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':curriculum_id_allowed', $curriculumId, PDO::PARAM_INT);
    $stmt->bindValue(':curriculum_id_mapeh', $curriculumId, PDO::PARAM_INT);
    $stmt->execute();
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function getMonitoringSections(PDO $conn, int $schoolYearId, int $curriculumId, int $gradeLevelId = 0): array {
    if ($curriculumId <= 0) return [];

    $whereSql = implode(' AND ', [
        'co.is_deleted = 0',
        'sec.is_deleted = 0',
        'sub.is_deleted = 0',
        'co.school_year_id = :school_year_id',
        buildCurriculumSubjectFilterSql($curriculumId)
    ]);
    $params = [
        ':school_year_id' => $schoolYearId,
        ':curriculum_id_allowed' => $curriculumId,
        ':curriculum_id_mapeh' => $curriculumId,
    ];
    if ($gradeLevelId > 0) {
        $whereSql .= ' AND sec.grade_level_id = :grade_level_id';
        $params[':grade_level_id'] = $gradeLevelId;
    }
    $sql = "SELECT DISTINCT sec.section_id, sec.section_name, gl.grade_name
            FROM class_offerings co
            JOIN subjects sub ON sub.subject_id = co.subject_id
            JOIN sections sec ON sec.section_id = co.section_id
            LEFT JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id
            WHERE {$whereSql}
            ORDER BY COALESCE(gl.sort_order, gl.grade_level_id), gl.grade_name ASC, sec.section_name ASC";
    $stmt = $conn->prepare($sql);
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $stmt->execute();
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function getCurriculumIdForSchoolYear(PDO $conn, int $schoolYearId): int {
    return (int)(app_integrity_get_curriculum_id_for_school_year($conn, $schoolYearId) ?? 0);
}

function buildCurriculumSubjectFilterSql(int $curriculumId, string $subjectAlias = 'sub', string $sectionAlias = 'sec', string $offeringAlias = 'co'): string {
    if ($curriculumId <= 0) return '1 = 0';
    $subjectAlias = preg_replace('/[^A-Za-z0-9_]/', '', $subjectAlias) ?: 'sub';
    $sectionAlias = preg_replace('/[^A-Za-z0-9_]/', '', $sectionAlias) ?: 'sec';
    $offeringAlias = preg_replace('/[^A-Za-z0-9_]/', '', $offeringAlias) ?: 'co';

    return "(
        EXISTS (
            SELECT 1
            FROM curriculum_subjects cs_allowed
            WHERE cs_allowed.curriculum_id = :curriculum_id_allowed
              AND cs_allowed.grade_level_id = {$sectionAlias}.grade_level_id
              AND cs_allowed.subject_id = {$offeringAlias}.subject_id
              AND cs_allowed.is_deleted = 0
        )
        OR (
            EXISTS (
                SELECT 1
                FROM curriculum_subjects cs_mapeh
                JOIN subjects s_mapeh ON s_mapeh.subject_id = cs_mapeh.subject_id AND s_mapeh.is_deleted = 0
                WHERE cs_mapeh.curriculum_id = :curriculum_id_mapeh
                  AND cs_mapeh.grade_level_id = {$sectionAlias}.grade_level_id
                  AND cs_mapeh.is_deleted = 0
                  AND s_mapeh.subject_name LIKE '%MAPEH%'
            )
            AND (
                {$subjectAlias}.subject_name LIKE '%MAPEH Component%'
                OR (
                    {$subjectAlias}.subject_name NOT LIKE '%MAPEH%'
                    AND {$subjectAlias}.subject_name REGEXP '(^|[^A-Za-z])(Music|Arts|Physical Education|Health)([^A-Za-z]|$)'
                )
            )
        )
    )";
}

function getGradeMonitoring(PDO $conn): void {
    $schoolYearId = getIntParam('school_year_id') ?: getActiveSchoolYearId($conn);
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    if ($schoolYearId <= 0) {
        respond([
            'success' => true,
            'school_year_id' => 0,
            'grade_level_id' => 0,
            'school_years' => getSchoolYears($conn),
            'periods' => [],
            'grade_levels' => [],
            'sections' => [],
            'summary' => emptySummary(),
            'rows' => []
        ]);
    }

    $periodId = getIntParam('grading_period_id');
    $teacherId = getIntParam('teacher_id');
    $sectionId = getIntParam('section_id');
    $gradeLevelId = getIntParam('grade_level_id');
    $status = strtolower(trim((string)($_GET['status'] ?? '')));
    $search = trim((string)($_GET['search'] ?? ''));

    $where = [
        'co.is_deleted = 0',
        'sec.is_deleted = 0',
        'sub.is_deleted = 0',
        'gp.is_deleted = 0',
        'co.school_year_id = :school_year_id',
        buildCurriculumSubjectFilterSql($curriculumId)
    ];
    $having = [];
    $params = [
        ':school_year_id' => $schoolYearId,
    ];
    if ($curriculumId > 0) {
        $params[':curriculum_id_allowed'] = $curriculumId;
        $params[':curriculum_id_mapeh'] = $curriculumId;
    }

    if ($periodId > 0) {
        $where[] = 'gp.grading_period_id = :grading_period_id';
        $params[':grading_period_id'] = $periodId;
    }
    if ($teacherId > 0) {
        $where[] = 'co.teacher_id = :teacher_id';
        $params[':teacher_id'] = $teacherId;
    }
    if ($sectionId > 0) {
        $where[] = 'co.section_id = :section_id';
        $params[':section_id'] = $sectionId;
    }
    if ($gradeLevelId > 0) {
        $where[] = 'sec.grade_level_id = :grade_level_id';
        $params[':grade_level_id'] = $gradeLevelId;
    }
    if ($search !== '') {
        $where[] = "(CONCAT(emp.last_name, ', ', emp.first_name) LIKE :search_teacher
                    OR sub.subject_name LIKE :search_subject
                    OR sec.section_name LIKE :search_section
                    OR gl.grade_name LIKE :search_grade)";
        $searchValue = '%' . $search . '%';
        $params[':search_teacher'] = $searchValue;
        $params[':search_subject'] = $searchValue;
        $params[':search_section'] = $searchValue;
        $params[':search_grade'] = $searchValue;
    }
    if ($status === 'complete') {
        $having[] = 'missing_count = 0 AND expected_count > 0';
    } elseif ($status === 'incomplete') {
        $having[] = 'missing_count > 0';
    } elseif ($status === 'not-started') {
        $having[] = 'encoded_grade_inputs = 0 AND expected_count > 0';
    }

    $whereSql = implode(' AND ', $where);
    $havingSql = $having ? ' HAVING ' . implode(' AND ', $having) : '';
    $sql = "SELECT
                NULL AS class_id,
                learner_rollup.teacher_id,
                learner_rollup.teacher_name,
                MAX(learner_rollup.subject_names_raw) AS subject_names_raw,
                MAX(learner_rollup.required_subject_count) AS required_subject_count,
                learner_rollup.section_id,
                learner_rollup.section_name,
                learner_rollup.grade_name,
                learner_rollup.grading_period_id,
                learner_rollup.period_name,
                learner_rollup.period_no,
                learner_rollup.period_status,
                COUNT(DISTINCT learner_rollup.enrollment_id) AS expected_count,
                COUNT(DISTINCT CASE
                    WHEN learner_rollup.enrollment_id IS NOT NULL
                     AND learner_rollup.required_subject_count > 0
                     AND learner_rollup.encoded_subject_count >= learner_rollup.required_subject_count
                    THEN learner_rollup.enrollment_id
                END) AS encoded_count,
                (COUNT(DISTINCT learner_rollup.enrollment_id) - COUNT(DISTINCT CASE
                    WHEN learner_rollup.enrollment_id IS NOT NULL
                     AND learner_rollup.required_subject_count > 0
                     AND learner_rollup.encoded_subject_count >= learner_rollup.required_subject_count
                    THEN learner_rollup.enrollment_id
                END)) AS missing_count,
                SUM(learner_rollup.encoded_subject_count) AS encoded_grade_inputs,
                SUM(learner_rollup.required_subject_count) AS expected_grade_inputs,
                GROUP_CONCAT(
                    DISTINCT CASE
                        WHEN learner_rollup.enrollment_id IS NOT NULL
                         AND learner_rollup.encoded_subject_count < learner_rollup.required_subject_count
                        THEN CONCAT(learner_rollup.learner_name, ':::', COALESCE(learner_rollup.missing_subjects, ''))
                    END
                    ORDER BY learner_rollup.learner_name
                    SEPARATOR '||'
                ) AS missing_learners_raw,
                MAX(learner_rollup.last_grade_at) AS last_grade_at,
                SUBSTRING_INDEX(
                    GROUP_CONCAT(learner_rollup.last_encoded_by ORDER BY learner_rollup.last_grade_at DESC SEPARATOR '||'),
                    '||',
                    1
                ) AS last_encoded_by,
                MAX(learner_rollup.last_audit_at) AS last_audit_at,
                SUBSTRING_INDEX(GROUP_CONCAT(learner_rollup.last_audit_action ORDER BY learner_rollup.last_audit_at DESC SEPARATOR '||'), '||', 1) AS last_audit_action
            FROM (
                SELECT
                    co.teacher_id,
                    CONCAT(emp.last_name, ', ', emp.first_name) AS teacher_name,
                    sec.section_id,
                    sec.section_name,
                    gl.grade_name,
                    gp.grading_period_id,
                    gp.period_name,
                    gp.period_no,
                    gp.status AS period_status,
                    en.enrollment_id,
                    CONCAT(l.last_name, ', ', l.first_name,
                           CASE WHEN NULLIF(TRIM(l.middle_name), '') IS NULL THEN '' ELSE CONCAT(' ', TRIM(l.middle_name)) END,
                           CASE WHEN NULLIF(TRIM(l.name_extension), '') IS NULL THEN '' ELSE CONCAT(' ', TRIM(l.name_extension)) END
                   ) AS learner_name,
                    COUNT(DISTINCT co.class_id) AS required_subject_count,
                    COUNT(DISTINCT CASE WHEN g.grade_id IS NOT NULL AND g.quarterly_grade IS NOT NULL THEN co.class_id END) AS encoded_subject_count,
                    GROUP_CONCAT(DISTINCT sub.subject_name ORDER BY sub.subject_name SEPARATOR '||') AS subject_names_raw,
                    GROUP_CONCAT(
                        DISTINCT CASE
                            WHEN en.enrollment_id IS NOT NULL
                             AND (g.grade_id IS NULL OR g.quarterly_grade IS NULL)
                            THEN sub.subject_name
                        END
                        ORDER BY sub.subject_name
                        SEPARATOR ', '
                    ) AS missing_subjects,
                    MAX(g.updated_at) AS last_grade_at,
                    SUBSTRING_INDEX(
                        GROUP_CONCAT(
                            DISTINCT CASE
                                WHEN g.grade_id IS NOT NULL THEN COALESCE(
                                    CASE
                                        WHEN NULLIF(TRIM(enc_emp.first_name), '') IS NOT NULL
                                        THEN CONCAT(enc_emp.last_name, ', ', enc_emp.first_name)
                                    END,
                                    CONCAT(emp.last_name, ', ', emp.first_name),
                                    enc.username
                                )
                            END
                            ORDER BY g.updated_at DESC
                            SEPARATOR '||'
                        ),
                        '||',
                        1
                    ) AS last_encoded_by,
                    MAX(al.action_time) AS last_audit_at,
                    SUBSTRING_INDEX(GROUP_CONCAT(al.action ORDER BY al.action_time DESC SEPARATOR '||'), '||', 1) AS last_audit_action
                FROM class_offerings co
                JOIN employees emp ON emp.employee_id = co.teacher_id AND emp.is_deleted = 0
                JOIN subjects sub ON sub.subject_id = co.subject_id
                JOIN sections sec ON sec.section_id = co.section_id
                LEFT JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id
                JOIN grading_periods gp ON gp.school_year_id = co.school_year_id
                LEFT JOIN enrollments en ON en.section_id = co.section_id
                    AND en.school_year_id = co.school_year_id
                    AND en.is_deleted = 0
                    AND en.enrollment_status = 'Enrolled'
                LEFT JOIN learners l ON l.learner_id = en.learner_id AND l.is_deleted = 0
                LEFT JOIN grades g ON g.enrollment_id = en.enrollment_id
                    AND g.class_id = co.class_id
                    AND g.grading_period_id = gp.grading_period_id
                    AND g.is_deleted = 0
                LEFT JOIN (" . user_identity_derived_sql() . ") enc ON enc.user_id = g.encoded_by
                LEFT JOIN employees enc_emp ON enc_emp.user_id = enc.user_id AND enc_emp.is_deleted = 0
                LEFT JOIN audit_logs al ON al.table_name = 'grades' AND al.record_id = g.grade_id
                WHERE {$whereSql}
                GROUP BY co.teacher_id, sec.section_id, gp.grading_period_id, en.enrollment_id
            ) learner_rollup
            GROUP BY learner_rollup.teacher_id, learner_rollup.section_id, learner_rollup.grading_period_id
            {$havingSql}
            ORDER BY missing_count DESC, learner_rollup.teacher_name ASC, learner_rollup.period_no ASC, learner_rollup.section_name ASC";

    $stmt = $conn->prepare($sql);
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $stmt->execute();
    $rows = array_map('shapeMonitoringRow', $stmt->fetchAll(PDO::FETCH_ASSOC));

    respond([
        'success' => true,
        'school_year_id' => $schoolYearId,
        'grade_level_id' => $gradeLevelId,
        'curriculum_id' => $curriculumId,
        'grading_period_id' => $periodId,
        'school_years' => getSchoolYears($conn),
        'periods' => getGradingPeriods($conn, $schoolYearId),
        'grade_levels' => getMonitoringGradeLevels($conn, $schoolYearId, $curriculumId),
        'sections' => getMonitoringSections($conn, $schoolYearId, $curriculumId, $gradeLevelId),
        'summary' => summarizeRows($rows),
        'rows' => $rows
    ]);
}

function shapeMonitoringRow(array $row): array {
    $expected = (int)($row['expected_count'] ?? 0);
    $encoded = (int)($row['encoded_count'] ?? 0);
    $missing = max(0, $expected - $encoded);
    $percent = $expected > 0 ? round(($encoded / $expected) * 100, 1) : 0.0;
    $encodedGradeInputs = (int)($row['encoded_grade_inputs'] ?? 0);
    $expectedGradeInputs = (int)($row['expected_grade_inputs'] ?? 0);
    $status = $expected <= 0 ? 'No Learners' : ($missing === 0 ? 'Complete' : ($encodedGradeInputs === 0 ? 'Not Started' : 'Incomplete'));
    $subjectNames = [];
    $rawSubjects = trim((string)($row['subject_names_raw'] ?? ''));
    if ($rawSubjects !== '') {
        $subjectNames = array_values(array_filter(array_map('trim', explode('||', $rawSubjects))));
    }

    $missingLearners = [];
    $rawMissing = trim((string)($row['missing_learners_raw'] ?? ''));
    if ($rawMissing !== '') {
        foreach (array_filter(array_map('trim', explode('||', $rawMissing))) as $entry) {
            [$name, $missingSubjectsRaw] = array_pad(explode(':::', $entry, 2), 2, '');
            $missingSubjects = array_values(array_filter(array_map('trim', explode(',', $missingSubjectsRaw))));
            $missingLearners[] = [
                'name' => $name,
                'missing_subjects' => $missingSubjects,
                'missing_subject_count' => count($missingSubjects)
            ];
        }
    }

    return [
        'class_id' => (int)($row['class_id'] ?? 0),
        'teacher_id' => (int)$row['teacher_id'],
        'teacher_name' => $row['teacher_name'],
        'subject_name' => count($subjectNames) === 1 ? $subjectNames[0] : count($subjectNames) . ' subjects',
        'subject_code' => null,
        'subject_names' => $subjectNames,
        'required_subject_count' => (int)($row['required_subject_count'] ?? count($subjectNames)),
        'section_id' => (int)$row['section_id'],
        'section_name' => $row['section_name'],
        'grade_name' => $row['grade_name'],
        'grading_period_id' => (int)$row['grading_period_id'],
        'period_name' => $row['period_name'],
        'period_no' => (int)$row['period_no'],
        'period_status' => $row['period_status'],
        'expected_count' => $expected,
        'encoded_count' => $encoded,
        'missing_count' => $missing,
        'expected_grade_inputs' => $expectedGradeInputs,
        'encoded_grade_inputs' => $encodedGradeInputs,
        'missing_learners' => $missingLearners,
        'completion_percent' => $percent,
        'status' => $status,
        'last_grade_at' => $row['last_grade_at'],
        'last_encoded_by' => $row['last_encoded_by'],
        'last_audit_at' => $row['last_audit_at'],
        'last_audit_action' => $row['last_audit_action'],
    ];
}

function emptySummary(): array {
    return [
        'classes' => 0,
        'complete_classes' => 0,
        'incomplete_classes' => 0,
        'not_started_classes' => 0,
        'expected_inputs' => 0,
        'encoded_inputs' => 0,
        'missing_inputs' => 0,
        'completion_percent' => 0
    ];
}

function summarizeRows(array $rows): array {
    $summary = emptySummary();
    $summary['classes'] = count($rows);
    foreach ($rows as $row) {
        $summary['expected_inputs'] += (int)$row['expected_count'];
        $summary['encoded_inputs'] += (int)$row['encoded_count'];
        $summary['missing_inputs'] += (int)$row['missing_count'];
        if ($row['status'] === 'Complete') $summary['complete_classes']++;
        elseif ($row['status'] === 'Not Started') $summary['not_started_classes']++;
        elseif ($row['status'] === 'Incomplete') $summary['incomplete_classes']++;
    }
    $summary['completion_percent'] = $summary['expected_inputs'] > 0
        ? round(($summary['encoded_inputs'] / $summary['expected_inputs']) * 100, 1)
        : 0;
    return $summary;
}

function getGradeMonitoringAudit(PDO $conn): void {
    $schoolYearId = getIntParam('school_year_id') ?: getActiveSchoolYearId($conn);
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    $periodId = getIntParam('grading_period_id');
    $classId = getIntParam('class_id');
    $sectionId = getIntParam('section_id');
    $gradeLevelId = getIntParam('grade_level_id');
    $limit = min(50, max(1, getIntParam('limit') ?: 10));
    $offset = getIntParam('offset');
    $dateFrom = trim((string)($_GET['date_from'] ?? ''));
    $dateTo = trim((string)($_GET['date_to'] ?? ''));

    $where = [
        'al.audit_id IS NOT NULL',
        'co.is_deleted = 0',
        'co.school_year_id = :school_year_id',
        buildCurriculumSubjectFilterSql($curriculumId)
    ];
    $params = [
        ':school_year_id' => $schoolYearId,
    ];
    if ($curriculumId > 0) {
        $params[':curriculum_id_allowed'] = $curriculumId;
        $params[':curriculum_id_mapeh'] = $curriculumId;
    }

    if ($periodId > 0) {
        $where[] = 'g.grading_period_id = :grading_period_id';
        $params[':grading_period_id'] = $periodId;
    }
    if ($classId > 0) {
        $where[] = 'g.class_id = :class_id';
        $params[':class_id'] = $classId;
    }
    if ($sectionId > 0) {
        $where[] = 'co.section_id = :section_id';
        $params[':section_id'] = $sectionId;
    }
    if ($gradeLevelId > 0) {
        $where[] = 'sec.grade_level_id = :grade_level_id';
        $params[':grade_level_id'] = $gradeLevelId;
    }
    if ($dateFrom !== '') {
        $where[] = 'DATE(al.action_time) >= :date_from';
        $params[':date_from'] = $dateFrom;
    }
    if ($dateTo !== '') {
        $where[] = 'DATE(al.action_time) <= :date_to';
        $params[':date_to'] = $dateTo;
    }

    $whereSql = implode(' AND ', $where);
    $sqlLimit = $limit + 1;
    $sql = "SELECT g.grade_id, g.quarterly_grade, g.encoded_at, g.updated_at,
                   enc.username AS encoded_by,
                   COALESCE(
                       CASE
                           WHEN NULLIF(TRIM(enc_emp.first_name), '') IS NOT NULL
                           THEN CONCAT(enc_emp.last_name, ', ', enc_emp.first_name)
                       END,
                       CONCAT(emp.last_name, ', ', emp.first_name),
                       enc.username
                   ) AS encoded_by_name,
                   CONCAT(emp.last_name, ', ', emp.first_name) AS teacher_name,
                   CONCAT(l.last_name, ', ', l.first_name,
                           CASE WHEN NULLIF(TRIM(l.middle_name), '') IS NULL THEN '' ELSE CONCAT(' ', TRIM(l.middle_name)) END,
                           CASE WHEN NULLIF(TRIM(l.name_extension), '') IS NULL THEN '' ELSE CONCAT(' ', TRIM(l.name_extension)) END
                   ) AS learner_name,
                   sub.subject_name, sec.section_name, gp.period_name,
                   al.audit_id, al.action AS audit_action, al.old_values, al.new_values, al.action_time AS audit_time,
                   au.username AS audit_user,
                   COALESCE(
                       CASE
                           WHEN NULLIF(TRIM(au_emp.first_name), '') IS NOT NULL
                           THEN CONCAT(au_emp.last_name, ', ', au_emp.first_name)
                       END,
                       au.username
                   ) AS audit_user_name
            FROM grades g
            JOIN class_offerings co ON co.class_id = g.class_id
            JOIN employees emp ON emp.employee_id = co.teacher_id
            JOIN subjects sub ON sub.subject_id = co.subject_id
            JOIN sections sec ON sec.section_id = co.section_id
            JOIN grading_periods gp ON gp.grading_period_id = g.grading_period_id
            JOIN enrollments en ON en.enrollment_id = g.enrollment_id
            JOIN learners l ON l.learner_id = en.learner_id
            LEFT JOIN (" . user_identity_derived_sql() . ") enc ON enc.user_id = g.encoded_by
            LEFT JOIN employees enc_emp ON enc_emp.user_id = enc.user_id AND enc_emp.is_deleted = 0
            JOIN audit_logs al ON al.table_name = 'grades' AND al.record_id = g.grade_id
            LEFT JOIN (" . user_identity_derived_sql() . ") au ON au.user_id = al.user_id
            LEFT JOIN employees au_emp ON au_emp.user_id = au.user_id AND au_emp.is_deleted = 0
            WHERE {$whereSql}
            ORDER BY al.action_time DESC
            LIMIT {$sqlLimit} OFFSET {$offset}";

    $stmt = $conn->prepare($sql);
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $hasMore = count($rows) > $limit;
    if ($hasMore) {
        $rows = array_slice($rows, 0, $limit);
    }
    respond(['success' => true, 'rows' => $rows, 'has_more' => $hasMore, 'limit' => $limit, 'offset' => $offset]);
}
?>
