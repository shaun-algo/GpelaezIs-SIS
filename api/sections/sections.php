<?php
header('Content-Type: application/json');
require_once __DIR__ . '/../utils/cors.php';

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';
require_once __DIR__ . '/../utils/audit.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
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

function normalizeSectionLookupText(?string $value): string {
    $s = strtolower(trim((string)($value ?? '')));
    $s = preg_replace('/[^a-z0-9]+/', ' ', $s);
    $s = preg_replace('/\s+/', ' ', (string)$s);
    return trim((string)$s);
}

function requireUniqueSectionName(PDO $conn, string $sectionName, int $schoolYearId, ?int $exceptSectionId = null): void {
    $sql = 'SELECT section_id FROM sections
            WHERE school_year_id = :school_year_id
              AND BINARY LOWER(TRIM(section_name)) = BINARY LOWER(TRIM(:section_name))';
    if ($exceptSectionId !== null) $sql .= ' AND section_id <> :except_section_id';
    $sql .= ' LIMIT 1';
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':section_name', $sectionName);
    if ($exceptSectionId !== null) $stmt->bindValue(':except_section_id', $exceptSectionId, PDO::PARAM_INT);
    $stmt->execute();
    if ($stmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Name already taken.'], 422);
    }
}

function sectionImportAccessRow(PDO $conn, array $session, array $section): array {
    $roleKey = (string)($session['role_key'] ?? '');
    $employeeId = 0;
    $authorized = true;
    if (in_array($roleKey, ['teacher', 'adviser', 'advisor'], true)) {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        $authorized = (int)($section['adviser_id'] ?? 0) === $employeeId;
    }

    $isFull = (int)($section['enrolled_count'] ?? 0) >= (int)($section['max_capacity'] ?? 0);
    $message = 'Section is available for import.';
    if (!$authorized) {
        $message = 'Section exists, but you are not the adviser assigned to this section. Please make sure you are the adviser for '
            . ($section['grade_name'] ?? 'the grade') . ' - ' . ($section['section_name'] ?? 'this section')
            . ' in school year ' . ($section['year_label'] ?? $section['school_year_id'] ?? '') . '.';
    } elseif ($isFull) {
        $message = 'Section exists, but it is already full.';
    }

    return [
        'exists' => true,
        'authorized' => $authorized,
        'available' => $authorized && !$isFull,
        'is_full' => $isFull,
        'message' => $message,
        'section' => $section,
    ];
}

function requireEmployeeIsTeacher(PDO $conn, ?int $employeeId): void {
    if ($employeeId === null || $employeeId <= 0) {
        return;
    }
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
        respond(['success' => false, 'message' => 'Adviser must be an employee with a teacher role'], 422);
    }
}

function requireAdviserAvailableForSchoolYear(PDO $conn, ?int $adviserId, int $schoolYearId, ?int $sectionId = null): void {
    if ($adviserId === null || $adviserId <= 0) {
        return;
    }
    if ($schoolYearId <= 0) {
        respond(['success' => false, 'message' => 'School year is required before assigning an adviser'], 422);
    }

    $sql = 'SELECT s.section_id, s.section_name, gl.grade_name, sy.year_label
            FROM sections s
            LEFT JOIN grade_levels gl ON gl.grade_level_id = s.grade_level_id
            LEFT JOIN school_years sy ON sy.school_year_id = s.school_year_id
            WHERE s.is_deleted = 0
              AND s.adviser_id = :adviser_id
              AND s.school_year_id = :school_year_id';
    if ($sectionId !== null && $sectionId > 0) {
        $sql .= ' AND s.section_id <> :section_id';
    }
    $sql .= ' LIMIT 1';

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':adviser_id', $adviserId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    if ($sectionId !== null && $sectionId > 0) {
        $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    }
    $stmt->execute();
    $conflict = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($conflict) {
        $assignedTo = trim(($conflict['grade_name'] ?? '') . ' - ' . ($conflict['section_name'] ?? ''));
        respond([
            'success' => false,
            'message' => 'This adviser is already assigned to ' . $assignedTo . ' for school year ' . ($conflict['year_label'] ?? $schoolYearId) . '. An adviser can handle only one advisory section per school year.'
        ], 422);
    }
}

$operation = $_GET['operation'] ?? '';
// Archive names reuse the established soft-delete permissions and validations.
$operation = (['archiveSection' => 'deleteSection'])[$operation] ?? $operation;
$writeRoles = $operation === 'checkSectionAccess'
    ? ['admin', 'teacher', 'registrar', 'learners']
    : ['admin'];
$session = auth_enforce_roles($operation, ['admin', 'teacher', 'adviser', 'advisor', 'registrar', 'learners'], $writeRoles);

try {
    switch ($operation) {
        case 'getAllSections':
            getAllSections($conn, $session);
            break;
        case 'getSectionsByGradeLevel':
            getSectionsByGradeLevel($conn, $session);
            break;
        case 'checkSectionAccess':
            checkSectionAccess($conn, $session);
            break;
        case 'createSection':
            createSection($conn);
            break;
        case 'updateSection':
            updateSection($conn);
            break;
        case 'deleteSection':
            deleteSection($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllSections(PDO $conn, array $session): void {
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $includeAll = (int)($_GET['include_all'] ?? 0);

    if ($schoolYearId <= 0 && $includeAll !== 1) {
        $schoolYearId = (int)($conn->query("SELECT school_year_id FROM school_years WHERE is_active = 1 AND is_deleted = 0 ORDER BY year_start DESC LIMIT 1")->fetchColumn() ?? 0);
    }

    $sql = "SELECT s.section_id, s.section_name, s.grade_level_id, gl.grade_name,
                                     s.school_year_id, sy.year_label,
                                     s.adviser_id,
                                     CONCAT(COALESCE(emp.last_name, ''), CASE WHEN emp.last_name IS NOT NULL THEN ', ' ELSE '' END, COALESCE(emp.first_name, '')) AS adviser_name,
                                     s.max_capacity,
                                     COALESCE(ec.enrolled_count, 0) AS enrolled_count,
                                     GREATEST(s.max_capacity - COALESCE(ec.enrolled_count, 0), 0) AS available_slots,
                                     CASE WHEN COALESCE(ec.enrolled_count, 0) >= s.max_capacity THEN 1 ELSE 0 END AS is_full
                        FROM sections s
                        LEFT JOIN grade_levels gl ON s.grade_level_id = gl.grade_level_id
                        LEFT JOIN school_years sy ON s.school_year_id = sy.school_year_id
                        LEFT JOIN employees emp ON s.adviser_id = emp.employee_id
                        LEFT JOIN (
                                SELECT e.section_id, e.school_year_id, COUNT(*) AS enrolled_count
                                FROM enrollments e
                                WHERE e.is_deleted = 0
                                    AND (e.enrollment_status = 'Enrolled' OR e.enrollment_status IS NULL)
                                GROUP BY e.section_id, e.school_year_id
                        ) ec ON ec.section_id = s.section_id AND ec.school_year_id = s.school_year_id
                        WHERE s.is_deleted = 0";

    $roleKey = (string)($session['role_key'] ?? '');
    $employeeId = 0;
    if (in_array($roleKey, ['teacher', 'adviser', 'advisor'], true)) {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        $sql .= ' AND (s.adviser_id = :adviser_eid OR EXISTS (
                    SELECT 1
                    FROM class_offerings co2
                    WHERE co2.is_deleted = 0
                      AND co2.section_id = s.section_id
                      AND co2.school_year_id = s.school_year_id
                      AND co2.teacher_id = :co_eid
                  ))';
    }

    $sql .= ($schoolYearId > 0 ? ' AND s.school_year_id = :school_year_id' : '') .
                     ' ORDER BY sy.year_label DESC, gl.grade_name, s.section_name';
    $stmt = $conn->prepare($sql);
    if (in_array($roleKey, ['teacher', 'adviser', 'advisor'], true)) {
        $stmt->bindValue(':co_eid', $employeeId, PDO::PARAM_INT);
        $stmt->bindValue(':adviser_eid', $employeeId, PDO::PARAM_INT);
    }
    if ($schoolYearId > 0) {
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    }
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function getSectionsByGradeLevel(PDO $conn, array $session): void {
    $gradeLevelId = (int)($_GET['grade_level_id'] ?? 0);
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $onlyWithSlots = (int)($_GET['only_with_slots'] ?? 0);
    $importScope = (int)($_GET['import_scope'] ?? 0);
    if ($gradeLevelId <= 0) {
        respond(['success' => false, 'message' => 'grade_level_id is required'], 422);
    }

    if ($schoolYearId <= 0) {
        $schoolYearId = (int)($conn->query("SELECT school_year_id FROM school_years WHERE is_active = 1 AND is_deleted = 0 ORDER BY year_start DESC LIMIT 1")->fetchColumn() ?? 0);
    }

    $sql = "SELECT s.section_id, s.section_name, s.grade_level_id,
                                     s.school_year_id, s.adviser_id, s.max_capacity,
                                     COALESCE(ec.enrolled_count, 0) AS enrolled_count,
                                     GREATEST(s.max_capacity - COALESCE(ec.enrolled_count, 0), 0) AS available_slots,
                                     CASE WHEN COALESCE(ec.enrolled_count, 0) >= s.max_capacity THEN 1 ELSE 0 END AS is_full
                        FROM sections s
                        LEFT JOIN (
                                SELECT e.section_id, e.school_year_id, COUNT(*) AS enrolled_count
                                FROM enrollments e
                                WHERE e.is_deleted = 0
                                    AND (e.enrollment_status = 'Enrolled' OR e.enrollment_status IS NULL)
                                GROUP BY e.section_id, e.school_year_id
                        ) ec ON ec.section_id = s.section_id AND ec.school_year_id = s.school_year_id
                        WHERE s.is_deleted = 0
                            AND s.grade_level_id = :grade_level_id";

    $roleKey = (string)($session['role_key'] ?? '');
    $employeeId = 0;
    if (in_array($roleKey, ['teacher', 'adviser', 'advisor'], true)) {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        if ($importScope === 1) {
            $sql .= ' AND s.adviser_id = :adviser_eid';
        } else {
            $sql .= ' AND (
                        s.adviser_id = :adviser_eid
                        OR EXISTS (
                            SELECT 1
                            FROM class_offerings co2
                            WHERE co2.is_deleted = 0
                              AND co2.section_id = s.section_id
                              AND co2.school_year_id = s.school_year_id
                              AND co2.teacher_id = :co_eid
                        )
                      )';
        }
    }

    $sql .= ($schoolYearId > 0 ? ' AND s.school_year_id = :school_year_id' : '')
         . ($onlyWithSlots === 1 ? ' AND COALESCE(ec.enrolled_count, 0) < s.max_capacity' : '')
         . ' ORDER BY s.section_name';
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':grade_level_id', $gradeLevelId, PDO::PARAM_INT);
    if (in_array($roleKey, ['teacher', 'adviser', 'advisor'], true)) {
        $stmt->bindValue(':adviser_eid', $employeeId, PDO::PARAM_INT);
        if ($importScope !== 1) {
            $stmt->bindValue(':co_eid', $employeeId, PDO::PARAM_INT);
        }
    }
    if ($schoolYearId > 0) {
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    }
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function checkSectionAccess(PDO $conn, array $session): void {
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $gradeLevelId = (int)($_GET['grade_level_id'] ?? 0);
    $sectionName = trim((string)($_GET['section_name'] ?? ''));
    $sectionId = (int)($_GET['section_id'] ?? 0);

    if ($schoolYearId <= 0 || $gradeLevelId <= 0) {
        respond(['success' => false, 'message' => 'school_year_id and grade_level_id are required'], 422);
    }

    $sql = "SELECT s.section_id, s.section_name, s.grade_level_id, gl.grade_name,
                   s.school_year_id, sy.year_label, s.adviser_id, s.max_capacity,
                   COALESCE(ec.enrolled_count, 0) AS enrolled_count,
                   GREATEST(s.max_capacity - COALESCE(ec.enrolled_count, 0), 0) AS available_slots
            FROM sections s
            JOIN grade_levels gl ON gl.grade_level_id = s.grade_level_id
            JOIN school_years sy ON sy.school_year_id = s.school_year_id
            LEFT JOIN (
                SELECT section_id, school_year_id, COUNT(*) AS enrolled_count
                FROM enrollments
                WHERE is_deleted = 0
                  AND (enrollment_status = 'Enrolled' OR enrollment_status IS NULL)
                GROUP BY section_id, school_year_id
            ) ec ON ec.section_id = s.section_id AND ec.school_year_id = s.school_year_id
            WHERE s.is_deleted = 0
              AND s.school_year_id = :school_year_id
              AND s.grade_level_id = :grade_level_id";
    if ($sectionId > 0) {
        $sql .= ' AND s.section_id = :section_id';
    }
    $sql .= ' ORDER BY s.section_name';

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':grade_level_id', $gradeLevelId, PDO::PARAM_INT);
    if ($sectionId > 0) {
        $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    }
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    if ($sectionId <= 0 && $sectionName !== '') {
        $wanted = normalizeSectionLookupText($sectionName);
        $rows = array_values(array_filter($rows, fn ($row) => normalizeSectionLookupText((string)$row['section_name']) === $wanted));
    }

    if (!$rows) {
        respond([
            'success' => true,
            'exists' => false,
            'authorized' => false,
            'available' => false,
            'message' => $sectionName !== ''
                ? 'Section "' . $sectionName . '" does not exist in the Sections masterfile for the selected school year and grade level.'
                : 'No sections exist in the Sections masterfile for the selected school year and grade level.'
        ]);
    }

    if ($sectionId <= 0 && $sectionName === '') {
        $authorizedRows = [];
        foreach ($rows as $row) {
            $access = sectionImportAccessRow($conn, $session, $row);
            if (!empty($access['available'])) {
                $authorizedRows[] = $row;
            }
        }
        if ($authorizedRows) {
            respond([
                'success' => true,
                'exists' => true,
                'authorized' => true,
                'available' => true,
                'message' => count($authorizedRows) . ' section(s) are available for import.',
                'sections' => $authorizedRows,
            ]);
        }
        respond([
            'success' => true,
            'exists' => true,
            'authorized' => false,
            'available' => false,
            'message' => 'Sections exist for the selected school year and grade level, but none are assigned to you as adviser. Please make sure you are the adviser before importing learners.',
            'sections' => $rows,
        ]);
    }

    if (count($rows) > 1) {
        respond([
            'success' => true,
            'exists' => true,
            'authorized' => false,
            'available' => false,
            'message' => 'More than one matching section exists. Please make section names unique for this school year and grade level.',
            'matches' => $rows,
        ]);
    }

    respond(['success' => true] + sectionImportAccessRow($conn, $session, $rows[0]));
}

function createSection(PDO $conn): void {
    $data = getJsonInput();
    $sectionName = trim((string)($data['section_name'] ?? ''));
    $gradeLevelId = (int)($data['grade_level_id'] ?? 0);
    $schoolYearId = (int)($data['school_year_id'] ?? 0);
    if ($sectionName === '' || $gradeLevelId <= 0 || $schoolYearId <= 0) {
        respond(['success' => false, 'message' => 'Section name, grade level, and school year are required'], 422);
    }
    $data['section_name'] = $sectionName;
    requireUniqueSectionName($conn, $sectionName, $schoolYearId);

    $adviserId = null;
    if (isset($data['adviser_id']) && $data['adviser_id'] !== '') {
        $adviserId = (int)$data['adviser_id'];
        if ($adviserId <= 0) {
            $adviserId = null;
        }
    }
    requireEmployeeIsTeacher($conn, $adviserId);
    requireAdviserAvailableForSchoolYear($conn, $adviserId, (int)$data['school_year_id']);

    $maxCapacity = isset($data['max_capacity']) && $data['max_capacity'] !== '' ? (int)$data['max_capacity'] : 45;
    if ($maxCapacity <= 0 || $maxCapacity > 60) {
        respond(['success' => false, 'message' => 'max_capacity must be between 1 and 60'], 422);
    }

    $stmt = $conn->prepare('INSERT INTO sections (grade_level_id, section_name, school_year_id, adviser_id, max_capacity) VALUES (:grade_level_id, :section_name, :school_year_id, :adviser_id, :max_capacity)');
    $stmt->bindValue(':grade_level_id', $data['grade_level_id'], PDO::PARAM_INT);
    $stmt->bindValue(':section_name', $data['section_name']);
    $stmt->bindValue(':school_year_id', (int)$data['school_year_id'], PDO::PARAM_INT);
    $stmt->bindValue(':adviser_id', $adviserId, $adviserId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
    $stmt->bindValue(':max_capacity', $maxCapacity, PDO::PARAM_INT);
    $stmt->execute();

    $sectionId = (int)$conn->lastInsertId();
    audit_log($conn, 'sections', $sectionId, 'INSERT', null, [
        'section_id' => $sectionId,
        'section_name' => $data['section_name'],
        'grade_level_id' => (int)$data['grade_level_id'],
        'school_year_id' => (int)$data['school_year_id'],
    ]);

    respond(['success' => true, 'message' => 'Section created', 'section_id' => $sectionId]);
}

function updateSection(PDO $conn): void {
    $data = getJsonInput();
    $sectionName = trim((string)($data['section_name'] ?? ''));
    $gradeLevelId = (int)($data['grade_level_id'] ?? 0);
    $schoolYearId = (int)($data['school_year_id'] ?? 0);
    $sectionId = (int)($data['section_id'] ?? 0);
    if ($sectionId <= 0 || $sectionName === '' || $gradeLevelId <= 0 || $schoolYearId <= 0) {
        respond(['success' => false, 'message' => 'Section ID, name, grade level, and school year are required'], 422);
    }
    $data['section_name'] = $sectionName;
    requireUniqueSectionName($conn, $sectionName, $schoolYearId, $sectionId);

    $currentStmt = $conn->prepare('SELECT adviser_id FROM sections WHERE section_id = :section_id AND is_deleted = 0 LIMIT 1');
    $currentStmt->bindValue(':section_id', (int)$data['section_id'], PDO::PARAM_INT);
    $currentStmt->execute();
    $currentSection = $currentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$currentSection) {
        respond(['success' => false, 'message' => 'Section not found'], 404);
    }

    $adviserIsSet = array_key_exists('adviser_id', $data) ? 1 : 0;
    $adviserId = null;
    if ($adviserIsSet === 1) {
        $adviserId = isset($data['adviser_id']) && $data['adviser_id'] !== '' ? (int)$data['adviser_id'] : null;
        if ($adviserId !== null && $adviserId <= 0) {
            $adviserId = null;
        }
    } elseif ($currentSection['adviser_id'] !== null) {
        $adviserId = (int)$currentSection['adviser_id'];
    }
    requireEmployeeIsTeacher($conn, $adviserId);
    requireAdviserAvailableForSchoolYear($conn, $adviserId, (int)$data['school_year_id'], (int)$data['section_id']);

    $maxCapacity = isset($data['max_capacity']) && $data['max_capacity'] !== '' ? (int)$data['max_capacity'] : null;
    if ($maxCapacity !== null && ($maxCapacity <= 0 || $maxCapacity > 60)) {
        respond(['success' => false, 'message' => 'max_capacity must be between 1 and 60'], 422);
    }

    $stmt = $conn->prepare('UPDATE sections
                            SET section_name = :section_name,
                                grade_level_id = :grade_level_id,
                                school_year_id = :school_year_id,
                                adviser_id = CASE WHEN :adviser_is_set = 1 THEN :adviser_id ELSE adviser_id END,
                                max_capacity = COALESCE(:max_capacity, max_capacity)
                            WHERE section_id = :section_id');
    $stmt->bindValue(':section_name', $data['section_name']);
    $stmt->bindValue(':grade_level_id', $data['grade_level_id'], PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', (int)$data['school_year_id'], PDO::PARAM_INT);
    $stmt->bindValue(':adviser_is_set', $adviserIsSet, PDO::PARAM_INT);
    $stmt->bindValue(':adviser_id', $adviserId, $adviserId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
    $stmt->bindValue(':max_capacity', $maxCapacity, $maxCapacity === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
    $stmt->bindValue(':section_id', $data['section_id'], PDO::PARAM_INT);
    $stmt->execute();

    $oldRow = audit_fetch_old($conn, 'sections', 'section_id', (int)$data['section_id']);
    audit_log($conn, 'sections', (int)$data['section_id'], 'UPDATE', $oldRow, [
        'section_id' => (int)$data['section_id'],
        'section_name' => $data['section_name'],
        'grade_level_id' => (int)$data['grade_level_id'],
    ]);

    respond(['success' => true, 'message' => 'Section updated']);
}

function deleteSection(PDO $conn): void {
    $data = getJsonInput();
    $sectionId = (int)($data['section_id'] ?? 0);
    if ($sectionId <= 0) {
        respond(['success' => false, 'message' => 'Section ID is required'], 422);
    }

    $currentStmt = $conn->prepare('SELECT section_id, section_name, is_deleted
                                   FROM sections
                                   WHERE section_id = :section_id
                                   LIMIT 1');
    $currentStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $currentStmt->execute();
    $currentSection = $currentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$currentSection) {
        respond(['success' => false, 'message' => 'Section not found'], 404);
    }
    if ((int)$currentSection['is_deleted'] === 1) {
        respond(['success' => false, 'message' => 'This section is already archived'], 409);
    }

    $enrolledStmt = $conn->prepare('SELECT COUNT(*)
                                    FROM enrollments
                                    WHERE section_id = :section_id
                                      AND is_deleted = 0
                                      AND (enrollment_status = \'Enrolled\' OR enrollment_status IS NULL)');
    $enrolledStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $enrolledStmt->execute();
    if ((int)$enrolledStmt->fetchColumn() > 0) {
        respond([
            'success' => false,
            'message' => 'This section cannot be archived while it has enrolled learners. Move the learners to another section first.'
        ], 409);
    }

    $oldRow = audit_fetch_old($conn, 'sections', 'section_id', $sectionId);
    $stmt = $conn->prepare('UPDATE sections
                            SET is_deleted = 1, deleted_at = NOW()
                            WHERE section_id = :section_id AND is_deleted = 0');
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->execute();

    audit_log($conn, 'sections', $sectionId, 'DELETE', $oldRow, null);

    respond(['success' => true, 'message' => 'Section archived']);
}
?>
