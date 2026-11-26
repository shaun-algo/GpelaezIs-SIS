<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/audit.php';
require_once __DIR__ . '/../utils/password_policy.php';
require_once __DIR__ . '/../utils/account_credentials.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';
require_once __DIR__ . '/../utils/name_extension_errors.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function getLearnerRoleId(PDO $conn): int {
    // Prefer lookup by name to avoid hard-coding, but keep a safe fallback.
    try {
        $stmt = $conn->prepare("SELECT role_id FROM roles WHERE role_name = 'learners' AND is_deleted = 0 LIMIT 1");
        $stmt->execute();
        $rid = $stmt->fetchColumn();
        if ($rid) {
            return (int)$rid;
        }
    } catch (Exception $e) {
        // ignore and fall back
    }
    return 10;
}

function resolveOrCreateLearnerAccount(PDO $conn, string $lrn, ?int $providedUserId = null): array {
    $lrn = trim($lrn);
    if ($lrn === '') {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        respond(['success' => false, 'message' => 'LRN is required to create learner account'], 422);
    }

    if ($providedUserId !== null && $providedUserId > 0) {
        $existing = account_credentials_find_by_legacy_user($conn, $providedUserId);
        $identity = $conn->prepare('SELECT u.role_id, u.username,
            EXISTS(SELECT 1 FROM employees e WHERE e.user_id = u.user_id) AS has_employee
            FROM users u WHERE u.user_id = ?');
        $identity->execute([$providedUserId]);
        $linked = $identity->fetch(PDO::FETCH_ASSOC);
        if (!$linked || $linked['username'] !== null || (int)$linked['has_employee'] || (int)$linked['role_id'] !== getLearnerRoleId($conn)) {
            if ($conn->inTransaction()) $conn->rollBack();
            respond(['success' => false, 'message' => 'Learners require a separate learner identity; staff accounts cannot be linked.'], 422);
        }
        return [
            'user_id' => $providedUserId,
            'created' => false,
            'username' => $existing['username'] ?? $lrn,
            'password_hash' => $existing['password'] ?? password_hash($lrn, PASSWORD_BCRYPT),
            'role_id' => $existing['role_id'] ?? getLearnerRoleId($conn),
        ];
    }

    $username = $lrn;
    $existing = account_credentials_find_by_username($conn, $username);
    if ($existing) {
        $uid = (int)($existing['legacy_user_id'] ?? 0);
        // Prevent a single user account from being linked to multiple learners.
        if (($existing['account_type'] ?? '') !== 'learner' || ((int)($existing['actor_id'] ?? 0) > 0)) {
            if ($conn->inTransaction()) {
                $conn->rollBack();
            }
            respond(['success' => false, 'message' => 'An existing account with this LRN is already linked.'], 409);
        }

        return ['user_id' => $uid, 'created' => false, 'username' => $username];
    }

    $roleId = getLearnerRoleId($conn);
    return ['user_id' => account_identity_create($conn, $roleId), 'created' => true, 'username' => $username, 'password_hash' => password_hash($lrn, PASSWORD_BCRYPT), 'role_id' => $roleId];
}

$operation = $_GET['operation'] ?? '';
// Archive names reuse the established soft-delete permissions and validations.
$operation = (['archiveLearner' => 'deleteLearner'])[$operation] ?? $operation;

// Define role permissions per operation
$operationRoles = [
    'getAllLearners'  => ['admin', 'teacher', 'registrar'],
    'createLearner'   => ['admin'],
    'updateLearner'   => ['admin', 'registrar'],  // Registrar can edit learner profiles
    'deleteLearner'   => ['admin']
];

// Get allowed roles for this operation (default to admin-only for security)
$allowedRoles = $operationRoles[$operation] ?? ['admin'];
$session = auth_require_roles($allowedRoles);

try {
    switch ($operation) {
        case 'getAllLearners':
            getAllLearners($conn, $session);
            break;
        case 'createLearner':
            createLearner($conn);
            break;
        case 'updateLearner':
            updateLearner($conn);
            break;
        case 'deleteLearner':
            deleteLearner($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (ApplicationIntegrityException $e) {
    if ($conn && $conn->inTransaction()) $conn->rollBack();
    respond(['success' => false, 'message' => $e->getMessage()], $e->getCode());
} catch (Exception $e) {
    if ($conn && $conn->inTransaction()) {
        $conn->rollBack();
    }
    if (is_name_extension_fk_violation($e)) {
        respond(name_extension_fk_error_payload(), 422);
    }
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllLearners(PDO $conn, array $session): void {
    $isTeacher = (($session['role_key'] ?? '') === 'teacher');
    $employeeId = 0;
    if ($isTeacher) {
        $employeeStmt = $conn->prepare('SELECT employee_id FROM employees WHERE user_id = :user_id AND is_deleted = 0 LIMIT 1');
        $employeeStmt->bindValue(':user_id', (int)($session['user_id'] ?? 0), PDO::PARAM_INT);
        $employeeStmt->execute();
        $employeeId = (int)($employeeStmt->fetchColumn() ?: 0);
        if ($employeeId <= 0) {
            respond(['success' => false, 'message' => 'Teacher profile not found'], 403);
        }
    }

    $sql = "SELECT l.learner_id, l.lrn, l.first_name, l.middle_name, l.last_name, l.date_of_birth, l.gender,
                   e.enrollment_status AS status_name,
                   e.enrollment_id, e.grade_level_id, gl.grade_name, e.section_id, sec.section_name,
                   e.school_year_id
            FROM learners l
            LEFT JOIN (
                SELECT e1.*
                FROM enrollments e1
                INNER JOIN (
                    SELECT learner_id, enrollment_id
                    FROM (
                        SELECT learner_id, enrollment_id,
                               ROW_NUMBER() OVER (
                                   PARTITION BY learner_id
                                   ORDER BY
                                       (school_year_id = (SELECT school_year_id FROM school_years WHERE is_active = 1 AND is_deleted = 0 ORDER BY year_start DESC LIMIT 1)) DESC,
                                       enrollment_date DESC,
                                       enrollment_id DESC
                               ) AS rn
                        FROM enrollments
                        WHERE is_deleted = 0
                    ) ranked
                    WHERE rn = 1
                ) latest ON latest.enrollment_id = e1.enrollment_id
            ) e ON e.learner_id = l.learner_id
            LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
            LEFT JOIN sections sec ON sec.section_id = e.section_id
            WHERE l.is_deleted = 0";

    if ($isTeacher) {
        $sql .= "
              AND EXISTS (
                  SELECT 1
                  FROM class_offerings co
                  WHERE co.section_id = e.section_id
                    AND co.school_year_id = e.school_year_id
                    AND co.teacher_id = :teacher_id
                    AND co.is_deleted = 0
              )";
    }

    $sql .= "
            ORDER BY l.last_name, l.first_name";

    $stmt = $conn->prepare($sql);
    if ($isTeacher) {
        $stmt->bindValue(':teacher_id', $employeeId, PDO::PARAM_INT);
    }
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function createLearner(PDO $conn): void {
    $data = getJsonInput();
    $lrn = trim((string)($data['lrn'] ?? ''));
    if ($lrn === '' || empty($data['first_name']) || empty($data['last_name']) || empty($data['grade_level_id']) || empty($data['section_id'])) {
        respond(['success' => false, 'message' => 'LRN, name, grade level, and section are required'], 422);
    }

    if (!preg_match('/^\d{12}$/', $lrn)) {
        respond(['success' => false, 'message' => 'LRN must be exactly 12 digits'], 422);
    }

    $schoolYearId = getActiveSchoolYearId($conn);
    if (!$schoolYearId) {
        respond(['success' => false, 'message' => 'No active school year found'], 409);
    }

    $userId = !empty($data['user_id']) ? (int)$data['user_id'] : null;

    $conn->beginTransaction();

    try {
        $account = resolveOrCreateLearnerAccount($conn, $lrn, $userId);
        $learnerValues = app_integrity_prepare_learner($conn, [
            'lrn' => $lrn,
            'date_of_birth' => $data['date_of_birth'] ?? null,
            'sex' => $data['sex'] ?? null,
            'gender' => $data['gender'] ?? null,
            'indigenous_group' => $data['indigenous_group'] ?? ($data['indigenous_group_id'] ?? null),
            'is_indigenous' => (int)($data['is_indigenous'] ?? 0),
        ], null, true);

        $stmt = $conn->prepare('INSERT INTO learners (user_id, lrn, username, password, role_id, is_active, account_created_at, first_name, middle_name, last_name, name_extension, date_of_birth, sex, gender, religion, mother_tongue, indigenous_group, is_indigenous, completed, address)
                                VALUES (:user_id, :lrn, :username, :password, :role_id, 1, NOW(), :first_name, :middle_name, :last_name, :name_extension, :date_of_birth, :sex, :gender, :religion, :mother_tongue, :indigenous_group, :is_indigenous, :completed, :address)');
        $stmt->bindValue(':user_id', (int)$account['user_id'], PDO::PARAM_INT);
        $stmt->bindValue(':lrn', $learnerValues['lrn']);
        $stmt->bindValue(':username', $account['username'] ?? $lrn);
        $stmt->bindValue(':password', $account['password_hash'] ?? password_hash($lrn, PASSWORD_BCRYPT));
        $stmt->bindValue(':role_id', $account['role_id'] ?? getLearnerRoleId($conn), PDO::PARAM_INT);
        $stmt->bindValue(':first_name', $data['first_name']);
        $stmt->bindValue(':middle_name', $data['middle_name'] ?? null);
        $stmt->bindValue(':last_name', $data['last_name']);
        $stmt->bindValue(':name_extension', $data['name_extension'] ?? ($data['name_extension_id'] ?? null));
        $stmt->bindValue(':date_of_birth', $learnerValues['date_of_birth']);
        $stmt->bindValue(':sex', $learnerValues['sex']);
        $stmt->bindValue(':gender', $learnerValues['gender']);
        $stmt->bindValue(':religion', $data['religion'] ?? ($data['religion_id'] ?? null));
        $stmt->bindValue(':mother_tongue', $data['mother_tongue'] ?? ($data['mother_tongue_id'] ?? null));
        $stmt->bindValue(':indigenous_group', $learnerValues['indigenous_group']);
        $stmt->bindValue(':is_indigenous', $learnerValues['is_indigenous'], PDO::PARAM_INT);
        $stmt->bindValue(':completed', (int)($data['completed'] ?? 0), PDO::PARAM_INT);
        $stmt->bindValue(':address', $data['address'] ?? null);
        $stmt->execute();

        $learnerId = (int)$conn->lastInsertId();
        $curriculumId = app_integrity_validate_enrollment($conn, [
            'section_id' => (int)$data['section_id'],
            'school_year_id' => $schoolYearId,
            'grade_level_id' => (int)$data['grade_level_id'],
            'enrollment_status' => 'Enrolled',
            'is_deleted' => 0,
        ]);
        $enroll = $conn->prepare('INSERT INTO enrollments (learner_id, school_year_id, grade_level_id, section_id, curriculum_id, enrollment_date, enrollment_status) VALUES (:learner_id, :school_year_id, :grade_level_id, :section_id, :curriculum_id, CURDATE(), "Enrolled")');
        $enroll->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
        $enroll->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $enroll->bindValue(':grade_level_id', $data['grade_level_id'], PDO::PARAM_INT);
        $enroll->bindValue(':section_id', $data['section_id'], PDO::PARAM_INT);
        $enroll->bindValue(':curriculum_id', $curriculumId, $curriculumId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $enroll->execute();

        $conn->commit();

        audit_log($conn, 'learners', $learnerId, 'INSERT', null, [
            'learner_id' => $learnerId,
            'lrn' => $lrn,
            'first_name' => $data['first_name'],
            'last_name' => $data['last_name'],
        ]);

        respond([
            'success' => true,
            'message' => 'Learner created',
            'learner_id' => $learnerId,
            'learner_account' => [
                'created' => (bool)($account['created'] ?? false),
                'linked' => true,
                'username' => (string)($account['username'] ?? $lrn),
            ]
        ]);
    } catch (PDOException $e) {
        if ($conn && $conn->inTransaction()) {
            $conn->rollBack();
        }
        if (is_name_extension_fk_violation($e)) {
            respond(name_extension_fk_error_payload(), 422);
        }
        if ((string)$e->getCode() === '23000') {
            respond(['success' => false, 'message' => 'Duplicate record (LRN or username already exists).'], 409);
        }
        throw $e;
    }
}

function updateLearner(PDO $conn): void {
    $data = getJsonInput();
    $lrn = trim((string)($data['lrn'] ?? ''));
    if (empty($data['learner_id']) || $lrn === '' || empty($data['first_name']) || empty($data['last_name']) || empty($data['grade_level_id']) || empty($data['section_id'])) {
        respond(['success' => false, 'message' => 'Learner ID, LRN, name, grade level, and section are required'], 422);
    }

    // Allow updates on legacy records with non-12-digit LRNs as long as the LRN is not being changed.
    $currentStmt = $conn->prepare('SELECT * FROM learners WHERE learner_id = :learner_id AND is_deleted = 0 LIMIT 1');
    $currentStmt->bindValue(':learner_id', (int)$data['learner_id'], PDO::PARAM_INT);
    $currentStmt->execute();
    $oldLearner = $currentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$oldLearner) {
        respond(['success' => false, 'message' => 'Learner not found'], 404);
    }
    $currentLrn = trim((string)$oldLearner['lrn']);

    if ($lrn !== $currentLrn) {
        if (!preg_match('/^\d{12}$/', $lrn)) {
            respond(['success' => false, 'message' => 'LRN must be exactly 12 digits'], 422);
        }
        $dup = $conn->prepare('SELECT learner_id FROM learners WHERE lrn = :lrn AND is_deleted = 0 AND learner_id <> :learner_id LIMIT 1');
        $dup->bindValue(':lrn', $lrn);
        $dup->bindValue(':learner_id', (int)$data['learner_id'], PDO::PARAM_INT);
        $dup->execute();
        if ($dup->fetchColumn()) {
            respond(['success' => false, 'message' => 'LRN already exists.'], 409);
        }
    }

    $conn->beginTransaction();
    $learnerValues = app_integrity_prepare_learner($conn, [
        'lrn' => $lrn,
        'date_of_birth' => $data['date_of_birth'] ?? null,
        'sex' => $data['sex'] ?? null,
        'gender' => $data['gender'] ?? null,
        'indigenous_group' => $data['indigenous_group'] ?? ($data['indigenous_group_id'] ?? null),
        'is_indigenous' => (int)($data['is_indigenous'] ?? 0),
    ], $oldLearner, false);

    $stmt = $conn->prepare('UPDATE learners
                            SET lrn = :lrn,
                                first_name = :first_name,
                                middle_name = :middle_name,
                                last_name = :last_name,
                                name_extension = :name_extension,
                                date_of_birth = :date_of_birth,
                                sex = :sex,
                                gender = :gender,
                                religion = :religion,
                                mother_tongue = :mother_tongue,
                                indigenous_group = :indigenous_group,
                                is_indigenous = :is_indigenous,
                                completed = :completed,
                                address = :address
                            WHERE learner_id = :learner_id');
    $stmt->bindValue(':lrn', $learnerValues['lrn']);
    $stmt->bindValue(':first_name', $data['first_name']);
    $stmt->bindValue(':middle_name', $data['middle_name'] ?? null);
    $stmt->bindValue(':last_name', $data['last_name']);
    $stmt->bindValue(':name_extension', $data['name_extension'] ?? ($data['name_extension_id'] ?? null));
    $stmt->bindValue(':date_of_birth', $learnerValues['date_of_birth']);
    $stmt->bindValue(':sex', $learnerValues['sex']);
    $stmt->bindValue(':gender', $learnerValues['gender']);
    $stmt->bindValue(':religion', $data['religion'] ?? ($data['religion_id'] ?? null));
    $stmt->bindValue(':mother_tongue', $data['mother_tongue'] ?? ($data['mother_tongue_id'] ?? null));
    $stmt->bindValue(':indigenous_group', $learnerValues['indigenous_group']);
    $stmt->bindValue(':is_indigenous', $learnerValues['is_indigenous'], PDO::PARAM_INT);
    $stmt->bindValue(':completed', (int)($data['completed'] ?? 0), PDO::PARAM_INT);
    $stmt->bindValue(':address', $data['address'] ?? null);
    $stmt->bindValue(':learner_id', $data['learner_id'], PDO::PARAM_INT);
    $stmt->execute();

    $latest = getLatestEnrollment($conn, (int)$data['learner_id']);

    if ($latest) {
        $curriculumId = app_integrity_validate_enrollment($conn, [
            'section_id' => (int)$data['section_id'],
            'school_year_id' => (int)$latest['school_year_id'],
            'grade_level_id' => (int)$data['grade_level_id'],
            'curriculum_id' => !empty($latest['curriculum_id']) ? (int)$latest['curriculum_id'] : null,
            'enrollment_status' => $latest['enrollment_status'] ?? 'Enrolled',
            'is_deleted' => 0,
        ], (int)$latest['enrollment_id']);
        $enroll = $conn->prepare('UPDATE enrollments SET grade_level_id = :grade_level_id, section_id = :section_id, curriculum_id = :curriculum_id WHERE enrollment_id = :enrollment_id');
        $enroll->bindValue(':grade_level_id', $data['grade_level_id'], PDO::PARAM_INT);
        $enroll->bindValue(':section_id', $data['section_id'], PDO::PARAM_INT);
        $enroll->bindValue(':curriculum_id', $curriculumId, $curriculumId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $enroll->bindValue(':enrollment_id', $latest['enrollment_id'], PDO::PARAM_INT);
        $enroll->execute();
    } else {
        $schoolYearId = getActiveSchoolYearId($conn);
        if (!$schoolYearId) {
            $conn->rollBack();
            respond(['success' => false, 'message' => 'No active school year found'], 409);
        }
        $curriculumId = app_integrity_validate_enrollment($conn, [
            'section_id' => (int)$data['section_id'],
            'school_year_id' => $schoolYearId,
            'grade_level_id' => (int)$data['grade_level_id'],
            'enrollment_status' => 'Enrolled',
            'is_deleted' => 0,
        ]);
        $enroll = $conn->prepare('INSERT INTO enrollments (learner_id, school_year_id, grade_level_id, section_id, curriculum_id, enrollment_date, enrollment_status) VALUES (:learner_id, :school_year_id, :grade_level_id, :section_id, :curriculum_id, CURDATE(), "Enrolled")');
        $enroll->bindValue(':learner_id', $data['learner_id'], PDO::PARAM_INT);
        $enroll->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $enroll->bindValue(':grade_level_id', $data['grade_level_id'], PDO::PARAM_INT);
        $enroll->bindValue(':section_id', $data['section_id'], PDO::PARAM_INT);
        $enroll->bindValue(':curriculum_id', $curriculumId, $curriculumId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $enroll->execute();
    }

    $conn->commit();

    $oldRow = audit_fetch_old($conn, 'learners', 'learner_id', (int)$data['learner_id']);
    audit_log($conn, 'learners', (int)$data['learner_id'], 'UPDATE', $oldRow, [
        'learner_id' => (int)$data['learner_id'],
        'lrn' => $lrn,
        'first_name' => $data['first_name'],
        'last_name' => $data['last_name'],
    ]);

    respond(['success' => true, 'message' => 'Learner updated']);
}

function deleteLearner(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['learner_id'])) {
        respond(['success' => false, 'message' => 'Learner ID is required'], 422);
    }

    $conn->beginTransaction();

    $stmt = $conn->prepare('UPDATE learners SET is_deleted = 1, deleted_at = NOW(), is_active = 0 WHERE learner_id = :learner_id');
    $stmt->bindValue(':learner_id', $data['learner_id'], PDO::PARAM_INT);
    $stmt->execute();

    $enroll = $conn->prepare('UPDATE enrollments SET is_deleted = 1, deleted_at = NOW() WHERE learner_id = :learner_id');
    $enroll->bindValue(':learner_id', $data['learner_id'], PDO::PARAM_INT);
    $enroll->execute();

    $conn->commit();

    $oldRow = audit_fetch_old($conn, 'learners', 'learner_id', (int)$data['learner_id']);
    audit_log($conn, 'learners', (int)$data['learner_id'], 'DELETE', $oldRow, null);

    respond(['success' => true, 'message' => 'Learner archived']);
}

function getActiveSchoolYearId(PDO $conn): ?int {
    $stmt = $conn->prepare('SELECT school_year_id FROM school_years WHERE is_active = 1 AND is_deleted = 0 ORDER BY year_start DESC LIMIT 1');
    $stmt->execute();
    $id = $stmt->fetchColumn();
    return $id ? (int)$id : null;
}

function getLatestEnrollment(PDO $conn, int $learnerId): ?array {
    $stmt = $conn->prepare(
        'SELECT * FROM enrollments
         WHERE learner_id = :learner_id AND is_deleted = 0
         ORDER BY
             (school_year_id = (SELECT school_year_id FROM school_years WHERE is_active = 1 AND is_deleted = 0 ORDER BY year_start DESC LIMIT 1)) DESC,
             enrollment_date DESC,
             enrollment_id DESC
         LIMIT 1'
    );
    $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}
?>
