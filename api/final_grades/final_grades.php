<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';
require_once __DIR__ . '/../services/GradeComputationService.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
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

$operation = $_GET['operation'] ?? '';
$session = auth_enforce_roles($operation, ['admin', 'teacher', 'learners'], ['admin', 'teacher']);
try {
    switch ($operation) {
        case 'getAllFinalGrades': getAllFinalGrades($conn, $session); break;
        case 'getMyFinalGrades': getMyFinalGrades($conn, $session); break;
        case 'createFinalGrade': createFinalGrade($conn); break;
        case 'updateFinalGrade': updateFinalGrade($conn); break;
        case 'deleteFinalGrade': deleteFinalGrade($conn); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (ApplicationIntegrityException $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    respond(['success' => false, 'message' => $e->getMessage()], $e->getCode());
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllFinalGrades(PDO $conn, array $session): void {
    $roleKey = $session['role_key'] ?? '';
    $isLearner = ($roleKey === 'learners');
    $learnerId = $isLearner ? getLearnerIdForUser($conn, (int)($session['user_id'] ?? 0)) : 0;

    $sql = "SELECT fg.final_grade_id, fg.enrollment_id, fg.class_id, fg.final_grade,
                   fg.remark AS remark_name,
                   CONCAT(l.last_name, ', ', l.first_name) AS learner_name,
                   s.subject_name
            FROM final_grades fg
            JOIN enrollments e ON fg.enrollment_id = e.enrollment_id
                              AND e.is_deleted = 0
            JOIN learners l ON e.learner_id = l.learner_id
            JOIN class_offerings c ON fg.class_id = c.class_id
                                  AND c.section_id = e.section_id
                                  AND c.school_year_id = e.school_year_id
            JOIN subjects s ON c.subject_id = s.subject_id
                        WHERE fg.is_deleted = 0
                            AND c.is_deleted = 0";

    if ($isLearner) {
        $sql .= " AND e.learner_id = :learner_id";
    }

    $sql .= " ORDER BY s.subject_name, fg.final_grade_id DESC";
    $stmt = $conn->prepare($sql);
    if ($isLearner) {
        $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    }
    $stmt->execute();

    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$row) {
        // Backward compatibility for older clients expecting grade_remark_id
        $row['grade_remark_id'] = match ($row['remark_name']) {
            'Passed' => 1,
            'Failed' => 2,
            default => null,
        };
    }
    unset($row);
    respond($rows);
}

function getMyFinalGrades(PDO $conn, array $session): void {
    // Convenience endpoint for learners viewing their own final grades.
    getAllFinalGrades($conn, $session);
}

function createFinalGrade(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['enrollment_id']) || empty($data['class_id'])) {
        respond(['success' => false, 'message' => 'Enrollment and class are required'], 422);
    }

    $remark = trim((string)($data['remark'] ?? ''));
    $remarkId = isset($data['grade_remark_id']) ? (int)$data['grade_remark_id'] : 0;
    if ($remark === '' && $remarkId > 0) {
        $idMap = [1 => 'Passed', 2 => 'Failed'];
        $remark = $idMap[$remarkId] ?? '';
    }
    if ($remark === '') {
        $remark = 'Failed';
    }
    $allowed = ['Passed','Failed'];
    if (!in_array($remark, $allowed, true)) {
        respond(['success' => false, 'message' => 'Invalid remark'], 422);
    }

    $conn->beginTransaction();
    $prepared = app_integrity_prepare_final_grade($conn, (int)$data['enrollment_id'], (int)$data['class_id'], $data['final_grade'] ?? null);
    $stmt = $conn->prepare('INSERT INTO final_grades (enrollment_id, class_id, final_grade, remark) VALUES (:enrollment_id, :class_id, :final_grade, :remark)');
    $stmt->bindValue(':enrollment_id', $data['enrollment_id'], PDO::PARAM_INT);
    $stmt->bindValue(':class_id', $data['class_id'], PDO::PARAM_INT);
    $stmt->bindValue(':final_grade', $prepared['final_grade'], $prepared['final_grade'] === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
    $stmt->bindValue(':remark', $prepared['remark']);
    $stmt->execute();
    $finalGradeId = (int)$conn->lastInsertId();
    $enrollmentCompleted = (new GradeComputationService($conn))->autoCompleteIfEligible((int)$data['enrollment_id']);
    $conn->commit();
    respond(['success' => true, 'message' => 'Final grade created', 'final_grade_id' => $finalGradeId, 'enrollment_completed' => $enrollmentCompleted]);
}

function updateFinalGrade(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['final_grade_id']) || empty($data['enrollment_id']) || empty($data['class_id'])) {
        respond(['success' => false, 'message' => 'Final grade ID, enrollment, and class are required'], 422);
    }

    $remark = trim((string)($data['remark'] ?? ''));
    $remarkId = isset($data['grade_remark_id']) ? (int)$data['grade_remark_id'] : 0;
    if ($remark === '' && $remarkId > 0) {
        $idMap = [1 => 'Passed', 2 => 'Failed'];
        $remark = $idMap[$remarkId] ?? '';
    }
    if ($remark === '') {
        $remark = 'Failed';
    }
    $allowed = ['Passed','Failed'];
    if (!in_array($remark, $allowed, true)) {
        respond(['success' => false, 'message' => 'Invalid remark'], 422);
    }

    $conn->beginTransaction();
    $prepared = app_integrity_prepare_final_grade($conn, (int)$data['enrollment_id'], (int)$data['class_id'], $data['final_grade'] ?? null);
    $stmt = $conn->prepare('UPDATE final_grades SET enrollment_id = :enrollment_id, class_id = :class_id, final_grade = :final_grade, remark = :remark WHERE final_grade_id = :final_grade_id');
    $stmt->bindValue(':enrollment_id', $data['enrollment_id'], PDO::PARAM_INT);
    $stmt->bindValue(':class_id', $data['class_id'], PDO::PARAM_INT);
    $stmt->bindValue(':final_grade', $prepared['final_grade'], $prepared['final_grade'] === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
    $stmt->bindValue(':remark', $prepared['remark']);
    $stmt->bindValue(':final_grade_id', $data['final_grade_id'], PDO::PARAM_INT);
    $stmt->execute();
    $enrollmentCompleted = (new GradeComputationService($conn))->autoCompleteIfEligible((int)$data['enrollment_id']);
    $conn->commit();
    respond(['success' => true, 'message' => 'Final grade updated', 'enrollment_completed' => $enrollmentCompleted]);
}

function deleteFinalGrade(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['final_grade_id'])) {
        respond(['success' => false, 'message' => 'Final grade ID is required'], 422);
    }
    $stmt = $conn->prepare('UPDATE final_grades SET is_deleted = 1, deleted_at = NOW() WHERE final_grade_id = :final_grade_id');
    $stmt->bindValue(':final_grade_id', $data['final_grade_id'], PDO::PARAM_INT);
    $stmt->execute();
    respond(['success' => true, 'message' => 'Final grade deleted']);
}
?>
