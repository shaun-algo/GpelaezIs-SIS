<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/audit.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';
require_once __DIR__ . '/../services/GradeComputationService.php';
require_once __DIR__ . '/../services/GradingPolicyService.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
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

function tableExists(PDO $conn, string $table): bool {
    static $cache = [];
    if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) return false;
    if (array_key_exists($table, $cache)) return $cache[$table];
    $stmt = $conn->query("SHOW TABLES LIKE " . $conn->quote($table));
    $cache[$table] = (bool)$stmt->fetch(PDO::FETCH_NUM);
    return $cache[$table];
}

function requireInt($value, string $name): int {
    if ($value === null || $value === '' || !is_numeric($value)) {
        throw new InvalidArgumentException("Missing or invalid {$name}");
    }
    return (int)$value;
}

/**
 * Sanitize a direct period grade value.
 * Returns null for blank/null, float for valid numbers 60–100,
 * or throws for non-numeric strings / out-of-range.
 */
function sanitizeGradeValue($raw, string $label): ?float {
    if ($raw === null || $raw === '') return null;
    try {
        return app_integrity_validate_quarterly_grade($raw, $label);
    } catch (ApplicationIntegrityException $e) {
        throw new InvalidArgumentException($e->getMessage(), $e->getCode(), $e);
    }
}

function getTeacherEmployeeId(PDO $conn, int $userId): ?int {
    $stmt = $conn->prepare('SELECT employee_id FROM employees WHERE user_id = :user_id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $stmt->execute();
    $val = $stmt->fetchColumn();
    if ($val === false || $val === null) return null;
    return (int)$val;
}

function fetchClassOffering(PDO $conn, int $classId): ?array {
    $sql = "SELECT co.class_id, co.subject_id, s.subject_name,
                   co.section_id, sec.section_name, sec.grade_level_id, gl.grade_name,
                   co.teacher_id, co.school_year_id, sy.year_label, sy.grading_system_type
            FROM class_offerings co
            JOIN subjects s ON s.subject_id = co.subject_id AND s.is_deleted = 0
            JOIN sections sec ON sec.section_id = co.section_id AND sec.is_deleted = 0
            LEFT JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id
            LEFT JOIN school_years sy ON sy.school_year_id = co.school_year_id
                        WHERE co.class_id = :class_id
                            AND co.is_deleted = 0
            LIMIT 1";
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function fetchClassOfferingForUpdate(PDO $conn, int $classId): ?array {
    $sql = "SELECT co.class_id, co.subject_id, s.subject_name,
                   co.section_id, sec.section_name, sec.grade_level_id, gl.grade_name,
                   co.teacher_id, co.school_year_id, sy.year_label, sy.grading_system_type
            FROM class_offerings co
            JOIN subjects s ON s.subject_id = co.subject_id AND s.is_deleted = 0
            JOIN sections sec ON sec.section_id = co.section_id AND sec.is_deleted = 0
            LEFT JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id
            LEFT JOIN school_years sy ON sy.school_year_id = co.school_year_id
                        WHERE co.class_id = :class_id
                            AND co.is_deleted = 0
            LIMIT 1
            FOR UPDATE";
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function resolveCanonicalClassId(PDO $conn, int $sectionId, int $schoolYearId, int $subjectId): int {
    $stmt = $conn->prepare(
        'SELECT MAX(class_id) AS class_id
         FROM class_offerings
         WHERE section_id = :section_id
           AND school_year_id = :school_year_id
           AND subject_id = :subject_id
           AND is_deleted = 0'
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':subject_id', $subjectId, PDO::PARAM_INT);
    $stmt->execute();
    $canonicalClassId = (int)($stmt->fetchColumn() ?: 0);
    return $canonicalClassId > 0 ? $canonicalClassId : 0;
}

function normalizeMapehToken(?string $value): string {
    return strtoupper(trim((string)$value));
}

function fetchCurriculumSubjectsForGrade(PDO $conn, int $curriculumId, int $gradeLevelId): array {
    if ($curriculumId <= 0 || $gradeLevelId <= 0) return [];
    $stmt = $conn->prepare(
        "SELECT cs.subject_id, s.subject_name,
                COALESCE(cla.area_code, '') AS area_code
         FROM curriculum_subjects cs
         JOIN subjects s ON s.subject_id = cs.subject_id AND s.is_deleted = 0
         LEFT JOIN curriculum_learning_areas cla ON cla.area_id = cs.learning_area_id AND cla.is_deleted = 0
         WHERE cs.curriculum_id = :curriculum_id
           AND cs.grade_level_id = :grade_level_id
           AND cs.is_deleted = 0
         ORDER BY cs.sort_order ASC, s.subject_name ASC"
    );
    $stmt->bindValue(':curriculum_id', $curriculumId, PDO::PARAM_INT);
    $stmt->bindValue(':grade_level_id', $gradeLevelId, PDO::PARAM_INT);
    $stmt->execute();
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function isMapehComponentName(?string $subjectName): bool {
    $name = strtolower(trim((string)$subjectName));
    if ($name === '') return false;
    if (str_contains($name, 'mapeh') && str_contains($name, 'component')) return true;
    if (str_contains($name, 'mapeh')) return false;

    $classicComponent = preg_match('/\b(music|arts|physical education|health|pe|p\.e\.)\b/i', $name);
    $matatagGroup = preg_match('/\bmusic\s*(and|&)\s*arts?\b/i', $name)
        || preg_match('/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/i', $name);

    return (bool)($classicComponent || $matatagGroup);
}

function isMapehComponentRow(array $row, bool $allowNameFallback = false): bool {
    $area = normalizeMapehToken($row['area_code'] ?? '');
    $name = strtolower((string)($row['subject_name'] ?? ''));
    if (str_contains($name, 'mapeh') && !str_contains($name, 'component')) return false;
    if (str_contains($name, 'mapeh') && str_contains($name, 'component')) return true;
    if ($area === 'MAPEH' && isMapehComponentName($name)) return true;
    if ($area === 'MAPEH' && !str_contains($name, 'mapeh')) return true;
    return $allowNameFallback && isMapehComponentName($name);
}

function isMapehClusterRow(array $row): bool {
    $area = normalizeMapehToken($row['area_code'] ?? '');
    $name = strtolower((string)($row['subject_name'] ?? ''));
    if (isMapehComponentRow($row)) return false;
    return $area === 'MAPEH' || str_contains($name, 'mapeh');
}

function fetchMapehFallbackSubjectIds(PDO $conn, string $mode): array {
    $patterns = match ($mode) {
        'legacy' => ["%MAPEH Component%"],
        'grouped' => ["%Music and Arts%", "%Music & Arts%", "%Physical Education and Health%", "%PE and Health%", "%P.E. and Health%"],
        'classic' => ["Music", "Arts", "Physical Education", "Health"],
        default => [],
    };
    if (!$patterns) return [];

    if ($mode === 'classic') {
        $where = implode(' OR ', array_fill(0, count($patterns), 'subject_name = ?'));
    } else {
        $where = implode(' OR ', array_fill(0, count($patterns), 'subject_name LIKE ?'));
    }

    $stmt = $conn->prepare(
        "SELECT subject_id
         FROM subjects
         WHERE is_deleted = 0
           AND ({$where})
         ORDER BY FIELD(
             CASE
                 WHEN subject_name LIKE '%Music and Arts%' OR subject_name LIKE '%Music & Arts%' THEN 'Music and Arts'
                 WHEN subject_name LIKE '%Physical Education and Health%' OR subject_name LIKE '%PE and Health%' OR subject_name LIKE '%P.E. and Health%' THEN 'Physical Education and Health'
                 WHEN subject_name LIKE '%Music%' THEN 'Music'
                 WHEN subject_name LIKE '%Arts%' THEN 'Arts'
                 WHEN subject_name LIKE '%Physical Education%' THEN 'Physical Education'
                 WHEN subject_name LIKE '%Health%' THEN 'Health'
                 ELSE subject_name
             END,
             'Music', 'Arts', 'Physical Education', 'Health', 'Music and Arts', 'Physical Education and Health'
         ), subject_id"
    );
    $stmt->execute($patterns);
    return array_values(array_unique(array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN))));
}

function getMapehComponentSubjectIds(PDO $conn, int $curriculumId, int $gradeLevelId): array {
    $rows = fetchCurriculumSubjectsForGrade($conn, $curriculumId, $gradeLevelId);
    $hasCluster = false;
    foreach ($rows as $row) {
        if (isMapehClusterRow($row)) {
            $hasCluster = true;
            break;
        }
    }

    $ids = [];
    foreach ($rows as $row) {
        if (isMapehComponentRow($row, $hasCluster)) {
            $ids[] = (int)$row['subject_id'];
        }
    }
    $ids = array_values(array_unique(array_filter($ids, fn($id) => $id > 0)));
    if ($ids) {
        return $ids;
    }

    if (getMapehClusterSubjectId($conn, $curriculumId, $gradeLevelId) <= 0) {
        return [];
    }

    foreach (['legacy', 'grouped', 'classic'] as $mode) {
        $fallbackIds = fetchMapehFallbackSubjectIds($conn, $mode);
        if ($fallbackIds) return $fallbackIds;
    }
    return [];
}

function getMapehClusterSubjectId(PDO $conn, int $curriculumId, int $gradeLevelId): int {
    foreach (fetchCurriculumSubjectsForGrade($conn, $curriculumId, $gradeLevelId) as $row) {
        if (isMapehClusterRow($row)) {
            return (int)$row['subject_id'];
        }
    }
    return 0;
}

function getRequiredHonorSubjectIds(PDO $conn, ?int $curriculumId, int $gradeLevelId): array {
    if (!$curriculumId || $gradeLevelId <= 0) {
        return [];
    }

    $componentSubjectIds = getMapehComponentSubjectIds($conn, (int)$curriculumId, $gradeLevelId);
    $ids = [];
    foreach (fetchCurriculumSubjectsForGrade($conn, (int)$curriculumId, $gradeLevelId) as $row) {
        $subjectId = (int)$row['subject_id'];
        if ($subjectId <= 0 || in_array($subjectId, $componentSubjectIds, true)) {
            continue;
        }
        $ids[] = $subjectId;
    }

    return array_values(array_unique($ids));
}

function buildHonorsSubjectFilterSql(array $requiredSubjectIds, array $componentSubjectIds, string $alias = 'co'): string {
    $alias = preg_replace('/[^A-Za-z0-9_]/', '', $alias) ?: 'co';
    if ($requiredSubjectIds) {
        return ' AND ' . $alias . '.subject_id IN (' . implode(',', array_map('intval', $requiredSubjectIds)) . ')';
    }
    if ($componentSubjectIds) {
        return ' AND ' . $alias . '.subject_id NOT IN (' . implode(',', array_map('intval', $componentSubjectIds)) . ')';
    }
    return '';
}

function isClassOfferingInCurriculum(PDO $conn, array $class): bool {
    $curriculumId = fetchPrimaryCurriculumId($conn, (int)($class['school_year_id'] ?? 0));
    if (!$curriculumId) return false;
    $subjectId = (int)($class['subject_id'] ?? 0);
    $componentIds = getMapehComponentSubjectIds($conn, (int)$curriculumId, (int)($class['grade_level_id'] ?? 0));
    if (in_array($subjectId, $componentIds, true)) {
        return true;
    }
    foreach (fetchCurriculumSubjectsForGrade($conn, (int)$curriculumId, (int)($class['grade_level_id'] ?? 0)) as $row) {
        if ((int)$row['subject_id'] === $subjectId) {
            return true;
        }
    }
    return false;
}

function getCurriculumSubjectRole(PDO $conn, array $class): array {
    $curriculumId = fetchPrimaryCurriculumId($conn, (int)($class['school_year_id'] ?? 0));
    $gradeLevelId = (int)($class['grade_level_id'] ?? 0);
    $subjectId = (int)($class['subject_id'] ?? 0);
    $componentIds = $curriculumId ? getMapehComponentSubjectIds($conn, (int)$curriculumId, $gradeLevelId) : [];
    $clusterId = $curriculumId ? getMapehClusterSubjectId($conn, (int)$curriculumId, $gradeLevelId) : 0;

    return [
        'curriculum_id' => $curriculumId ? (int)$curriculumId : null,
        'is_mapeh_component' => in_array($subjectId, $componentIds, true),
        'is_mapeh_cluster' => $clusterId > 0 && $subjectId === $clusterId,
        'has_mapeh_components' => count($componentIds) > 0,
        'mapeh_cluster_subject_id' => $clusterId,
        'mapeh_component_subject_ids' => $componentIds,
    ];
}

function syncMapehComponentOfferingsForActiveClusters(PDO $conn, ?int $teacherId = null): void {
    $startedTransaction = false;
    if (!$conn->inTransaction()) {
        $conn->beginTransaction();
        $startedTransaction = true;
    }

    try {
    $sql = "SELECT co.class_id, co.subject_id, co.section_id, co.school_year_id, co.teacher_id, sec.grade_level_id
            FROM class_offerings co
            JOIN sections sec ON sec.section_id = co.section_id AND sec.is_deleted = 0
            JOIN school_years sy ON sy.school_year_id = co.school_year_id AND sy.is_deleted = 0
            WHERE co.is_deleted = 0
              AND co.teacher_id > 0";
    if ($teacherId !== null && $teacherId > 0) {
        $sql .= ' AND co.teacher_id = :teacher_id';
    }

    $stmt = $conn->prepare($sql);
    if ($teacherId !== null && $teacherId > 0) {
        $stmt->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
    }
    $stmt->execute();
    $parents = $stmt->fetchAll(PDO::FETCH_ASSOC);
    if (!$parents) {
        if ($startedTransaction) $conn->commit();
        return;
    }

    $findStmt = $conn->prepare(
        'SELECT class_id
         FROM class_offerings
         WHERE subject_id = :subject_id
           AND section_id = :section_id
           AND school_year_id = :school_year_id
         ORDER BY (teacher_id = :teacher_id) DESC, is_deleted ASC, class_id DESC
         LIMIT 1'
    );
    $restoreStmt = $conn->prepare(
        'UPDATE class_offerings
         SET teacher_id = :teacher_id, is_deleted = 0, deleted_at = NULL
         WHERE class_id = :class_id'
    );
    $insertStmt = $conn->prepare(
        'INSERT INTO class_offerings (subject_id, section_id, teacher_id, school_year_id)
         VALUES (:subject_id, :section_id, :teacher_id, :school_year_id)'
    );

    foreach ($parents as $parent) {
        $curriculumId = fetchPrimaryCurriculumId($conn, (int)($parent['school_year_id'] ?? 0));
        if (!$curriculumId) continue;
        $clusterSubjectId = getMapehClusterSubjectId($conn, (int)$curriculumId, (int)($parent['grade_level_id'] ?? 0));
        if ($clusterSubjectId <= 0 || (int)($parent['subject_id'] ?? 0) !== $clusterSubjectId) {
            continue;
        }
        $componentIds = getMapehComponentSubjectIds($conn, (int)$curriculumId, (int)($parent['grade_level_id'] ?? 0));
        foreach ($componentIds as $componentSubjectId) {
            $findStmt->execute([
                ':subject_id' => $componentSubjectId,
                ':section_id' => (int)$parent['section_id'],
                ':school_year_id' => (int)$parent['school_year_id'],
                ':teacher_id' => (int)$parent['teacher_id'],
            ]);
            $existingClassId = (int)($findStmt->fetchColumn() ?: 0);
            if ($existingClassId > 0) {
                $restoreStmt->execute([
                    ':teacher_id' => (int)$parent['teacher_id'],
                    ':class_id' => $existingClassId,
                ]);
                // The former class_offerings update trigger propagated this
                // teacher assignment to any active schedules. Keep that
                // invariant when this MAPEH repair path restores a row.
                app_integrity_sync_schedule_teacher($conn, $existingClassId, (int)$parent['teacher_id']);
            } else {
                $insertStmt->execute([
                    ':subject_id' => $componentSubjectId,
                    ':section_id' => (int)$parent['section_id'],
                    ':teacher_id' => (int)$parent['teacher_id'],
                    ':school_year_id' => (int)$parent['school_year_id'],
                ]);
            }
        }
    }
    if ($startedTransaction) $conn->commit();
    } catch (Throwable $e) {
        if ($startedTransaction && $conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
}

/**
 * When a MAPEH component grade is saved, recompute the official MAPEH cluster grade
 * as the simple average of the available component grades for each affected learner.
 */
function recomputeMapehGrades(PDO $conn, array $class, int $gradingPeriodId, array $enrollmentIds, int $userId): int {
    if (empty($enrollmentIds)) {
        return 0;
    }

    $curriculumId = fetchPrimaryCurriculumId($conn, (int)($class['school_year_id'] ?? 0));
    if (!$curriculumId) return 0;
    $componentSubjectIds = getMapehComponentSubjectIds($conn, (int)$curriculumId, (int)($class['grade_level_id'] ?? 0));
    $clusterSubjectId = getMapehClusterSubjectId($conn, (int)$curriculumId, (int)($class['grade_level_id'] ?? 0));
    $savedSubjectId = (int)($class['subject_id'] ?? 0);
    if (!$componentSubjectIds || $clusterSubjectId <= 0) return 0;

    // Only trigger when a component grade was saved, not when the cluster itself is saved.
    if (!in_array($savedSubjectId, $componentSubjectIds, true)) {
        return 0;
    }

    $sectionId = (int)$class['section_id'];
    $schoolYearId = (int)$class['school_year_id'];

    // Locate the MAPEH cluster class offering for this section/school year.
    $clusterStmt = $conn->prepare(
        'SELECT MAX(class_id) AS class_id
         FROM class_offerings
         WHERE section_id = :section_id
           AND school_year_id = :school_year_id
           AND subject_id = :subject_id
           AND is_deleted = 0'
    );
    $clusterStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $clusterStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $clusterStmt->bindValue(':subject_id', $clusterSubjectId, PDO::PARAM_INT);
    $clusterStmt->execute();
    $clusterClassId = (int)($clusterStmt->fetchColumn() ?: 0);
    if ($clusterClassId <= 0) {
        return 0;
    }

    // Find all component class offerings for this section/school year.
    $componentClassStmt = $conn->prepare(
        'SELECT class_id
         FROM class_offerings
         WHERE section_id = :section_id
           AND school_year_id = :school_year_id
           AND subject_id IN (' . implode(',', $componentSubjectIds) . ')
           AND is_deleted = 0'
    );
    $componentClassStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $componentClassStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $componentClassStmt->execute();
    $componentClassIds = array_map('intval', $componentClassStmt->fetchAll(PDO::FETCH_COLUMN));
    if (!$componentClassIds) {
        return 0;
    }

    $placeholders = implode(',', array_fill(0, count($enrollmentIds), '?'));
    $avgStmt = $conn->prepare(
        "SELECT enrollment_id, ROUND(AVG(quarterly_grade), 2) AS mapeh_grade
         FROM grades
         WHERE enrollment_id IN ($placeholders)
           AND class_id IN (" . implode(',', $componentClassIds) . ")
           AND grading_period_id = ?
           AND quarterly_grade IS NOT NULL
           AND is_deleted = 0
         GROUP BY enrollment_id
         HAVING COUNT(*) > 0"
    );
    $params = [];
    foreach ($enrollmentIds as $id) {
        $params[] = (int)$id;
    }
    $params[] = $gradingPeriodId;
    $avgStmt->execute($params);
    $computed = $avgStmt->fetchAll(PDO::FETCH_ASSOC);

    if (!$computed) {
        return 0;
    }

    $upsertStmt = $conn->prepare(
        'INSERT INTO grades (
            enrollment_id, class_id, grading_period_id, quarterly_grade,
            encoded_by, is_deleted, deleted_at
        ) VALUES (
            :enrollment_id, :class_id, :grading_period_id, :quarterly_grade,
            :encoded_by, 0, NULL
        )
        ON DUPLICATE KEY UPDATE
            quarterly_grade = VALUES(quarterly_grade),
            encoded_by = VALUES(encoded_by),
            is_deleted = 0,
            deleted_at = NULL'
    );

    $updated = 0;
    foreach ($computed as $row) {
        $upsertStmt->execute([
            ':enrollment_id' => (int)$row['enrollment_id'],
            ':class_id' => $clusterClassId,
            ':grading_period_id' => $gradingPeriodId,
            ':quarterly_grade' => (float)$row['mapeh_grade'],
            ':encoded_by' => $userId ?: null
        ]);
        $updated++;
    }

    return $updated;
}

function enforceClassAccess(PDO $conn, array $session, int $classId): array {
    $class = fetchClassOffering($conn, $classId);
    if (!$class) {
        auth_abort(404, 'Class offering not found');
    }

    if (auth_is_admin($session)) {
        return $class;
    }

    $employeeId = getTeacherEmployeeId($conn, (int)$session['user_id']);
    if (!$employeeId) {
        auth_abort(403, 'Teacher profile not found');
    }

    if (!employeeCanAccessClassAsTeacher($conn, $class, (int)$employeeId)) {
        auth_abort(403, 'Not authorized for this class');
    }

    return $class;
}

function isHandwrittenDescriptiveClass(PDO $conn, array $class): bool {
    $policy = GradingPolicyService::resolve(
        $conn,
        (int)($class['school_year_id'] ?? 0),
        (int)($class['grade_level_id'] ?? 0),
        $class['grade_name'] ?? null
    );
    return $policy['grading_mode'] === 'Descriptive'
        && in_array(strtoupper((string)$policy['sf9_template_variant']), ['G1', 'G2', 'G3'], true);
}

function assertDigitalClassRecordEnabled(PDO $conn, array $class): void {
    if (isHandwrittenDescriptiveClass($conn, $class)) {
        $policy = GradingPolicyService::resolve(
            $conn,
            (int)($class['school_year_id'] ?? 0),
            (int)($class['grade_level_id'] ?? 0),
            $class['grade_name'] ?? null
        );
        $variant = strtoupper((string)($policy['sf9_template_variant'] ?? ''));
        if ($variant === 'G1') {
            throw new RuntimeException('Grade 1 descriptive classes use the PACE form. Numeric grade input is not available.');
        }
        throw new RuntimeException('This Grade 2-3 descriptive class uses a handwritten SF9. Digital grade input is not available for this grade level.');
    }
}

function employeeCanAccessClassAsTeacher(PDO $conn, array $class, int $employeeId): bool {
    if ($employeeId <= 0) {
        return false;
    }
    return (int)($class['teacher_id'] ?? 0) === $employeeId;
}

function fetchGradingPeriod(PDO $conn, int $gradingPeriodId, bool $forUpdate = false): ?array {
    $sql = 'SELECT grading_period_id, school_year_id, period_name, status, date_start, date_end FROM grading_periods WHERE grading_period_id = :id AND is_deleted = 0 LIMIT 1';
    if ($forUpdate) {
        $sql .= ' FOR UPDATE';
    }
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':id', $gradingPeriodId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function fetchPrimaryCurriculumId(PDO $conn, int $schoolYearId = 0): ?int {
    return $schoolYearId > 0
        ? app_integrity_get_curriculum_id_for_school_year($conn, $schoolYearId)
        : null;
}

function fetchPassingMark(PDO $conn, int $curriculumId, int $gradeLevelId, int $subjectId): float {
    $stmt = $conn->prepare(
        'SELECT passing_mark
         FROM curriculum_passing_marks
         WHERE curriculum_id = :cid
           AND is_deleted = 0
           AND (grade_level_id = :glid OR grade_level_id IS NULL)
           AND (subject_id = :sid OR subject_id IS NULL)
         ORDER BY (subject_id IS NULL) ASC, (grade_level_id IS NULL) ASC
         LIMIT 1'
    );
    $stmt->bindValue(':cid', $curriculumId, PDO::PARAM_INT);
    $stmt->bindValue(':glid', $gradeLevelId, PDO::PARAM_INT);
    $stmt->bindValue(':sid', $subjectId, PDO::PARAM_INT);
    $stmt->execute();
    $val = $stmt->fetchColumn();
    if ($val === false || $val === null || $val === '') {
        return 75.0;
    }
    return (float)$val;
}

function canonicalClassOfferingsSql(): string {
    return 'SELECT co_latest.class_id, co_latest.section_id, co_latest.school_year_id, co_latest.subject_id, co_latest.teacher_id
            FROM class_offerings co_latest
            JOIN (
                SELECT section_id, school_year_id, subject_id, MAX(class_id) AS class_id
                FROM class_offerings
                                WHERE is_deleted = 0
                GROUP BY section_id, school_year_id, subject_id
            ) pick ON pick.class_id = co_latest.class_id
                        WHERE co_latest.is_deleted = 0';
}

function countActiveEnrolledInSection(PDO $conn, int $sectionId, int $schoolYearId): int {
    $stmt = $conn->prepare(
        'SELECT COUNT(*)
         FROM enrollments
         WHERE is_deleted = 0
           AND enrollment_status = "Enrolled"
           AND section_id = :sid
           AND school_year_id = :sy'
    );
    $stmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    return (int)$stmt->fetchColumn();
}

function countActiveEnrolledInGradeLevel(PDO $conn, int $schoolYearId, int $gradeLevelId): int {
    $stmt = $conn->prepare(
        'SELECT COUNT(*)
         FROM enrollments e
         JOIN sections sec ON sec.section_id = e.section_id
                          AND sec.is_deleted = 0
                          AND sec.school_year_id = e.school_year_id
                          AND sec.grade_level_id = :gl
         WHERE e.is_deleted = 0
           AND e.enrollment_status = "Enrolled"
           AND e.school_year_id = :sy
           AND e.grade_level_id = :gl_enroll'
    );
    $stmt->bindValue(':gl', $gradeLevelId, PDO::PARAM_INT);
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':gl_enroll', $gradeLevelId, PDO::PARAM_INT);
    $stmt->execute();
    return (int)$stmt->fetchColumn();
}

$operation = $_GET['operation'] ?? '';
$readRoles = ['admin', 'teacher', 'adviser', 'advisor'];
if ($operation === 'getHonorsListByGradeLevel') {
    $readRoles = ['admin', 'teacher', 'registrar', 'adviser', 'advisor'];
}
$session = auth_enforce_roles($operation, $readRoles, ['teacher', 'adviser', 'advisor']);

try {
    switch ($operation) {
        case 'getMyClassOfferings':
            getMyClassOfferings($conn, $session);
            break;
        case 'getRosterGrades':
            getRosterGrades($conn, $session);
            break;
        case 'getClassRecordSheet':
            getClassRecordSheet($conn, $session);
            break;
        case 'getObservedValues':
            getObservedValues($conn, $session);
            break;
        case 'saveRosterGrades':
            saveRosterGrades($conn, $session);
            break;
        case 'saveObservedValues':
            saveObservedValues($conn, $session);
            break;
        case 'finalizeRosterGrades':
            finalizeRosterGrades($conn, $session);
            break;
        case 'getHonorsList':
            getHonorsList($conn, $session);
            break;
        case 'getHonorsListByGradeLevel':
            getHonorsListByGradeLevel($conn, $session);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (InvalidArgumentException $e) {
    respond(['success' => false, 'message' => $e->getMessage()], 422);
} catch (ApplicationIntegrityException $e) {
    respond(['success' => false, 'message' => $e->getMessage()], $e->getCode());
} catch (RuntimeException $e) {
    $message = $e->getMessage();
    $code = 500;
    if (str_starts_with($message, 'Class offering not found') || str_starts_with($message, 'Grading period not found')) {
        $code = 404;
    } elseif (str_contains($message, 'authorized') || str_contains($message, 'open for encoding') || str_contains($message, 'save lock')) {
        $code = 403;
    }
    respond(['success' => false, 'message' => $message], $code);
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getMyClassOfferings(PDO $conn, array $session): void {
    if (auth_is_admin($session)) {
        syncMapehComponentOfferingsForActiveClusters($conn);
        $sql = "SELECT co.class_id, co.subject_id, s.subject_name,
                       co.section_id, sec.section_name, sec.grade_level_id, gl.grade_name,
                       sec.adviser_id,
                       co.school_year_id, sy.year_label, sy.is_active AS school_year_is_active,
                       sy.grading_system_type,
                       co.teacher_id
                FROM class_offerings co
                JOIN subjects s ON s.subject_id = co.subject_id AND s.is_deleted = 0
                JOIN sections sec ON sec.section_id = co.section_id AND sec.is_deleted = 0 AND sec.school_year_id = co.school_year_id
                LEFT JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id
                JOIN school_years sy ON sy.school_year_id = co.school_year_id AND sy.is_deleted = 0
                WHERE co.is_deleted = 0
                ORDER BY sy.school_year_id DESC, sec.section_name ASC, s.subject_name ASC";
        $stmt = $conn->prepare($sql);
        $stmt->execute();
        $rows = array_values(array_filter(
            $stmt->fetchAll(PDO::FETCH_ASSOC),
            fn($row) => isClassOfferingInCurriculum($conn, $row)
        ));
        respond(['success' => true, 'data' => decorateClassRecordOfferings($conn, $rows)]);
    }

    $employeeId = getTeacherEmployeeId($conn, (int)$session['user_id']);
    if (!$employeeId) {
        auth_abort(403, 'Teacher profile not found');
    }
    syncMapehComponentOfferingsForActiveClusters($conn, $employeeId);

    $sql = "SELECT co.class_id, co.subject_id, s.subject_name,
                 co.section_id, sec.section_name, sec.grade_level_id, gl.grade_name,
                 sec.adviser_id,
                 co.school_year_id, sy.year_label, sy.is_active AS school_year_is_active,
                 sy.grading_system_type,
                 co.teacher_id
             FROM class_offerings co
            JOIN subjects s ON s.subject_id = co.subject_id AND s.is_deleted = 0
            JOIN sections sec ON sec.section_id = co.section_id AND sec.is_deleted = 0 AND sec.school_year_id = co.school_year_id
            LEFT JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id
             JOIN school_years sy ON sy.school_year_id = co.school_year_id AND sy.is_deleted = 0
             WHERE co.is_deleted = 0
               AND co.teacher_id = :teacher_id
            ORDER BY sy.school_year_id DESC, sec.section_name ASC, s.subject_name ASC";
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':teacher_id', $employeeId, PDO::PARAM_INT);
    $stmt->execute();
    $rows = array_values(array_filter(
        $stmt->fetchAll(PDO::FETCH_ASSOC),
        fn($row) => isClassOfferingInCurriculum($conn, $row)
    ));
    respond(['success' => true, 'data' => decorateClassRecordOfferings($conn, $rows)]);
}

function decorateClassRecordOfferings(PDO $conn, array $rows): array {
    foreach ($rows as &$row) {
        $policy = GradingPolicyService::resolve(
            $conn,
            (int)($row['school_year_id'] ?? 0),
            (int)($row['grade_level_id'] ?? 0),
            $row['grade_name'] ?? null
        );
        $row['grading_mode'] = $policy['grading_mode'];
        $row['sf9_template_variant'] = $policy['sf9_template_variant'];
        $row['supports_term_comments'] = (bool)$policy['supports_term_comments'];
        $row['supports_pace'] = strtolower((string)$policy['grading_mode']) === 'descriptive'
            && strtoupper((string)$policy['sf9_template_variant']) === 'G1';
        $row['pace_areas'] = $row['supports_pace'] ? ['Language, Reading and Literacy'] : [];
    }
    unset($row);
    return array_values(array_filter($rows, static function (array $row): bool {
        return !(
            ($row['grading_mode'] ?? '') === 'Descriptive'
            && in_array(strtoupper((string)($row['sf9_template_variant'] ?? '')), ['G2', 'G3'], true)
        );
    }));
}

function getExpectedPeriodCount(PDO $conn, int $schoolYearId): int {
    $stmt = $conn->prepare(
        'SELECT grading_system_type FROM school_years WHERE school_year_id = :sy AND is_deleted = 0 LIMIT 1'
    );
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $type = $stmt->fetchColumn();
    return match ((string)$type) {
        'Semester' => 2,
        'Three-Term', 'Trimester' => 3,
        default => 4,
    };
}

function fetchEquivalentClassIds(PDO $conn, array $class, ?int $classId = null): array {
    $classId = $classId ?? (int)$class['class_id'];
    $stmt = $conn->prepare(
        'SELECT class_id
         FROM class_offerings
         WHERE section_id = :section_id
           AND school_year_id = :school_year_id
           AND subject_id = :subject_id'
    );
    $stmt->bindValue(':section_id', (int)$class['section_id'], PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', (int)$class['school_year_id'], PDO::PARAM_INT);
    $stmt->bindValue(':subject_id', (int)$class['subject_id'], PDO::PARAM_INT);
    $stmt->execute();
    $ids = array_values(array_unique(array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN))));
    if (!in_array($classId, $ids, true)) {
        $ids[] = $classId;
    }
    return array_values(array_filter($ids, fn($id) => $id > 0));
}

function getClassRecordSheet(PDO $conn, array $session): void {
    $sectionId = requireInt($_GET['section_id'] ?? null, 'section_id');
    $requestedClassId = isset($_GET['class_id']) && $_GET['class_id'] !== '' ? requireInt($_GET['class_id'], 'class_id') : null;
    $classFilter = $requestedClassId !== null ? ' AND co.class_id = :class_id' : '';
    $teacherClassFilter = auth_is_admin($session) ? '' : ' AND co.teacher_id = :teacher_id';

    // Resolve school year and grade level from an active class offering in this section.
    $classStmt = $conn->prepare(
        'SELECT co.class_id, co.school_year_id, sec.grade_level_id, co.subject_id,
                s.subject_name, sec.section_name, gl.grade_name,
                sy.year_label, sy.grading_system_type
         FROM class_offerings co
         JOIN subjects s ON s.subject_id = co.subject_id AND s.is_deleted = 0
         JOIN sections sec ON sec.section_id = co.section_id AND sec.is_deleted = 0
         JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id AND gl.is_deleted = 0
         JOIN school_years sy ON sy.school_year_id = co.school_year_id AND sy.is_deleted = 0
         WHERE co.section_id = :section_id AND co.is_deleted = 0' . $classFilter . $teacherClassFilter . '
         ORDER BY co.school_year_id DESC, co.class_id DESC
         LIMIT 1'
    );
    $classStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    if ($requestedClassId !== null) {
        $classStmt->bindValue(':class_id', $requestedClassId, PDO::PARAM_INT);
    }
    $teacherId = 0;
    if (!auth_is_admin($session)) {
        $teacherId = getTeacherEmployeeId($conn, (int)$session['user_id']);
        if (!$teacherId) {
            respond(['success' => false, 'message' => 'Access denied'], 403);
        }
        $classStmt->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
    }
    $classStmt->execute();
    $firstClass = $classStmt->fetch(PDO::FETCH_ASSOC);
    if (!$firstClass) {
        respond(['success' => false, 'message' => 'Section not found or has no class offerings'], 404);
    }
    assertDigitalClassRecordEnabled($conn, $firstClass);

    $schoolYearId = (int)$firstClass['school_year_id'];
    $gradeLevelId = (int)$firstClass['grade_level_id'];

    $periodsStmt = $conn->prepare(
        'SELECT grading_period_id, period_name, period_no, status, date_start, date_end
         FROM grading_periods
         WHERE school_year_id = :sy AND is_deleted = 0
         ORDER BY period_no ASC, grading_period_id ASC'
    );
    $periodsStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $periodsStmt->execute();
    $periods = $periodsStmt->fetchAll(PDO::FETCH_ASSOC);

    $expectedPeriods = getExpectedPeriodCount($conn, $schoolYearId);

    // Admins receive all class offerings. Teachers receive only their assigned
    // subject offerings, even when they advise the section.
    $teacherClassesFilter = auth_is_admin($session) ? '' : ' AND co.teacher_id = :teacher_id';
    $classesStmt = $conn->prepare(
        'SELECT co.class_id, co.subject_id, s.subject_name
         FROM class_offerings co
         JOIN subjects s ON s.subject_id = co.subject_id AND s.is_deleted = 0
         WHERE co.section_id = :section_id
           AND co.school_year_id = :sy
           AND co.is_deleted = 0' . $teacherClassesFilter . '
           ORDER BY s.subject_name ASC, co.class_id ASC'
    );
    $classesStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $classesStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    if (!auth_is_admin($session)) {
        $classesStmt->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
    }
    $classesStmt->execute();
    $classes = $classesStmt->fetchAll(PDO::FETCH_ASSOC);

    // Learners in the section.
    $learnersStmt = $conn->prepare(
        "SELECT e.enrollment_id,
                l.learner_id,
                l.lrn,
                CONCAT(l.last_name, ', ', l.first_name,
                     CASE WHEN l.middle_name IS NULL OR l.middle_name = '' THEN '' ELSE CONCAT(' ', l.middle_name) END,
                     CASE WHEN l.name_extension IS NULL OR l.name_extension = '' THEN '' ELSE CONCAT(' ', l.name_extension) END
                ) AS learner_name,
                l.gender,
                e.enrollment_status
         FROM enrollments e
         JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
         WHERE e.is_deleted = 0
           AND e.section_id = :section_id
           AND e.school_year_id = :school_year_id
         ORDER BY l.last_name ASC, l.first_name ASC"
    );
    $learnersStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $learnersStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $learnersStmt->execute();
    $learners = $learnersStmt->fetchAll(PDO::FETCH_ASSOC);

    $periodIds = array_map(fn($p) => (int)$p['grading_period_id'], $periods);

    $curriculumId = fetchPrimaryCurriculumId($conn, $schoolYearId);
    $componentSubjectIds = $curriculumId ? getMapehComponentSubjectIds($conn, (int)$curriculumId, $gradeLevelId) : [];

    $classIdBySubject = [];
    foreach ($classes as $class) {
        $sid = (int)$class['subject_id'];
        $classIdBySubject[$sid] = max((int)($classIdBySubject[$sid] ?? 0), (int)$class['class_id']);
    }

    $requiredClasses = [];
    if ($curriculumId && auth_is_admin($session)) {
        foreach (fetchCurriculumSubjectsForGrade($conn, (int)$curriculumId, $gradeLevelId) as $subjectRow) {
            $sid = (int)$subjectRow['subject_id'];
            if (in_array($sid, $componentSubjectIds, true)) {
                continue;
            }
            $requiredClasses[] = [
                'subject_id' => $sid,
                'class_id' => $classIdBySubject[$sid] ?? null,
            ];
        }
    }

    if (!$requiredClasses) {
        foreach ($classIdBySubject as $sid => $cid) {
            if (in_array((int)$sid, $componentSubjectIds, true)) {
                continue;
            }
            $requiredClasses[] = [
                'subject_id' => (int)$sid,
                'class_id' => (int)$cid,
            ];
        }
    }

    $completedSubjectsByEnrollment = [];
    $requiredGradesByEnrollment = [];
    foreach ($requiredClasses as $requiredClass) {
        $requiredSubjectId = (int)$requiredClass['subject_id'];
        if (empty($requiredClass['class_id'])) {
            continue;
        }
        $equivalentClassIds = fetchEquivalentClassIds($conn, [
            'class_id' => (int)$requiredClass['class_id'],
            'section_id' => $sectionId,
            'school_year_id' => $schoolYearId,
            'subject_id' => $requiredSubjectId,
        ]);
        $placeholders = implode(',', array_fill(0, count($equivalentClassIds), '?'));
        $completionStmt = $conn->prepare(
            "SELECT g1.enrollment_id, g1.grading_period_id, g1.quarterly_grade
             FROM grades g1
             JOIN (
                 SELECT enrollment_id, grading_period_id, MAX(grade_id) AS latest_grade_id
                 FROM grades
                 WHERE class_id IN ({$placeholders})
                   AND is_deleted = 0
                 GROUP BY enrollment_id, grading_period_id
             ) pick ON pick.latest_grade_id = g1.grade_id"
        );
        $completionStmt->execute($equivalentClassIds);
        while ($grade = $completionStmt->fetch(PDO::FETCH_ASSOC)) {
            if ($grade['quarterly_grade'] !== null) {
                $eid = (int)$grade['enrollment_id'];
                $gpid = (int)$grade['grading_period_id'];
                $completedSubjectsByEnrollment[$eid][$gpid][$requiredSubjectId] = true;
                $requiredGradesByEnrollment[$eid][$gpid][$requiredSubjectId] = (float)$grade['quarterly_grade'];
            }
        }
    }
    $requiredSubjectCount = count($requiredClasses);
    $requiredPeriodIds = array_slice($periodIds, 0, $expectedPeriods);
    $summaryRows = [];
    foreach ($learners as $learner) {
        $eid = (int)$learner['enrollment_id'];
        $periodAverages = [];
        $periodsComplete = [];
        $completedPeriodValues = [];

        foreach ($periodIds as $gpid) {
            $periodGrades = $requiredGradesByEnrollment[$eid][$gpid] ?? [];
            $isComplete = $requiredSubjectCount > 0 && count($periodGrades) === $requiredSubjectCount;
            $periodsComplete[$gpid] = $isComplete;

            if ($isComplete) {
                $avg = round(array_sum($periodGrades) / count($periodGrades), 2);
                $periodAverages[$gpid] = $avg;
                if (in_array($gpid, $requiredPeriodIds, true)) {
                    $completedPeriodValues[] = $avg;
                }
            } else {
                $periodAverages[$gpid] = null;
            }
        }

        $allPeriodsComplete = $requiredSubjectCount > 0
            && count($completedPeriodValues) >= $expectedPeriods
            && !empty($requiredPeriodIds)
            && !in_array(false, array_map(fn($gpid) => $periodsComplete[$gpid] ?? false, $requiredPeriodIds), true);

        $finalGrade = null;
        $remark = '';
        if ($allPeriodsComplete) {
            $finalGrade = round(array_sum($completedPeriodValues) / count($completedPeriodValues), 2);
            $remark = $finalGrade >= 75.00 ? 'Passed' : 'Failed';
        }

        $summaryRows[] = [
            'enrollment_id' => $eid,
            'learner_id' => (int)$learner['learner_id'],
            'lrn' => $learner['lrn'],
            'learner_name' => $learner['learner_name'],
            'gender' => $learner['gender'],
            'enrollment_status' => $learner['enrollment_status'] ?: 'Enrolled',
            'period_averages' => $periodAverages,
            'periods_complete' => $periodsComplete,
            'all_periods_complete' => $allPeriodsComplete,
            'final_grade' => $finalGrade,
            'remark' => $remark,
        ];
    }

    $defaultPassingMark = 75.0;
    $passingMarkBySubject = [];
    foreach ($classes as $class) {
        $pm = $defaultPassingMark;
        if ($curriculumId) {
            $pm = fetchPassingMark($conn, (int)$curriculumId, $gradeLevelId, (int)$class['subject_id']);
        }
        $passingMarkBySubject[(int)$class['class_id']] = $pm;
    }

    $subjectSheets = [];
    foreach ($classes as $class) {
        $classId = (int)$class['class_id'];
        $equivClassIds = fetchEquivalentClassIds($conn, [
            'class_id' => $classId,
            'section_id' => $sectionId,
            'school_year_id' => $schoolYearId,
            'subject_id' => (int)$class['subject_id'],
        ], $classId);
        $inPlaceholders = implode(',', array_fill(0, count($equivClassIds), '?'));

        $gradesStmt = $conn->prepare(
            "SELECT g1.enrollment_id, g1.grading_period_id, g1.quarterly_grade
             FROM grades g1
             JOIN (
                 SELECT enrollment_id, grading_period_id, MAX(grade_id) AS latest_grade_id
                 FROM grades
                 WHERE class_id IN ({$inPlaceholders})
                   AND is_deleted = 0
                 GROUP BY enrollment_id, grading_period_id
             ) pick ON pick.latest_grade_id = g1.grade_id"
        );
        foreach ($equivClassIds as $i => $cid) {
            $gradesStmt->bindValue($i + 1, (int)$cid, PDO::PARAM_INT);
        }
        $gradesStmt->execute();
        $gradesByEnrollment = [];
        while ($row = $gradesStmt->fetch(PDO::FETCH_ASSOC)) {
            $eid = (int)$row['enrollment_id'];
            $gpid = (int)$row['grading_period_id'];
            $gradesByEnrollment[$eid][$gpid] = $row['quarterly_grade'] !== null ? (float)$row['quarterly_grade'] : null;
        }

        $finalStmt = $conn->prepare(
            "SELECT fg1.enrollment_id, fg1.final_grade, fg1.remark
             FROM final_grades fg1
             JOIN (
                 SELECT enrollment_id, MAX(final_grade_id) AS latest_id
                 FROM final_grades
                 WHERE class_id IN ({$inPlaceholders})
                   AND is_deleted = 0
                 GROUP BY enrollment_id
             ) pick ON pick.latest_id = fg1.final_grade_id"
        );
        foreach ($equivClassIds as $i => $cid) {
            $finalStmt->bindValue($i + 1, (int)$cid, PDO::PARAM_INT);
        }
        $finalStmt->execute();
        $finalByEnrollment = [];
        while ($row = $finalStmt->fetch(PDO::FETCH_ASSOC)) {
            $finalByEnrollment[(int)$row['enrollment_id']] = [
                'final_grade' => $row['final_grade'] !== null ? (float)$row['final_grade'] : null,
                'remark' => $row['remark'],
            ];
        }

        $passingMark = $passingMarkBySubject[$classId] ?? $defaultPassingMark;
        $rows = [];
        foreach ($learners as $learner) {
            $eid = (int)$learner['enrollment_id'];
            $grades = $gradesByEnrollment[$eid] ?? [];
            $filled = 0;
            $periodGrades = [];
            $periodsComplete = [];
            foreach ($periodIds as $gpid) {
                $val = $grades[$gpid] ?? null;
                $isComplete = $requiredSubjectCount > 0
                    && count($completedSubjectsByEnrollment[$eid][$gpid] ?? []) === $requiredSubjectCount;
                $periodsComplete[$gpid] = $isComplete;
                $periodGrades[$gpid] = $isComplete ? $val : null;
                if ($val !== null) {
                    $filled++;
                }
            }
            $allSubjectsComplete = $requiredSubjectCount > 0
                && !empty($periodsComplete)
                && !in_array(false, $periodsComplete, true);

            $finalRow = $finalByEnrollment[$eid] ?? null;
            $finalGrade = $finalRow['final_grade'] ?? null;
            $remark = $finalRow['remark'] ?? '';

            if (!$allSubjectsComplete) {
                $finalGrade = null;
                $remark = '';
            } elseif ($finalGrade === null && $filled >= $expectedPeriods) {
                $periodValues = array_filter($periodGrades, fn($v) => $v !== null);
                $finalGrade = (float)round(array_sum($periodValues) / count($periodValues), 2);
                $remark = $finalGrade >= $passingMark ? 'Passed' : 'Failed';
            } elseif ($finalGrade !== null) {
                $finalGrade = (float)round($finalGrade, 2);
            }

            $rows[] = [
                'enrollment_id' => $eid,
                'learner_id' => (int)$learner['learner_id'],
                'lrn' => $learner['lrn'],
                'learner_name' => $learner['learner_name'],
                'gender' => $learner['gender'],
                'enrollment_status' => $learner['enrollment_status'] ?: 'Enrolled',
                'grades' => $periodGrades,
                'periods_filled' => $filled,
                'periods_complete' => $periodsComplete,
                'all_subjects_complete' => $allSubjectsComplete,
                'final_grade' => $finalGrade,
                'remark' => $remark,
            ];
        }

        $subjectSheets[] = [
            'class_id' => $classId,
            'subject_id' => (int)$class['subject_id'],

            'subject_name' => $class['subject_name'],
            'passing_mark' => $passingMark,
            'learners' => $rows,
        ];
    }

    respond([
        'success' => true,
        'data' => [
            'section' => [
                'section_id' => $sectionId,
                'section_name' => $firstClass['section_name'],
                'grade_level_id' => $gradeLevelId,
                'grade_name' => $firstClass['grade_name'],
                'school_year_id' => $schoolYearId,
                'year_label' => $firstClass['year_label'],
                'grading_system_type' => $firstClass['grading_system_type'] ?? 'Quarterly',
            ],
            'periods' => array_map(fn($p) => [
                'grading_period_id' => (int)$p['grading_period_id'],
                'period_name' => $p['period_name'],
                'period_no' => $p['period_no'] !== null ? (int)$p['period_no'] : null,
                'status' => $p['status'],
                'date_start' => $p['date_start'],
                'date_end' => $p['date_end'],
            ], $periods),
            'expected_periods' => $expectedPeriods,
            'summary' => [
                'required_subject_count' => $requiredSubjectCount,
                'learners' => $summaryRows,
            ],
            'subjects' => $subjectSheets,
        ],
    ]);
}

function getRosterGrades(PDO $conn, array $session): void {
    $classId = requireInt($_GET['class_id'] ?? null, 'class_id');
    $gradingPeriodId = requireInt($_GET['grading_period_id'] ?? null, 'grading_period_id');

    $class = enforceClassAccess($conn, $session, $classId);
    assertDigitalClassRecordEnabled($conn, $class);
    $gp = fetchGradingPeriod($conn, $gradingPeriodId);
    if (!$gp) {
        respond(['success' => false, 'message' => 'Grading period not found'], 404);
    }
    if ((int)$gp['school_year_id'] !== (int)$class['school_year_id']) {
        respond(['success' => false, 'message' => 'Grading period does not belong to this school year'], 422);
    }

    $curriculumId = fetchPrimaryCurriculumId($conn, (int)$class['school_year_id']);
    $passingMark = 75.0;
    if ($curriculumId) {
        $passingMark = fetchPassingMark($conn, (int)$curriculumId, (int)$class['grade_level_id'], (int)$class['subject_id']);
    }
    $subjectRole = getCurriculumSubjectRole($conn, $class);
    $curriculumAligned = isClassOfferingInCurriculum($conn, $class);

    // Support teacher reassignment history:
    // if older grades were encoded under a previous class_id for the same
    // section + school year + subject, include those rows and pick the latest.
    $equivalentClassIds = fetchEquivalentClassIds($conn, $class, $classId);

    $inPlaceholders = implode(',', array_fill(0, count($equivalentClassIds), '?'));
    // Grade-entry rosters contain only learners who can still be worked on in
    // this class record. Dropped/transferred-out enrollments remain available
    // through the all-period history view, but are never exposed for new input.
    // Completed rows remain supported for authorized corrections while a
    // grading period is open; NULL is retained as a legacy Enrolled value.
    $sql = "SELECT e.enrollment_id,
                   l.learner_id,
                   l.lrn,
                   CONCAT(l.last_name, ', ', l.first_name,
                        CASE WHEN l.middle_name IS NULL OR l.middle_name = '' THEN '' ELSE CONCAT(' ', l.middle_name) END,
                        CASE WHEN l.name_extension IS NULL OR l.name_extension = '' THEN '' ELSE CONCAT(' ', l.name_extension) END
                   ) AS learner_name,
                   l.gender,
                   e.enrollment_status,
                   g.grade_id,
                   g.quarterly_grade
            FROM enrollments e
            JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
            LEFT JOIN (
                SELECT g1.enrollment_id,
                       g1.grade_id,
                       g1.quarterly_grade
                FROM grades g1
                JOIN (
                    SELECT enrollment_id, MAX(grade_id) AS latest_grade_id
                    FROM grades
                    WHERE grading_period_id = ?
                      AND is_deleted = 0
                      AND class_id IN (" . $inPlaceholders . ")
                    GROUP BY enrollment_id
                ) pick ON pick.latest_grade_id = g1.grade_id
            ) g ON g.enrollment_id = e.enrollment_id
            WHERE e.is_deleted = 0
              AND (e.enrollment_status IN ('Enrolled', 'Completed') OR e.enrollment_status IS NULL)
              AND e.section_id = ?
              AND e.school_year_id = ?
            ORDER BY l.last_name ASC, l.first_name ASC";

    $stmt = $conn->prepare($sql);
    $bindPos = 1;
    $stmt->bindValue($bindPos++, $gradingPeriodId, PDO::PARAM_INT);
    foreach ($equivalentClassIds as $cid) {
        $stmt->bindValue($bindPos++, (int)$cid, PDO::PARAM_INT);
    }
    $stmt->bindValue($bindPos++, (int)$class['section_id'], PDO::PARAM_INT);
    $stmt->bindValue($bindPos++, (int)$class['school_year_id'], PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    respond([
        'success' => true,
        'data' => [
            'class' => [
                'class_id' => (int)$class['class_id'],
                'subject_id' => (int)$class['subject_id'],
                'subject_name' => $class['subject_name'],
                'section_id' => (int)$class['section_id'],
                'section_name' => $class['section_name'],
                'grade_level_id' => (int)$class['grade_level_id'],
                'grade_name' => $class['grade_name'],
                'school_year_id' => (int)$class['school_year_id'],
                'year_label' => $class['year_label'],
                'grading_system_type' => $class['grading_system_type'] ?? 'Quarterly',
                'passing_mark' => $passingMark,
                'curriculum_aligned' => $curriculumAligned,
                'curriculum_id' => $subjectRole['curriculum_id'],
                'is_mapeh_component' => $subjectRole['is_mapeh_component'],
                'is_mapeh_cluster' => $subjectRole['is_mapeh_cluster'],
                'has_mapeh_components' => $subjectRole['has_mapeh_components'],
                'mapeh_cluster_subject_id' => $subjectRole['mapeh_cluster_subject_id'],
                'mapeh_component_subject_ids' => $subjectRole['mapeh_component_subject_ids']
            ],
            'grading_period' => [
                'grading_period_id' => (int)$gp['grading_period_id'],
                'period_name' => $gp['period_name'],
                'status' => $gp['status'],
                'date_start' => $gp['date_start'],
                'date_end' => $gp['date_end']
            ],
            'learners' => $rows
        ]
    ]);
}

function observedValuesTemplateRows(): array {
    return [
        ['code' => 'MAKA_DIYOS_1', 'core_value' => 'Maka-Diyos', 'behavior_statement' => "Expresses one's spiritual beliefs while respecting the spiritual beliefs of others", 'sort_order' => 1],
        ['code' => 'MAKA_DIYOS_2', 'core_value' => 'Maka-Diyos', 'behavior_statement' => 'Shows adherence to ethical principles by upholding truth in all undertakings', 'sort_order' => 2],
        ['code' => 'MAKATAO_1', 'core_value' => 'Makatao', 'behavior_statement' => 'Is sensitive to individual, social and cultural differences; resists stereotyping people', 'sort_order' => 3],
        ['code' => 'MAKATAO_2', 'core_value' => 'Makatao', 'behavior_statement' => 'Demonstrates contributions toward solidarity', 'sort_order' => 4],
        ['code' => 'MAKAKALIKASAN_1', 'core_value' => 'Makakalikasan', 'behavior_statement' => 'Cares for the environment and utilizes resources wisely, judiciously and economically', 'sort_order' => 5],
        ['code' => 'MAKABANSA_1', 'core_value' => 'Makabansa', 'behavior_statement' => 'Demonstrates pride in being a Filipino; exercises the rights and responsibilities of a Filipino citizen', 'sort_order' => 6],
        ['code' => 'MAKABANSA_2', 'core_value' => 'Makabansa', 'behavior_statement' => 'Demonstrates appropriate behavior in carrying out activities in the school, community and country', 'sort_order' => 7],
    ];
}

function fetchObservedValueIndicators(PDO $conn): array {
    if (!tableExists($conn, 'observed_value_core_values') || !tableExists($conn, 'observed_value_indicators')) {
        return array_map(fn($row) => ['indicator_id' => null] + $row, observedValuesTemplateRows());
    }

    $stmt = $conn->query(
        "SELECT ovi.indicator_id,
                ovi.code,
                ovc.core_value,
                ovi.behavior_statement,
                ovi.sort_order
         FROM observed_value_indicators ovi
         JOIN observed_value_core_values ovc ON ovc.core_value_id = ovi.core_value_id
                                      AND ovc.is_deleted = 0
         WHERE ovi.is_deleted = 0
         ORDER BY ovc.sort_order ASC, ovi.sort_order ASC, ovi.indicator_id ASC"
    );
    $rows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
    if (!$rows) {
        return array_map(fn($row) => ['indicator_id' => null] + $row, observedValuesTemplateRows());
    }
    return array_map(fn($row) => [
        'indicator_id' => (int)$row['indicator_id'],
        'code' => $row['code'],
        'core_value' => $row['core_value'],
        'behavior_statement' => $row['behavior_statement'],
        'sort_order' => (int)$row['sort_order'],
    ], $rows);
}

function fetchSectionForObservedValues(PDO $conn, int $sectionId, ?int $gradingPeriodId = null): array {
    $sql = "SELECT sec.section_id,
                   sec.section_name,
                   sec.grade_level_id,
                   gl.grade_name,
                   sec.school_year_id,
                   sy.year_label,
                   sy.grading_system_type,
                   sec.adviser_id
            FROM sections sec
            JOIN school_years sy ON sy.school_year_id = sec.school_year_id AND sy.is_deleted = 0
            LEFT JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id
            WHERE sec.section_id = :section_id
              AND sec.is_deleted = 0
            LIMIT 1";
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->execute();
    $section = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$section) {
        throw new RuntimeException('Section not found');
    }

    if ($gradingPeriodId !== null) {
        $gp = fetchGradingPeriod($conn, $gradingPeriodId);
        if (!$gp) {
            throw new RuntimeException('Grading period not found');
        }
        if ((int)$gp['school_year_id'] !== (int)$section['school_year_id']) {
            throw new InvalidArgumentException('Grading period does not belong to this section school year');
        }
        $section['grading_period'] = $gp;
    }

    return $section;
}

function enforceObservedValuesSectionAccess(PDO $conn, array $session, array $section): void {
    if (auth_is_admin($session)) {
        return;
    }

    $employeeId = getTeacherEmployeeId($conn, (int)$session['user_id']);
    if (!$employeeId) {
        auth_abort(403, 'Teacher profile not found');
    }

    $stmt = $conn->prepare(
        'SELECT 1
         FROM sections sec
         WHERE sec.section_id = :section_id
           AND sec.school_year_id = :school_year_id
           AND sec.is_deleted = 0
           AND EXISTS (
               SELECT 1
               FROM class_offerings co
               WHERE co.section_id = sec.section_id
                 AND co.school_year_id = sec.school_year_id
                 AND co.teacher_id = :teacher_id
                 AND co.is_deleted = 0
           )
         LIMIT 1'
    );
    $stmt->bindValue(':section_id', (int)$section['section_id'], PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', (int)$section['school_year_id'], PDO::PARAM_INT);
    $stmt->bindValue(':teacher_id', $employeeId, PDO::PARAM_INT);
    $stmt->execute();
    if (!$stmt->fetchColumn()) {
        auth_abort(403, 'Access denied for this section');
    }
}

function enforceObservedValuesWriteAccess(PDO $conn, array $session, array $section): void {
    if (auth_is_admin($session)) {
        auth_abort(403, 'Administrators have view-only access to observed values');
    }
    enforceObservedValuesSectionAccess($conn, $session, $section);
}

function fetchObservedValuesLearners(PDO $conn, int $sectionId, int $schoolYearId): array {
    $stmt = $conn->prepare(
        "SELECT e.enrollment_id,
                l.learner_id,
                l.lrn,
                CONCAT(l.last_name, ', ', l.first_name,
                     CASE WHEN l.middle_name IS NULL OR l.middle_name = '' THEN '' ELSE CONCAT(' ', l.middle_name) END,
                     CASE WHEN l.name_extension IS NULL OR l.name_extension = '' THEN '' ELSE CONCAT(' ', l.name_extension) END
                ) AS learner_name,
                l.gender
         FROM enrollments e
         JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
         WHERE e.is_deleted = 0
           -- Completed learners remain visible so the class list is stable
           -- after automatic academic completion.
           AND (e.enrollment_status IN ('Enrolled', 'Completed') OR e.enrollment_status IS NULL)
           AND e.section_id = :section_id
           AND e.school_year_id = :school_year_id
         ORDER BY l.last_name ASC, l.first_name ASC"
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function getObservedValues(PDO $conn, array $session): void {
    $sectionId = requireInt($_GET['section_id'] ?? null, 'section_id');
    $gradingPeriodId = requireInt($_GET['grading_period_id'] ?? null, 'grading_period_id');

    $section = fetchSectionForObservedValues($conn, $sectionId, $gradingPeriodId);
    assertDigitalClassRecordEnabled($conn, $section);
    enforceObservedValuesSectionAccess($conn, $session, $section);

    $hasStorage = tableExists($conn, 'learner_observed_values')
        && tableExists($conn, 'observed_value_indicators')
        && tableExists($conn, 'observed_value_core_values');
    $indicators = fetchObservedValueIndicators($conn);
    $learners = fetchObservedValuesLearners($conn, $sectionId, (int)$section['school_year_id']);

    $ratingsByEnrollment = [];
    if ($hasStorage && $learners && array_filter(array_column($indicators, 'indicator_id'))) {
        $enrollmentIds = array_values(array_unique(array_map('intval', array_column($learners, 'enrollment_id'))));
        $placeholders = implode(',', array_fill(0, count($enrollmentIds), '?'));
        $stmt = $conn->prepare(
            "SELECT enrollment_id, indicator_id, rating_code
             FROM learner_observed_values
             WHERE grading_period_id = ?
               AND is_deleted = 0
               AND enrollment_id IN ({$placeholders})"
        );
        $params = [$gradingPeriodId, ...$enrollmentIds];
        $stmt->execute($params);
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $eid = (int)$row['enrollment_id'];
            $indicatorId = (int)$row['indicator_id'];
            $ratingsByEnrollment[$eid][$indicatorId] = $row['rating_code'];
        }
    }

    $rows = array_map(function ($learner) use ($ratingsByEnrollment) {
        $eid = (int)$learner['enrollment_id'];
        return [
            'enrollment_id' => $eid,
            'learner_id' => (int)$learner['learner_id'],
            'lrn' => $learner['lrn'],
            'learner_name' => $learner['learner_name'],
            'gender' => $learner['gender'],
            'values' => $ratingsByEnrollment[$eid] ?? [],
        ];
    }, $learners);

    respond([
        'success' => true,
        'data' => [
            'migration_required' => !$hasStorage,
            'can_save' => $hasStorage,
            'ratings' => [
                ['code' => 'AO', 'label' => 'Always Observed'],
                ['code' => 'SO', 'label' => 'Sometimes Observed'],
                ['code' => 'RO', 'label' => 'Rarely Observed'],
                ['code' => 'NO', 'label' => 'Not Observed'],
            ],
            'section' => [
                'section_id' => (int)$section['section_id'],
                'section_name' => $section['section_name'],
                'grade_level_id' => (int)$section['grade_level_id'],
                'grade_name' => $section['grade_name'],
                'school_year_id' => (int)$section['school_year_id'],
                'year_label' => $section['year_label'],
                'grading_system_type' => $section['grading_system_type'] ?? 'Quarterly',
            ],
            'grading_period' => [
                'grading_period_id' => (int)$section['grading_period']['grading_period_id'],
                'period_name' => $section['grading_period']['period_name'],
                'status' => $section['grading_period']['status'],
                'date_start' => $section['grading_period']['date_start'],
                'date_end' => $section['grading_period']['date_end'],
            ],
            'indicators' => $indicators,
            'learners' => $rows,
        ],
    ]);
}

function saveObservedValues(PDO $conn, array $session): void {
    if (!tableExists($conn, 'learner_observed_values')
        || !tableExists($conn, 'observed_value_indicators')
        || !tableExists($conn, 'observed_value_core_values')) {
        throw new RuntimeException('Observed-values tables are not installed. Run add_observed_values_encoding.sql first.');
    }

    $data = getJsonInput();
    $sectionId = requireInt($data['section_id'] ?? null, 'section_id');
    $gradingPeriodId = requireInt($data['grading_period_id'] ?? null, 'grading_period_id');
    $values = $data['values'] ?? [];
    if (!is_array($values)) {
        throw new InvalidArgumentException('values must be an array');
    }

    $section = fetchSectionForObservedValues($conn, $sectionId, $gradingPeriodId);
    assertDigitalClassRecordEnabled($conn, $section);
    enforceObservedValuesWriteAccess($conn, $session, $section);
    $gp = $section['grading_period'] ?? null;
    if (!$gp || strtoupper((string)$gp['status']) !== 'OPEN') {
        throw new RuntimeException('Grading period is not open for observed-values encoding');
    }

    $validRatings = ['AO' => true, 'SO' => true, 'RO' => true, 'NO' => true];
    $parsed = [];
    foreach ($values as $index => $row) {
        if (!is_array($row)) continue;
        $enrollmentId = isset($row['enrollment_id']) ? (int)$row['enrollment_id'] : 0;
        $indicatorId = isset($row['indicator_id']) ? (int)$row['indicator_id'] : 0;
        $rating = strtoupper(trim((string)($row['rating_code'] ?? '')));
        if ($enrollmentId <= 0 || $indicatorId <= 0) continue;
        if ($rating !== '' && !isset($validRatings[$rating])) {
            throw new InvalidArgumentException("Invalid observed-value rating at row {$index}");
        }
        $parsed[] = [
            'enrollment_id' => $enrollmentId,
            'indicator_id' => $indicatorId,
            'rating_code' => $rating,
        ];
    }

    if (!$parsed) {
        throw new InvalidArgumentException('No observed-value rows provided');
    }

    $userId = (int)($session['user_id'] ?? 0);
    $lockKey = "save_observed_values:{$sectionId}:{$gradingPeriodId}";
    $lockAcquired = false;
    $saved = 0;
    $cleared = 0;

    try {
        $conn->beginTransaction();
        $lockStmt = $conn->prepare('SELECT GET_LOCK(?, 10)');
        $lockStmt->execute([$lockKey]);
        $lockAcquired = (bool)$lockStmt->fetchColumn();
        if (!$lockAcquired) {
            throw new RuntimeException('Could not acquire save lock; another user may be saving observed values for this period. Please retry.');
        }

        $enrollmentIds = array_values(array_unique(array_map('intval', array_column($parsed, 'enrollment_id'))));
        $indicatorIds = array_values(array_unique(array_map('intval', array_column($parsed, 'indicator_id'))));
        $enrollmentPlaceholders = implode(',', array_fill(0, count($enrollmentIds), '?'));
        $indicatorPlaceholders = implode(',', array_fill(0, count($indicatorIds), '?'));

        $enrollStmt = $conn->prepare(
            "SELECT enrollment_id
             FROM enrollments
             WHERE enrollment_id IN ({$enrollmentPlaceholders})
               AND section_id = ?
               AND school_year_id = ?
               AND (enrollment_status IN ('Enrolled', 'Completed') OR enrollment_status IS NULL)
               AND is_deleted = 0"
        );
        $enrollStmt->execute([...$enrollmentIds, $sectionId, (int)$section['school_year_id']]);
        $validEnrollmentMap = array_fill_keys(array_map('intval', $enrollStmt->fetchAll(PDO::FETCH_COLUMN)), true);

        $indicatorStmt = $conn->prepare(
            "SELECT indicator_id
             FROM observed_value_indicators
             WHERE indicator_id IN ({$indicatorPlaceholders})
               AND is_deleted = 0"
        );
        $indicatorStmt->execute($indicatorIds);
        $validIndicatorMap = array_fill_keys(array_map('intval', $indicatorStmt->fetchAll(PDO::FETCH_COLUMN)), true);

        $upsert = $conn->prepare(
            "INSERT INTO learner_observed_values (
                enrollment_id, grading_period_id, indicator_id, rating_code,
                encoded_by, updated_by, is_deleted, deleted_at
             ) VALUES (
                :enrollment_id, :grading_period_id, :indicator_id, :rating_code,
                :encoded_by, :updated_by, 0, NULL
             )
             ON DUPLICATE KEY UPDATE
                rating_code = VALUES(rating_code),
                updated_by = VALUES(updated_by),
                is_deleted = 0,
                deleted_at = NULL"
        );
        $clear = $conn->prepare(
            "UPDATE learner_observed_values
             SET rating_code = NULL,
                 updated_by = :updated_by,
                 is_deleted = 1,
                 deleted_at = NOW()
             WHERE enrollment_id = :enrollment_id
               AND grading_period_id = :grading_period_id
               AND indicator_id = :indicator_id"
        );

        foreach ($parsed as $row) {
            $enrollmentId = (int)$row['enrollment_id'];
            $indicatorId = (int)$row['indicator_id'];
            if (!isset($validEnrollmentMap[$enrollmentId]) || !isset($validIndicatorMap[$indicatorId])) {
                continue;
            }
            if ($row['rating_code'] === '') {
                $clear->execute([
                    ':updated_by' => $userId ?: null,
                    ':enrollment_id' => $enrollmentId,
                    ':grading_period_id' => $gradingPeriodId,
                    ':indicator_id' => $indicatorId,
                ]);
                $cleared += $clear->rowCount() > 0 ? 1 : 0;
                continue;
            }

            $upsert->execute([
                ':enrollment_id' => $enrollmentId,
                ':grading_period_id' => $gradingPeriodId,
                ':indicator_id' => $indicatorId,
                ':rating_code' => $row['rating_code'],
                ':encoded_by' => $userId ?: null,
                ':updated_by' => $userId ?: null,
            ]);
            $saved++;
        }

        $conn->commit();
    } catch (Exception $e) {
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

    respond([
        'success' => true,
        'message' => 'Observed values saved',
        'data' => [
            'saved' => $saved,
            'cleared' => $cleared,
            'section_id' => $sectionId,
            'grading_period_id' => $gradingPeriodId,
        ],
    ]);
}

function saveRosterGrades(PDO $conn, array $session): void {
    if (auth_is_admin($session)) {
        auth_abort(403, 'Administrators have view-only access to grade encoding and imports');
    }

    $data = getJsonInput();
    $classId = requireInt($data['class_id'] ?? null, 'class_id');
    $gradingPeriodId = requireInt($data['grading_period_id'] ?? null, 'grading_period_id');
    $grades = $data['grades'] ?? [];

    if (!is_array($grades)) {
        respond(['success' => false, 'message' => 'grades must be an array'], 422);
    }

    // Pre-parse all incoming rows so we can validate before touching the database.
    $parsedRows = [];
    foreach ($grades as $index => $g) {
        if (!is_array($g)) {
            continue;
        }
        $enrollmentId = isset($g['enrollment_id']) ? (int)$g['enrollment_id'] : 0;
        if ($enrollmentId <= 0) {
            continue;
        }
        $parsedRows[] = [
            'index' => $index,
            'enrollment_id' => $enrollmentId,
            'raw_qg' => $g['quarterly_grade'] ?? null,
        ];
    }

    if (!$parsedRows) {
        respond(['success' => false, 'message' => 'No valid grade rows provided'], 422);
    }

    $userId = (int)($session['user_id'] ?? 0);
    $lockKey = "save_roster:{$classId}:{$gradingPeriodId}";
    $lockAcquired = false;

    $errors = [];
    $skipped = 0;
    $saved = 0;

    try {
        $conn->beginTransaction();

        // Serialize concurrent saves for the same class + grading period.
        $lockStmt = $conn->prepare('SELECT GET_LOCK(?, 10)');
        $lockStmt->execute([$lockKey]);
        $lockAcquired = (bool)$lockStmt->fetchColumn();
        if (!$lockAcquired) {
            throw new RuntimeException('Could not acquire save lock; another teacher may be saving grades for this period. Please retry.');
        }

        // Re-fetch class and period inside the transaction with row locks.
        $class = fetchClassOfferingForUpdate($conn, $classId);
        if (!$class) {
            throw new RuntimeException('Class offering not found');
        }
        assertDigitalClassRecordEnabled($conn, $class);
        if (!isClassOfferingInCurriculum($conn, $class)) {
            throw new InvalidArgumentException('This class offering subject is not part of the section curriculum for this grade level. Rebuild the class offerings from the curriculum before encoding grades.');
        }
        if (!auth_is_admin($session)) {
            $employeeId = getTeacherEmployeeId($conn, (int)$session['user_id']);
            if (!$employeeId || !employeeCanAccessClassAsTeacher($conn, $class, (int)$employeeId)) {
                throw new RuntimeException('Not authorized for this class');
            }
        }
        $curriculumId = fetchPrimaryCurriculumId($conn, (int)$class['school_year_id']);
        $componentSubjectIds = $curriculumId ? getMapehComponentSubjectIds($conn, (int)$curriculumId, (int)$class['grade_level_id']) : [];
        $clusterSubjectId = $curriculumId ? getMapehClusterSubjectId($conn, (int)$curriculumId, (int)$class['grade_level_id']) : 0;
        if ($clusterSubjectId > 0 && $componentSubjectIds && (int)$class['subject_id'] === $clusterSubjectId) {
            throw new InvalidArgumentException('MAPEH grades are computed automatically from the configured MAPEH component grades and cannot be encoded directly');
        }

        $gp = fetchGradingPeriod($conn, $gradingPeriodId, true);
        if (!$gp) {
            throw new RuntimeException('Grading period not found');
        }
        if ((int)$gp['school_year_id'] !== (int)$class['school_year_id']) {
            throw new InvalidArgumentException('Grading period does not belong to this school year');
        }
        if (strtoupper((string)$gp['status']) !== 'OPEN') {
            throw new RuntimeException('Grading period is not open for encoding');
        }

        // Resolve canonical class_id so all grades are saved under the latest offering.
        $canonicalClassId = resolveCanonicalClassId(
            $conn,
            (int)$class['section_id'],
            (int)$class['school_year_id'],
            (int)$class['subject_id']
        );
        if ($canonicalClassId <= 0) {
            $canonicalClassId = $classId;
        }

        // Completed enrollments remain eligible for grade corrections while the
        // selected grading period is open; the period lock above is the write gate.
        $enrollmentIds = array_values(array_unique(array_column($parsedRows, 'enrollment_id')));
        $placeholders = implode(',', array_fill(0, count($enrollmentIds), '?'));
        $valStmt = $conn->prepare(
            "SELECT enrollment_id
             FROM enrollments
             WHERE enrollment_id IN ($placeholders)
               AND is_deleted = 0
               AND (enrollment_status IN ('Enrolled', 'Completed') OR enrollment_status IS NULL)
               AND section_id = ?
               AND school_year_id = ?"
        );
        $i = 1;
        foreach ($enrollmentIds as $id) {
            $valStmt->bindValue($i++, $id, PDO::PARAM_INT);
        }
        $valStmt->bindValue($i++, (int)$class['section_id'], PDO::PARAM_INT);
        $valStmt->bindValue($i++, (int)$class['school_year_id'], PDO::PARAM_INT);
        $valStmt->execute();
        $validIds = array_map('intval', $valStmt->fetchAll(PDO::FETCH_COLUMN));
        $validMap = array_fill_keys($validIds, true);

        // Sanitize grades and prepare bulk values.
        $bulkRows = [];
        foreach ($parsedRows as $row) {
            $enrollmentId = $row['enrollment_id'];
            if (!isset($validMap[$enrollmentId])) {
                $errors[] = ['index' => $row['index'], 'enrollment_id' => $enrollmentId, 'reason' => 'enrollment not in this class/section'];
                $skipped++;
                continue;
            }
            try {
                $qg = sanitizeGradeValue($row['raw_qg'], 'quarterly_grade');
            } catch (InvalidArgumentException $e) {
                $errors[] = ['index' => $row['index'], 'enrollment_id' => $enrollmentId, 'reason' => $e->getMessage()];
                $skipped++;
                continue;
            }
            if ($qg === null) {
                // Skip blank grades to avoid creating empty rows.
                $skipped++;
                continue;
            }
            $bulkRows[] = [
                'enrollment_id' => $enrollmentId,
                'quarterly_grade' => $qg,
            ];
        }

        $affectedEnrollmentIds = [];
        if ($bulkRows) {
            $oldGradeMap = fetchExistingGradesForUpsert($conn, $canonicalClassId, $gradingPeriodId, array_column($bulkRows, 'enrollment_id'));
            $saved = executeBulkGradeUpsert($conn, $canonicalClassId, $gradingPeriodId, $bulkRows, $userId);
            auditBulkGradeChanges($conn, $canonicalClassId, $gradingPeriodId, $bulkRows, $oldGradeMap);
            $affectedEnrollmentIds = array_values(array_unique(array_column($bulkRows, 'enrollment_id')));
        }

        // Recompute the official MAPEH cluster grade when component grades are saved.
        $recomputedMapeh = recomputeMapehGrades($conn, $class, $gradingPeriodId, $affectedEnrollmentIds, $userId);

        // Auto-compute final grades + general averages for any learner whose
        // period grades are now complete (e.g. just entered the last period).
        $autoFinalized = 0;
        $service = new GradeComputationService($conn);
        foreach ($affectedEnrollmentIds as $enrollmentId) {
            if ($service->autoComputeForEnrollment((int)$enrollmentId, $canonicalClassId, $userId)) {
                $autoFinalized++;
            }
        }

        $conn->commit();
    } catch (Exception $e) {
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

    respond([
        'success' => true,
        'message' => 'Grades saved',
        'data' => [
            'saved' => $saved,
            'skipped' => $skipped,
            'recomputed_mapeh' => $recomputedMapeh ?? 0,
            'auto_finalized' => $autoFinalized ?? 0,
            'errors' => $errors,
            'class_id' => $canonicalClassId,
            'grading_period_id' => $gradingPeriodId
        ]
    ]);
}

/**
 * Bulk-upsert grade rows using a single INSERT ... ON DUPLICATE KEY UPDATE statement.
 * Returns the number of rows processed (inserted or updated).
 */
function executeBulkGradeUpsert(PDO $conn, int $classId, int $gradingPeriodId, array $rows, int $userId): int {
    $valuePlaceholders = [];
    $params = [];
    foreach ($rows as $row) {
        $valuePlaceholders[] = '(?, ?, ?, ?, ?, 0, NULL)';
        $params[] = $row['enrollment_id'];
        $params[] = $classId;
        $params[] = $gradingPeriodId;
        $params[] = $row['quarterly_grade'];
        $params[] = $userId ?: null;
    }

    $sql = 'INSERT INTO grades (
            enrollment_id, class_id, grading_period_id, quarterly_grade,
            encoded_by, is_deleted, deleted_at
        ) VALUES ' . implode(', ', $valuePlaceholders) . '
        ON DUPLICATE KEY UPDATE
            quarterly_grade = VALUES(quarterly_grade),
            encoded_by = VALUES(encoded_by),
            is_deleted = 0,
            deleted_at = NULL';

    $stmt = $conn->prepare($sql);
    $stmt->execute($params);
    return count($rows);
}

function fetchExistingGradesForUpsert(PDO $conn, int $classId, int $gradingPeriodId, array $enrollmentIds): array {
    $enrollmentIds = array_values(array_unique(array_map('intval', $enrollmentIds)));
    if (!$enrollmentIds) return [];

    $placeholders = implode(',', array_fill(0, count($enrollmentIds), '?'));
    $stmt = $conn->prepare(
        "SELECT grade_id, enrollment_id, class_id, grading_period_id, quarterly_grade, encoded_by, is_deleted
         FROM grades
         WHERE class_id = ?
           AND grading_period_id = ?
           AND enrollment_id IN ({$placeholders})"
    );
    $params = [$classId, $gradingPeriodId, ...$enrollmentIds];
    $stmt->execute($params);

    $map = [];
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $map[(int)$row['enrollment_id']] = $row;
    }
    return $map;
}

function auditBulkGradeChanges(PDO $conn, int $classId, int $gradingPeriodId, array $rows, array $oldGradeMap): void {
    $enrollmentIds = array_values(array_unique(array_map('intval', array_column($rows, 'enrollment_id'))));
    $newGradeMap = fetchExistingGradesForUpsert($conn, $classId, $gradingPeriodId, $enrollmentIds);

    foreach ($rows as $row) {
        $enrollmentId = (int)$row['enrollment_id'];
        $newRow = $newGradeMap[$enrollmentId] ?? null;
        if (!$newRow) continue;

        $oldRow = $oldGradeMap[$enrollmentId] ?? null;
        $action = $oldRow ? 'UPDATE' : 'INSERT';
        if ($oldRow && (float)$oldRow['quarterly_grade'] === (float)$newRow['quarterly_grade'] && (int)$oldRow['is_deleted'] === 0) {
            continue;
        }

        audit_log($conn, 'grades', (int)$newRow['grade_id'], $action, $oldRow, [
            'grade_id' => (int)$newRow['grade_id'],
            'enrollment_id' => $enrollmentId,
            'class_id' => $classId,
            'grading_period_id' => $gradingPeriodId,
            'quarterly_grade' => $newRow['quarterly_grade']
        ]);
    }
}

function finalizeRosterGrades(PDO $conn, array $session): void {
    $data = getJsonInput();
    $classId = requireInt($data['class_id'] ?? null, 'class_id');

    // Admins can finalize any class; teachers can only finalize their own.
    $class = enforceClassAccess($conn, $session, $classId);
    assertDigitalClassRecordEnabled($conn, $class);
    $schoolYearId = (int)$class['school_year_id'];

    $expected = getExpectedPeriodCount($conn, $schoolYearId);

    // Count open vs locked periods for the school year.
    $periodStmt = $conn->prepare(
        'SELECT status FROM grading_periods WHERE school_year_id = :sy AND is_deleted = 0'
    );
    $periodStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $periodStmt->execute();
    $periods = $periodStmt->fetchAll(PDO::FETCH_COLUMN);
    $lockedCount = count(array_filter($periods, fn($s) => strtoupper((string)$s) === 'LOCKED'));

    if ($lockedCount < $expected) {
        respond([
            'success' => false,
            'message' => "Cannot finalize: {$lockedCount} of {$expected} required periods are locked. Lock all periods first."
        ], 422);
    }

    $userId = (int)($session['user_id'] ?? 0);
    $service = new GradeComputationService($conn);

    try {
        $conn->beginTransaction();
        $result = $service->finalizeClass($classId, $userId);
        $conn->commit();
    } catch (Exception $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        throw $e;
    }

    respond([
        'success' => true,
        'message' => "Finalized {$result['finalized']} learner(s). General averages updated for {$result['general_averages']} learner(s); {$result['enrollments_completed']} learner(s) marked Completed and ready for promotion placement.",
        'data' => $result,
    ]);
}

function assignHonorsDenseRanks(array &$honorees): void {
    $previousAverage = null;
    $rank = 0;

    foreach ($honorees as &$honoree) {
        // Honors averages are rounded to two decimals before ranking. This
        // makes 90, 90.0, and 90.00 the same exact displayed rating.
        $averageKey = number_format((float)($honoree['general_average'] ?? 0), 2, '.', '');
        if ($previousAverage === null || $averageKey !== $previousAverage) {
            $rank++;
        }
        $honoree['rank'] = $rank;
        $previousAverage = $averageKey;
    }
    unset($honoree);
}

function getHonorsList(PDO $conn, array $session): void {
    $sectionId = requireInt($_GET['section_id'] ?? null, 'section_id');
    $mode = strtolower(trim((string)($_GET['mode'] ?? 'quarter')));
    if (!in_array($mode, ['quarter', 'final'], true)) {
        respond(['success' => false, 'message' => 'Invalid mode'], 422);
    }

    $gradingPeriodId = null;
    if ($mode === 'quarter') {
        $gradingPeriodId = requireInt($_GET['grading_period_id'] ?? null, 'grading_period_id');
    }

    $secStmt = $conn->prepare(
        'SELECT sec.section_id, sec.section_name, sec.grade_level_id, gl.grade_name, sec.school_year_id, sy.year_label
         FROM sections sec
         LEFT JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id
         LEFT JOIN school_years sy ON sy.school_year_id = sec.school_year_id
         WHERE sec.section_id = :sid AND sec.is_deleted = 0
         LIMIT 1'
    );
    $secStmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
    $secStmt->execute();
    $section = $secStmt->fetch(PDO::FETCH_ASSOC);
    if (!$section) {
        respond(['success' => false, 'message' => 'Section not found'], 404);
    }

    $schoolYearId = (int)$section['school_year_id'];

    if (!auth_is_admin($session)) {
        $employeeId = getTeacherEmployeeId($conn, (int)$session['user_id']);
        if (!$employeeId) {
            auth_abort(403, 'Teacher profile not found');
        }
        $chk = $conn->prepare('SELECT COUNT(*) FROM class_offerings WHERE section_id = :sid AND school_year_id = :sy AND teacher_id = :tid AND is_deleted = 0');
        $chk->bindValue(':sid', $sectionId, PDO::PARAM_INT);
        $chk->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $chk->bindValue(':tid', $employeeId, PDO::PARAM_INT);
        $chk->execute();
        if ((int)$chk->fetchColumn() <= 0) {
            auth_abort(403, 'Not authorized for this section');
        }
    }

    if ($mode === 'quarter') {
        $gp = fetchGradingPeriod($conn, (int)$gradingPeriodId);
        if (!$gp) {
            respond(['success' => false, 'message' => 'Grading period not found'], 404);
        }
        if ((int)$gp['school_year_id'] !== $schoolYearId) {
            respond(['success' => false, 'message' => 'Grading period does not belong to this school year'], 422);
        }
    }

    $totalEnrolled = countActiveEnrolledInSection($conn, $sectionId, $schoolYearId);
    $canonicalOfferingsSql = canonicalClassOfferingsSql();
    $curriculumId = fetchPrimaryCurriculumId($conn, $schoolYearId);
    $componentSubjectIds = $curriculumId ? getMapehComponentSubjectIds($conn, (int)$curriculumId, (int)$section['grade_level_id']) : [];
    $requiredSubjectIds = getRequiredHonorSubjectIds($conn, $curriculumId, (int)$section['grade_level_id']);
    $honorsSubjectFilterSql = buildHonorsSubjectFilterSql($requiredSubjectIds, $componentSubjectIds);

    $offerStmt = $conn->prepare(
        'SELECT co.class_id, co.subject_id, s.subject_name
         FROM (' . $canonicalOfferingsSql . ') co
         JOIN subjects s ON s.subject_id = co.subject_id AND s.is_deleted = 0
         WHERE co.section_id = :sid AND co.school_year_id = :sy
           ' . $honorsSubjectFilterSql . '
         ORDER BY s.subject_name ASC'
    );
    $offerStmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
    $offerStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $offerStmt->execute();
    $subjects = $offerStmt->fetchAll(PDO::FETCH_ASSOC);
    $subjectCount = count($subjects);

    if ($subjectCount === 0) {
        respond(['success' => true, 'data' => ['section' => $section, 'subjects' => [], 'honorees' => [], 'counts' => ['total_enrolled' => $totalEnrolled, 'highest' => 0, 'high' => 0, 'honors' => 0]]] );
    }

    $honorStmt = $conn->prepare('SELECT honor_level_id, honor_name, min_average, max_average FROM honor_levels WHERE is_deleted = 0 ORDER BY min_average DESC');
    $honorStmt->execute();
    $honorLevels = $honorStmt->fetchAll(PDO::FETCH_ASSOC);

    $rows = [];

    if ($mode === 'quarter') {
        $sql = "SELECT e.enrollment_id,
                       l.learner_id,
                       l.lrn,
                       CONCAT(l.last_name, ', ', l.first_name,
                            CASE WHEN l.middle_name IS NULL OR l.middle_name = '' THEN '' ELSE CONCAT(' ', l.middle_name) END,
                            CASE WHEN l.name_extension IS NULL OR l.name_extension = '' THEN '' ELSE CONCAT(' ', l.name_extension) END
                       ) AS learner_name,
                       l.gender,
                       co.class_id,
                       s.subject_name,
                       qg.quarterly_grade AS grade_value
                FROM enrollments e
                JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
                JOIN (" . $canonicalOfferingsSql . ") co ON co.section_id = e.section_id AND co.school_year_id = e.school_year_id
                JOIN subjects s ON s.subject_id = co.subject_id AND s.is_deleted = 0
                LEFT JOIN (
                    SELECT g1.enrollment_id,
                           c1.section_id,
                           c1.school_year_id,
                           c1.subject_id,
                           g1.quarterly_grade
                    FROM grades g1
                    JOIN class_offerings c1 ON c1.class_id = g1.class_id AND c1.is_deleted = 0
                    JOIN (
                        SELECT g.enrollment_id,
                               c.section_id,
                               c.school_year_id,
                               c.subject_id,
                               g.grading_period_id,
                               MAX(g.grade_id) AS latest_grade_id
                        FROM grades g
                        JOIN class_offerings c ON c.class_id = g.class_id AND c.is_deleted = 0
                        WHERE g.is_deleted = 0
                          AND g.grading_period_id = :gp_pick
                        GROUP BY g.enrollment_id, c.section_id, c.school_year_id, c.subject_id, g.grading_period_id
                    ) pick ON pick.latest_grade_id = g1.grade_id
                ) qg ON qg.enrollment_id = e.enrollment_id
                    AND qg.section_id = co.section_id
                    AND qg.school_year_id = co.school_year_id
                    AND qg.subject_id = co.subject_id
                WHERE e.section_id = :sid
                  AND e.school_year_id = :sy
                  AND e.is_deleted = 0
                  " . $honorsSubjectFilterSql . "
                ORDER BY l.last_name ASC, l.first_name ASC, s.subject_name ASC";
        $stmt = $conn->prepare($sql);
        $stmt->bindValue(':gp_pick', (int)$gradingPeriodId, PDO::PARAM_INT);
        $stmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
        $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } else {
        $expectedPeriods = getExpectedPeriodCount($conn, $schoolYearId);

        $sql = "SELECT e.enrollment_id,
                       l.learner_id,
                       l.lrn,
                       CONCAT(l.last_name, ', ', l.first_name,
                            CASE WHEN l.middle_name IS NULL OR l.middle_name = '' THEN '' ELSE CONCAT(' ', l.middle_name) END,
                            CASE WHEN l.name_extension IS NULL OR l.name_extension = '' THEN '' ELSE CONCAT(' ', l.name_extension) END
                       ) AS learner_name,
                       l.gender,
                       co.class_id,
                       s.subject_name,
                       CASE WHEN gf.cnt = :expected_periods THEN gf.computed_final ELSE NULL END AS grade_value
                FROM enrollments e
                JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
                JOIN (" . $canonicalOfferingsSql . ") co ON co.section_id = e.section_id AND co.school_year_id = e.school_year_id
                JOIN subjects s ON s.subject_id = co.subject_id AND s.is_deleted = 0
                LEFT JOIN (
                    SELECT latest.enrollment_id,
                           latest.section_id,
                           latest.school_year_id,
                           latest.subject_id,
                           ROUND(AVG(latest.quarterly_grade), 2) AS computed_final,
                           COUNT(DISTINCT latest.period_no) AS cnt
                    FROM (
                        SELECT g1.enrollment_id,
                               c1.section_id,
                               c1.school_year_id,
                               c1.subject_id,
                               gp1.period_no,
                               g1.quarterly_grade
                        FROM grades g1
                        JOIN class_offerings c1 ON c1.class_id = g1.class_id AND c1.is_deleted = 0
                        JOIN grading_periods gp1 ON gp1.grading_period_id = g1.grading_period_id AND gp1.is_deleted = 0
                        JOIN (
                            SELECT g.enrollment_id,
                                   c.section_id,
                                   c.school_year_id,
                                   c.subject_id,
                                   g.grading_period_id,
                                   MAX(g.grade_id) AS latest_grade_id
                            FROM grades g
                            JOIN class_offerings c ON c.class_id = g.class_id AND c.is_deleted = 0
                            JOIN grading_periods gp ON gp.grading_period_id = g.grading_period_id
                                                   AND gp.school_year_id = :sy_gp
                                                   AND gp.is_deleted = 0
                            WHERE g.is_deleted = 0
                              AND g.quarterly_grade IS NOT NULL
                            GROUP BY g.enrollment_id, c.section_id, c.school_year_id, c.subject_id, g.grading_period_id
                        ) pick ON pick.latest_grade_id = g1.grade_id
                    ) latest
                    GROUP BY latest.enrollment_id, latest.section_id, latest.school_year_id, latest.subject_id
                ) gf ON gf.enrollment_id = e.enrollment_id
                    AND gf.section_id = co.section_id
                    AND gf.school_year_id = co.school_year_id
                    AND gf.subject_id = co.subject_id
                WHERE e.section_id = :sid
                  AND e.school_year_id = :sy_main
                  AND e.is_deleted = 0
                  " . $honorsSubjectFilterSql . "
                ORDER BY l.last_name ASC, l.first_name ASC, s.subject_name ASC";

        $stmt = $conn->prepare($sql);
        $stmt->bindValue(':expected_periods', $expectedPeriods, PDO::PARAM_INT);
        $stmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
        $stmt->bindValue(':sy_gp', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':sy_main', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    $byEnrollment = [];
    foreach ($rows as $r) {
        $eid = (int)$r['enrollment_id'];
        if (!isset($byEnrollment[$eid])) {
            $byEnrollment[$eid] = [
                'enrollment_id' => $eid,
                'learner_id' => (int)$r['learner_id'],
                'lrn' => $r['lrn'],
                'learner_name' => $r['learner_name'],
                'gender' => $r['gender'],
                'subjects' => [],
                'general_average' => null,
                'honor' => null
            ];
        }
        $byEnrollment[$eid]['subjects'][] = [
            'class_id' => (int)$r['class_id'],

            'subject_name' => $r['subject_name'],
            'grade' => ($r['grade_value'] === null || $r['grade_value'] === '') ? null : (float)$r['grade_value']
        ];
    }

    $honorees = [];

    foreach ($byEnrollment as $eid => $entry) {
        $vals = [];
        $filled = 0;
        foreach ($entry['subjects'] as $sg) {
            if ($sg['grade'] !== null) {
                $vals[] = (float)$sg['grade'];
                $filled++;
            }
        }
        if ($filled !== $subjectCount || !$vals) {
            continue;
        }

        $avg = round(array_sum($vals) / count($vals), 2);
        $entry['general_average'] = $avg;

        $matched = null;
        foreach ($honorLevels as $hl) {
            $min = $hl['min_average'] === null ? null : (float)$hl['min_average'];
            $max = $hl['max_average'] === null ? null : (float)$hl['max_average'];
            if ($min !== null && $avg < $min) continue;
            if ($max !== null && $avg > $max) continue;
            $matched = [
                'honor_level_id' => (int)$hl['honor_level_id'],
                'honor_name' => $hl['honor_name'],
                'min_average' => $min,
                'max_average' => $max
            ];
            break;
        }

        if ($matched) {
            $entry['honor'] = $matched;
            $honorees[] = $entry;
        }
    }

    usort($honorees, fn($a, $b) => ($b['general_average'] ?? 0) <=> ($a['general_average'] ?? 0));
    assignHonorsDenseRanks($honorees);

    $counts = ['total_enrolled' => $totalEnrolled, 'highest' => 0, 'high' => 0, 'honors' => 0];
    foreach ($honorees as $h) {
        $name = strtolower((string)($h['honor']['honor_name'] ?? ''));
        if (str_contains($name, 'highest')) $counts['highest']++;
        else if (str_contains($name, 'high')) $counts['high']++;
        else $counts['honors']++;
    }

    respond([
        'success' => true,
        'data' => [
            'mode' => $mode,
            'section' => $section,
            'subjects' => $subjects,
            'honorees' => $honorees,
            'counts' => $counts
        ]
    ]);
}

function getHonorsListByGradeLevel(PDO $conn, array $session): void {
    $schoolYearId = requireInt($_GET['school_year_id'] ?? null, 'school_year_id');
    $gradeLevelId = requireInt($_GET['grade_level_id'] ?? null, 'grade_level_id');
    $mode = strtolower(trim((string)($_GET['mode'] ?? 'quarter')));
    if (!in_array($mode, ['quarter', 'final'], true)) {
        respond(['success' => false, 'message' => 'Invalid mode'], 422);
    }

    $gradingPeriodId = null;
    if ($mode === 'quarter') {
        $gradingPeriodId = requireInt($_GET['grading_period_id'] ?? null, 'grading_period_id');
        $gp = fetchGradingPeriod($conn, (int)$gradingPeriodId);
        if (!$gp) {
            respond(['success' => false, 'message' => 'Grading period not found'], 404);
        }
        if ((int)$gp['school_year_id'] !== (int)$schoolYearId) {
            respond(['success' => false, 'message' => 'Grading period does not belong to this school year'], 422);
        }
    }

    // Authorization: admin/registrar can access all; teachers must teach
    // at least one subject in this grade level and school year.
    $roleKey = strtolower((string)($session['role_key'] ?? ''));
    if (!auth_is_admin($session) && $roleKey !== 'registrar') {
        $employeeId = getTeacherEmployeeId($conn, (int)$session['user_id']);
        if (!$employeeId) {
            auth_abort(403, 'Teacher profile not found');
        }
        $chk = $conn->prepare(
            'SELECT COUNT(*)
             FROM sections sec
             WHERE sec.is_deleted = 0
               AND sec.school_year_id = :sy
               AND sec.grade_level_id = :gl
               AND EXISTS (
                   SELECT 1
                   FROM class_offerings co
                   WHERE co.is_deleted = 0
                     AND co.section_id = sec.section_id
                     AND co.school_year_id = sec.school_year_id
                     AND co.teacher_id = :teacher_id
               )'
        );
        $chk->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $chk->bindValue(':gl', $gradeLevelId, PDO::PARAM_INT);
        $chk->bindValue(':teacher_id', $employeeId, PDO::PARAM_INT);
        $chk->execute();
        if ((int)$chk->fetchColumn() <= 0) {
            auth_abort(403, 'Not authorized for this year level');
        }
    }

    $teacherSectionsFilter = (!auth_is_admin($session) && $roleKey !== 'registrar')
        ? ' AND EXISTS (
                SELECT 1
                FROM class_offerings co_teacher
                WHERE co_teacher.is_deleted = 0
                  AND co_teacher.section_id = sec.section_id
                  AND co_teacher.school_year_id = sec.school_year_id
                  AND co_teacher.teacher_id = :teacher_id_sections
            )'
        : '';
    $secStmt = $conn->prepare(
        'SELECT sec.section_id, sec.section_name, sec.grade_level_id, gl.grade_name, sec.school_year_id, sy.year_label
         FROM sections sec
         LEFT JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id
         LEFT JOIN school_years sy ON sy.school_year_id = sec.school_year_id
         WHERE sec.is_deleted = 0
           AND sec.school_year_id = :sy
           AND sec.grade_level_id = :gl' . $teacherSectionsFilter . '
         ORDER BY sec.section_name ASC'
    );
    $secStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $secStmt->bindValue(':gl', $gradeLevelId, PDO::PARAM_INT);
    if ($teacherSectionsFilter !== '') {
        $secStmt->bindValue(':teacher_id_sections', $employeeId, PDO::PARAM_INT);
    }
    $secStmt->execute();
    $sections = $secStmt->fetchAll(PDO::FETCH_ASSOC);
    if (!$sections) {
        respond([
            'success' => true,
            'data' => [
                'mode' => $mode,
                'section' => [
                    'section_id' => 0,
                    'section_name' => 'All Sections',
                    'grade_level_id' => $gradeLevelId,
                    'grade_name' => '',
                    'school_year_id' => $schoolYearId,
                    'year_label' => ''
                ],
                'subjects' => [],
                'honorees' => [],
                'counts' => ['total_enrolled' => 0, 'highest' => 0, 'high' => 0, 'honors' => 0]
            ]
        ]);
    }

    $honorStmt = $conn->prepare('SELECT honor_level_id, honor_name, min_average, max_average FROM honor_levels WHERE is_deleted = 0 ORDER BY min_average DESC');
    $honorStmt->execute();
    $honorLevels = $honorStmt->fetchAll(PDO::FETCH_ASSOC);

    $totalEnrolled = countActiveEnrolledInGradeLevel($conn, $schoolYearId, $gradeLevelId);
    $canonicalOfferingsSql = canonicalClassOfferingsSql();
    $curriculumId = fetchPrimaryCurriculumId($conn, $schoolYearId);
    $componentSubjectIds = $curriculumId ? getMapehComponentSubjectIds($conn, (int)$curriculumId, $gradeLevelId) : [];
    $requiredSubjectIds = getRequiredHonorSubjectIds($conn, $curriculumId, $gradeLevelId);
    $honorsSubjectFilterSql = buildHonorsSubjectFilterSql($requiredSubjectIds, $componentSubjectIds);
    $secCountSql =
        'SELECT co.section_id, co.school_year_id, COUNT(*) AS subject_count
         FROM (' . $canonicalOfferingsSql . ') co
         WHERE co.school_year_id = :sy_count
           ' . $honorsSubjectFilterSql . '
         GROUP BY co.section_id, co.school_year_id';

    // Grade values per enrollment per subject (latest active offering per subject).
    if ($mode === 'quarter') {
        $sql =
            'SELECT e.enrollment_id,
                    e.section_id,
                    sec.section_name,
                    l.learner_id,
                    l.lrn,
                    CONCAT(l.last_name, ", ", l.first_name,
                        CASE WHEN l.middle_name IS NULL OR l.middle_name = "" THEN "" ELSE CONCAT(" ", l.middle_name) END,
                        CASE WHEN l.name_extension IS NULL OR l.name_extension = "" THEN "" ELSE CONCAT(" ", l.name_extension) END
                    ) AS learner_name,
                    AVG(qg.quarterly_grade) AS avg_grade,
                    SUM(CASE WHEN qg.quarterly_grade IS NULL THEN 0 ELSE 1 END) AS filled,
                    sc.subject_count AS subject_count
             FROM enrollments e
             JOIN sections sec ON sec.section_id = e.section_id
                              AND sec.is_deleted = 0
                              AND sec.school_year_id = e.school_year_id
                              AND sec.grade_level_id = :gl_sec
             JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
             JOIN (' . $canonicalOfferingsSql . ') co ON co.section_id = e.section_id
                                                      AND co.school_year_id = e.school_year_id
             LEFT JOIN (
                 SELECT g1.enrollment_id,
                        c1.section_id,
                        c1.school_year_id,
                        c1.subject_id,
                        g1.quarterly_grade
                 FROM grades g1
                 JOIN class_offerings c1 ON c1.class_id = g1.class_id AND c1.is_deleted = 0
                 JOIN (
                     SELECT g.enrollment_id,
                            c.section_id,
                            c.school_year_id,
                            c.subject_id,
                            g.grading_period_id,
                            MAX(g.grade_id) AS latest_grade_id
                     FROM grades g
                     JOIN class_offerings c ON c.class_id = g.class_id AND c.is_deleted = 0
                     WHERE g.is_deleted = 0
                       AND g.grading_period_id = :gp
                     GROUP BY g.enrollment_id, c.section_id, c.school_year_id, c.subject_id, g.grading_period_id
                 ) pick ON pick.latest_grade_id = g1.grade_id
             ) qg ON qg.enrollment_id = e.enrollment_id
                 AND qg.section_id = co.section_id
                 AND qg.school_year_id = co.school_year_id
                 AND qg.subject_id = co.subject_id
             JOIN (' . $secCountSql . ') sc ON sc.section_id = e.section_id
                                           AND sc.school_year_id = e.school_year_id
             WHERE e.is_deleted = 0
               AND e.school_year_id = :sy_main
               AND e.grade_level_id = :gl_enroll
               ' . $honorsSubjectFilterSql . '
             GROUP BY e.enrollment_id, e.section_id, sec.section_name, l.learner_id, l.lrn, learner_name, sc.subject_count';

        $stmt = $conn->prepare($sql);
        $stmt->bindValue(':gp', (int)$gradingPeriodId, PDO::PARAM_INT);
        $stmt->bindValue(':gl_sec', $gradeLevelId, PDO::PARAM_INT);
        $stmt->bindValue(':sy_count', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':sy_main', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':gl_enroll', $gradeLevelId, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } else {
        $expectedPeriods = getExpectedPeriodCount($conn, $schoolYearId);

        $sql =
            'SELECT e.enrollment_id,
                    e.section_id,
                    sec.section_name,
                    l.learner_id,
                    l.lrn,
                    CONCAT(l.last_name, ", ", l.first_name,
                        CASE WHEN l.middle_name IS NULL OR l.middle_name = "" THEN "" ELSE CONCAT(" ", l.middle_name) END,
                        CASE WHEN l.name_extension IS NULL OR l.name_extension = "" THEN "" ELSE CONCAT(" ", l.name_extension) END
                    ) AS learner_name,
                    AVG(CASE WHEN gf.cnt = :expected_periods_avg THEN gf.computed_final ELSE NULL END) AS avg_grade,
                    SUM(CASE WHEN (CASE WHEN gf.cnt = :expected_periods_fill THEN gf.computed_final ELSE NULL END) IS NULL THEN 0 ELSE 1 END) AS filled,
                    sc.subject_count AS subject_count
             FROM enrollments e
             JOIN sections sec ON sec.section_id = e.section_id
                              AND sec.is_deleted = 0
                              AND sec.school_year_id = e.school_year_id
                              AND sec.grade_level_id = :gl_sec
             JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
             JOIN (' . $canonicalOfferingsSql . ') co ON co.section_id = e.section_id
                                                      AND co.school_year_id = e.school_year_id
             LEFT JOIN (
                 SELECT latest.enrollment_id,
                        latest.section_id,
                        latest.school_year_id,
                        latest.subject_id,
                        ROUND(AVG(latest.quarterly_grade), 2) AS computed_final,
                        COUNT(DISTINCT latest.period_no) AS cnt
                 FROM (
                     SELECT g1.enrollment_id,
                            c1.section_id,
                            c1.school_year_id,
                            c1.subject_id,
                            gp1.period_no,
                            g1.quarterly_grade
                     FROM grades g1
                     JOIN class_offerings c1 ON c1.class_id = g1.class_id AND c1.is_deleted = 0
                     JOIN grading_periods gp1 ON gp1.grading_period_id = g1.grading_period_id AND gp1.is_deleted = 0
                     JOIN (
                         SELECT g.enrollment_id,
                                c.section_id,
                                c.school_year_id,
                                c.subject_id,
                                g.grading_period_id,
                                MAX(g.grade_id) AS latest_grade_id
                         FROM grades g
                         JOIN class_offerings c ON c.class_id = g.class_id AND c.is_deleted = 0
                         JOIN grading_periods gp ON gp.grading_period_id = g.grading_period_id
                                                AND gp.school_year_id = :sy_gp
                                                AND gp.is_deleted = 0
                         WHERE g.is_deleted = 0
                           AND g.quarterly_grade IS NOT NULL
                         GROUP BY g.enrollment_id, c.section_id, c.school_year_id, c.subject_id, g.grading_period_id
                     ) pick ON pick.latest_grade_id = g1.grade_id
                 ) latest
                 GROUP BY latest.enrollment_id, latest.section_id, latest.school_year_id, latest.subject_id
             ) gf ON gf.enrollment_id = e.enrollment_id
                 AND gf.section_id = co.section_id
                 AND gf.school_year_id = co.school_year_id
                 AND gf.subject_id = co.subject_id
             JOIN (' . $secCountSql . ') sc ON sc.section_id = e.section_id
                                           AND sc.school_year_id = e.school_year_id
             WHERE e.is_deleted = 0
               AND e.school_year_id = :sy_main
               AND e.grade_level_id = :gl_enroll
               ' . $honorsSubjectFilterSql . '
             GROUP BY e.enrollment_id, e.section_id, sec.section_name, l.learner_id, l.lrn, learner_name, sc.subject_count';

        $stmt = $conn->prepare($sql);
        $stmt->bindValue(':expected_periods_avg', $expectedPeriods, PDO::PARAM_INT);
        $stmt->bindValue(':expected_periods_fill', $expectedPeriods, PDO::PARAM_INT);
        $stmt->bindValue(':gl_sec', $gradeLevelId, PDO::PARAM_INT);
        $stmt->bindValue(':sy_gp', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':sy_count', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':sy_main', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':gl_enroll', $gradeLevelId, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    $honorees = [];
    foreach ($rows as $r) {
        $filled = (int)($r['filled'] ?? 0);
        $subjectCount = (int)($r['subject_count'] ?? 0);
        if ($subjectCount <= 0 || $filled !== $subjectCount) {
            continue;
        }

        $avg = ($r['avg_grade'] === null || $r['avg_grade'] === '') ? null : round((float)$r['avg_grade'], 2);
        if ($avg === null) continue;

        $matched = null;
        foreach ($honorLevels as $hl) {
            $min = $hl['min_average'] === null ? null : (float)$hl['min_average'];
            $max = $hl['max_average'] === null ? null : (float)$hl['max_average'];
            if ($min !== null && $avg < $min) continue;
            if ($max !== null && $avg > $max) continue;
            $matched = [
                'honor_level_id' => (int)$hl['honor_level_id'],
                'honor_name' => $hl['honor_name'],
                'min_average' => $min,
                'max_average' => $max
            ];
            break;
        }

        if (!$matched) continue;

        $honorees[] = [
            'enrollment_id' => (int)$r['enrollment_id'],
            'learner_id' => (int)$r['learner_id'],
            'section_id' => (int)$r['section_id'],
            'section_name' => $r['section_name'] ?? '',
            'lrn' => $r['lrn'],
            'learner_name' => $r['learner_name'],
            'general_average' => $avg,
            'honor' => $matched
        ];
    }

    usort($honorees, fn($a, $b) => ($b['general_average'] ?? 0) <=> ($a['general_average'] ?? 0));
    assignHonorsDenseRanks($honorees);

    $counts = ['total_enrolled' => $totalEnrolled, 'highest' => 0, 'high' => 0, 'honors' => 0];
    foreach ($honorees as $h) {
        $name = strtolower((string)($h['honor']['honor_name'] ?? ''));
        if (str_contains($name, 'highest')) $counts['highest']++;
        else if (str_contains($name, 'high')) $counts['high']++;
        else $counts['honors']++;
    }

    // Use the grade name and SY label from any section row.
    $any = $sections[0];
    $sectionMeta = [
        'section_id' => 0,
        'section_name' => 'All Sections',
        'grade_level_id' => (int)$any['grade_level_id'],
        'grade_name' => $any['grade_name'],
        'school_year_id' => (int)$any['school_year_id'],
        'year_label' => $any['year_label']
    ];

    respond([
        'success' => true,
        'data' => [
            'mode' => $mode,
            'section' => $sectionMeta,
            'subjects' => [],
            'honorees' => $honorees,
            'counts' => $counts
        ]
    ]);
}
?>
