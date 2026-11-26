<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/audit.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

/**
 * Sanitize a direct period grade value.
 * Returns null for blank/null, float for valid numbers 60-100,
 * or throws for non-numeric strings / out-of-range.
 */
function sanitizeGradeValue($raw, string $label): ?float {
    return app_integrity_validate_quarterly_grade($raw, $label);
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

function getLearnerIdForUser(PDO $conn, int $userId): int {
    if ($userId <= 0) {
        respond(['success' => false, 'message' => 'Invalid session user'], 401);
    }
    $stmt = $conn->prepare('SELECT learner_id FROM learners WHERE user_id = :user_id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $stmt->execute();
    $lid = (int)($stmt->fetchColumn() ?: 0);
    if ($lid <= 0) {
        respond(['success' => false, 'message' => 'Learner profile not found for this account'], 403);
    }
    return $lid;
}

function requireTeacherOwnsClassOffering(PDO $conn, int $employeeId, int $classId): void {
    $stmt = $conn->prepare(
        'SELECT 1 FROM class_offerings
         WHERE class_id = :class_id
           AND is_deleted = 0
           AND teacher_id = :eid
         LIMIT 1'
    );
    $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $stmt->bindValue(':eid', $employeeId, PDO::PARAM_INT);
    $stmt->execute();
    if (!$stmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Not authorized for this class offering'], 403);
    }
}

function requireEnrollmentMatchesClassOffering(PDO $conn, int $enrollmentId, int $classId): void {
    $stmt = $conn->prepare(
        'SELECT 1
         FROM enrollments e
         JOIN class_offerings c ON c.class_id = :class_id AND c.is_deleted = 0
         WHERE e.enrollment_id = :enrollment_id
           AND e.is_deleted = 0
           AND e.section_id = c.section_id
           AND e.school_year_id = c.school_year_id
         LIMIT 1'
    );
    $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
    $stmt->execute();
    if (!$stmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Enrollment does not match the class offering context'], 422);
    }
}

function requireGradingPeriodMatchesClassOffering(PDO $conn, int $gradingPeriodId, int $classId): void {
    $stmt = $conn->prepare(
        'SELECT 1
         FROM grading_periods gp
         JOIN class_offerings c
           ON c.school_year_id = gp.school_year_id
          AND c.class_id = :class_id
          AND c.is_deleted = 0
         WHERE gp.grading_period_id = :grading_period_id
           AND gp.is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $stmt->bindValue(':grading_period_id', $gradingPeriodId, PDO::PARAM_INT);
    $stmt->execute();
    if (!$stmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Grading period does not belong to the class offering school year'], 422);
    }
}

function requireTeacherOwnsGrade(PDO $conn, int $employeeId, int $gradeId): void {
    $stmt = $conn->prepare(
        'SELECT 1
         FROM grades g
         JOIN class_offerings c ON c.class_id = g.class_id
         WHERE g.grade_id = :grade_id
           AND g.is_deleted = 0
           AND c.is_deleted = 0
           AND c.teacher_id = :eid
         LIMIT 1'
    );
    $stmt->bindValue(':grade_id', $gradeId, PDO::PARAM_INT);
    $stmt->bindValue(':eid', $employeeId, PDO::PARAM_INT);
    $stmt->execute();
    if (!$stmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Not authorized for this grade record'], 403);
    }
}

function fetchGradeRecord(PDO $conn, int $gradeId): ?array {
    $stmt = $conn->prepare(
        'SELECT g.grade_id, g.enrollment_id, g.class_id, g.grading_period_id, g.quarterly_grade, gp.status AS period_status
         FROM grades g
         JOIN enrollments e ON e.enrollment_id = g.enrollment_id AND e.is_deleted = 0
         JOIN class_offerings c ON c.class_id = g.class_id
                               AND c.school_year_id = e.school_year_id
                               AND c.is_deleted = 0
         JOIN grading_periods gp ON gp.grading_period_id = g.grading_period_id
                                AND gp.school_year_id = e.school_year_id
                                AND gp.is_deleted = 0
         WHERE g.grade_id = :grade_id
           AND g.is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':grade_id', $gradeId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function requireGradingPeriodOpen(PDO $conn, int $gradingPeriodId): void {
    $stmt = $conn->prepare(
        'SELECT status FROM grading_periods
         WHERE grading_period_id = :grading_period_id
           AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':grading_period_id', $gradingPeriodId, PDO::PARAM_INT);
    $stmt->execute();
    $status = $stmt->fetchColumn();
    if ($status === false || $status === null) {
        respond(['success' => false, 'message' => 'Grading period not found'], 404);
    }
    if (strcasecmp((string)$status, 'Open') !== 0) {
        respond(['success' => false, 'message' => 'This grading period is closed. Grades can only be changed while the period is Open.'], 403);
    }
}

$operation = $_GET['operation'] ?? '';
$session = auth_enforce_roles($operation, ['admin', 'teacher', 'learners'], ['admin', 'teacher']);
try {
    switch ($operation) {
        case 'getAllGrades': getAllGrades($conn, $session); break;
        case 'getMyGrades': getMyGrades($conn, $session); break;
        case 'createGrade': createGrade($conn, $session); break;
        case 'updateGrade': updateGrade($conn, $session); break;
        case 'deleteGrade': deleteGrade($conn, $session); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (ApplicationIntegrityException $e) {
    respond(['success' => false, 'message' => $e->getMessage()], $e->getCode());
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllGrades(PDO $conn, array $session): void {
    $roleKey = $session['role_key'] ?? '';
    $isTeacher = ($roleKey === 'teacher');
    $isLearner = ($roleKey === 'learners');
    $employeeId = $isTeacher ? getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0)) : 0;
    $learnerId = $isLearner ? getLearnerIdForUser($conn, (int)($session['user_id'] ?? 0)) : 0;

    $sql = "SELECT g.grade_id, g.enrollment_id, g.class_id, g.grading_period_id,
                   g.quarterly_grade,
                   e.school_year_id,
                   CONCAT(l.last_name, ', ', l.first_name) AS learner_name,
                   s.subject_name, gp.period_no, gp.period_name
            FROM grades g
            JOIN enrollments e ON g.enrollment_id = e.enrollment_id AND e.is_deleted = 0
            JOIN learners l ON e.learner_id = l.learner_id
            JOIN class_offerings c ON g.class_id = c.class_id
                                  AND c.school_year_id = e.school_year_id
                                  AND c.is_deleted = 0
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN grading_periods gp ON g.grading_period_id = gp.grading_period_id
                                   AND gp.school_year_id = e.school_year_id
                                   AND gp.is_deleted = 0
                        WHERE g.is_deleted = 0
                            AND c.is_deleted = 0";

    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    if ($schoolYearId > 0) {
        $sql .= " AND e.school_year_id = :school_year_id";
    }

    if ($isTeacher) {
        $sql .= " AND c.teacher_id = :teacher_id";
    } elseif ($isLearner) {
        $sql .= " AND e.learner_id = :learner_id";
    }

    $sql .= " ORDER BY gp.period_no, s.subject_name, g.grade_id DESC";
    $stmt = $conn->prepare($sql);
    if ($schoolYearId > 0) {
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    }
    if ($isTeacher) {
        $stmt->bindValue(':teacher_id', $employeeId, PDO::PARAM_INT);
    } elseif ($isLearner) {
        $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    }
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function getMyGrades(PDO $conn, array $session): void {
    // Convenience endpoint: returns the current learner's grades only.
    getAllGrades($conn, $session);
}

function createGrade(PDO $conn, array $session): void {
    $data = getJsonInput();
    if (empty($data['enrollment_id']) || empty($data['class_id']) || empty($data['grading_period_id'])) {
        respond(['success' => false, 'message' => 'Enrollment, class, and grading period are required'], 422);
    }

    $enrollmentId = (int)$data['enrollment_id'];
    $classId = (int)$data['class_id'];
    $gradingPeriodId = (int)$data['grading_period_id'];

    if (($session['role_key'] ?? '') === 'teacher') {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        requireTeacherOwnsClassOffering($conn, $employeeId, $classId);
    }

    requireEnrollmentMatchesClassOffering($conn, $enrollmentId, $classId);
    requireGradingPeriodMatchesClassOffering($conn, $gradingPeriodId, $classId);
    requireGradingPeriodOpen($conn, $gradingPeriodId);

    $qg = sanitizeGradeValue(array_key_exists('quarterly_grade', $data) ? $data['quarterly_grade'] : null, 'quarterly_grade');

    $stmt = $conn->prepare(
        'INSERT INTO grades (enrollment_id, class_id, grading_period_id, quarterly_grade)
         VALUES (:enrollment_id, :class_id, :grading_period_id, :quarterly_grade)'
    );
    $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
    $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $stmt->bindValue(':grading_period_id', $gradingPeriodId, PDO::PARAM_INT);

    if ($qg === null) $stmt->bindValue(':quarterly_grade', null, PDO::PARAM_NULL);
    else $stmt->bindValue(':quarterly_grade', $qg);

    $stmt->execute();
    $gradeId = (int)$conn->lastInsertId();
    audit_log($conn, 'grades', $gradeId, 'INSERT', null, [
        'grade_id' => $gradeId,
        'enrollment_id' => $enrollmentId,
        'class_id' => $classId,
        'grading_period_id' => $gradingPeriodId,
        'quarterly_grade' => $qg
    ]);
    respond(['success' => true, 'message' => 'Grade created', 'grade_id' => $gradeId]);
}

function updateGrade(PDO $conn, array $session): void {
    $data = getJsonInput();
    if (empty($data['grade_id']) || empty($data['enrollment_id']) || empty($data['class_id']) || empty($data['grading_period_id'])) {
        respond(['success' => false, 'message' => 'Grade ID, enrollment, class, and grading period are required'], 422);
    }

    $gradeId = (int)$data['grade_id'];
    $enrollmentId = (int)$data['enrollment_id'];
    $classId = (int)$data['class_id'];
    $gradingPeriodId = (int)$data['grading_period_id'];
    $existing = fetchGradeRecord($conn, $gradeId);
    if (!$existing) {
        respond(['success' => false, 'message' => 'Grade record not found'], 404);
    }

    if (($session['role_key'] ?? '') === 'teacher') {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        requireTeacherOwnsGrade($conn, $employeeId, $gradeId);
        requireTeacherOwnsClassOffering($conn, $employeeId, $classId);
    }

    requireEnrollmentMatchesClassOffering($conn, $enrollmentId, $classId);
    requireGradingPeriodMatchesClassOffering($conn, $gradingPeriodId, $classId);
    requireGradingPeriodOpen($conn, (int)$existing['grading_period_id']);
    requireGradingPeriodOpen($conn, $gradingPeriodId);

    $qg = sanitizeGradeValue(array_key_exists('quarterly_grade', $data) ? $data['quarterly_grade'] : null, 'quarterly_grade');

    $stmt = $conn->prepare(
        'UPDATE grades
         SET enrollment_id = :enrollment_id,
             class_id = :class_id,
             grading_period_id = :grading_period_id,
             quarterly_grade = :quarterly_grade
         WHERE grade_id = :grade_id'
    );
    $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
    $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $stmt->bindValue(':grading_period_id', $gradingPeriodId, PDO::PARAM_INT);

    if ($qg === null) $stmt->bindValue(':quarterly_grade', null, PDO::PARAM_NULL);
    else $stmt->bindValue(':quarterly_grade', $qg);

    $stmt->bindValue(':grade_id', $gradeId, PDO::PARAM_INT);
    $stmt->execute();
    audit_log($conn, 'grades', $gradeId, 'UPDATE', $existing, [
        'grade_id' => $gradeId,
        'enrollment_id' => $enrollmentId,
        'class_id' => $classId,
        'grading_period_id' => $gradingPeriodId,
        'quarterly_grade' => $qg
    ]);
    respond(['success' => true, 'message' => 'Grade updated']);
}

function deleteGrade(PDO $conn, array $session): void {
    $data = getJsonInput();
    if (empty($data['grade_id'])) {
        respond(['success' => false, 'message' => 'Grade ID is required'], 422);
    }

    if (($session['role_key'] ?? '') === 'teacher') {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        requireTeacherOwnsGrade($conn, $employeeId, (int)$data['grade_id']);
    }
    $existing = fetchGradeRecord($conn, (int)$data['grade_id']);
    if (!$existing) {
        respond(['success' => false, 'message' => 'Grade record not found'], 404);
    }
    requireGradingPeriodOpen($conn, (int)$existing['grading_period_id']);

    $stmt = $conn->prepare('UPDATE grades SET is_deleted = 1, deleted_at = NOW() WHERE grade_id = :grade_id');
    $stmt->bindValue(':grade_id', $data['grade_id'], PDO::PARAM_INT);
    $stmt->execute();
    audit_log($conn, 'grades', (int)$data['grade_id'], 'DELETE', $existing, null);
    respond(['success' => true, 'message' => 'Grade deleted']);
}
