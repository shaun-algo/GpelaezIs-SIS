<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');
ini_set('serialize_precision', '-1');

require_once __DIR__ . '/../utils/cors.php';
require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function intParam(string $key): int {
    return isset($_GET[$key]) && $_GET[$key] !== '' ? max(0, (int)$_GET[$key]) : 0;
}

function proficiencyBucketSql(string $expr): string {
    return "CASE
        WHEN {$expr} >= 90 THEN 'Advanced'
        WHEN {$expr} >= 85 THEN 'Proficient'
        WHEN {$expr} >= 80 THEN 'Approaching Proficiency'
        WHEN {$expr} >= 75 THEN 'Developing'
        WHEN {$expr} IS NULL THEN 'No Grade'
        ELSE 'Beginning'
    END";
}

function enrollmentDescriptor(?float $changePercent, ?int $previousTotal): string {
    if ($previousTotal === null || $previousTotal <= 0 || $changePercent === null) {
        return 'Baseline Enrollment';
    }
    if ($changePercent >= 5) return 'Strong Increase in Enrollment';
    if ($changePercent >= 0) return 'Slight Increase / Stable Enrollment';
    if ($changePercent >= -5) return 'Slight Decrease in Enrollment';
    return 'Significant Decrease in Enrollment';
}

function enrollmentTrendTip(string $label, int $total, ?int $previousTotal, ?float $changePercent, string $descriptor): string {
    $currentText = "Total learners enrolled in {$label}: " . number_format($total) . ".";
    if ($previousTotal === null || $previousTotal <= 0 || $changePercent === null) {
        return "{$currentText} This is the first available school year for comparison.";
    }

    $difference = $total - $previousTotal;
    if ($difference === 0) {
        return "{$currentText} Enrollment stayed the same as last school year ({$descriptor}).";
    }

    $direction = $difference > 0 ? 'increased' : 'decreased';
    $absDifference = abs($difference);
    $percentText = ($changePercent >= 0 ? '+' : '') . number_format($changePercent, 2) . '%';

    if ($previousTotal < 10) {
        return "{$currentText} Enrollment {$direction} by " . number_format($absDifference) .
            " learner" . ($absDifference === 1 ? '' : 's') .
            " from " . number_format($previousTotal) . " last school year. The percentage change is {$percentText}, which is high because the previous count was small.";
    }

    return "{$currentText} Enrollment {$direction} by " . number_format($absDifference) .
        " learner" . ($absDifference === 1 ? '' : 's') .
        " from last school year ({$percentText}; {$descriptor}).";
}

function bindFilters(PDOStatement $stmt, array $filters): void {
    foreach ($filters as $key => $value) {
        $stmt->bindValue($key, $value, PDO::PARAM_INT);
    }
}

// This is the privileged aggregate analytics surface. Teachers and learners
// must not receive it, even if they try to open the page or call the endpoint.
// Teacher operational monitoring remains in its own modules.
auth_require_roles(['admin', 'registrar', 'principal']);

try {
    $hasExplicitSchoolYearFilter = isset($_GET['school_year_id']) && $_GET['school_year_id'] !== '';
    $schoolYearId = intParam('school_year_id');
    $gradeLevelId = intParam('grade_level_id');
    $sectionId = intParam('section_id');
    $subjectId = intParam('subject_id');

    $refs = [];
    $refs['school_years'] = $conn->query(
        'SELECT school_year_id, year_label, is_active
         FROM school_years
         WHERE is_deleted = 0
         ORDER BY year_start DESC, school_year_id DESC'
    )->fetchAll(PDO::FETCH_ASSOC);

    $selectedSchoolYearIsActive = false;
    foreach ($refs['school_years'] as $schoolYearRef) {
        if ((int)($schoolYearRef['school_year_id'] ?? 0) !== $schoolYearId) {
            continue;
        }
        $selectedSchoolYearIsActive = (int)($schoolYearRef['is_active'] ?? 0) === 1;
        break;
    }

    $refs['grade_levels'] = $conn->query(
        'SELECT grade_level_id, grade_name
         FROM grade_levels
         WHERE is_deleted = 0
         ORDER BY COALESCE(sort_order, grade_level_id), grade_level_id'
    )->fetchAll(PDO::FETCH_ASSOC);

    $secSql = 'SELECT section_id, section_name, grade_level_id, school_year_id
               FROM sections
               WHERE is_deleted = 0';
    $secParams = [];
    if ($schoolYearId > 0) {
        $secSql .= ' AND school_year_id = :section_sy';
        $secParams[':section_sy'] = $schoolYearId;
    }
    if ($gradeLevelId > 0) {
        $secSql .= ' AND grade_level_id = :section_grade';
        $secParams[':section_grade'] = $gradeLevelId;
    }
    $secSql .= ' ORDER BY section_name';
    $secStmt = $conn->prepare($secSql);
    bindFilters($secStmt, $secParams);
    $secStmt->execute();
    $refs['sections'] = $secStmt->fetchAll(PDO::FETCH_ASSOC);

    // Match the subject structure used by Class Offerings: subjects assigned
    // to the primary curriculum mapped to each school year and grade level,
    // while requiring an active class offering for that subject/context.
    // Do not populate this filter from the full subjects catalog or from
    // stale/off-curriculum class offering rows.
    $subjectSql = 'SELECT s.subject_id, s.subject_name
                   FROM curriculum_school_year_map csm
                   JOIN curricula c ON c.curriculum_id = csm.curriculum_id
                                    AND c.is_deleted = 0
                   JOIN school_years subject_sy ON subject_sy.school_year_id = csm.school_year_id
                                               AND subject_sy.is_deleted = 0
                   JOIN curriculum_subjects cs ON cs.curriculum_id = csm.curriculum_id
                                              AND cs.is_deleted = 0
                   JOIN subjects s ON s.subject_id = cs.subject_id AND s.is_deleted = 0
                   JOIN sections subject_sec ON subject_sec.school_year_id = csm.school_year_id
                                             AND subject_sec.grade_level_id = cs.grade_level_id
                                             AND subject_sec.is_deleted = 0
                   LEFT JOIN curriculum_learning_areas cla
                              ON cla.area_id = cs.learning_area_id
                             AND cla.is_deleted = 0
                   WHERE csm.is_primary = 1
                     AND csm.is_deleted = 0
                     AND EXISTS (
                         SELECT 1
                         FROM class_offerings co_subject
                         WHERE co_subject.school_year_id = csm.school_year_id
                           AND co_subject.section_id = subject_sec.section_id
                           AND co_subject.subject_id = cs.subject_id
                           AND co_subject.is_deleted = 0
                     )';
    $subjectParams = [];
    if ($schoolYearId > 0) {
        $subjectSql .= ' AND csm.school_year_id = :subjects_school_year_id';
        $subjectParams[':subjects_school_year_id'] = $schoolYearId;
    }
    if ($gradeLevelId > 0) {
        $subjectSql .= ' AND cs.grade_level_id = :subjects_grade_level_id';
        $subjectParams[':subjects_grade_level_id'] = $gradeLevelId;
    }
    if ($sectionId > 0) {
        $subjectSql .= ' AND subject_sec.section_id = :subjects_section_id';
        $subjectParams[':subjects_section_id'] = $sectionId;
    }
    $subjectSql .= ' GROUP BY s.subject_id, s.subject_name
                     ORDER BY MIN(COALESCE(cla.sort_order, 9999)),
                              MIN(COALESCE(cs.sort_order, 9999)),
                              s.subject_name, s.subject_id';
    $subjectStmt = $conn->prepare($subjectSql);
    bindFilters($subjectStmt, $subjectParams);
    $subjectStmt->execute();
    $refs['subjects'] = $subjectStmt->fetchAll(PDO::FETCH_ASSOC);

    // The active school year represents the current roster. Historical years
    // retain completed learners so their population and proficiency remain
    // useful after the enrollment lifecycle closes. With no explicit year,
    // the analytics page combines the available enrollment history.
    $enrollmentPopulationStatus = $schoolYearId <= 0
        ? "(e.enrollment_status IN ('Enrolled', 'Completed') OR e.enrollment_status IS NULL)"
        : ($selectedSchoolYearIsActive
            ? "(e.enrollment_status = 'Enrolled' OR e.enrollment_status IS NULL)"
            : "(e.enrollment_status IN ('Enrolled', 'Completed') OR e.enrollment_status IS NULL)");
    $where = ['e.is_deleted = 0', 'l.is_deleted = 0', $enrollmentPopulationStatus];
    $params = [];
    if ($schoolYearId > 0) {
        $where[] = 'e.school_year_id = :school_year_id';
        $params[':school_year_id'] = $schoolYearId;
    }
    if ($gradeLevelId > 0) {
        $where[] = 'e.grade_level_id = :grade_level_id';
        $params[':grade_level_id'] = $gradeLevelId;
    }
    if ($sectionId > 0) {
        $where[] = 'e.section_id = :section_id';
        $params[':section_id'] = $sectionId;
    }
    if ($subjectId > 0) {
        // A subject filter is a learner-cohort filter as well as a proficiency
        // calculation filter. This keeps the population cards/charts aligned
        // with the subject-specific panels below them.
        $where[] = 'EXISTS (
            SELECT 1
            FROM class_offerings co_filter_subject
            WHERE co_filter_subject.school_year_id = e.school_year_id
              AND co_filter_subject.section_id = e.section_id
              AND co_filter_subject.subject_id = :subject_id
              AND co_filter_subject.is_deleted = 0
        )';
        $params[':subject_id'] = $subjectId;
    }
    $whereSql = implode(' AND ', $where);
    $safeSubjectId = (int)$subjectId;
    $totalStmt = $conn->prepare("SELECT COUNT(DISTINCT e.enrollment_id) FROM enrollments e JOIN learners l ON l.learner_id = e.learner_id WHERE {$whereSql}");
    bindFilters($totalStmt, $params);
    $totalStmt->execute();
    $totalLearners = (int)$totalStmt->fetchColumn();

    $gradeStmt = $conn->prepare(
        "SELECT sy.school_year_id, sy.year_label, sy.year_start,
                gl.grade_level_id, gl.grade_name, COUNT(*) AS total
         FROM enrollments e
         JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
         JOIN school_years sy ON sy.school_year_id = e.school_year_id AND sy.is_deleted = 0
         JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id AND gl.is_deleted = 0
         WHERE {$whereSql}
         GROUP BY sy.school_year_id, sy.year_label, sy.year_start,
                  gl.grade_level_id, gl.grade_name, gl.sort_order
         ORDER BY sy.year_start, sy.school_year_id, gl.sort_order, gl.grade_level_id"
    );
    bindFilters($gradeStmt, $params);
    $gradeStmt->execute();
    $byGrade = $gradeStmt->fetchAll(PDO::FETCH_ASSOC);

    $sectionStmt = $conn->prepare(
        "SELECT sy.school_year_id, sy.year_label, sy.year_start,
                sec.section_id, sec.section_name, gl.grade_name, COUNT(*) AS total
         FROM enrollments e
         JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
         JOIN school_years sy ON sy.school_year_id = e.school_year_id AND sy.is_deleted = 0
         JOIN sections sec ON sec.section_id = e.section_id
                          AND sec.school_year_id = e.school_year_id
                          AND sec.is_deleted = 0
         JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id AND gl.is_deleted = 0
         WHERE {$whereSql}
         GROUP BY sy.school_year_id, sy.year_label, sy.year_start,
                  sec.section_id, sec.section_name, gl.grade_name
         ORDER BY sy.year_start, sy.school_year_id, gl.sort_order, sec.section_name"
    );
    bindFilters($sectionStmt, $params);
    $sectionStmt->execute();
    $bySection = $sectionStmt->fetchAll(PDO::FETCH_ASSOC);

    $profLabels = ['Advanced', 'Proficient', 'Approaching Proficiency', 'Developing', 'Beginning', 'No Grade'];
    $profData = array_fill_keys($profLabels, 0);
    if ($subjectId > 0) {
        $safeSubjectId = (int)$subjectId;
        $subjectAvg = "(SELECT AVG(fg.final_grade)
                        FROM final_grades fg
                        JOIN class_offerings co ON co.class_id = fg.class_id
                                                AND co.school_year_id = e.school_year_id
                                                AND co.subject_id = {$safeSubjectId}
                                                AND co.is_deleted = 0
                        WHERE fg.enrollment_id = e.enrollment_id
                          AND fg.is_deleted = 0
                          AND fg.final_grade IS NOT NULL)";
        $profSql = "SELECT " . proficiencyBucketSql($subjectAvg) . " AS label, COUNT(*) AS total
                    FROM enrollments e
                    JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
                    WHERE {$whereSql}
                    GROUP BY e.enrollment_id";
        $profStmt = $conn->prepare("SELECT label, COUNT(*) AS total FROM ({$profSql}) x GROUP BY label");
        bindFilters($profStmt, $params);
    } else {
        $profStmt = $conn->prepare(
            "SELECT " . proficiencyBucketSql('ga.general_average') . " AS label, COUNT(*) AS total
             FROM enrollments e
             JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
             LEFT JOIN general_averages ga ON ga.enrollment_id = e.enrollment_id
                                          AND ga.school_year_id = e.school_year_id
                                          AND ga.is_deleted = 0
             WHERE {$whereSql}
             GROUP BY label"
        );
        bindFilters($profStmt, $params);
    }
    $profStmt->execute();
    foreach ($profStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $label = (string)($row['label'] ?? 'No Grade');
        if (!array_key_exists($label, $profData)) $profData[$label] = 0;
        $profData[$label] = (int)($row['total'] ?? 0);
    }

    if ($subjectId > 0) {
        $safeSubjectId = (int)$subjectId;
        $gradeSubjectAvg = "(SELECT AVG(fg.final_grade)
                             FROM final_grades fg
                             JOIN class_offerings co ON co.class_id = fg.class_id
                                                     AND co.school_year_id = e.school_year_id
                                                     AND co.subject_id = {$safeSubjectId}
                                                     AND co.is_deleted = 0
                             WHERE fg.enrollment_id = e.enrollment_id
                               AND fg.is_deleted = 0
                               AND fg.final_grade IS NOT NULL)";
        $byGradeProfSql = "SELECT gl.grade_name, " . proficiencyBucketSql($gradeSubjectAvg) . " AS label, COUNT(*) AS total
                           FROM enrollments e
                           JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
                           JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
                           WHERE {$whereSql}
                           GROUP BY gl.grade_level_id, gl.grade_name, gl.sort_order, label
                           ORDER BY gl.sort_order, gl.grade_level_id";
    } else {
        $byGradeProfSql = "SELECT gl.grade_name, " . proficiencyBucketSql('ga.general_average') . " AS label, COUNT(*) AS total
                           FROM enrollments e
                           JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
                           JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
                           LEFT JOIN general_averages ga ON ga.enrollment_id = e.enrollment_id
                                                        AND ga.school_year_id = e.school_year_id
                                                        AND ga.is_deleted = 0
                           WHERE {$whereSql}
                           GROUP BY gl.grade_level_id, gl.grade_name, gl.sort_order, label
                           ORDER BY gl.sort_order, gl.grade_level_id";
    }
    $byGradeProfStmt = $conn->prepare($byGradeProfSql);
    bindFilters($byGradeProfStmt, $params);
    $byGradeProfStmt->execute();
    $byGradeProficiency = $byGradeProfStmt->fetchAll(PDO::FETCH_ASSOC);

    $subjectWhereSql = $whereSql;
    if ($safeSubjectId > 0) {
        $subjectWhereSql .= " AND co.subject_id = {$safeSubjectId}";
    }
    $bySubjectSql = "SELECT subject_id, subject_name, label, COUNT(*) AS total
                     FROM (
                         SELECT s.subject_id,
                                s.subject_name,
                                " . proficiencyBucketSql('AVG(fg.final_grade)') . " AS label
                         FROM enrollments e
                         JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
                         JOIN final_grades fg ON fg.enrollment_id = e.enrollment_id
                                             AND fg.is_deleted = 0
                                             AND fg.final_grade IS NOT NULL
                         JOIN class_offerings co ON co.class_id = fg.class_id
                                                AND co.school_year_id = e.school_year_id
                                                AND co.is_deleted = 0
                         JOIN subjects s ON s.subject_id = co.subject_id AND s.is_deleted = 0
                         WHERE {$subjectWhereSql}
                         GROUP BY e.enrollment_id, s.subject_id, s.subject_name
                     ) x
                     GROUP BY subject_id, subject_name, label
                     ORDER BY subject_name, subject_id";
    $bySubjectStmt = $conn->prepare($bySubjectSql);
    bindFilters($bySubjectStmt, $params);
    $bySubjectStmt->execute();
    $bySubjectProficiency = $bySubjectStmt->fetchAll(PDO::FETCH_ASSOC);

    $trendWhere = [
        'e.is_deleted = 0',
        'l.is_deleted = 0',
        "(e.enrollment_status IN ('Enrolled', 'Completed') OR e.enrollment_status IS NULL)"
    ];
    $trendParams = [];
    if ($gradeLevelId > 0) {
        $trendWhere[] = 'e.grade_level_id = :trend_grade_level_id';
        $trendParams[':trend_grade_level_id'] = $gradeLevelId;
    }
    if ($sectionId > 0) {
        $trendWhere[] = 'e.section_id = :trend_section_id';
        $trendParams[':trend_section_id'] = $sectionId;
    }
    $trendWhereSql = implode(' AND ', $trendWhere);
    $trendSql = "SELECT sy.school_year_id,
                        sy.year_label,
                        COUNT(DISTINCT e.enrollment_id) AS learner_count
                 FROM school_years sy
                 LEFT JOIN enrollments e ON e.school_year_id = sy.school_year_id
                 LEFT JOIN learners l ON l.learner_id = e.learner_id
                 WHERE sy.is_deleted = 0 AND {$trendWhereSql}
                 GROUP BY sy.school_year_id, sy.year_label, sy.year_start
                 ORDER BY sy.year_start, sy.school_year_id";
    $trendStmt = $conn->prepare($trendSql);
    bindFilters($trendStmt, $trendParams);
    $trendStmt->execute();
    $trendRows = $trendStmt->fetchAll(PDO::FETCH_ASSOC);
    $trendLabels = [];
    $trendTotals = [];
    $trendChanges = [];
    $trendDescriptors = [];
    $trendTips = [];
    $trendComputedRows = [];
    $currentTrendKpi = [
        'school_year_id' => $schoolYearId,
        'label' => '',
        'total_enrollment' => $totalLearners,
        'previous_enrollment' => null,
        'change_percent' => null,
        'descriptor' => 'Baseline Enrollment',
        'tip' => 'Total number of learners enrolled for the selected school year and filters.'
    ];

    $previousTotal = null;
    foreach ($trendRows as $row) {
        $rowSyId = (int)($row['school_year_id'] ?? 0);
        $label = (string)($row['year_label'] ?? '');
        $total = (int)($row['learner_count'] ?? 0);
        $changePercent = null;
        if ($previousTotal !== null && $previousTotal > 0) {
            $changePercent = round((($total - $previousTotal) / $previousTotal) * 100, 2);
        }
        $descriptor = enrollmentDescriptor($changePercent, $previousTotal);
        $tip = enrollmentTrendTip($label, $total, $previousTotal, $changePercent, $descriptor);

        $computedTrendRow = [
            'school_year_id' => $rowSyId,
            'label' => $label,
            'total_enrollment' => $total,
            'previous_enrollment' => $previousTotal,
            'change_percent' => $changePercent,
            'descriptor' => $descriptor,
            'tip' => $tip,
        ];
        $trendComputedRows[] = $computedTrendRow;

        if ($rowSyId === $schoolYearId) {
            $currentTrendKpi = $computedTrendRow;
        }
        $previousTotal = $total;
    }

    $trendDisplayRows = $trendComputedRows;
    if ($hasExplicitSchoolYearFilter && $schoolYearId > 0) {
        $selectedIndex = null;
        foreach ($trendComputedRows as $index => $row) {
            if ((int)$row['school_year_id'] === $schoolYearId) {
                $selectedIndex = $index;
                break;
            }
        }
        if ($selectedIndex !== null) {
            $startIndex = max(0, $selectedIndex - 1);
            $trendDisplayRows = array_slice($trendComputedRows, $startIndex, $selectedIndex - $startIndex + 1);
        }
    }

    foreach ($trendDisplayRows as $row) {
        $trendLabels[] = $row['label'];
        $trendTotals[] = $row['total_enrollment'];
        $trendChanges[] = $row['change_percent'];
        $trendDescriptors[] = $row['descriptor'];
        $trendTips[] = $row['tip'];
    }

    respond([
        'success' => true,
        'data' => [
            'filters' => [
                // Return the effective year so the filter UI matches the
                // dataset when no explicit year was submitted.
                'school_year_id' => $schoolYearId,
                'school_year_explicit' => $hasExplicitSchoolYearFilter,
                'grade_level_id' => $gradeLevelId,
                'section_id' => $sectionId,
                'subject_id' => $subjectId,
            ],
            'refs' => $refs,
            'learners' => [
                'total' => $totalLearners,
                'by_grade_level' => $byGrade,
                'by_section' => $bySection,
            ],
            'proficiency' => [
                'labels' => array_keys($profData),
                'data' => array_values($profData),
                'by_grade_level' => $byGradeProficiency,
                'by_subject' => $bySubjectProficiency,
            ],
            'trends' => [
                'labels' => $trendLabels,
                'total_enrollment' => $trendTotals,
                'change_percent' => $trendChanges,
                'descriptors' => $trendDescriptors,
                'tips' => $trendTips,
                'kpi' => $currentTrendKpi,
            ],
        ],
    ]);
} catch (Throwable $e) {
    error_log('[dashboard/analytics.php] ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}
