<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';
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

function requireEmployeeIsTeacher(PDO $conn, int $employeeId): void {
    $stmt = $conn->prepare(
        'SELECT r.role_name FROM employees e
         JOIN (' . user_identity_derived_sql() . ') u ON u.user_id = e.user_id AND u.is_deleted = 0
         JOIN roles r ON r.role_id = u.role_id AND r.is_deleted = 0
         WHERE e.employee_id = :eid AND e.is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':eid', $employeeId, PDO::PARAM_INT);
    $stmt->execute();
    $roleName = $stmt->fetchColumn();
    if ($roleName === false || !str_contains(strtolower((string)$roleName), 'teacher')) {
        respond(['success' => false, 'message' => 'Assigned teacher must be an employee with a teacher role'], 422);
    }
}

function getCurriculumIdForSchoolYear(PDO $conn, int $schoolYearId = 0): int {
    return (int)(app_integrity_get_curriculum_id_for_school_year($conn, $schoolYearId) ?? 0);
}

function decorateClassOfferingRows(PDO $conn, array $rows): array {
    foreach ($rows as &$row) {
        $policy = GradingPolicyService::resolve(
            $conn,
            (int)($row['school_year_id'] ?? 0),
            (int)($row['grade_level_id'] ?? 0),
            $row['grade_name'] ?? null
        );
        $row['grading_mode'] = $policy['grading_mode'];
        $row['sf9_template_variant'] = $policy['sf9_template_variant'];
        $row['supports_pace'] = strtolower((string)$policy['grading_mode']) === 'descriptive'
            && strtoupper((string)$policy['sf9_template_variant']) === 'G1';
    }
    unset($row);
    return $rows;
}

function getSectionContext(PDO $conn, int $sectionId): array {
    $stmt = $conn->prepare(
        'SELECT section_id, grade_level_id, school_year_id
         FROM sections
         WHERE section_id = :section_id AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: [];
}

function getCurriculumSubjectsForGrade(PDO $conn, int $curriculumId, int $gradeLevelId): array {
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

function normalizeMapehToken(?string $value): string {
    return strtoupper(trim((string)$value));
}

function isMapehComponentName(?string $subjectName): bool {
    $name = strtolower(trim((string)$subjectName));
    if ($name === '') return false;
    if (str_contains($name, 'mapeh') && str_contains($name, 'component')) return true;
    if (str_contains($name, 'mapeh')) return false;

    return (bool)(
        preg_match('/\b(music|arts|physical education|health|pe|p\.e\.)\b/i', $name)
        || preg_match('/\bmusic\s*(and|&)\s*arts?\b/i', $name)
        || preg_match('/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/i', $name)
    );
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

    $where = $mode === 'classic'
        ? implode(' OR ', array_fill(0, count($patterns), 'subject_name = ?'))
        : implode(' OR ', array_fill(0, count($patterns), 'subject_name LIKE ?'));

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
    $rows = getCurriculumSubjectsForGrade($conn, $curriculumId, $gradeLevelId);
    $componentIds = [];
    foreach ($rows as $row) {
        // Name fallback is needed for curricula that store the component rows
        // without a learning-area/code marker and without a parent row.
        if (isMapehComponentRow($row, true)) {
            $componentIds[] = (int)$row['subject_id'];
        }
    }
    $componentIds = array_values(array_unique(array_filter($componentIds, fn($id) => $id > 0)));
    if ($componentIds) {
        return $componentIds;
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

function findMapehParentSubjectId(PDO $conn): int {
    $stmt = $conn->query(
        "SELECT subject_id
         FROM subjects
         WHERE is_deleted = 0
           AND UPPER(TRIM(subject_name)) = 'MUSIC, ARTS, PHYSICAL EDUCATION AND HEALTH (MAPEH)'
         ORDER BY subject_id ASC
         LIMIT 1"
    );
    $exact = (int)($stmt->fetchColumn() ?: 0);
    if ($exact > 0) return $exact;

    $fallback = $conn->query(
        "SELECT subject_id
         FROM subjects
         WHERE is_deleted = 0
           AND UPPER(subject_name) LIKE '%MAPEH%'
           AND UPPER(subject_name) NOT LIKE '%COMPONENT%'
         ORDER BY subject_id ASC
         LIMIT 1"
    );
    return (int)($fallback->fetchColumn() ?: 0);
}

function getMapehClusterSubjectId(PDO $conn, int $curriculumId, int $gradeLevelId): int {
    $rows = getCurriculumSubjectsForGrade($conn, $curriculumId, $gradeLevelId);
    $hasComponents = false;
    foreach ($rows as $row) {
        if (isMapehClusterRow($row)) {
            return (int)$row['subject_id'];
        }
        if (isMapehComponentRow($row, true)) {
            $hasComponents = true;
        }
    }
    if ($hasComponents) {
        return findMapehParentSubjectId($conn);
    }
    return 0;
}

function isSubjectAllowedForSection(PDO $conn, int $subjectId, int $sectionId, int $schoolYearId): bool {
    $section = getSectionContext($conn, $sectionId);
    $gradeLevelId = (int)($section['grade_level_id'] ?? 0);
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    if ($gradeLevelId <= 0 || $curriculumId <= 0) return false;

    foreach (getCurriculumSubjectsForGrade($conn, $curriculumId, $gradeLevelId) as $row) {
        if ((int)$row['subject_id'] === $subjectId) return true;
    }
    if (in_array($subjectId, getMapehComponentSubjectIds($conn, $curriculumId, $gradeLevelId), true)) {
        return true;
    }
    $clusterSubjectId = getMapehClusterSubjectId($conn, $curriculumId, $gradeLevelId);
    // A parent MAPEH offering is valid only when the curriculum explicitly
    // assigns that parent subject to this grade.  Some curricula store only
    // the four MAPEH components; the parent lookup is still useful for
    // synchronizing those components, but must not expand the curriculum's
    // allowed subject set.
    $curriculumSubjectIds = array_map(
        static fn(array $row): int => (int)($row['subject_id'] ?? 0),
        getCurriculumSubjectsForGrade($conn, $curriculumId, $gradeLevelId)
    );
    if ($clusterSubjectId > 0 && $subjectId === $clusterSubjectId
        && in_array($clusterSubjectId, $curriculumSubjectIds, true)
        && getMapehComponentSubjectIds($conn, $curriculumId, $gradeLevelId)) {
        return true;
    }
    return false;
}

function getOrCreateMapehComponentOffering(PDO $conn, int $componentSubjectId, int $sectionId, int $schoolYearId, int $teacherId): void {
    // If a component offering already exists (any teacher), update it to the cluster teacher and restore if deleted.
    $stmt = $conn->prepare(
        'SELECT class_id, is_deleted FROM class_offerings
         WHERE subject_id = :subject_id
           AND section_id = :section_id
           AND school_year_id = :school_year_id
         ORDER BY (teacher_id = :teacher_id) DESC, is_deleted ASC, class_id DESC
         LIMIT 1'
    );
    $stmt->bindValue(':subject_id', $componentSubjectId, PDO::PARAM_INT);
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
    $stmt->execute();
    $existing = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($existing) {
        $restore = $conn->prepare(
            'UPDATE class_offerings
             SET teacher_id = :teacher_id, is_deleted = 0, deleted_at = NULL
             WHERE class_id = :class_id'
        );
        $restore->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
        $restore->bindValue(':class_id', (int)$existing['class_id'], PDO::PARAM_INT);
        $restore->execute();
        app_integrity_sync_schedule_teacher($conn, (int)$existing['class_id'], $teacherId);
    } else {
        $insert = $conn->prepare(
            'INSERT INTO class_offerings (subject_id, section_id, teacher_id, school_year_id)
             VALUES (:subject_id, :section_id, :teacher_id, :school_year_id)'
        );
        $insert->bindValue(':subject_id', $componentSubjectId, PDO::PARAM_INT);
        $insert->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
        $insert->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
        $insert->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $insert->execute();
    }
}

function syncMapehComponentOfferings(PDO $conn, int $sectionId, int $schoolYearId, int $teacherId): void {
    $startedTransaction = false;
    if (!$conn->inTransaction()) {
        $conn->beginTransaction();
        $startedTransaction = true;
    }
    try {
        $section = getSectionContext($conn, $sectionId);
        $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
        $componentIds = getMapehComponentSubjectIds($conn, $curriculumId, (int)($section['grade_level_id'] ?? 0));
        foreach ($componentIds as $componentSubjectId) {
            getOrCreateMapehComponentOffering($conn, $componentSubjectId, $sectionId, $schoolYearId, $teacherId);
        }
        if ($startedTransaction) $conn->commit();
    } catch (Throwable $e) {
        if ($startedTransaction && $conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
}

function syncMapehComponentOfferingsForActiveClusters(PDO $conn, ?int $teacherId = null): void {
    $sql = "SELECT co.subject_id, co.section_id, co.school_year_id, co.teacher_id, sec.grade_level_id
            FROM class_offerings co
            JOIN sections sec ON sec.section_id = co.section_id AND sec.is_deleted = 0
            WHERE co.is_deleted = 0
              AND co.teacher_id > 0";
    if ($teacherId !== null && $teacherId > 0) {
        $sql .= " AND co.teacher_id = :teacher_id";
    }

    $stmt = $conn->prepare($sql);
    if ($teacherId !== null && $teacherId > 0) {
        $stmt->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
    }
    $stmt->execute();

    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $curriculumId = getCurriculumIdForSchoolYear($conn, (int)($row['school_year_id'] ?? 0));
        $clusterSubjectId = getMapehClusterSubjectId($conn, $curriculumId, (int)($row['grade_level_id'] ?? 0));
        if ($clusterSubjectId <= 0 || (int)($row['subject_id'] ?? 0) !== $clusterSubjectId) {
            continue;
        }
        syncMapehComponentOfferings(
            $conn,
            (int)($row['section_id'] ?? 0),
            (int)($row['school_year_id'] ?? 0),
            (int)($row['teacher_id'] ?? 0)
        );
    }
}

function syncMapehComponentsForSection(PDO $conn): void {
    $data = getJsonInput();
    $sectionId = (int)($data['section_id'] ?? 0);
    $schoolYearId = (int)($data['school_year_id'] ?? 0);
    if ($sectionId <= 0 || $schoolYearId <= 0) {
        respond(['success' => false, 'message' => 'section_id and school_year_id are required'], 422);
    }

    $section = getSectionContext($conn, $sectionId);
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    $clusterSubjectId = getMapehClusterSubjectId($conn, $curriculumId, (int)($section['grade_level_id'] ?? 0));
    if ($clusterSubjectId <= 0) {
        respond(['success' => true, 'message' => 'No MAPEH subject is assigned to this section grade']);
    }

    $stmt = $conn->prepare(
        'SELECT teacher_id
         FROM class_offerings
         WHERE section_id = :section_id
           AND school_year_id = :school_year_id
           AND subject_id = :subject_id
           AND is_deleted = 0
         ORDER BY class_id DESC
         LIMIT 1'
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':subject_id', $clusterSubjectId, PDO::PARAM_INT);
    $stmt->execute();
    $teacherId = (int)($stmt->fetchColumn() ?: 0);
    if ($teacherId <= 0) {
        respond(['success' => true, 'message' => 'MAPEH has no active teacher to sync']);
    }

    syncMapehComponentOfferings($conn, $sectionId, $schoolYearId, $teacherId);
    respond(['success' => true, 'message' => 'MAPEH components synced']);
}

function deleteMapehComponentOfferings(PDO $conn, int $sectionId, int $schoolYearId): void {
    $section = getSectionContext($conn, $sectionId);
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    $componentIds = getMapehComponentSubjectIds($conn, $curriculumId, (int)($section['grade_level_id'] ?? 0));
    if (!$componentIds) return;
    $stmt = $conn->prepare(
        'UPDATE class_offerings
         SET is_deleted = 1, deleted_at = NOW()
         WHERE section_id = :section_id
           AND school_year_id = :school_year_id
           AND subject_id IN (' . implode(',', $componentIds) . ')
           AND is_deleted = 0'
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
}

function getMapehComponentClassIds(PDO $conn, int $sectionId, int $schoolYearId): array {
    $section = getSectionContext($conn, $sectionId);
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    $componentIds = getMapehComponentSubjectIds($conn, $curriculumId, (int)($section['grade_level_id'] ?? 0));
    if (!$componentIds) return [];
    $stmt = $conn->prepare(
        'SELECT class_id FROM class_offerings
         WHERE section_id = :section_id
           AND school_year_id = :school_year_id
           AND subject_id IN (' . implode(',', $componentIds) . ')'
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
}

function isMapehComponentOffering(PDO $conn, int $subjectId, int $sectionId, int $schoolYearId): bool {
    $section = getSectionContext($conn, $sectionId);
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    $componentIds = getMapehComponentSubjectIds($conn, $curriculumId, (int)($section['grade_level_id'] ?? 0));
    return in_array($subjectId, $componentIds, true);
}

function hasActiveMapehClusterOffering(PDO $conn, int $sectionId, int $schoolYearId): bool {
    $section = getSectionContext($conn, $sectionId);
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    $clusterSubjectId = getMapehClusterSubjectId($conn, $curriculumId, (int)($section['grade_level_id'] ?? 0));
    if ($clusterSubjectId <= 0) return false;
    $stmt = $conn->prepare(
        'SELECT 1
         FROM class_offerings
         WHERE section_id = :section_id
           AND school_year_id = :school_year_id
           AND subject_id = :subject_id
           AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':subject_id', $clusterSubjectId, PDO::PARAM_INT);
    $stmt->execute();
    return (bool)$stmt->fetchColumn();
}

$operation = $_GET['operation'] ?? '';
$session = auth_enforce_roles($operation, ['admin', 'teacher'], ['admin']);
try {
    switch ($operation) {
        case 'getAllClassOfferings': getAllClassOfferings($conn, $session); break;
        case 'getClassOfferingsByContext': getClassOfferingsByContext($conn, $session); break;
        case 'getClassOfferingRoster': getClassOfferingRoster($conn, $session); break;
        case 'createClassOffering': createClassOffering($conn); break;
        case 'updateClassOffering': updateClassOffering($conn); break;
        case 'deleteClassOffering': deleteClassOffering($conn); break;
        case 'syncMapehComponents': syncMapehComponentsForSection($conn); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (ApplicationIntegrityException $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    respond(['success' => false, 'message' => $e->getMessage()], $e->getCode());
} catch (Exception $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllClassOfferings(PDO $conn, array $session): void {
    $includeDeleted = (int)($_GET['include_deleted'] ?? 0) === 1;

    $isTeacher = (($session['role_key'] ?? '') === 'teacher');
    $employeeId = $isTeacher ? getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0)) : 0;

    // Teachers can only see their own class offerings.
    if ($isTeacher) {
        $includeDeleted = false;
    }

    // Teacher reads must remain read-only. Administrators retain the existing
    // MAPEH component synchronization during their management load.
    if (!$isTeacher) {
        syncMapehComponentOfferingsForActiveClusters($conn, null);
    }

        $sql = "SELECT c.class_id, c.subject_id, s.subject_name, c.section_id, sec.section_name,
                   sec.grade_level_id, gl.grade_name, sec.adviser_id,
                   TRIM(CONCAT_WS(' ', NULLIF(adviser.first_name, ''), NULLIF(adviser.middle_name, ''),
                       NULLIF(adviser.last_name, ''), NULLIF(adviser.name_extension, ''))) AS adviser_name,
                   c.teacher_id, CONCAT(e.last_name, ', ', e.first_name) AS teacher_name,
                   c.school_year_id, sy.year_label, sy.year_start, sy.year_end,
                     c.is_deleted, c.deleted_at
            FROM class_offerings c
            LEFT JOIN subjects s ON c.subject_id = s.subject_id
            LEFT JOIN sections sec ON c.section_id = sec.section_id
            LEFT JOIN grade_levels gl ON sec.grade_level_id = gl.grade_level_id
            LEFT JOIN employees adviser ON sec.adviser_id = adviser.employee_id AND adviser.is_deleted = 0
            LEFT JOIN employees e ON c.teacher_id = e.employee_id
            LEFT JOIN school_years sy ON c.school_year_id = sy.school_year_id
            WHERE " . ($includeDeleted ? '1=1' : 'c.is_deleted = 0') .
            ($isTeacher ? " AND c.teacher_id = :teacher_id" : "") .
            "
            ORDER BY c.class_id DESC";
    $stmt = $conn->prepare($sql);
    if ($isTeacher) {
        $stmt->bindValue(':teacher_id', $employeeId, PDO::PARAM_INT);
    }
    $stmt->execute();
    respond(decorateClassOfferingRows($conn, $stmt->fetchAll(PDO::FETCH_ASSOC)));
}

function getClassOfferingsByContext(PDO $conn, array $session): void {
    $sectionId = (int)($_GET['section_id'] ?? 0);
    $teacherId = (int)($_GET['teacher_id'] ?? 0);
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    if ($sectionId <= 0 || $teacherId <= 0 || $schoolYearId <= 0) {
        respond(['success' => false, 'message' => 'section_id, teacher_id, and school_year_id are required'], 422);
    }

    if (($session['role_key'] ?? '') === 'teacher') {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        if ($teacherId !== $employeeId) {
            respond(['success' => false, 'message' => 'Not authorized to view other teachers\' class offerings'], 403);
        }
    }

    $sql = "SELECT c.class_id, c.subject_id, s.subject_name,
                   c.section_id, sec.section_name, sec.grade_level_id, gl.grade_name, sec.adviser_id,
                   TRIM(CONCAT_WS(' ', NULLIF(adviser.first_name, ''), NULLIF(adviser.middle_name, ''),
                       NULLIF(adviser.last_name, ''), NULLIF(adviser.name_extension, ''))) AS adviser_name,
                   c.teacher_id, CONCAT(e.last_name, ', ', e.first_name) AS teacher_name,
                                     c.school_year_id, sy.year_label
            FROM class_offerings c
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN sections sec ON c.section_id = sec.section_id
            LEFT JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id
            LEFT JOIN employees adviser ON sec.adviser_id = adviser.employee_id AND adviser.is_deleted = 0
            JOIN employees e ON c.teacher_id = e.employee_id
            JOIN school_years sy ON c.school_year_id = sy.school_year_id
            WHERE c.is_deleted = 0
              AND c.section_id = :section_id
              AND c.teacher_id = :teacher_id
                            AND c.school_year_id = :school_year_id
                        ORDER BY s.subject_name ASC, c.class_id DESC";

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    respond(decorateClassOfferingRows($conn, $stmt->fetchAll(PDO::FETCH_ASSOC)));
}

function getClassOfferingRoster(PDO $conn, array $session): void {
    $classId = (int)($_GET['class_id'] ?? 0);
    if ($classId <= 0) {
        respond(['success' => false, 'message' => 'class_id is required'], 422);
    }

    $stmt = $conn->prepare(
        "SELECT c.class_id, c.subject_id, s.subject_name,
                c.section_id, sec.section_name, sec.grade_level_id, gl.grade_name, sec.adviser_id,
                TRIM(CONCAT_WS(' ', NULLIF(adviser.first_name, ''), NULLIF(adviser.middle_name, ''),
                    NULLIF(adviser.last_name, ''), NULLIF(adviser.name_extension, ''))) AS adviser_name,
                c.teacher_id, CONCAT(e.last_name, ', ', e.first_name) AS teacher_name,
                c.school_year_id, sy.year_label,
                c.is_deleted
         FROM class_offerings c
         LEFT JOIN subjects s ON c.subject_id = s.subject_id
         LEFT JOIN sections sec ON c.section_id = sec.section_id
         LEFT JOIN grade_levels gl ON gl.grade_level_id = sec.grade_level_id
         LEFT JOIN employees adviser ON sec.adviser_id = adviser.employee_id AND adviser.is_deleted = 0
         LEFT JOIN employees e ON c.teacher_id = e.employee_id
         LEFT JOIN school_years sy ON c.school_year_id = sy.school_year_id
         WHERE c.class_id = :class_id
         LIMIT 1"
    );
    $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $stmt->execute();
    $offering = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$offering) {
        respond(['success' => false, 'message' => 'Class offering not found'], 404);
    }

    // Teachers can only view rosters for their own offerings.
    if (($session['role_key'] ?? '') === 'teacher') {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        if ((int)($offering['teacher_id'] ?? 0) !== $employeeId) {
            respond(['success' => false, 'message' => 'Not authorized to view this class offering roster'], 403);
        }
    }

    $offering = decorateClassOfferingRows($conn, [$offering])[0];
    $sectionId = (int)($offering['section_id'] ?? 0);
    $schoolYearId = (int)($offering['school_year_id'] ?? 0);
    if ($sectionId <= 0 || $schoolYearId <= 0) {
        respond(['success' => true, 'offering' => $offering, 'roster' => []]);
    }

    $rosterStmt = $conn->prepare(
        "SELECT e.enrollment_id,
                e.learner_id,
                l.lrn,
                CONCAT(l.last_name, ', ', l.first_name) AS learner_name,
                l.gender,
                e.enrollment_status
         FROM enrollments e
         JOIN learners l ON e.learner_id = l.learner_id
         WHERE e.is_deleted = 0
           AND e.section_id = :section_id
           AND e.school_year_id = :school_year_id
         ORDER BY l.last_name, l.first_name, e.enrollment_id DESC"
    );
    $rosterStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $rosterStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $rosterStmt->execute();
    $roster = $rosterStmt->fetchAll(PDO::FETCH_ASSOC);

    respond([
        'success' => true,
        'offering' => $offering,
        'roster' => $roster,
    ]);
}

function classOfferingHasDependencies(PDO $conn, int $classId): bool {
    $checks = [
        ['table' => 'grades', 'where' => 'class_id = :class_id AND is_deleted = 0'],
        ['table' => 'final_grades', 'where' => 'class_id = :class_id AND is_deleted = 0'],
        ['table' => 'class_schedules', 'where' => 'class_id = :class_id AND is_deleted = 0'],
    ];

    foreach ($checks as $c) {
        $stmt = $conn->prepare('SELECT COUNT(*) FROM ' . $c['table'] . ' WHERE ' . $c['where'] . ' LIMIT 1');
        $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
        $stmt->execute();
        if ((int)$stmt->fetchColumn() > 0) {
            return true;
        }
    }
    return false;
}

function createClassOffering(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['subject_id']) || empty($data['section_id']) || empty($data['teacher_id']) || empty($data['school_year_id'])) {
        respond(['success' => false, 'message' => 'Subject, section, teacher, and school year are required'], 422);
    }

    $subjectId = (int)$data['subject_id'];
    $sectionId = (int)$data['section_id'];
    $schoolYearId = (int)$data['school_year_id'];
    $teacherId = (int)$data['teacher_id'];

    requireEmployeeIsTeacher($conn, $teacherId);

    // Validate: section must belong to the same school year as the class offering.
    $check = $conn->prepare('SELECT school_year_id FROM sections WHERE section_id = :section_id AND is_deleted = 0');
    $check->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $check->execute();
    $secSy = $check->fetchColumn();
    if (!$secSy) {
        respond(['success' => false, 'message' => 'Invalid section_id'], 422);
    }
    if ((int)$secSy !== $schoolYearId) {
        respond(['success' => false, 'message' => 'school_year_id must match the section\'s school_year_id'], 422);
    }
    if (!isSubjectAllowedForSection($conn, $subjectId, $sectionId, $schoolYearId)) {
        respond(['success' => false, 'message' => 'Subject is not part of this section\'s curriculum and grade level'], 422);
    }

    $conn->beginTransaction();
    try {
        $classId = upsertClassOffering($conn, $subjectId, $sectionId, $schoolYearId, $teacherId);

        $section = getSectionContext($conn, $sectionId);
        $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
        if ($subjectId === getMapehClusterSubjectId($conn, $curriculumId, (int)($section['grade_level_id'] ?? 0))) {
            syncMapehComponentOfferings($conn, $sectionId, $schoolYearId, $teacherId);
        }
        $conn->commit();
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }

    respond(['success' => true, 'message' => 'Class offering created', 'class_id' => $classId]);
}

function upsertClassOffering(PDO $conn, int $subjectId, int $sectionId, int $schoolYearId, int $teacherId): int {
    $dup = $conn->prepare(
        'SELECT class_id, is_deleted
         FROM class_offerings
         WHERE subject_id = :subject_id
           AND section_id = :section_id
           AND school_year_id = :school_year_id
         ORDER BY is_deleted ASC, class_id DESC
         LIMIT 1'
    );
    $dup->bindValue(':subject_id', $subjectId, PDO::PARAM_INT);
    $dup->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $dup->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $dup->execute();
    $existing = $dup->fetch(PDO::FETCH_ASSOC);

    if ($existing) {
        $existingId = (int)($existing['class_id'] ?? 0);
        $restore = $conn->prepare('UPDATE class_offerings
                                   SET is_deleted = 0, deleted_at = NULL, teacher_id = :teacher_id
                                   WHERE class_id = :class_id');
        $restore->bindValue(':class_id', $existingId, PDO::PARAM_INT);
        $restore->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
        $restore->execute();
        app_integrity_sync_schedule_teacher($conn, $existingId, $teacherId);
        return $existingId;
    }

    $stmt = $conn->prepare('INSERT INTO class_offerings (subject_id, section_id, teacher_id, school_year_id) VALUES (:subject_id, :section_id, :teacher_id, :school_year_id)');
    $stmt->bindValue(':subject_id', $subjectId, PDO::PARAM_INT);
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    try {
        $stmt->execute();
        return (int)$conn->lastInsertId();
    } catch (PDOException $e) {
        // Race condition fallback if UNIQUE KEY uq_class_offering is hit.
        if ($e->getCode() === '23000') {
            $dup->execute();
            $existing = $dup->fetch(PDO::FETCH_ASSOC);
            if ($existing) {
                $existingId = (int)($existing['class_id'] ?? 0);
                $restore = $conn->prepare('UPDATE class_offerings
                                           SET is_deleted = 0, deleted_at = NULL, teacher_id = :teacher_id
                                           WHERE class_id = :class_id');
                $restore->bindValue(':class_id', $existingId, PDO::PARAM_INT);
                $restore->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
                $restore->execute();
                app_integrity_sync_schedule_teacher($conn, $existingId, $teacherId);
                return $existingId;
            }
        }
        throw $e;
    }
}

function updateClassOffering(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['class_id']) || empty($data['subject_id']) || empty($data['section_id']) || empty($data['teacher_id']) || empty($data['school_year_id'])) {
        respond(['success' => false, 'message' => 'Class ID, subject, section, teacher, and school year are required'], 422);
    }

    requireEmployeeIsTeacher($conn, (int)$data['teacher_id']);

    $check = $conn->prepare('SELECT school_year_id FROM sections WHERE section_id = :section_id AND is_deleted = 0');
    $check->bindValue(':section_id', (int)$data['section_id'], PDO::PARAM_INT);
    $check->execute();
    $secSy = $check->fetchColumn();
    if (!$secSy) {
        respond(['success' => false, 'message' => 'Invalid section_id'], 422);
    }
    if ((int)$secSy !== (int)$data['school_year_id']) {
        respond(['success' => false, 'message' => 'school_year_id must match the section\'s school_year_id'], 422);
    }

        // Prevent exact duplicates when updating (same subject + section + school year + teacher)
    $dup = $conn->prepare(
        'SELECT class_id
         FROM class_offerings
         WHERE subject_id = :subject_id
           AND section_id = :section_id
           AND school_year_id = :school_year_id
           AND teacher_id = :teacher_id
           AND is_deleted = 0
           AND class_id <> :class_id
         LIMIT 1'
    );
    $dup->bindValue(':subject_id', (int)$data['subject_id'], PDO::PARAM_INT);
    $dup->bindValue(':section_id', (int)$data['section_id'], PDO::PARAM_INT);
    $dup->bindValue(':school_year_id', (int)$data['school_year_id'], PDO::PARAM_INT);
    $dup->bindValue(':teacher_id', (int)$data['teacher_id'], PDO::PARAM_INT);
    $dup->bindValue(':class_id', (int)$data['class_id'], PDO::PARAM_INT);
    $dup->execute();
    $existingId = $dup->fetchColumn();
    if ($existingId) {
        respond(['success' => false, 'message' => 'Another identical class offering already exists'], 409);
    }

    $subjectId = (int)$data['subject_id'];
    $sectionId = (int)$data['section_id'];
    $schoolYearId = (int)$data['school_year_id'];
    $teacherId = (int)$data['teacher_id'];
    if (!isSubjectAllowedForSection($conn, $subjectId, $sectionId, $schoolYearId)) {
        respond(['success' => false, 'message' => 'Subject is not part of this section\'s curriculum and grade level'], 422);
    }

    $conn->beginTransaction();
    $existingClassStmt = $conn->prepare('SELECT class_id FROM class_offerings WHERE class_id = :class_id AND is_deleted = 0 LIMIT 1');
    $existingClassStmt->bindValue(':class_id', (int)$data['class_id'], PDO::PARAM_INT);
    $existingClassStmt->execute();
    if ($existingClassStmt->fetchColumn() === false) {
        $conn->rollBack();
        respond(['success' => false, 'message' => 'Class offering not found'], 404);
    }

    $stmt = $conn->prepare('UPDATE class_offerings SET subject_id = :subject_id, section_id = :section_id, teacher_id = :teacher_id, school_year_id = :school_year_id WHERE class_id = :class_id');
    $stmt->bindValue(':subject_id', $subjectId, PDO::PARAM_INT);
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':class_id', $data['class_id'], PDO::PARAM_INT);
    try {
        $stmt->execute();
    } catch (PDOException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        if ($e->getCode() === '23000') {
            respond(['success' => false, 'message' => 'Another identical class offering already exists'], 409);
        }
        throw $e;
    }
    // Keep existing schedule rows aligned with the current offering
    // assignment. This also re-checks teacher conflicts after reassignment.
    app_integrity_sync_schedule_teacher($conn, (int)$data['class_id'], $teacherId);

    $section = getSectionContext($conn, $sectionId);
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    if ($subjectId === getMapehClusterSubjectId($conn, $curriculumId, (int)($section['grade_level_id'] ?? 0))) {
        syncMapehComponentOfferings($conn, $sectionId, $schoolYearId, $teacherId);
    }

    $conn->commit();
    respond(['success' => true, 'message' => 'Class offering updated']);
}

function deleteClassOffering(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['class_id'])) {
        respond(['success' => false, 'message' => 'Class ID is required'], 422);
    }
    $classId = (int)$data['class_id'];

    $metaStmt = $conn->prepare('SELECT subject_id, section_id, school_year_id FROM class_offerings WHERE class_id = :class_id AND is_deleted = 0 LIMIT 1');
    $metaStmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $metaStmt->execute();
    $meta = $metaStmt->fetch(PDO::FETCH_ASSOC);
    $subjectId = (int)($meta['subject_id'] ?? 0);
    $sectionId = (int)($meta['section_id'] ?? 0);
    $schoolYearId = (int)($meta['school_year_id'] ?? 0);
    $section = getSectionContext($conn, $sectionId);
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    $clusterSubjectId = getMapehClusterSubjectId($conn, $curriculumId, (int)($section['grade_level_id'] ?? 0));
    $isComponent = isMapehComponentOffering($conn, $subjectId, $sectionId, $schoolYearId);
    $isPlaceholderClusterDelete = (int)($data['mapeh_parent_subject_id'] ?? 0) > 0
        && (int)($data['mapeh_parent_subject_id'] ?? 0) === $clusterSubjectId
        && $isComponent;

    if ($isComponent && hasActiveMapehClusterOffering($conn, $sectionId, $schoolYearId) && !$isPlaceholderClusterDelete) {
        respond(['success' => true, 'message' => 'MAPEH components are managed by the MAPEH parent offering']);
    }

    if (classOfferingHasDependencies($conn, $classId)) {
        respond(['success' => false, 'message' => 'Cannot remove this class offering because it already has related records (grades/final grades/schedules).'], 409);
    }

    // For MAPEH cluster deletes, block if any component has dependencies to avoid orphaning grades.
    if (($subjectId === $clusterSubjectId || $isPlaceholderClusterDelete) && $sectionId > 0 && $schoolYearId > 0) {
        foreach (getMapehComponentClassIds($conn, $sectionId, $schoolYearId) as $componentClassId) {
            if (classOfferingHasDependencies($conn, $componentClassId)) {
                respond(['success' => false, 'message' => 'Cannot remove MAPEH because one of its components already has grades/final grades/schedules.'], 409);
            }
        }
    }

    if ($isPlaceholderClusterDelete) {
        $componentIds = getMapehComponentSubjectIds($conn, $curriculumId, (int)($section['grade_level_id'] ?? 0));
        $subjectIds = array_values(array_unique(array_merge([$clusterSubjectId], $componentIds)));
        $stmt = $conn->prepare(
            'UPDATE class_offerings
             SET is_deleted = 1, deleted_at = NOW()
             WHERE section_id = :section_id
               AND school_year_id = :school_year_id
               AND subject_id IN (' . implode(',', $subjectIds) . ')
               AND is_deleted = 0'
        );
        $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        respond(['success' => true, 'message' => 'MAPEH class offerings deleted']);
    }

    $stmt = $conn->prepare('UPDATE class_offerings SET is_deleted = 1, deleted_at = NOW() WHERE class_id = :class_id');
    $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $stmt->execute();

    // If deleting the MAPEH cluster, also soft-delete its component offerings.
    if ($subjectId === $clusterSubjectId && $sectionId > 0 && $schoolYearId > 0) {
        deleteMapehComponentOfferings($conn, $sectionId, $schoolYearId);
    }

    respond(['success' => true, 'message' => 'Class offering deleted']);
}

?>
