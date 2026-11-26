<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

require_once __DIR__ . '/../utils/cors.php';
require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}


auth_require_roles(['admin', 'teacher', 'registrar']);

try {
    // Active school year (single source of truth for analytics)
    $syStmt = $conn->query(
        "SELECT school_year_id, year_label, year_start, year_end
         FROM school_years
         WHERE is_deleted = 0
         ORDER BY is_active DESC, year_end DESC, school_year_id DESC
         LIMIT 1"
    );
    $syRow = $syStmt->fetch(PDO::FETCH_ASSOC) ?: null;
    $activeSchoolYearId = $syRow ? (int)($syRow['school_year_id'] ?? 0) : 0;
    $schoolYear = $syRow ? (string)($syRow['year_label'] ?? '') : '';
    if (!$schoolYear && $syRow) {
        $ys = $syRow['year_start'] ?? null;
        $ye = $syRow['year_end'] ?? null;
        if ($ys !== null && $ye !== null) {
            $schoolYear = $ys . '-' . $ye;
        }
    }
    if (!$schoolYear) $schoolYear = 'N/A';

    $activeEnrollmentSql = "(e.enrollment_status = 'Enrolled' OR e.enrollment_status IS NULL)";

    // Summary cards are scoped to the active school year and the same
    // enrollment lifecycle used by the roster and class-record modules.
    $studentStmt = $conn->prepare(
        "SELECT COUNT(DISTINCT e.learner_id)
         FROM enrollments e
         JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
         WHERE e.is_deleted = 0
           AND e.school_year_id = :sy
           AND {$activeEnrollmentSql}"
    );
    $studentStmt->execute([':sy' => $activeSchoolYearId]);
    $totalStudents = (int)$studentStmt->fetchColumn();

    $teacherStmt = $conn->query(
        "SELECT COUNT(DISTINCT e.employee_id)
         FROM employees e
         JOIN users u ON u.user_id = e.user_id
                      AND u.is_active = 1
                      AND u.is_deleted = 0
         JOIN roles r ON r.role_id = u.role_id
                      AND r.is_deleted = 0
                      AND LOWER(r.role_name) = 'teacher'
         WHERE e.is_deleted = 0"
    );
    $totalTeachers = (int)$teacherStmt->fetchColumn();

    $classStmt = $conn->prepare(
        "SELECT COUNT(DISTINCT co.class_id)
         FROM class_offerings co
         JOIN subjects s ON s.subject_id = co.subject_id AND s.is_deleted = 0
         JOIN sections sec ON sec.section_id = co.section_id
                          AND sec.school_year_id = co.school_year_id
                          AND sec.is_deleted = 0
         WHERE co.is_deleted = 0
           AND co.school_year_id = :sy"
    );
    $classStmt->execute([':sy' => $activeSchoolYearId]);
    $totalClasses = (int)$classStmt->fetchColumn();

    // Enrollment KPIs (active school year)
    $enrollmentKpi = [
        'totalEnrollments' => 0,
        'newEnrollments' => 0,
        'droppedEnrollments' => 0,
        'enrollmentRecords' => 0,
        'newEnrollmentWindowDays' => 30,
        'dropoutRate' => 0,
    ];
    if ($activeSchoolYearId > 0) {
        $kpiStmt = $conn->prepare(
            "SELECT
                SUM(CASE WHEN {$activeEnrollmentSql} THEN 1 ELSE 0 END) AS total_enrollments,
                SUM(CASE
                    WHEN {$activeEnrollmentSql}
                     AND enrollment_date IS NOT NULL
                     AND enrollment_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                    THEN 1 ELSE 0
                END) AS new_enrollments,
                SUM(CASE WHEN enrollment_status = 'Dropped' THEN 1 ELSE 0 END) AS dropped,
                COUNT(*) AS enrollment_records
             FROM enrollments e
             WHERE e.is_deleted = 0 AND e.school_year_id = :sy"
        );
        $kpiStmt->execute([':sy' => $activeSchoolYearId]);
        $kpiRow = $kpiStmt->fetch(PDO::FETCH_ASSOC) ?: [];
        $totalEnrollments = (int)($kpiRow['total_enrollments'] ?? 0);
        $dropped = (int)($kpiRow['dropped'] ?? 0);
        $enrollmentRecords = (int)($kpiRow['enrollment_records'] ?? 0);

        $enrollmentKpi['totalEnrollments'] = $totalEnrollments;
        $enrollmentKpi['newEnrollments'] = (int)($kpiRow['new_enrollments'] ?? 0);
        $enrollmentKpi['droppedEnrollments'] = $dropped;
        $enrollmentKpi['enrollmentRecords'] = $enrollmentRecords;
        $enrollmentKpi['newEnrollmentWindowDays'] = 30;
        $enrollmentKpi['dropoutRate'] = $enrollmentRecords > 0 ? round(($dropped / $enrollmentRecords) * 100, 2) : 0;
    }

    // Enrollment trend by month (current school year)
    $enrollmentStmt = $conn->prepare(
        "SELECT DATE_FORMAT(enrollment_date, '%b %Y') AS label,
                COUNT(*) AS total,
                MIN(enrollment_date) AS sort_key
         FROM enrollments e
         JOIN school_years sy ON sy.school_year_id = e.school_year_id
         WHERE e.is_deleted = 0 AND sy.is_deleted = 0
         AND sy.school_year_id = :sy
         AND {$activeEnrollmentSql}
         AND e.enrollment_date IS NOT NULL
         GROUP BY DATE_FORMAT(enrollment_date, '%Y-%m')
         ORDER BY sort_key"
    );
    $enrollmentStmt->execute([':sy' => $activeSchoolYearId]);
    $enrollmentRows = $enrollmentStmt->fetchAll(PDO::FETCH_ASSOC);
    $enrollmentTrend = [
        'labels' => array_column($enrollmentRows, 'label'),
        'data'   => array_map('intval', array_column($enrollmentRows, 'total')),
    ];

    // Grade distribution
    $gradeStmt = $conn->prepare(
        "SELECT gl.grade_name AS label, COUNT(*) AS total
         FROM enrollments e
         JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
            JOIN school_years sy ON sy.school_year_id = e.school_year_id
            WHERE e.is_deleted = 0 AND gl.is_deleted = 0 AND sy.is_deleted = 0
            AND sy.school_year_id = :sy
            AND {$activeEnrollmentSql}
         GROUP BY gl.grade_level_id, gl.grade_name
         ORDER BY gl.grade_level_id"
    );
    $gradeStmt->execute([':sy' => $activeSchoolYearId]);
    $gradeRows = $gradeStmt->fetchAll(PDO::FETCH_ASSOC);
    $gradeDistribution = [
        'labels' => array_column($gradeRows, 'label'),
        'data'   => array_map('intval', array_column($gradeRows, 'total')),
    ];

    // DepEd performance distribution (based on General Average)
    $performance = [
        'labels' => [
            'Outstanding',
            'Very Satisfactory',
            'Satisfactory',
            'Fairly Satisfactory',
            'Did Not Meet Expectations',
            'No Grade'
        ],
        'data' => [0, 0, 0, 0, 0, 0]
    ];

    if ($activeSchoolYearId > 0) {
        $gaStmt = $conn->prepare(
            "SELECT
                SUM(CASE WHEN ga.general_average >= 90 THEN 1 ELSE 0 END) AS outstanding,
                SUM(CASE WHEN ga.general_average >= 85 AND ga.general_average < 90 THEN 1 ELSE 0 END) AS very_satisfactory,
                SUM(CASE WHEN ga.general_average >= 80 AND ga.general_average < 85 THEN 1 ELSE 0 END) AS satisfactory,
                SUM(CASE WHEN ga.general_average >= 75 AND ga.general_average < 80 THEN 1 ELSE 0 END) AS fairly_satisfactory,
                SUM(CASE WHEN ga.general_average < 75 THEN 1 ELSE 0 END) AS did_not_meet,
                SUM(CASE WHEN ga.general_average IS NULL THEN 1 ELSE 0 END) AS no_grade
             FROM enrollments e
             JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
             LEFT JOIN general_averages ga ON ga.enrollment_id = e.enrollment_id
                                          AND ga.school_year_id = e.school_year_id
                                          AND ga.is_deleted = 0
             WHERE e.school_year_id = :sy
               AND e.is_deleted = 0
               AND {$activeEnrollmentSql}
               "
        );
        $gaStmt->execute([':sy' => $activeSchoolYearId]);
        $gaRow = $gaStmt->fetch(PDO::FETCH_ASSOC) ?: [];
        $performance['data'] = [
            (int)($gaRow['outstanding'] ?? 0),
            (int)($gaRow['very_satisfactory'] ?? 0),
            (int)($gaRow['satisfactory'] ?? 0),
            (int)($gaRow['fairly_satisfactory'] ?? 0),
            (int)($gaRow['did_not_meet'] ?? 0),
            (int)($gaRow['no_grade'] ?? 0)
        ];
    }

    // Latest-period risk distribution (for "at risk" count)
    $riskDistribution = ['labels' => [], 'data' => []];
    $atRiskStudents = 0;

    if ($activeSchoolYearId > 0) {
        $riskStmt = $conn->prepare(
            "SELECT rl.risk_name AS label, COUNT(*) AS total
             FROM risk_assessments ra
             JOIN grading_periods gp ON gp.grading_period_id = ra.grading_period_id
                                   AND gp.is_deleted = 0
                                   AND gp.school_year_id = :sy
             JOIN risk_levels rl ON rl.risk_level_id = ra.risk_level_id
                                AND rl.is_deleted = 0
             JOIN enrollments e ON e.enrollment_id = ra.enrollment_id
                               AND e.is_deleted = 0
                               AND e.school_year_id = :sy_risk_enroll
                               AND {$activeEnrollmentSql}
             JOIN (
                 SELECT ra2.enrollment_id, MAX(ra2.grading_period_id) AS latest_period_id
                 FROM risk_assessments ra2
                 JOIN grading_periods gp2 ON gp2.grading_period_id = ra2.grading_period_id
                                         AND gp2.is_deleted = 0
                                         AND gp2.school_year_id = :sy2
                 JOIN enrollments e2 ON e2.enrollment_id = ra2.enrollment_id
                                    AND e2.is_deleted = 0
                                    AND e2.school_year_id = :sy3
                                    AND (e2.enrollment_status = 'Enrolled' OR e2.enrollment_status IS NULL)
                 WHERE ra2.is_deleted = 0
                 GROUP BY ra2.enrollment_id
             ) latest ON latest.enrollment_id = ra.enrollment_id
                     AND latest.latest_period_id = ra.grading_period_id
             WHERE ra.is_deleted = 0
             GROUP BY rl.risk_level_id, rl.risk_name
             ORDER BY rl.risk_level_id"
        );
        $riskStmt->execute([
            ':sy' => $activeSchoolYearId,
            ':sy2' => $activeSchoolYearId,
            ':sy3' => $activeSchoolYearId,
            ':sy_risk_enroll' => $activeSchoolYearId
        ]);
        $riskRows = $riskStmt->fetchAll(PDO::FETCH_ASSOC);

        $riskDistribution = [
            'labels' => array_column($riskRows, 'label'),
            'data' => array_map('intval', array_column($riskRows, 'total'))
        ];

        foreach ($riskRows as $r) {
            $name = strtolower(trim((string)($r['label'] ?? '')));
            if ($name !== 'low') {
                $atRiskStudents += (int)($r['total'] ?? 0);
            }
        }
    }

    // Quarterly performance trend (average across enrolled learners per period)
    $quarterlyTrend = ['labels' => [], 'data' => []];

    if ($activeSchoolYearId > 0) {
        $qtStmt = $conn->prepare(
            "SELECT gp.grading_period_id,
                    gp.period_name AS label,
                    ROUND(AVG(t.period_avg), 2) AS avg_grade,
                    COALESCE(gp.date_start, '9999-12-31') AS sort_key
             FROM grading_periods gp
             LEFT JOIN (
                 SELECT g.grading_period_id,
                        g.enrollment_id,
                        AVG(g.quarterly_grade) AS period_avg
                 FROM grades g
                 JOIN enrollments e ON e.enrollment_id = g.enrollment_id
                                   AND e.is_deleted = 0
                                   AND e.enrollment_status = 'Enrolled'
                                   AND e.school_year_id = :sy_enroll
                 WHERE g.is_deleted = 0
                   AND g.quarterly_grade IS NOT NULL
                 GROUP BY g.grading_period_id, g.enrollment_id
             ) t ON t.grading_period_id = gp.grading_period_id
             WHERE gp.is_deleted = 0
               AND gp.school_year_id = :sy_gp
             GROUP BY gp.grading_period_id, gp.period_name, sort_key
             ORDER BY sort_key ASC, gp.grading_period_id ASC"
        );
        $qtStmt->execute([':sy_enroll' => $activeSchoolYearId, ':sy_gp' => $activeSchoolYearId]);
        $qtRows = $qtStmt->fetchAll(PDO::FETCH_ASSOC);
        $quarterlyTrend = [
            'labels' => array_column($qtRows, 'label'),
            'data' => array_map(static fn($v) => $v === null ? null : (float)$v, array_column($qtRows, 'avg_grade'))
        ];
    }

    respond([
        'success' => true,
        'data' => [
            'stats' => [
                'totalStudents' => $totalStudents,
                'totalTeachers' => $totalTeachers,
                'totalClasses'  => $totalClasses,
                'schoolYear'    => $schoolYear,
                'atRiskStudents' => $atRiskStudents,
            ],
            'enrollmentTrend'   => $enrollmentTrend,
            'gradeDistribution' => $gradeDistribution,
            'performance'       => $performance,
            'riskDistribution'  => $riskDistribution,
            'quarterlyTrend'    => $quarterlyTrend,
            'enrollmentStats'   => $enrollmentKpi,
        ],
    ]);
} catch (Exception $e) {
    error_log('[metrics.php] ' . $e->getMessage());
    respond([
        'success' => false,
        'message' => 'Server error',
    ], 500);
}
