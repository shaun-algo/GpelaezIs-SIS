<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/notifications.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';
require_once __DIR__ . '/../services/GradingPolicyService.php';
require_once __DIR__ . '/../services/RiskActionService.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function getIntParam(string $name): ?int {
    $value = $_GET[$name] ?? null;
    if ($value === null || $value === '') return null;
    if (!is_numeric($value)) return null;
    return (int)$value;
}

function riskGradeNumber(int $gradeLevelId, ?string $gradeName): int {
    $name = trim((string)$gradeName);
    if ($name !== '' && preg_match('/^(?:grade\s*)?0*(\d+)$/i', $name, $match)) {
        return (int)$match[1];
    }
    return $gradeLevelId > 0 && $gradeLevelId <= 3 ? $gradeLevelId : 0;
}

function riskGradingPolicyContext(PDO $conn, int $schoolYearId, int $gradeLevelId, ?string $gradeName): array {
    static $policyCache = [];
    $cacheKey = $schoolYearId . ':' . $gradeLevelId;
    if (!array_key_exists($cacheKey, $policyCache)) {
        $policyCache[$cacheKey] = GradingPolicyService::resolve(
            $conn,
            $schoolYearId,
            $gradeLevelId,
            $gradeName
        );
    }

    $policy = $policyCache[$cacheKey];
    $gradeNumber = riskGradeNumber($gradeLevelId, $gradeName);
    $gradingMode = (string)($policy['grading_mode'] ?? 'Numeric');
    $isGradeOne = $gradeNumber === 1;
    $isDescriptiveElementary = $gradeNumber >= 1
        && $gradeNumber <= 3
        && strtolower($gradingMode) === 'descriptive';

    return [
        'grade_number' => $gradeNumber,
        'grading_mode' => $gradingMode,
        'exclude_grade_risk' => $isGradeOne || $isDescriptiveElementary,
        'grade_risk_note' => ($isGradeOne || $isDescriptiveElementary)
            ? 'Grade 1 is excluded from academic grade-risk scoring; Grades 2–3 are excluded when configured for Descriptive mode. Attendance risk remains active.'
            : '',
    ];
}

$operation = $_GET['operation'] ?? '';
// The analytics page is privileged aggregate reporting. Keep the same
// endpoint available to teachers for the operational Risk Assessment page,
// but do not allow teacher analytics requests to use that read path.
$isPrivilegedAnalyticsRead = $operation === 'getAtRiskLearners'
    && (string)($_GET['analytics'] ?? '') === '1';
$isLearnerAcademicStatusRead = $operation === 'getMyAcademicStatus';
$readRoles = $isPrivilegedAnalyticsRead
    ? ['admin', 'registrar', 'principal']
    : ($isLearnerAcademicStatusRead
        ? ['admin', 'learners']
        : ['admin', 'teacher', 'registrar']);
// Assessment writes remain limited to administrators and teachers.
$session = auth_enforce_roles($operation, $readRoles, ['admin', 'teacher']);

try {
    switch ($operation) {
        case 'getAllRiskAssessments':
            getAllRiskAssessments($conn);
            break;
        case 'getAtRiskLearners':
            getAtRiskLearners($conn, $session);
            break;
        case 'getMyAcademicStatus':
            getMyAcademicStatus($conn, $session);
            break;
        case 'getMyAdvisorySections':
            getMyAdvisorySections($conn, $session);
            break;
        case 'createRiskAssessment':
            createRiskAssessment($conn);
            break;
        case 'updateRiskAssessment':
            updateRiskAssessment($conn);
            break;
        case 'deleteRiskAssessment':
            deleteRiskAssessment($conn);
            break;
        case 'computeAutomatedAssessments':
            computeAutomatedAssessments($conn, $session);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (ApplicationIntegrityException $e) {
    respond(['success' => false, 'message' => $e->getMessage()], $e->getCode());
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function canonicalClassOfferingsSql(): string {
    return 'SELECT co_latest.class_id, co_latest.section_id, co_latest.school_year_id, co_latest.subject_id
            FROM class_offerings co_latest
            JOIN (
                SELECT section_id, school_year_id, subject_id, MAX(class_id) AS class_id
                FROM class_offerings
                WHERE is_deleted = 0
                GROUP BY section_id, school_year_id, subject_id
            ) pick ON pick.class_id = co_latest.class_id
            WHERE co_latest.is_deleted = 0';
}

function fetchPrimaryCurriculumId(PDO $conn, int $schoolYearId): ?int {
    return app_integrity_get_curriculum_id_for_school_year($conn, $schoolYearId);
}

function riskSubjectCountSql(?int $curriculumId): string {
    $canonicalSql = canonicalClassOfferingsSql();
    if ($curriculumId && $curriculumId > 0) {
        return 'SELECT sec.section_id,
                       COALESCE(NULLIF(COUNT(DISTINCT cs.subject_id), 0), COUNT(DISTINCT co.subject_id)) AS expected_subject_count
                FROM sections sec
                LEFT JOIN curriculum_subjects cs
                       ON cs.curriculum_id = :subject_curriculum_id
                      AND cs.grade_level_id = sec.grade_level_id
                      AND cs.is_required = 1
                      AND cs.is_deleted = 0
                LEFT JOIN (' . $canonicalSql . ') co
                       ON co.section_id = sec.section_id
                      AND co.school_year_id = sec.school_year_id
                WHERE sec.school_year_id = :sy_subject
                  AND sec.is_deleted = 0
                GROUP BY sec.section_id';
    }

    return 'SELECT co.section_id, COUNT(*) AS expected_subject_count
            FROM (' . $canonicalSql . ') co
            WHERE co.school_year_id = :sy_subject
            GROUP BY co.section_id';
}

function getAllRiskAssessments(PDO $conn): void {
    $sql = "SELECT ra.risk_assessment_id, ra.enrollment_id, ra.grading_period_id, ra.risk_level_id,
                   ra.assessed_by, ra.assessed_at, ra.notes,
                   l.lrn,
                   CONCAT(l.last_name, ', ', l.first_name,
                       CASE WHEN l.middle_name IS NULL OR l.middle_name = '' THEN '' ELSE CONCAT(' ', l.middle_name) END,
                       CASE WHEN l.name_extension IS NULL OR l.name_extension = '' THEN '' ELSE CONCAT(' ', l.name_extension) END
                   ) AS learner_name,
                   sec.section_name,
                   gl.grade_name,
                   sy.year_label,
                   gp.period_name,
                   rl.risk_name,
                   rl.color_code,
                   u.username AS assessed_by_name
            FROM risk_assessments ra
            JOIN enrollments e ON ra.enrollment_id = e.enrollment_id AND e.is_deleted = 0
            JOIN learners l ON e.learner_id = l.learner_id AND l.is_deleted = 0
            LEFT JOIN sections sec ON sec.section_id = e.section_id AND sec.is_deleted = 0
            LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
            LEFT JOIN school_years sy ON sy.school_year_id = e.school_year_id
            JOIN grading_periods gp ON ra.grading_period_id = gp.grading_period_id AND gp.is_deleted = 0
            JOIN risk_levels rl ON ra.risk_level_id = rl.risk_level_id AND rl.is_deleted = 0
            LEFT JOIN (" . user_identity_derived_sql() . ") u ON ra.assessed_by = u.user_id
            WHERE ra.is_deleted = 0
            ORDER BY ra.assessed_at DESC, ra.risk_assessment_id DESC";
    $stmt = $conn->prepare($sql);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function getTeacherEmployeeId(PDO $conn, int $userId): ?int {
    $stmt = $conn->prepare('SELECT employee_id FROM employees WHERE user_id = :uid AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':uid', $userId, PDO::PARAM_INT);
    $stmt->execute();
    $val = $stmt->fetchColumn();
    return $val ? (int)$val : null;
}

function getTeacherRiskSections(PDO $conn, int $employeeId, ?int $schoolYearId): array {
    $sql = 'SELECT s.section_id,
                   s.section_name,
                   s.grade_level_id,
                   gl.grade_name,
                   s.school_year_id,
                   0 AS is_advisory,
                   COUNT(DISTINCT CASE WHEN co.teacher_id = :employee_subject_count THEN co.subject_id ELSE NULL END) AS assigned_subject_count,
                   GROUP_CONCAT(DISTINCT
                       CASE WHEN co.teacher_id = :employee_subject THEN subj.subject_name ELSE NULL END
                       ORDER BY subj.subject_name
                       SEPARATOR ", "
                   ) AS assigned_subjects
            FROM sections s
            JOIN grade_levels gl ON gl.grade_level_id = s.grade_level_id
            LEFT JOIN class_offerings co ON co.section_id = s.section_id
                                        AND co.school_year_id = s.school_year_id
                                        AND co.teacher_id = :employee_join
                                        AND co.is_deleted = 0
            LEFT JOIN subjects subj ON subj.subject_id = co.subject_id AND subj.is_deleted = 0
            WHERE s.is_deleted = 0
              AND co.class_id IS NOT NULL';
    $params = [
        ':employee_subject_count' => $employeeId,
        ':employee_subject' => $employeeId,
        ':employee_join' => $employeeId,
    ];
    if ($schoolYearId) {
        $sql .= ' AND s.school_year_id = :sy';
        $params[':sy'] = $schoolYearId;
    }
    $sql .= ' GROUP BY s.section_id, s.section_name, s.grade_level_id, gl.grade_name, s.school_year_id
              ORDER BY gl.grade_level_id, s.section_name';

    $stmt = $conn->prepare($sql);
    foreach ($params as $key => $val) {
        $stmt->bindValue($key, $val, PDO::PARAM_INT);
    }
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    foreach ($rows as &$row) {
        $isAdvisory = (int)($row['is_advisory'] ?? 0) === 1;
        $subjectCount = (int)($row['assigned_subject_count'] ?? 0);
        $tags = [];
        if ($isAdvisory) $tags[] = 'Advisory';
        if ($subjectCount > 0) $tags[] = $subjectCount . ' subject class' . ($subjectCount === 1 ? '' : 'es');
        $suffix = $tags ? (' - ' . implode(' / ', $tags)) : '';
        $row['display_name'] = trim((string)($row['grade_name'] ?? '') . ' ' . (string)($row['section_name'] ?? '')) . $suffix;
    }
    unset($row);

    return $rows;
}

function getTeacherRiskSectionIds(PDO $conn, int $employeeId, ?int $schoolYearId): array {
    return array_values(array_unique(array_map(static function ($row): int {
        return (int)($row['section_id'] ?? 0);
    }, getTeacherRiskSections($conn, $employeeId, $schoolYearId))));
}

function getMyAdvisorySections(PDO $conn, array $session): void {
    if (($session['role_key'] ?? '') === 'admin') {
        respond(['success' => true, 'data' => []]);
    }

    $employeeId = getTeacherEmployeeId($conn, (int)($session['user_id'] ?? 0));
    if (!$employeeId) {
        respond(['success' => true, 'data' => []]);
    }

    $schoolYearId = getIntParam('school_year_id');
    if (!$schoolYearId || $schoolYearId <= 0) {
        $schoolYearId = getActiveSchoolYearId($conn);
    }

    respond(['success' => true, 'data' => getTeacherRiskSections($conn, $employeeId, $schoolYearId)]);
}

function getAtRiskLearners(PDO $conn, array $session): void {
    $schoolYearId = getIntParam('school_year_id');
    if (!$schoolYearId || $schoolYearId <= 0) {
        $schoolYearId = getActiveSchoolYearId($conn);
    }

    if (!$schoolYearId) {
        respond([
            'success' => true,
            'data' => [
                'records' => [],
                'summary' => ['total_records' => 0, 'critical' => 0, 'high' => 0, 'moderate' => 0, 'low' => 0],
                'school_year_id' => null,
                'period_mode' => 'latest'
            ]
        ]);
    }

    $isGlobalRiskViewer = in_array(($session['role_key'] ?? ''), ['admin', 'registrar'], true);
    $riskAssessmentId = getIntParam('risk_assessment_id');
    $gradingPeriodId = getIntParam('grading_period_id');
    if ((!$gradingPeriodId || $gradingPeriodId <= 0) && (!$riskAssessmentId || $riskAssessmentId <= 0)) {
        respond(['success' => false, 'message' => 'grading_period_id is required because risk flags are term-specific'], 422);
    }
    $gradeLevelId = getIntParam('grade_level_id');
    $sectionId = getIntParam('section_id');
    $riskLevelIdFilter = getIntParam('risk_level_id');
    $riskBandFilter = strtolower(trim((string)($_GET['risk_band'] ?? '')));
    $includeLow = ((string)($_GET['include_low'] ?? '0') === '1');

    refreshAutomatedRiskForSchoolYear($conn, $schoolYearId, (int)($session['user_id'] ?? 0));

    // Teachers may only view learners in sections where they have an assigned subject.
    // Their default view remains focused on non-Low risk records, but an explicit
    // Risk Level selection is still honored within their scoped sections.
    $advisorySectionIds = [];
    if (!$isGlobalRiskViewer) {
        $employeeId = getTeacherEmployeeId($conn, (int)($session['user_id'] ?? 0));
        $advisorySectionIds = $employeeId ? getTeacherRiskSectionIds($conn, $employeeId, $schoolYearId) : [];

        if (empty($advisorySectionIds)) {
            respond([
                'success' => true,
                'data' => [
                    'records' => [],
                    'summary' => ['total_records' => 0, 'critical' => 0, 'high' => 0, 'moderate' => 0, 'low' => 0],
                    'school_year_id' => $schoolYearId,
                    'period_mode' => 'latest'
                ]
            ]);
        }

        if ($sectionId && !in_array($sectionId, $advisorySectionIds, true)) {
            $sectionId = null;
        }
        $gradeLevelId = null;
    }

    $canonicalSql = canonicalClassOfferingsSql();
    $primaryCurriculumId = fetchPrimaryCurriculumId($conn, $schoolYearId);
    $subjectCountSql = riskSubjectCountSql($primaryCurriculumId);

    $periodGradesSql =
        'SELECT e.enrollment_id,
                g.grading_period_id,
                ROUND(AVG(g.quarterly_grade), 2) AS period_average,
                MIN(g.quarterly_grade) AS min_quarterly_grade,
                COUNT(g.grade_id) AS encoded_subject_count,
                COUNT(CASE WHEN g.quarterly_grade < 75 THEN 1 END) AS failing_subject_count,
                GROUP_CONCAT(
                    CASE
                        WHEN g.quarterly_grade < 75
                        THEN CONCAT(COALESCE(subj.subject_name, "Subject"), " ", ROUND(g.quarterly_grade, 2))
                        ELSE NULL
                    END
                    ORDER BY subj.subject_name
                    SEPARATOR " / "
                ) AS failing_subjects
         FROM enrollments e
         JOIN (' . $canonicalSql . ') co ON co.section_id = e.section_id
                                       AND co.school_year_id = e.school_year_id
         LEFT JOIN subjects subj ON subj.subject_id = co.subject_id
                                AND subj.is_deleted = 0
         LEFT JOIN grades g ON g.enrollment_id = e.enrollment_id
                           AND g.class_id = co.class_id
                           AND g.is_deleted = 0
                           AND g.quarterly_grade IS NOT NULL
         WHERE e.is_deleted = 0
           AND e.school_year_id = :sy_period_grades
         GROUP BY e.enrollment_id, g.grading_period_id';

    // Attendance is bucketed by the grading-period date window. A stored
    // grading_period_id is accepted only when its attendance date is inside
    // that same window; legacy NULL period IDs are inferred by date.
    $attendanceSql =
        'SELECT a.enrollment_id,
                gp_att.grading_period_id AS period_bucket_id,
                COUNT(DISTINCT a.attendance_date) AS recorded_days,
                SUM(CASE
                    WHEN a.status IN ("Half-day", "HD") THEN 0.5
                    WHEN a.status IN ("Absent", "Excused", "NLPA") THEN 1
                    ELSE 0
                END) AS absent_days,
                SUM(CASE WHEN a.status IN ("Late", "Cutting") THEN 1 ELSE 0 END) AS late_count,
                COUNT(DISTINCT CASE WHEN a.status IN ("Holiday", "No Classes") THEN a.attendance_date END) AS closed_days
         FROM attendance a
         JOIN enrollments e ON e.enrollment_id = a.enrollment_id AND e.is_deleted = 0
         JOIN grading_periods gp_att
           ON gp_att.school_year_id = e.school_year_id
          AND gp_att.is_deleted = 0
          AND a.attendance_date BETWEEN gp_att.date_start AND gp_att.date_end
          AND (
              a.grading_period_id = gp_att.grading_period_id
              OR (
                  a.grading_period_id IS NULL
                  AND gp_att.grading_period_id = (
                      SELECT gp_inferred.grading_period_id
                      FROM grading_periods gp_inferred
                      WHERE gp_inferred.school_year_id = e.school_year_id
                        AND gp_inferred.is_deleted = 0
                        AND a.attendance_date BETWEEN gp_inferred.date_start AND gp_inferred.date_end
                      ORDER BY gp_inferred.date_start ASC, gp_inferred.grading_period_id ASC
                      LIMIT 1
                  )
              )
          )
         WHERE a.is_deleted = 0
         GROUP BY a.enrollment_id, gp_att.grading_period_id';

    $indicatorSql =
        'SELECT ri.risk_assessment_id,
                GROUP_CONCAT(
                    CONCAT(
                        ri.indicator_type,
                        CASE
                            WHEN ri.details IS NULL OR ri.details = "" THEN ""
                            ELSE CONCAT(": ", ri.details)
                        END
                    )
                    ORDER BY ri.indicator_id ASC
                    SEPARATOR " / "
                ) AS indicators
         FROM risk_indicators ri
         WHERE ri.is_deleted = 0
         GROUP BY ri.risk_assessment_id';

    $latestJoin = '';
    $where = [
        'ra.is_deleted = 0',
        'e.is_deleted = 0',
        'e.school_year_id = :sy_main'
    ];

    if ($riskAssessmentId && $riskAssessmentId > 0) {
        $where[] = 'ra.risk_assessment_id = :risk_assessment_id';
    } elseif ($gradingPeriodId && $gradingPeriodId > 0) {
        $where[] = 'ra.grading_period_id = :gp_filter';
    } else {
        $latestJoin =
            'JOIN (
                SELECT ra2.enrollment_id, MAX(ra2.grading_period_id) AS latest_period_id
                FROM risk_assessments ra2
                JOIN enrollments e2 ON e2.enrollment_id = ra2.enrollment_id
                                   AND e2.is_deleted = 0
                                   AND e2.school_year_id = :sy_latest_enroll
                JOIN grading_periods gp2 ON gp2.grading_period_id = ra2.grading_period_id
                                        AND gp2.is_deleted = 0
                                        AND gp2.school_year_id = :sy_latest_period
                WHERE ra2.is_deleted = 0
                GROUP BY ra2.enrollment_id
             ) latest ON latest.enrollment_id = ra.enrollment_id
                     AND latest.latest_period_id = ra.grading_period_id';
    }

    if ($gradeLevelId && $gradeLevelId > 0) {
        $where[] = 'e.grade_level_id = :grade_level_id';
    }
    if ($sectionId && $sectionId > 0) {
        $where[] = 'e.section_id = :section_id';
    } elseif (!$isGlobalRiskViewer) {
        $advisoryPlaceholders = [];
        foreach ($advisorySectionIds as $idx => $advSectionId) {
            $advisoryPlaceholders[] = ':adv_sec_' . $idx;
        }
        $where[] = 'e.section_id IN (' . implode(',', $advisoryPlaceholders) . ')';
    }
    $sql =
        'SELECT ra.risk_assessment_id,
                ra.enrollment_id,
                ra.grading_period_id,
                ra.risk_level_id,
                ra.assessed_at,
                ra.notes,
                l.lrn,
                CONCAT(l.last_name, ", ", l.first_name,
                    CASE WHEN l.middle_name IS NULL OR l.middle_name = "" THEN "" ELSE CONCAT(" ", l.middle_name) END,
                    CASE WHEN l.name_extension IS NULL OR l.name_extension = "" THEN "" ELSE CONCAT(" ", l.name_extension) END
                ) AS learner_name,
                sec.section_name,
                gl.grade_name,
                sy.year_label,
                gp.period_name,
                gp.date_start,
                gp.date_end,
                CASE WHEN EXISTS (
                    SELECT 1
                    FROM grading_periods gp_prev
                    WHERE gp_prev.school_year_id = gp.school_year_id
                      AND gp_prev.is_deleted = 0
                      AND (
                          COALESCE(gp_prev.date_start, "9999-12-31") < COALESCE(gp.date_start, "9999-12-31")
                          OR (
                              COALESCE(gp_prev.date_start, "9999-12-31") = COALESCE(gp.date_start, "9999-12-31")
                              AND gp_prev.grading_period_id < gp.grading_period_id
                          )
                      )
                ) THEN 0 ELSE 1 END AS is_first_period,
                rl.risk_name,
                rl.color_code,
                e.grade_level_id,
                ga.general_average,
                pg.period_average,
                pg.min_quarterly_grade,
                pg.encoded_subject_count,
                pg.failing_subject_count,
                pg.failing_subjects,
                sc.expected_subject_count,
                att.recorded_days,
                att.absent_days,
                att.late_count,
                att.closed_days,
                CASE
                    WHEN att.recorded_days IS NULL OR att.recorded_days = 0 THEN NULL
                    ELSE ROUND((att.absent_days / att.recorded_days) * 100, 2)
                END AS attendance_rate,
                COALESCE(ri.indicators, "") AS indicators
         FROM risk_assessments ra
         JOIN enrollments e ON e.enrollment_id = ra.enrollment_id
         JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
         LEFT JOIN sections sec ON sec.section_id = e.section_id AND sec.is_deleted = 0
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         LEFT JOIN school_years sy ON sy.school_year_id = e.school_year_id
         JOIN grading_periods gp ON gp.grading_period_id = ra.grading_period_id AND gp.is_deleted = 0
         JOIN risk_levels rl ON rl.risk_level_id = ra.risk_level_id AND rl.is_deleted = 0
         LEFT JOIN general_averages ga ON ga.enrollment_id = e.enrollment_id
                                      AND ga.school_year_id = e.school_year_id
                                      AND ga.is_deleted = 0
         LEFT JOIN (' . $periodGradesSql . ') pg ON pg.enrollment_id = e.enrollment_id
                                                AND pg.grading_period_id = ra.grading_period_id
         LEFT JOIN (' . $subjectCountSql . ') sc ON sc.section_id = e.section_id
         LEFT JOIN (' . $attendanceSql . ') att ON att.enrollment_id = e.enrollment_id
                                              AND att.period_bucket_id = ra.grading_period_id
         LEFT JOIN (' . $indicatorSql . ') ri ON ri.risk_assessment_id = ra.risk_assessment_id
         ' . $latestJoin . '
         WHERE ' . implode(' AND ', $where) . '
         ORDER BY ra.risk_level_id DESC, ra.assessed_at DESC, learner_name ASC';

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':sy_main', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':sy_period_grades', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':sy_subject', $schoolYearId, PDO::PARAM_INT);
    if ($primaryCurriculumId && $primaryCurriculumId > 0) {
        $stmt->bindValue(':subject_curriculum_id', $primaryCurriculumId, PDO::PARAM_INT);
    }

    if ($riskAssessmentId && $riskAssessmentId > 0) {
        $stmt->bindValue(':risk_assessment_id', $riskAssessmentId, PDO::PARAM_INT);
    } elseif (!$gradingPeriodId || $gradingPeriodId <= 0) {
        $stmt->bindValue(':sy_latest_enroll', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':sy_latest_period', $schoolYearId, PDO::PARAM_INT);
    } else {
        $stmt->bindValue(':gp_filter', $gradingPeriodId, PDO::PARAM_INT);
    }

    if ($gradeLevelId && $gradeLevelId > 0) {
        $stmt->bindValue(':grade_level_id', $gradeLevelId, PDO::PARAM_INT);
    }
    if ($sectionId && $sectionId > 0) {
        $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    } elseif (!$isGlobalRiskViewer) {
        foreach ($advisorySectionIds as $idx => $advSectionId) {
            $stmt->bindValue(':adv_sec_' . $idx, $advSectionId, PDO::PARAM_INT);
        }
    }

    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $riskLevelMap = resolveRiskLevelIds($conn);
    $riskActionRules = RiskActionService::loadRules($conn);
    foreach ($rows as &$row) {
        $gradingPolicy = riskGradingPolicyContext(
            $conn,
            $schoolYearId,
            (int)($row['grade_level_id'] ?? 0),
            (string)($row['grade_name'] ?? '')
        );
        $excludeGradeRisk = (bool)$gradingPolicy['exclude_grade_risk'];

        $recordedDays = isset($row['recorded_days']) && $row['recorded_days'] !== null ? (int)$row['recorded_days'] : 0;
        if ($recordedDays > 0) {
            $totalSchoolDays = countWeekdaysBetween($row['date_start'] ?? null, $row['date_end'] ?? null);
            $closedDays = max(0, (int)($row['closed_days'] ?? 0));
            $learnerSchoolDays = max(0, $totalSchoolDays - $closedDays);
            $denominator = $learnerSchoolDays > 0 ? $learnerSchoolDays : $recordedDays;
            $absentDays = (float)($row['absent_days'] ?? 0);
            $row['attendance_rate'] = round(($absentDays / $denominator) * 100, 2);
        }

        [$riskLevelId, $indicators, $notes, $score, $level, $action] = evaluateRiskLevel([
            'skip_grade_assessment' => $excludeGradeRisk,
            'subject_count' => $excludeGradeRisk ? 0 : (int)($row['expected_subject_count'] ?? 0),
            'grade_count' => $excludeGradeRisk ? 0 : (int)($row['encoded_subject_count'] ?? 0),
            'failing_count' => $excludeGradeRisk ? 0 : (int)($row['failing_subject_count'] ?? 0),
            'failing_subjects' => $excludeGradeRisk ? '' : (string)($row['failing_subjects'] ?? ''),
            'period_avg' => $excludeGradeRisk || $row['period_average'] === null || $row['period_average'] === ''
                ? null
                : (float)$row['period_average'],
            'min_grade' => $excludeGradeRisk || $row['min_quarterly_grade'] === null || $row['min_quarterly_grade'] === ''
                ? null
                : (float)$row['min_quarterly_grade'],
            'decline_streak' => 0,
            'latest_drop' => null,
            'has_previous_grading_period' => ((int)($row['is_first_period'] ?? 0) !== 1),
            'absence_rate' => ($row['attendance_rate'] === null || $row['attendance_rate'] === '') ? null : (float)$row['attendance_rate'],
            'late_count' => (int)($row['late_count'] ?? 0),
            'final_min' => null,
            'general_average' => $excludeGradeRisk || $row['general_average'] === null || $row['general_average'] === ''
                ? null
                : (float)$row['general_average'],
        ], $riskLevelMap, $riskActionRules);

        $storedMetrics = parseRiskMetricsFromNotes((string)($row['notes'] ?? ''));
        if (!$excludeGradeRisk && (int)($storedMetrics['score'] ?? 0) > $score) {
            $score = (int)$storedMetrics['score'];
            $level = (string)($storedMetrics['level'] ?? scoreToRiskLevel($score));
            $riskLevelId = (int)($riskLevelMap[$level] ?? $riskLevelId);
        }

        // Recommended actions come from the active masterfile rule for each
        // computed indicator, not from previously stored notes.
        $action = RiskActionService::recommendedAction($indicators, $riskActionRules);

        $row['risk_level_id'] = $riskLevelId;
        $row['risk_score'] = $score;
        $row['risk_name'] = $level;
        $row['color_code'] = riskLevelColor($level);
        $row['recommended_action'] = $action;
        $computedIndicators = implode(' / ', array_map(static function (array $item): string {
            $details = trim((string)($item['details'] ?? ''));
            return $details === ''
                ? (string)$item['indicator_type']
                : ((string)$item['indicator_type'] . ': ' . $details);
        }, $indicators));
        $row['indicators'] = $excludeGradeRisk
            ? $computedIndicators
            : mergeStoredTrendIndicators($computedIndicators, (string)($row['indicators'] ?? ''));
        $row['grading_mode'] = $gradingPolicy['grading_mode'];
        $row['grade_risk_assessed'] = !$excludeGradeRisk;
        $row['grade_risk_note'] = $gradingPolicy['grade_risk_note'];

        if ($excludeGradeRisk) {
            $row['general_average'] = null;
            $row['period_average'] = null;
            $row['min_quarterly_grade'] = null;
            $row['encoded_subject_count'] = null;
            $row['failing_subject_count'] = null;
            $row['failing_subjects'] = '';
        }
    }
    unset($row);

    $rows = array_values(array_filter($rows, static function (array $row) use ($isGlobalRiskViewer, $includeLow, $riskLevelIdFilter, $riskBandFilter): bool {
        $name = strtolower((string)($row['risk_name'] ?? ''));
        $score = (int)($row['risk_score'] ?? 0);

        if ($riskBandFilter === 'danger') {
            if (!str_contains($name, 'medium')
                && !str_contains($name, 'moderate')
                && !str_contains($name, 'high')
                && !str_contains($name, 'critical')) {
                return false;
            }
        } elseif ($riskBandFilter === 'high') {
            if (!str_contains($name, 'high') && !str_contains($name, 'critical')) {
                return false;
            }
        } elseif ($riskLevelIdFilter && (int)($row['risk_level_id'] ?? 0) !== $riskLevelIdFilter) {
            return false;
        }

        // Low-risk records are included when Show all include Low is selected or
        // when a specific Low filter is selected. Teacher section scope is
        // still enforced before this response filter is applied.
        if (in_array($name, ['low', 'low risk'], true)) {
            return $includeLow || (bool)$riskLevelIdFilter;
        }

        if (!$isGlobalRiskViewer) {
            return $score > 0 || in_array($name, ['high', 'medium'], true);
        }

        return true;
    }));

    usort($rows, static function (array $a, array $b) {
        $aScore = (int)($a['risk_score'] ?? 0);
        $bScore = (int)($b['risk_score'] ?? 0);
        if ($bScore !== $aScore) {
            return $bScore <=> $aScore;
        }
        return strcmp((string)($a['learner_name'] ?? ''), (string)($b['learner_name'] ?? ''));
    });

    $summary = ['total_records' => 0, 'high' => 0, 'medium' => 0, 'low' => 0];
    foreach ($rows as $row) {
        $summary['total_records'] += 1;
        $name = strtolower((string)($row['risk_name'] ?? ''));
        if (str_contains($name, 'critical') || str_contains($name, 'high')) $summary['high'] += 1;
        elseif (str_contains($name, 'medium') || str_contains($name, 'moderate')) $summary['medium'] += 1;
        else $summary['low'] += 1;
    }

    respond([
        'success' => true,
        'data' => [
            'records' => $rows,
            'summary' => $summary,
            'school_year_id' => $schoolYearId,
            'period_mode' => ($gradingPeriodId && $gradingPeriodId > 0) ? 'selected' : 'latest'
        ]
    ]);
}

function getMyAcademicStatus(PDO $conn, array $session): void {
    $userId = (int)($session['user_id'] ?? 0);
    if ($userId <= 0) {
        respond(['success' => false, 'message' => 'Not authenticated'], 401);
    }

    $enrollmentStmt = $conn->prepare(
        'SELECT e.enrollment_id,
                e.school_year_id,
                e.grade_level_id,
                sy.year_label,
                sy.year_start,
                sy.year_end,
                gl.grade_name,
                sec.section_name,
                l.lrn,
                CONCAT(l.last_name, ", ", l.first_name,
                    CASE WHEN l.middle_name IS NULL OR l.middle_name = "" THEN "" ELSE CONCAT(" ", l.middle_name) END,
                    CASE WHEN l.name_extension IS NULL OR l.name_extension = "" THEN "" ELSE CONCAT(" ", l.name_extension) END
                ) AS learner_name
         FROM enrollments e
         JOIN learners l ON l.learner_id = e.learner_id
                        AND l.user_id = :user_id
                        AND l.is_deleted = 0
         JOIN school_years sy ON sy.school_year_id = e.school_year_id
                             AND sy.is_deleted = 0
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         LEFT JOIN sections sec ON sec.section_id = e.section_id
                               AND sec.is_deleted = 0
         WHERE e.is_deleted = 0
         ORDER BY sy.is_active DESC,
                  COALESCE(sy.year_start, "0000-00-00") DESC,
                  e.enrollment_id DESC
         LIMIT 1'
    );
    $enrollmentStmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $enrollmentStmt->execute();
    $enrollment = $enrollmentStmt->fetch(PDO::FETCH_ASSOC) ?: null;

    if (!$enrollment) {
        respond([
            'success' => true,
            'data' => [
                'learner' => null,
                'school_year' => null,
                'periods' => [],
                'records' => [],
                'message' => 'No academic enrollment is linked to your learner account.'
            ]
        ]);
    }

    $schoolYearId = (int)$enrollment['school_year_id'];
    $periodStmt = $conn->prepare(
        'SELECT grading_period_id, period_no, period_name, date_start, date_end, status
         FROM grading_periods
         WHERE school_year_id = :school_year_id
           AND is_deleted = 0
         ORDER BY COALESCE(date_start, "9999-12-31"),
                  COALESCE(period_no, 999),
                  grading_period_id'
    );
    $periodStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $periodStmt->execute();
    $periods = $periodStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    if (!$periods) {
        respond([
            'success' => true,
            'data' => [
                'learner' => [
                    'learner_name' => (string)($enrollment['learner_name'] ?? ''),
                    'lrn' => (string)($enrollment['lrn'] ?? ''),
                    'grade_name' => (string)($enrollment['grade_name'] ?? ''),
                    'section_name' => (string)($enrollment['section_name'] ?? '')
                ],
                'school_year' => [
                    'school_year_id' => $schoolYearId,
                    'year_label' => (string)($enrollment['year_label'] ?? '')
                ],
                'periods' => [],
                'records' => [],
                'message' => 'No grading periods are configured for this school year.'
            ]
        ]);
    }

    // Recompute the learner's current term statuses from attendance and grade
    // records before reading the saved risk assessment rows.
    refreshAutomatedRiskForSchoolYear($conn, $schoolYearId, $userId);

    $indicatorStmt = $conn->prepare(
        'SELECT ra.risk_assessment_id,
                ra.grading_period_id,
                rl.risk_name,
                ri.indicator_type,
                ri.details
         FROM risk_assessments ra
         JOIN grading_periods gp ON gp.grading_period_id = ra.grading_period_id
                                AND gp.school_year_id = :school_year_id
                                AND gp.is_deleted = 0
         JOIN risk_levels rl ON rl.risk_level_id = ra.risk_level_id
                            AND rl.is_deleted = 0
         LEFT JOIN risk_indicators ri ON ri.risk_assessment_id = ra.risk_assessment_id
                                     AND ri.is_deleted = 0
         WHERE ra.enrollment_id = :enrollment_id
           AND ra.is_deleted = 0
         ORDER BY COALESCE(gp.date_start, "9999-12-31"),
                  gp.grading_period_id,
                  ri.indicator_id'
    );
    $indicatorStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $indicatorStmt->bindValue(':enrollment_id', (int)$enrollment['enrollment_id'], PDO::PARAM_INT);
    $indicatorStmt->execute();

    $assessmentByPeriod = [];
    foreach ($indicatorStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $periodId = (int)$row['grading_period_id'];
        if (!isset($assessmentByPeriod[$periodId])) {
            $assessmentByPeriod[$periodId] = [
                'risk_assessment_id' => (int)($row['risk_assessment_id'] ?? 0),
                'risk_name' => (string)($row['risk_name'] ?? 'Assessed'),
                'indicators' => []
            ];
        }
        $indicatorType = trim((string)($row['indicator_type'] ?? ''));
        if ($indicatorType !== '') {
            $assessmentByPeriod[$periodId]['indicators'][] = [
                'indicator_type' => $indicatorType,
                'details' => (string)($row['details'] ?? '')
            ];
        }
    }

    $today = date('Y-m-d');
    $records = [];
    foreach ($periods as $period) {
        $periodId = (int)$period['grading_period_id'];
        $assessment = $assessmentByPeriod[$periodId] ?? null;
        $dateStart = substr((string)($period['date_start'] ?? ''), 0, 10);
        $dateEnd = substr((string)($period['date_end'] ?? ''), 0, 10);

        $records[] = [
            'grading_period_id' => $periodId,
            'period_no' => (int)($period['period_no'] ?? 0),
            'period_name' => (string)($period['period_name'] ?? 'Term'),
            'date_start' => $dateStart,
            'date_end' => $dateEnd,
            'period_status' => (string)($period['status'] ?? 'Locked'),
            'is_current' => $dateStart !== '' && $dateEnd !== '' && $today >= $dateStart && $today <= $dateEnd,
            'status' => $assessment ? 'assessed' : 'not_assessed',
            'risk_assessment_id' => (int)($assessment['risk_assessment_id'] ?? 0),
            'risk_name' => $assessment['risk_name'] ?? 'Not assessed',
            'indicators' => $assessment['indicators'] ?? []
        ];
    }

    respond([
        'success' => true,
        'data' => [
            'learner' => [
                'learner_name' => (string)($enrollment['learner_name'] ?? ''),
                'lrn' => (string)($enrollment['lrn'] ?? ''),
                'grade_name' => (string)($enrollment['grade_name'] ?? ''),
                'section_name' => (string)($enrollment['section_name'] ?? '')
            ],
            'school_year' => [
                'school_year_id' => $schoolYearId,
                'year_label' => (string)($enrollment['year_label'] ?? ''),
                'year_start' => (string)($enrollment['year_start'] ?? ''),
                'year_end' => (string)($enrollment['year_end'] ?? '')
            ],
            'periods' => $records,
            'records' => $records
        ]
    ]);
}

function refreshAutomatedRiskForSchoolYear(PDO $conn, int $schoolYearId, int $userId): void {
    $lockKey = "risk_refresh:{$schoolYearId}";
    $lockAcquired = false;
    $lockStmt = $conn->prepare('SELECT GET_LOCK(?, 10)');
    $lockStmt->execute([$lockKey]);
    $lockAcquired = (bool)$lockStmt->fetchColumn();
    if (!$lockAcquired) {
        throw new RuntimeException('Could not acquire risk assessment refresh lock. Please retry.');
    }

    try {
        $conn->beginTransaction();
        $expectedPeriods = getExpectedPeriodsForSchoolYear($conn, $schoolYearId);
        $finalGrades = computeFinalGrades($conn, $schoolYearId, $expectedPeriods);
        upsertFinalGrades($conn, $finalGrades, $userId);

        $generalAverages = computeGeneralAveragesFromPersistedFinalGrades($conn, $schoolYearId);
        upsertGeneralAverages($conn, $schoolYearId, $generalAverages, $userId);
        computeRiskAssessments($conn, $schoolYearId, $userId, $generalAverages, $finalGrades);
        $conn->commit();
    } catch (Throwable $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        throw $e;
    } finally {
        if ($lockAcquired) {
            $releaseStmt = $conn->prepare('SELECT RELEASE_LOCK(?)');
            $releaseStmt->execute([$lockKey]);
        }
    }
}

function createRiskAssessment(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['enrollment_id']) || empty($data['grading_period_id']) || empty($data['risk_level_id'])) {
        respond(['success' => false, 'message' => 'Enrollment, grading period, and risk level are required'], 422);
    }
    $stmt = $conn->prepare('INSERT INTO risk_assessments (enrollment_id, grading_period_id, risk_level_id, assessed_by, notes) VALUES (:enrollment_id, :grading_period_id, :risk_level_id, :assessed_by, :notes)');
    $stmt->bindValue(':enrollment_id', $data['enrollment_id'], PDO::PARAM_INT);
    $stmt->bindValue(':grading_period_id', $data['grading_period_id'], PDO::PARAM_INT);
    $stmt->bindValue(':risk_level_id', $data['risk_level_id'], PDO::PARAM_INT);
    $stmt->bindValue(':assessed_by', $data['assessed_by'] ?? null, $data['assessed_by'] === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
    $stmt->bindValue(':notes', $data['notes'] ?? null);
    $stmt->execute();
    $riskAssessmentId = (int)$conn->lastInsertId();
    notifyLearnerRiskAssessment($conn, $riskAssessmentId);
    respond(['success' => true, 'message' => 'Risk assessment created', 'risk_assessment_id' => $riskAssessmentId]);
}

function updateRiskAssessment(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['risk_assessment_id']) || empty($data['enrollment_id']) || empty($data['grading_period_id']) || empty($data['risk_level_id'])) {
        respond(['success' => false, 'message' => 'Risk assessment ID, enrollment, grading period, and risk level are required'], 422);
    }
    $stmt = $conn->prepare('UPDATE risk_assessments SET enrollment_id = :enrollment_id, grading_period_id = :grading_period_id, risk_level_id = :risk_level_id, assessed_by = :assessed_by, notes = :notes WHERE risk_assessment_id = :risk_assessment_id');
    $stmt->bindValue(':enrollment_id', $data['enrollment_id'], PDO::PARAM_INT);
    $stmt->bindValue(':grading_period_id', $data['grading_period_id'], PDO::PARAM_INT);
    $stmt->bindValue(':risk_level_id', $data['risk_level_id'], PDO::PARAM_INT);
    $stmt->bindValue(':assessed_by', $data['assessed_by'] ?? null, $data['assessed_by'] === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
    $stmt->bindValue(':notes', $data['notes'] ?? null);
    $stmt->bindValue(':risk_assessment_id', $data['risk_assessment_id'], PDO::PARAM_INT);
    $stmt->execute();
    notifyLearnerRiskAssessment($conn, (int)$data['risk_assessment_id']);
    respond(['success' => true, 'message' => 'Risk assessment updated']);
}

function deleteRiskAssessment(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['risk_assessment_id'])) {
        respond(['success' => false, 'message' => 'Risk assessment ID is required'], 422);
    }
    $stmt = $conn->prepare('UPDATE risk_assessments SET is_deleted = 1, deleted_at = NOW() WHERE risk_assessment_id = :risk_assessment_id');
    $stmt->bindValue(':risk_assessment_id', $data['risk_assessment_id'], PDO::PARAM_INT);
    $stmt->execute();
    respond(['success' => true, 'message' => 'Risk assessment deleted']);
}

function computeAutomatedAssessments(PDO $conn, array $session): void {
    $requestedSchoolYearId = getIntParam('school_year_id');
    $schoolYearId = ($requestedSchoolYearId && $requestedSchoolYearId > 0)
        ? $requestedSchoolYearId
        : getActiveSchoolYearId($conn);

    if (!$schoolYearId) {
        respond(['success' => false, 'message' => 'No target school year found'], 422);
    }

    $userId = (int)($session['user_id'] ?? 0);
    $counts = [
        'quarterly_updated' => 0,
        'final_grades_upserted' => 0,
        'general_averages_upserted' => 0,
        'risk_assessments_upserted' => 0,
        'risk_indicators_upserted' => 0,
        'school_year_id' => $schoolYearId
    ];

    $conn->beginTransaction();
    try {
        $expectedPeriods = getExpectedPeriodsForSchoolYear($conn, $schoolYearId);
        $finalGrades = computeFinalGrades($conn, $schoolYearId, $expectedPeriods);
        $counts['final_grades_upserted'] = upsertFinalGrades($conn, $finalGrades, $userId);

        $generalAverages = computeGeneralAveragesFromPersistedFinalGrades($conn, $schoolYearId);
        $counts['general_averages_upserted'] = upsertGeneralAverages($conn, $schoolYearId, $generalAverages, $userId);

        $riskResult = computeRiskAssessments($conn, $schoolYearId, $userId, $generalAverages, $finalGrades);
        $counts['risk_assessments_upserted'] = (int)$riskResult['assessments'];
        $counts['risk_indicators_upserted'] = (int)$riskResult['indicators'];

        $conn->commit();
    } catch (Exception $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        throw $e;
    }

    notifyAtRiskLearners($conn, $schoolYearId, getIntParam('grading_period_id'));

    respond([
        'success' => true,
        'message' => 'Automation completed',
        'data' => $counts
    ]);
}

function getActiveSchoolYearId(PDO $conn): ?int {
    $stmt = $conn->query('SELECT school_year_id FROM school_years WHERE is_deleted = 0 AND is_active = 1 ORDER BY school_year_id DESC LIMIT 1');
    $id = $stmt->fetchColumn();
    return $id ? (int)$id : null;
}

function getExpectedPeriodsForSchoolYear(PDO $conn, int $schoolYearId): int {
    // Expected period count is driven by the school year's grading system.
    // Do not infer from existing rows because missing grading_periods would incorrectly allow
    // Final Grades to be computed before all periods are encoded.
    try {
        $stmt = $conn->prepare('SELECT grading_system_type FROM school_years WHERE school_year_id = :sy AND is_deleted = 0 LIMIT 1');
        $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        $type = strtolower(trim((string)($stmt->fetchColumn() ?? '')));
        return match ($type) {
            'semester' => 2,
            'three-term', 'three term', 'trimester', 'term' => 3,
            default => 4,
        };
    } catch (Exception $e) {
        return 4;
    }
}

function computeFinalGrades(PDO $conn, int $schoolYearId, int $expectedPeriods): array {
    $canonicalSql = canonicalClassOfferingsSql();

    $stmt = $conn->prepare(
        'SELECT g.enrollment_id,
                g.class_id,
                COALESCE(subj.subject_name, "Subject") AS subject_name,
                ROUND(AVG(g.quarterly_grade), 2) AS final_grade,
                COUNT(*) AS graded_periods
         FROM grades g
         JOIN enrollments e ON e.enrollment_id = g.enrollment_id
                           AND e.is_deleted = 0
                           AND e.school_year_id = :sy_enroll
         JOIN (' . $canonicalSql . ') co ON co.class_id = g.class_id
                                        AND co.section_id = e.section_id
                                        AND co.school_year_id = e.school_year_id
         LEFT JOIN subjects subj ON subj.subject_id = co.subject_id
                                AND subj.is_deleted = 0
         JOIN grading_periods gp ON gp.grading_period_id = g.grading_period_id
                                AND gp.is_deleted = 0
                                AND gp.school_year_id = :sy_period
         WHERE g.is_deleted = 0
           AND g.quarterly_grade IS NOT NULL
         GROUP BY g.enrollment_id, g.class_id, subj.subject_name
         HAVING graded_periods = :expected_periods'
    );
    $stmt->bindValue(':sy_enroll', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':sy_period', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':expected_periods', $expectedPeriods, PDO::PARAM_INT);
    $stmt->execute();

    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    return array_map(static function ($row) {
        return [
            'enrollment_id' => (int)$row['enrollment_id'],
            'class_id' => (int)$row['class_id'],
            'subject_name' => (string)($row['subject_name'] ?? 'Subject'),
            'final_grade' => round((float)$row['final_grade'], 2)
        ];
    }, $rows);
}

function upsertFinalGrades(PDO $conn, array $finalGrades, int $userId): int {
    $findStmt = $conn->prepare('SELECT final_grade_id FROM final_grades WHERE enrollment_id = :enrollment_id AND class_id = :class_id LIMIT 1');
    $updateStmt = $conn->prepare('UPDATE final_grades SET final_grade = :final_grade, remark = :remark, computed_by = :computed_by, computed_at = NOW(), is_deleted = 0, deleted_at = NULL WHERE final_grade_id = :final_grade_id');
    $insertStmt = $conn->prepare('INSERT INTO final_grades (enrollment_id, class_id, final_grade, remark, computed_by, is_deleted, deleted_at) VALUES (:enrollment_id, :class_id, :final_grade, :remark, :computed_by, 0, NULL)');

    $upserted = 0;

    foreach ($finalGrades as $row) {
        $prepared = app_integrity_prepare_final_grade(
            $conn,
            (int)$row['enrollment_id'],
            (int)$row['class_id'],
            $row['final_grade']
        );
        $finalGrade = $prepared['final_grade'];
        $remark = $prepared['remark'];

        $findStmt->execute([
            ':enrollment_id' => (int)$row['enrollment_id'],
            ':class_id' => (int)$row['class_id']
        ]);
        $existingId = $findStmt->fetchColumn();

        if ($existingId) {
            $updateStmt->execute([
                ':final_grade' => $finalGrade,
                ':remark' => $remark,
                ':computed_by' => $userId ?: null,
                ':final_grade_id' => (int)$existingId
            ]);
        } else {
            $insertStmt->execute([
                ':enrollment_id' => (int)$row['enrollment_id'],
                ':class_id' => (int)$row['class_id'],
                ':final_grade' => $finalGrade,
                ':remark' => $remark,
                ':computed_by' => $userId ?: null
            ]);
        }

        $upserted += 1;
    }

    return $upserted;
}

function computeGeneralAveragesFromPersistedFinalGrades(PDO $conn, int $schoolYearId): array {
    $stmt = $conn->prepare(
        'SELECT e.enrollment_id,
                ROUND(AVG(fg.final_grade), 2) AS general_average
         FROM enrollments e
         JOIN final_grades fg ON fg.enrollment_id = e.enrollment_id
                             AND fg.is_deleted = 0
                             AND fg.final_grade IS NOT NULL
         JOIN class_offerings co ON co.class_id = fg.class_id
                                AND co.is_deleted = 0
                                AND co.school_year_id = e.school_year_id
         WHERE e.is_deleted = 0
           AND e.school_year_id = :school_year_id
         GROUP BY e.enrollment_id'
    );
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();

    return array_map(static function ($row) {
        return [
            'enrollment_id' => (int)$row['enrollment_id'],
            'general_average' => round((float)$row['general_average'], 2)
        ];
    }, $stmt->fetchAll(PDO::FETCH_ASSOC));
}

function upsertGeneralAverages(PDO $conn, int $schoolYearId, array $generalAverages, int $userId): int {
    $findStmt = $conn->prepare('SELECT general_average_id FROM general_averages WHERE enrollment_id = :enrollment_id LIMIT 1');
    $updateStmt = $conn->prepare('UPDATE general_averages SET school_year_id = :school_year_id, general_average = :general_average, computed_by = :computed_by, computed_at = NOW(), is_deleted = 0, deleted_at = NULL WHERE general_average_id = :general_average_id');
    $insertStmt = $conn->prepare('INSERT INTO general_averages (enrollment_id, school_year_id, general_average, computed_by, is_deleted, deleted_at) VALUES (:enrollment_id, :school_year_id, :general_average, :computed_by, 0, NULL)');

    $upserted = 0;

    foreach ($generalAverages as $row) {
        $findStmt->execute([
            ':enrollment_id' => (int)$row['enrollment_id']
        ]);
        $existingId = $findStmt->fetchColumn();

        if ($existingId) {
            $validatedAverage = app_integrity_prepare_general_average(
                $conn,
                (int)$row['enrollment_id'],
                $row['general_average'],
                $schoolYearId
            );
            $updateStmt->execute([
                ':school_year_id' => $schoolYearId,
                ':general_average' => $validatedAverage,
                ':computed_by' => $userId ?: null,
                ':general_average_id' => (int)$existingId
            ]);
        } else {
            $validatedAverage = app_integrity_prepare_general_average(
                $conn,
                (int)$row['enrollment_id'],
                $row['general_average'],
                $schoolYearId
            );
            $insertStmt->execute([
                ':enrollment_id' => (int)$row['enrollment_id'],
                ':school_year_id' => $schoolYearId,
                ':general_average' => $validatedAverage,
                ':computed_by' => $userId ?: null
            ]);
        }

        $upserted += 1;
    }

    return $upserted;
}

function resolveRiskLevelIds(PDO $conn): array {
    $map = ['low' => 1, 'medium' => 2, 'high' => 3];

    $stmt = $conn->query('SELECT risk_level_id, risk_name FROM risk_levels WHERE is_deleted = 0');
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $id = (int)($row['risk_level_id'] ?? 0);
        if ($id <= 0) {
            continue;
        }

        $name = strtolower(trim((string)($row['risk_name'] ?? '')));
        // Collapse legacy "critical" into high; accept both "medium" and "moderate" names.
        if (str_contains($name, 'critical') || str_contains($name, 'high')) {
            $map['high'] = $id;
        } elseif (str_contains($name, 'medium') || str_contains($name, 'moderate')) {
            $map['medium'] = $id;
        } elseif (str_contains($name, 'low')) {
            $map['low'] = $id;
        }
    }

    return $map;
}

function fetchPeriodsForSchoolYear(PDO $conn, int $schoolYearId): array {
    $stmt = $conn->prepare(
            'SELECT grading_period_id
             FROM grading_periods
         WHERE is_deleted = 0 AND school_year_id = :sy
         ORDER BY COALESCE(date_start, "9999-12-31") ASC, grading_period_id ASC'
    );
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function fetchEnrolledForSchoolYear(PDO $conn, int $schoolYearId): array {
    $stmt = $conn->prepare(
        'SELECT e.enrollment_id, e.section_id, e.grade_level_id, gl.grade_name
         FROM enrollments e
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         WHERE e.is_deleted = 0
           AND e.school_year_id = :sy'
    );
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function fetchSectionSubjectCounts(PDO $conn, int $schoolYearId): array {
    $primaryCurriculumId = fetchPrimaryCurriculumId($conn, $schoolYearId);
    $stmt = $conn->prepare(riskSubjectCountSql($primaryCurriculumId));
    $stmt->bindValue(':sy_subject', $schoolYearId, PDO::PARAM_INT);
    if ($primaryCurriculumId && $primaryCurriculumId > 0) {
        $stmt->bindValue(':subject_curriculum_id', $primaryCurriculumId, PDO::PARAM_INT);
    }
    $stmt->execute();

    $map = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $map[(int)$row['section_id']] = (int)$row['expected_subject_count'];
    }
    return $map;
}

function fetchPeriodGradeStats(PDO $conn, int $schoolYearId, int $gradingPeriodId): array {
    $canonicalSql = canonicalClassOfferingsSql();

    $stmt = $conn->prepare(
        'SELECT e.enrollment_id,
                ROUND(AVG(g.quarterly_grade), 2) AS period_avg,
                MIN(g.quarterly_grade) AS min_grade,
                COUNT(g.grade_id) AS grade_count,
                COUNT(CASE WHEN g.quarterly_grade < 75 THEN 1 END) AS failing_count,
                GROUP_CONCAT(
                    CASE
                        WHEN g.quarterly_grade < 75
                        THEN CONCAT(COALESCE(subj.subject_name, "Subject"), " ", ROUND(g.quarterly_grade, 2))
                        ELSE NULL
                    END
                    ORDER BY subj.subject_name
                    SEPARATOR " / "
                ) AS failing_subjects
         FROM enrollments e
         JOIN (' . $canonicalSql . ') co ON co.section_id = e.section_id
                                       AND co.school_year_id = e.school_year_id
         LEFT JOIN subjects subj ON subj.subject_id = co.subject_id
                                AND subj.is_deleted = 0
         LEFT JOIN grades g ON g.enrollment_id = e.enrollment_id
                           AND g.class_id = co.class_id
                           AND g.grading_period_id = :gp
                           AND g.is_deleted = 0
                           AND g.quarterly_grade IS NOT NULL
         WHERE e.is_deleted = 0
           AND e.school_year_id = :sy
         GROUP BY e.enrollment_id'
    );
    $stmt->bindValue(':gp', $gradingPeriodId, PDO::PARAM_INT);
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();

    $map = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $map[(int)$row['enrollment_id']] = [
            'period_avg' => ($row['period_avg'] === null || $row['period_avg'] === '') ? null : (float)$row['period_avg'],
            'min_grade' => ($row['min_grade'] === null || $row['min_grade'] === '') ? null : (float)$row['min_grade'],
            'grade_count' => (int)$row['grade_count'],
            'failing_count' => (int)($row['failing_count'] ?? 0),
            'failing_subjects' => (string)($row['failing_subjects'] ?? '')
        ];
    }
    return $map;
}

function fetchPeriodSubjectGrades(PDO $conn, int $schoolYearId, int $gradingPeriodId): array {
    $canonicalSql = canonicalClassOfferingsSql();

    $stmt = $conn->prepare(
        'SELECT g.enrollment_id,
                co.subject_id,
                COALESCE(subj.subject_name, "Subject") AS subject_name,
                ROUND(g.quarterly_grade, 2) AS quarterly_grade
         FROM grades g
         JOIN enrollments e ON e.enrollment_id = g.enrollment_id
                           AND e.is_deleted = 0
                           AND e.school_year_id = :sy
         JOIN (' . $canonicalSql . ') co ON co.class_id = g.class_id
                                        AND co.section_id = e.section_id
                                        AND co.school_year_id = e.school_year_id
         LEFT JOIN subjects subj ON subj.subject_id = co.subject_id
                                AND subj.is_deleted = 0
         WHERE g.is_deleted = 0
           AND g.grading_period_id = :gp
           AND g.quarterly_grade IS NOT NULL'
    );
    $stmt->bindValue(':gp', $gradingPeriodId, PDO::PARAM_INT);
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();

    $map = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $enrollmentId = (int)($row['enrollment_id'] ?? 0);
        $subjectId = (int)($row['subject_id'] ?? 0);
        if ($enrollmentId <= 0 || $subjectId <= 0) {
            continue;
        }

        $map[$enrollmentId][$subjectId] = [
            'subject_name' => (string)($row['subject_name'] ?? 'Subject'),
            'grade' => (float)($row['quarterly_grade'] ?? 0)
        ];
    }
    return $map;
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

function fetchAttendanceStats(PDO $conn, int $schoolYearId, int $gradingPeriodId): array {
    $periodStmt = $conn->prepare(
        'SELECT date_start, date_end
         FROM grading_periods
         WHERE grading_period_id = :gp AND school_year_id = :sy AND is_deleted = 0
         LIMIT 1'
    );
    $periodStmt->bindValue(':gp', $gradingPeriodId, PDO::PARAM_INT);
    $periodStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $periodStmt->execute();
    $period = $periodStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $schoolDays = countWeekdaysBetween($period['date_start'] ?? null, $period['date_end'] ?? null);

    $stmt = $conn->prepare(
        'SELECT a.enrollment_id,
                SUM(CASE
                    WHEN a.status IN ("Half-day", "HD") THEN 0.5
                    WHEN a.status IN ("Absent", "Excused", "NLPA") THEN 1
                    ELSE 0
                END) AS absent_days,
                SUM(CASE WHEN a.status IN ("Late", "Cutting") THEN 1 ELSE 0 END) AS late_count,
                COUNT(DISTINCT CASE WHEN a.status NOT IN ("Holiday", "No Classes") THEN a.attendance_date END) AS recorded_days,
                COUNT(DISTINCT CASE WHEN a.status IN ("Holiday", "No Classes") THEN a.attendance_date END) AS closed_days
         FROM attendance a
         JOIN enrollments e ON e.enrollment_id = a.enrollment_id
                           AND e.is_deleted = 0
                           AND e.school_year_id = :sy
         WHERE a.is_deleted = 0
           -- The term dates are authoritative even when a row has a period ID.
           AND a.attendance_date BETWEEN :period_start AND :period_end
           AND (a.grading_period_id = :gp OR a.grading_period_id IS NULL)
         GROUP BY a.enrollment_id'
    );
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':gp', $gradingPeriodId, PDO::PARAM_INT);
    $stmt->bindValue(':period_start', (string)($period['date_start'] ?? ''));
    $stmt->bindValue(':period_end', (string)($period['date_end'] ?? ''));
    $stmt->execute();

    $map = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $absent = (float)($row['absent_days'] ?? 0);
        $late = (int)($row['late_count'] ?? 0);
        $recorded = (int)($row['recorded_days'] ?? 0);
        $learnerSchoolDays = max(0, $schoolDays - (int)($row['closed_days'] ?? 0));
        $denominator = $learnerSchoolDays > 0 ? $learnerSchoolDays : ($recorded > 0 ? $recorded : 0);
        $map[(int)$row['enrollment_id']] = [
            'total_school_days' => $learnerSchoolDays,
            'recorded_days' => $recorded,
            'absent_days' => $absent,
            'late_count' => $late,
            'absence_rate' => $denominator > 0 ? round(($absent / $denominator) * 100, 2) : null
        ];
    }
    return $map;
}

function attendanceRiskScore(?float $absenceRate, int $lateCount): array {
    $indicators = [];
    $score = 0;

    if ($absenceRate !== null) {
        if ($absenceRate >= 20.0) {
            $score = 40;
            $indicators[] = [
                'indicator_type' => 'Chronic Absence',
                'details' => 'Absence rate: ' . number_format($absenceRate, 2) . '% (≥20%)'
            ];
        } elseif ($absenceRate >= 10.0) {
            $score = 25;
            $indicators[] = [
                'indicator_type' => 'Frequent Absence',
                'details' => 'Absence rate: ' . number_format($absenceRate, 2) . '% (10-19%)'
            ];
        } elseif ($absenceRate >= 5.0) {
            $score = 10;
            $indicators[] = [
                'indicator_type' => 'Attendance Rate Below Threshold',
                'details' => 'Absence rate: ' . number_format($absenceRate, 2) . '% (5-9%)'
            ];
        }
    }

    if ($lateCount >= 3) {
        $indicators[] = [
            'indicator_type' => 'Repeated Tardiness',
            'details' => 'Late/Cutting instances: ' . $lateCount
        ];
        $tardinessPoints = match (true) {
            $lateCount >= 10 => 10,
            $lateCount >= 6 => 7,
            $lateCount >= 3 => 5,
            default => 0
        };
        $score = min(40, $score + $tardinessPoints);
    }

    return ['score' => $score, 'indicators' => $indicators];
}

function mergeStoredTrendIndicators(string $currentIndicators, string $storedIndicators): string {
    $current = trim($currentIndicators);
    $stored = trim($storedIndicators);
    if ($stored === '') {
        return $current;
    }

    $preserveTypes = ['Sudden Grade Drop', 'Failed Subject Final Grade'];
    $trendItems = array_values(array_filter(array_map('trim', preg_split('/\s+(?:\||\/)\s+/', $stored) ?: []), static function (string $item) use ($current, $preserveTypes): bool {
        foreach ($preserveTypes as $type) {
            if (stripos($item, $type) !== false && stripos($current, $type) === false) {
                return true;
            }
        }
        return false;
    }));
    if (!$trendItems) {
        return $current;
    }

    return trim(implode(' / ', array_filter(array_merge([$current], $trendItems))));
}

function gradeRiskScore(array $metrics): array {
    $indicators = [];
    $score = 0;

    $subjectCount = (int)($metrics['subject_count'] ?? 0);
    $gradeCount = (int)($metrics['grade_count'] ?? 0);
    $failingCount = (int)($metrics['failing_count'] ?? 0);
    $failingSubjects = trim((string)($metrics['failing_subjects'] ?? ''));
    $minGrade = $metrics['min_grade'] ?? null;
    $periodAvg = $metrics['period_avg'] ?? null;
    $generalAverage = $metrics['general_average'] ?? null;
    $finalMin = $metrics['final_min'] ?? null;
    $finalFailingSubjects = trim((string)($metrics['final_failing_subjects'] ?? ''));
    if ($subjectCount > 0) {
        if ($gradeCount <= 0) {
            $indicators[] = [
                'indicator_type' => 'No Encoded Grades',
                'details' => 'No grades encoded for this period'
            ];
            $score = max($score, 20);
        } elseif ($gradeCount < $subjectCount) {
            $indicators[] = [
                'indicator_type' => 'Incomplete Grades',
                'details' => "Encoded {$gradeCount}/{$subjectCount} subjects"
            ];
            $score = max($score, 10);
        }
    }

    if ($failingCount >= 2) {
        $indicators[] = [
            'indicator_type' => '2 or More Failing Subjects',
            'details' => $failingSubjects !== ''
                ? "Failing subjects: {$failingSubjects}"
                : "{$failingCount} subjects below 75"
        ];
        // Two or more failing subjects must remain visible in the default
        // at-risk report. A score of 30 for exactly two failures is Low and
        // is filtered out, even though the learner has a clear academic risk.
        $score = max($score, 40);
    } elseif ($failingCount === 1) {
        $indicators[] = [
            'indicator_type' => '1 Failing Subject',
            'details' => $failingSubjects !== ''
                ? "Failing subject: {$failingSubjects}"
                : '1 subject below 75'
        ];
        $score = max($score, 40);
    } elseif ($minGrade !== null && $minGrade < 75) {
        $indicators[] = [
            'indicator_type' => 'Lowest Grade Below Passing',
            'details' => 'Lowest grade: ' . number_format((float)$minGrade, 2)
        ];
        $score = min(40, $score + 10);
    }

    if ($periodAvg !== null && $periodAvg < 75) {
        $indicators[] = [
            'indicator_type' => 'Period Average Below Passing',
            'details' => 'Period average: ' . number_format((float)$periodAvg, 2)
        ];
        $score = min(40, $score + 10);
    }

    if ($generalAverage !== null && $generalAverage < 75) {
        $indicators[] = [
            'indicator_type' => 'Low General Average',
            'details' => 'General average: ' . number_format((float)$generalAverage, 2)
        ];
        $score = min(40, $score + 10);
    }

    if ($finalMin !== null && $finalMin < 75) {
        $indicators[] = [
            'indicator_type' => 'Failed Subject Final Grade',
            'details' => $finalFailingSubjects !== ''
                ? "Final failing subject(s): {$finalFailingSubjects}"
                : 'Lowest final grade: ' . number_format((float)$finalMin, 2)
        ];
        $score = min(40, $score + 10);
    }

    return ['score' => $score, 'indicators' => $indicators];
}

function trendRiskScore(array $metrics, array $gradeIndicators): array {
    $indicators = [];
    $score = 0;

    if (empty($metrics['has_previous_grading_period'])) {
        return ['score' => 0, 'indicators' => []];
    }

    $declineStreak = (int)($metrics['decline_streak'] ?? 0);
    $latestDrop = $metrics['latest_drop'] ?? null;
    $subjectDrops = is_array($metrics['subject_drops'] ?? null) ? $metrics['subject_drops'] : [];
    $subjectDeclineStreak = (int)($metrics['subject_decline_streak'] ?? 0);
    $subjectCount = (int)($metrics['subject_count'] ?? 0);
    $gradeCount = (int)($metrics['grade_count'] ?? 0);

    if (!empty($subjectDrops)) {
        usort($subjectDrops, static fn(array $a, array $b): int => ((float)($b['drop'] ?? 0)) <=> ((float)($a['drop'] ?? 0)));
        $largestDrop = (float)($subjectDrops[0]['drop'] ?? 0);
        $shownDrops = array_slice($subjectDrops, 0, 3);
        $dropText = implode(' / ', array_map(static function (array $item): string {
            $subject = trim((string)($item['subject_name'] ?? 'Subject')) ?: 'Subject';
            $drop = number_format((float)($item['drop'] ?? 0), 2);
            $previous = number_format((float)($item['previous_grade'] ?? 0), 2);
            $current = number_format((float)($item['current_grade'] ?? 0), 2);
            return "{$subject} dropped by {$drop} points ({$previous} to {$current})";
        }, $shownDrops));

        if ($subjectDeclineStreak >= 2) {
            $trendPoints = match (true) {
                $subjectDeclineStreak >= 4 => 15,
                $subjectDeclineStreak >= 3 => 12,
                default => 10
            };
            $indicators[] = [
                'indicator_type' => 'Sudden Grade Drop',
                'details' => 'Subject grade declined for ' . $subjectDeclineStreak . ' consecutive grading periods. ' . $dropText
            ];
            $score += $trendPoints;
        } elseif ($largestDrop >= 5.0) {
            $trendPoints = $largestDrop >= 10.0 ? 10 : 5;
            $indicators[] = [
                'indicator_type' => 'Sudden Grade Drop',
                'details' => $dropText
            ];
            $score += $trendPoints;
        }
    } elseif ($declineStreak >= 2) {
        $dropText = is_numeric($latestDrop)
            ? (' Average dropped by ' . number_format((float)$latestDrop, 2) . ' points from the previous grading period.')
            : '';
        $trendPoints = match (true) {
            $declineStreak >= 4 => 15,
            $declineStreak >= 3 => 12,
            default => 10
        };
        $indicators[] = [
            'indicator_type' => 'Sudden Grade Drop',
            'details' => 'Average declined for ' . $declineStreak . ' consecutive grading periods.' . $dropText
        ];
        $score += $trendPoints;
    } elseif (is_numeric($latestDrop) && (float)$latestDrop >= 5.0) {
        $trendPoints = ((float)$latestDrop >= 10.0) ? 10 : 5;
        $indicators[] = [
            'indicator_type' => 'Sudden Grade Drop',
            'details' => 'Average dropped by ' . number_format((float)$latestDrop, 2) . ' points from the previous grading period'
        ];
        $score += $trendPoints;
    }

    if ($subjectCount > 0) {
        if ($gradeCount <= 0) {
            $score = min(20, $score + 5);
        } elseif ($gradeCount < $subjectCount) {
            $score = min(20, $score + 3);
        }
    }

    return ['score' => min(20, $score), 'indicators' => $indicators];
}

function scaleRiskComponentScore(int $score, int $fromMax, int $toMax): int {
    if ($score <= 0 || $fromMax <= 0 || $toMax <= 0) {
        return 0;
    }
    return min($toMax, (int)round(($score / $fromMax) * $toMax));
}

function scoreToRiskLevel(int $score): string {
    return match (true) {
        $score >= 60 => 'high',
        $score >= 40 => 'medium',
        default => 'low'
    };
}

function evaluateRiskLevel(array $metrics, array $riskLevelMap, array $riskActionRules = []): array {
    $attendance = attendanceRiskScore($metrics['absence_rate'] ?? null, (int)($metrics['late_count'] ?? 0));
    $skipGradeAssessment = !empty($metrics['skip_grade_assessment']);
    $grade = $skipGradeAssessment
        ? ['score' => 0, 'indicators' => []]
        : gradeRiskScore($metrics);
    $trend = $skipGradeAssessment
        ? ['score' => 0, 'indicators' => []]
        : trendRiskScore($metrics, $grade['indicators']);

    if (empty($metrics['has_previous_grading_period'])) {
        $attendance['score'] = scaleRiskComponentScore((int)$attendance['score'], 40, 50);
        $grade['score'] = scaleRiskComponentScore((int)$grade['score'], 40, 50);
        $trend['score'] = 0;
        $trend['indicators'] = [];
    }

    $indicators = array_merge($attendance['indicators'], $grade['indicators'], $trend['indicators']);
    $score = min(100, $attendance['score'] + $grade['score'] + $trend['score']);
    $level = scoreToRiskLevel($score);
    $riskLevelId = (int)($riskLevelMap[$level] ?? 1);

    $action = RiskActionService::recommendedAction($indicators, $riskActionRules);
    $summary = array_map(static function ($item) {
        $details = trim((string)($item['details'] ?? ''));
        return $details === ''
            ? (string)$item['indicator_type']
            : ((string)$item['indicator_type'] . ' (' . $details . ')');
    }, $indicators);

    if (empty($indicators)) {
        $notes = 'Risk score: ' . $score . '/100 (Low). No risk indicators detected.';
    } else {
        $notes = 'Risk score: ' . $score . '/100 (' . ucfirst($level) . '). ' . $action . ' Indicators: ' . implode(' / ', $summary) . '.';
    }

    return [$riskLevelId, $indicators, $notes, $score, $level, $action];
}

function riskLevelColor(string $level): string {
    return match (strtolower($level)) {
        'high' => '#b91c1c',
        'medium' => '#d97706',
        'low' => '#166534',
        default => '#6b7280'
    };
}

function parseRiskMetricsFromNotes(string $notes): array {
    $notes = trim($notes);
    $default = ['score' => 0, 'level' => 'low', 'action' => 'Continue routine monitoring and support.'];

    if ($notes === '' || !preg_match('/Risk score:\s*(\d+)\/100\s*\((\w+)\)\.\s*(.*?)\s*(?:Indicators:|$)/i', $notes, $matches)) {
        return $default;
    }

    $score = max(0, min(100, (int)$matches[1]));
    $level = strtolower($matches[2]);
    $action = trim($matches[3]);

    $validLevels = ['low', 'medium', 'high', 'moderate', 'critical'];
    if (!in_array($level, $validLevels, true)) {
        $level = scoreToRiskLevel($score);
    }
    if ($level === 'moderate' || $level === 'critical') {
        $level = $level === 'critical' ? 'high' : 'medium';
    }

    return [
        'score' => $score,
        'level' => $level,
        'action' => $action ?: $default['action']
    ];
}

function computeRiskAssessments(PDO $conn, int $schoolYearId, int $userId, array $generalAverages, array $finalGrades): array {
    $generalAverageMap = [];
    foreach ($generalAverages as $row) {
        $generalAverageMap[(int)$row['enrollment_id']] = (float)$row['general_average'];
    }

    $finalMinMap = [];
    $finalFailingSubjectsMap = [];
    foreach ($finalGrades as $row) {
        $enrollmentId = (int)$row['enrollment_id'];
        $grade = (float)$row['final_grade'];
        if (!isset($finalMinMap[$enrollmentId]) || $grade < $finalMinMap[$enrollmentId]) {
            $finalMinMap[$enrollmentId] = $grade;
        }
        if ($grade < 75) {
            $subjectName = trim((string)($row['subject_name'] ?? 'Subject')) ?: 'Subject';
            $finalFailingSubjectsMap[$enrollmentId][] = $subjectName . ' ' . number_format($grade, 2);
        }
    }

    $periods = fetchPeriodsForSchoolYear($conn, $schoolYearId);
    $enrollments = fetchEnrolledForSchoolYear($conn, $schoolYearId);
    $subjectCountMap = fetchSectionSubjectCounts($conn, $schoolYearId);

    if (!$periods || !$enrollments) {
        return ['assessments' => 0, 'indicators' => 0];
    }

    $riskLevelMap = resolveRiskLevelIds($conn);
    $riskActionRules = RiskActionService::loadRules($conn);

    $riskFindStmt = $conn->prepare('SELECT risk_assessment_id FROM risk_assessments WHERE enrollment_id = :enrollment_id AND grading_period_id = :grading_period_id LIMIT 1');
    $riskUpdateStmt = $conn->prepare('UPDATE risk_assessments SET risk_level_id = :risk_level_id, assessed_by = :assessed_by, assessed_at = NOW(), notes = :notes, is_deleted = 0, deleted_at = NULL WHERE risk_assessment_id = :risk_assessment_id');
    $riskInsertStmt = $conn->prepare('INSERT INTO risk_assessments (enrollment_id, grading_period_id, risk_level_id, assessed_by, notes, is_deleted, deleted_at) VALUES (:enrollment_id, :grading_period_id, :risk_level_id, :assessed_by, :notes, 0, NULL)');

    // risk_indicators are derived outputs (re-computable). Hard-delete avoids unbounded growth from soft-deleted duplicates.
    $indicatorDeleteStmt = $conn->prepare('DELETE FROM risk_indicators WHERE risk_assessment_id = :risk_assessment_id');
    $indicatorInsertStmt = $conn->prepare('INSERT INTO risk_indicators (risk_assessment_id, indicator_type, details, is_deleted, deleted_at) VALUES (:risk_assessment_id, :indicator_type, :details, 0, NULL)');

    $assessmentsUpserted = 0;
    $indicatorsUpserted = 0;
    $previousPeriodAvg = [];
    $declineStreakMap = [];
    $previousSubjectGrades = [];
    $subjectDeclineStreakMap = [];

    foreach ($periods as $periodIndex => $period) {
        $periodId = (int)$period['grading_period_id'];
        $hasPreviousGradingPeriod = ((int)$periodIndex > 0);
        $periodGradeMap = fetchPeriodGradeStats($conn, $schoolYearId, $periodId);
        $periodSubjectGradeMap = fetchPeriodSubjectGrades($conn, $schoolYearId, $periodId);
        $attendanceMap = fetchAttendanceStats($conn, $schoolYearId, $periodId);
        foreach ($enrollments as $enrollment) {
            $enrollmentId = (int)$enrollment['enrollment_id'];
            $sectionId = (int)$enrollment['section_id'];
            $gradingPolicy = riskGradingPolicyContext(
                $conn,
                $schoolYearId,
                (int)($enrollment['grade_level_id'] ?? 0),
                (string)($enrollment['grade_name'] ?? '')
            );
            $excludeGradeRisk = (bool)$gradingPolicy['exclude_grade_risk'];

            $gradeStats = $excludeGradeRisk ? [
                'period_avg' => null,
                'min_grade' => null,
                'grade_count' => 0,
                'failing_count' => 0,
                'failing_subjects' => ''
            ] : ($periodGradeMap[$enrollmentId] ?? [
                'period_avg' => null,
                'min_grade' => null,
                'grade_count' => 0,
                'failing_count' => 0,
                'failing_subjects' => ''
            ]);
            $attendanceStats = $attendanceMap[$enrollmentId] ?? [
                'total_school_days' => 0,
                'recorded_days' => 0,
                'absent_days' => 0,
                'late_count' => 0,
                'absence_rate' => null
            ];

            $periodAvg = $excludeGradeRisk ? null : $gradeStats['period_avg'];
            $previousAvg = $excludeGradeRisk ? null : ($previousPeriodAvg[$enrollmentId] ?? null);

            $declineStreak = $excludeGradeRisk ? 0 : (int)($declineStreakMap[$enrollmentId] ?? 0);
            $latestDrop = null;

            if ($previousAvg !== null && $periodAvg !== null) {
                if ($periodAvg < $previousAvg) {
                    $latestDrop = round($previousAvg - $periodAvg, 2);
                    $declineStreak += 1;
                } else {
                    $declineStreak = 0;
                }
                $declineStreakMap[$enrollmentId] = $declineStreak;
            }

            if ($periodAvg !== null) {
                $previousPeriodAvg[$enrollmentId] = $periodAvg;
            }

            $subjectDrops = [];
            $maxSubjectDeclineStreak = 0;
            $currentSubjectGrades = $excludeGradeRisk ? [] : ($periodSubjectGradeMap[$enrollmentId] ?? []);
            foreach ($currentSubjectGrades as $subjectId => $subjectGrade) {
                $currentGrade = (float)($subjectGrade['grade'] ?? 0);
                $previousSubject = $previousSubjectGrades[$enrollmentId][$subjectId] ?? null;

                if ($previousSubject && isset($previousSubject['grade'])) {
                    $previousGrade = (float)$previousSubject['grade'];
                    if ($currentGrade < $previousGrade) {
                        $drop = round($previousGrade - $currentGrade, 2);
                        $subjectDeclineStreakMap[$enrollmentId][$subjectId] = (int)($subjectDeclineStreakMap[$enrollmentId][$subjectId] ?? 0) + 1;
                        $currentSubjectStreak = (int)$subjectDeclineStreakMap[$enrollmentId][$subjectId];
                        if ($drop >= 5.0 || $currentSubjectStreak >= 2) {
                            $subjectDrops[] = [
                                'subject_name' => (string)($subjectGrade['subject_name'] ?? $previousSubject['subject_name'] ?? 'Subject'),
                                'previous_grade' => $previousGrade,
                                'current_grade' => $currentGrade,
                                'drop' => $drop
                            ];
                        }
                    } else {
                        $subjectDeclineStreakMap[$enrollmentId][$subjectId] = 0;
                    }
                    $maxSubjectDeclineStreak = max($maxSubjectDeclineStreak, (int)($subjectDeclineStreakMap[$enrollmentId][$subjectId] ?? 0));
                }

                $previousSubjectGrades[$enrollmentId][$subjectId] = $subjectGrade;
            }

            [$riskLevelId, $indicators, $notes] = evaluateRiskLevel([
                'skip_grade_assessment' => $excludeGradeRisk,
                'subject_count' => $excludeGradeRisk ? 0 : (int)($subjectCountMap[$sectionId] ?? 0),
                'grade_count' => (int)($gradeStats['grade_count'] ?? 0),
                'failing_count' => (int)($gradeStats['failing_count'] ?? 0),
                'failing_subjects' => (string)($gradeStats['failing_subjects'] ?? ''),
                'period_avg' => $periodAvg,
                'min_grade' => $gradeStats['min_grade'],
                'decline_streak' => $declineStreak,
                'latest_drop' => $latestDrop,
                'subject_drops' => $subjectDrops,
                'subject_decline_streak' => $maxSubjectDeclineStreak,
                'has_previous_grading_period' => $hasPreviousGradingPeriod,
                'absence_rate' => $attendanceStats['absence_rate'],
                'late_count' => (int)($attendanceStats['late_count'] ?? 0),
                'final_min' => $excludeGradeRisk ? null : ($finalMinMap[$enrollmentId] ?? null),
                'final_failing_subjects' => !$excludeGradeRisk && isset($finalFailingSubjectsMap[$enrollmentId])
                    ? implode(' / ', $finalFailingSubjectsMap[$enrollmentId])
                    : '',
                'general_average' => $excludeGradeRisk ? null : ($generalAverageMap[$enrollmentId] ?? null)
            ], $riskLevelMap, $riskActionRules);

            $riskFindStmt->execute([
                ':enrollment_id' => $enrollmentId,
                ':grading_period_id' => $periodId
            ]);
            $existingId = $riskFindStmt->fetchColumn();

            if ($existingId) {
                $riskAssessmentId = (int)$existingId;
                $riskUpdateStmt->execute([
                    ':risk_level_id' => $riskLevelId,
                    ':assessed_by' => $userId ?: null,
                    ':notes' => $notes,
                    ':risk_assessment_id' => $riskAssessmentId
                ]);
            } else {
                $riskInsertStmt->execute([
                    ':enrollment_id' => $enrollmentId,
                    ':grading_period_id' => $periodId,
                    ':risk_level_id' => $riskLevelId,
                    ':assessed_by' => $userId ?: null,
                    ':notes' => $notes
                ]);
                $riskAssessmentId = (int)$conn->lastInsertId();
            }

            $indicatorDeleteStmt->execute([
                ':risk_assessment_id' => $riskAssessmentId
            ]);

            foreach ($indicators as $indicator) {
                $indicatorInsertStmt->execute([
                    ':risk_assessment_id' => $riskAssessmentId,
                    ':indicator_type' => $indicator['indicator_type'],
                    ':details' => $indicator['details']
                ]);
                $indicatorsUpserted += 1;
            }

            $assessmentsUpserted += 1;
        }
    }

    return ['assessments' => $assessmentsUpserted, 'indicators' => $indicatorsUpserted];
}

function notifyLearnerRiskAssessment(PDO $conn, int $riskAssessmentId): void {
    if ($riskAssessmentId <= 0) return;
    notifications_ensure_tables($conn);

    try {
        $stmt = $conn->prepare(
            'SELECT ra.risk_assessment_id,
                    rl.risk_name,
                    gp.period_name,
                    l.user_id AS learner_user_id
             FROM risk_assessments ra
             JOIN risk_levels rl ON rl.risk_level_id = ra.risk_level_id
                                AND rl.is_deleted = 0
             JOIN grading_periods gp ON gp.grading_period_id = ra.grading_period_id
                                    AND gp.is_deleted = 0
                                    AND gp.status = "Locked"
             JOIN enrollments e ON e.enrollment_id = ra.enrollment_id
                               AND e.is_deleted = 0
             JOIN learners l ON l.learner_id = e.learner_id
                            AND l.is_deleted = 0
                            AND l.is_active = 1
             JOIN users u ON u.user_id = l.user_id
                         AND u.is_deleted = 0
                         AND u.is_active = 1
             WHERE ra.risk_assessment_id = :risk_assessment_id
               AND ra.is_deleted = 0
               AND LOWER(TRIM(rl.risk_name)) IN ("medium", "moderate", "high", "critical")
             LIMIT 1'
        );
        $stmt->execute([':risk_assessment_id' => $riskAssessmentId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        if (!$row) return;

        $learnerUserId = (int)($row['learner_user_id'] ?? 0);
        if ($learnerUserId <= 0) return;

        $riskName = trim((string)($row['risk_name'] ?? 'At risk')) ?: 'At risk';
        $periodName = trim((string)($row['period_name'] ?? ''));
        $copy = notifications_learner_risk_copy($riskName, $periodName);
        $title = $copy['title'];
        $message = $copy['message'];

        notifications_migrate_legacy_learner_risk_copy(
            $conn,
            $learnerUserId,
            $riskAssessmentId,
            $riskName,
            $copy
        );

        if (!notifications_exists_recent_for_reference(
            $conn,
            $learnerUserId,
            'Risk Flag',
            $title,
            'risk_assessments',
            $riskAssessmentId,
            365
        )) {
            notifications_create_for_user(
                $conn,
                $learnerUserId,
                'Risk Flag',
                $title,
                $message,
                'risk_assessments',
                $riskAssessmentId
            );
        }
    } catch (Throwable $e) {
        error_log('Learner risk notification creation failed: ' . $e->getMessage());
    }
}

function notifyAtRiskLearners(PDO $conn, int $schoolYearId, ?int $gradingPeriodId = null): void {
    if ($schoolYearId <= 0) return;
    notifications_ensure_tables($conn);

    try {
        $periodFilter = ($gradingPeriodId && $gradingPeriodId > 0)
            ? ' AND grading_period_id = :grading_period_id'
            : '';
        $gpStmt = $conn->prepare(
            "SELECT grading_period_id, period_name
             FROM grading_periods
             WHERE is_deleted = 0 AND school_year_id = :sy
               AND status = 'Locked'{$periodFilter}
             ORDER BY COALESCE(date_end, '9999-12-31') DESC, grading_period_id DESC
             LIMIT 1"
        );
        $gpParams = [':sy' => $schoolYearId];
        if ($gradingPeriodId && $gradingPeriodId > 0) {
            $gpParams[':grading_period_id'] = $gradingPeriodId;
        }
        $gpStmt->execute($gpParams);
        $gpRow = $gpStmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $targetGpId = $gpRow ? (int)$gpRow['grading_period_id'] : 0;
        if ($targetGpId <= 0) return;

        $stmt = $conn->prepare(
            'SELECT ra.risk_assessment_id,
                    ra.enrollment_id
             FROM risk_assessments ra
             JOIN grading_periods gp ON gp.grading_period_id = ra.grading_period_id
                                   AND gp.is_deleted = 0
                                   AND gp.status = "Locked"
                                   AND gp.school_year_id = :sy
             JOIN risk_levels rl ON rl.risk_level_id = ra.risk_level_id
                                AND rl.is_deleted = 0
             JOIN enrollments e ON e.enrollment_id = ra.enrollment_id
                               AND e.is_deleted = 0
                               AND e.school_year_id = :sy2
             JOIN learners l ON l.learner_id = e.learner_id
                            AND l.is_deleted = 0
             WHERE ra.is_deleted = 0
               AND ra.grading_period_id = :gp
               AND LOWER(TRIM(rl.risk_name)) IN ("medium", "moderate", "high", "critical")'
        );

        $stmt->execute([
            ':sy' => $schoolYearId,
            ':sy2' => $schoolYearId,
            ':gp' => $targetGpId
        ]);

        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if (!$rows) return;

        foreach ($rows as $r) {
            $riskAssessmentId = (int)($r['risk_assessment_id'] ?? 0);
            if ($riskAssessmentId <= 0) continue;

            notifyLearnerRiskAssessment($conn, $riskAssessmentId);
        }

        // Staff receive one consolidated card for this closed period. The
        // helper also migrates any legacy per-learner staff cards out of view.
        notifications_sync_closed_risk_alerts($conn);
    } catch (Exception $e) {
        error_log('Risk notification creation failed: ' . $e->getMessage());
    }
}
?>
