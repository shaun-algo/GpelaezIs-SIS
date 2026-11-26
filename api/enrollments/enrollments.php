<?php
header('Content-Type: application/json');

require_once __DIR__ . '/../utils/cors.php';


require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/notifications.php';
require_once __DIR__ . '/../utils/audit.php';
require_once __DIR__ . '/../utils/password_policy.php';
require_once __DIR__ . '/../utils/account_credentials.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';
require_once __DIR__ . '/../services/DescriptiveProgressionService.php';
require_once __DIR__ . '/../services/EnrollmentLifecycleService.php';
require_once __DIR__ . '/../services/EnrollmentEntryClassificationService.php';

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

function ensureLearnerUserAccount(PDO $conn, int $learnerId): array {
    $stmt = $conn->prepare('SELECT learner_id, user_id, lrn, username FROM learners WHERE learner_id = :id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':id', $learnerId, PDO::PARAM_INT);
    $stmt->execute();
    $learner = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$learner) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        respond(['success' => false, 'message' => 'Learner not found'], 404);
    }

    $existingUserId = isset($learner['user_id']) ? (int)($learner['user_id'] ?? 0) : 0;
    if ($existingUserId > 0) {
        return ['created' => false, 'linked' => true, 'user_id' => $existingUserId, 'username' => (string)($learner['username'] ?? $learner['lrn'] ?? '')];
    }

    $lrn = trim((string)($learner['lrn'] ?? ''));
    if ($lrn === '') {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        respond(['success' => false, 'message' => 'Learner LRN is missing; cannot create account'], 422);
    }

    $username = $lrn;

    $existing = account_credentials_find_by_username($conn, $username);
    if ($existing) {
        if (($existing['account_type'] ?? '') !== 'learner' || (int)($existing['actor_id'] ?? 0) !== $learnerId) {
            if ($conn->inTransaction()) {
                $conn->rollBack();
            }
            respond(['success' => false, 'message' => 'An existing account with this LRN is already linked.'], 409);
        }
    }

    $roleId = getLearnerRoleId($conn);
    $newUserId = account_identity_create($conn, $roleId);

    $link = $conn->prepare('UPDATE learners SET user_id = :uid, username = :username, password = :password, role_id = :role_id, is_active = 1, account_created_at = COALESCE(account_created_at, NOW()) WHERE learner_id = :lid AND is_deleted = 0');
    $link->bindValue(':uid', $newUserId, PDO::PARAM_INT);
    $link->bindValue(':username', $username);
    $link->bindValue(':password', password_hash($lrn, PASSWORD_BCRYPT));
    $link->bindValue(':role_id', $roleId, PDO::PARAM_INT);
    $link->bindValue(':lid', $learnerId, PDO::PARAM_INT);
    $link->execute();
    // Preserve the former learners password-change trigger behavior for the
    // account-linking path, which writes a credential after learner creation.
    app_integrity_bump_auth_version_for_learner($conn, $learnerId);

    return ['created' => true, 'linked' => true, 'user_id' => $newUserId, 'username' => $username];
}

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function getPrimaryCurriculumIdForSchoolYear(PDO $conn, int $schoolYearId): ?int {
    if ($schoolYearId <= 0) return null;
    $stmt = $conn->prepare(
        'SELECT curriculum_id
         FROM curriculum_school_year_map
         WHERE school_year_id = :sid
           AND is_deleted = 0
           AND is_primary = 1
         ORDER BY map_id DESC
         LIMIT 1'
    );
    $stmt->bindValue(':sid', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $val = $stmt->fetchColumn();
    return $val ? (int)$val : null;
}

function isCurriculumMappedToSchoolYear(PDO $conn, int $curriculumId, int $schoolYearId): bool {
    $stmt = $conn->prepare(
        'SELECT 1
         FROM curriculum_school_year_map
         WHERE curriculum_id = :cid
           AND school_year_id = :sid
           AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':cid', $curriculumId, PDO::PARAM_INT);
    $stmt->bindValue(':sid', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    return (bool)$stmt->fetchColumn();
}

function curriculumHasGradeLevelsConfigured(PDO $conn, int $curriculumId): bool {
    $stmt = $conn->prepare('SELECT COUNT(*) FROM curriculum_grade_levels WHERE curriculum_id = :cid AND is_deleted = 0');
    $stmt->bindValue(':cid', $curriculumId, PDO::PARAM_INT);
    $stmt->execute();
    return ((int)$stmt->fetchColumn()) > 0;
}

function curriculumCoversGradeLevel(PDO $conn, int $curriculumId, int $gradeLevelId): bool {
    $stmt = $conn->prepare(
        'SELECT 1
         FROM curriculum_grade_levels
         WHERE curriculum_id = :cid
           AND grade_level_id = :gid
           AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':cid', $curriculumId, PDO::PARAM_INT);
    $stmt->bindValue(':gid', $gradeLevelId, PDO::PARAM_INT);
    $stmt->execute();
    return (bool)$stmt->fetchColumn();
}

function resolveAndValidateCurriculum(PDO $conn, ?int $curriculumId, int $schoolYearId, int $gradeLevelId): ?int {
    try {
        return app_integrity_resolve_curriculum_for_school_year(
            $conn,
            $schoolYearId,
            $curriculumId,
            $gradeLevelId
        );
    } catch (ApplicationIntegrityException $e) {
        respond(['success' => false, 'message' => $e->getMessage()], $e->getCode() ?: 422);
    }
}

function validateSectionConsistency(PDO $conn, int $sectionId, int $schoolYearId, int $gradeLevelId): void {
    $stmt = $conn->prepare('SELECT section_id, school_year_id, grade_level_id FROM sections WHERE section_id = :section_id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        respond(['success' => false, 'message' => 'Selected section not found'], 422);
    }
    if ((int)$row['school_year_id'] !== (int)$schoolYearId) {
        respond(['success' => false, 'message' => 'Selected section does not belong to the selected school year'], 422);
    }
    if ((int)$row['grade_level_id'] !== (int)$gradeLevelId) {
        respond(['success' => false, 'message' => 'Selected section does not match the selected grade level'], 422);
    }
}

function getLatestPromotionForLearner(PDO $conn, int $learnerId, int $targetSchoolYearId): ?array {
    $stmt = $conn->prepare(
        'SELECT
            lp.progression_id,
            lp.school_year_id,
            sy.year_label,
            sy.year_start,
            lp.current_grade_level_id,
            cgl.grade_name AS current_grade_name,
            lp.next_grade_level_id,
            ngl.grade_name AS next_grade_name,
            lp.final_status,
            lp.is_processed
         FROM learner_progression lp
         JOIN school_years sy ON sy.school_year_id = lp.school_year_id
         JOIN grade_levels cgl ON cgl.grade_level_id = lp.current_grade_level_id
         LEFT JOIN grade_levels ngl ON ngl.grade_level_id = lp.next_grade_level_id
         WHERE lp.learner_id = :learner_id
           AND lp.school_year_id < :target_sy
         ORDER BY sy.year_start DESC, lp.created_at DESC
         LIMIT 1'
    );
    $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $stmt->bindValue(':target_sy', $targetSchoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function isPromotionValidationOverridable(?int $enrollmentTypeId): bool {
    return true;
}

function getLatestPriorDescriptiveEnrollment(PDO $conn, int $learnerId, int $targetSchoolYearId): ?array {
    $stmt = $conn->prepare(
        'SELECT e.enrollment_id,
                e.school_year_id,
                e.grade_level_id,
                sy.year_label,
                sy.year_start
         FROM enrollments e
         JOIN school_years sy ON sy.school_year_id = e.school_year_id
         WHERE e.learner_id = :learner_id
           AND e.school_year_id < :target_school_year_id
           AND e.is_deleted = 0
         ORDER BY sy.year_start DESC, e.enrollment_id DESC
         LIMIT 1'
    );
    $stmt->execute([
        ':learner_id' => $learnerId,
        ':target_school_year_id' => $targetSchoolYearId,
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;

    if (!DescriptiveProgressionService::isGradeOneDescriptive(
        $conn,
        (int)$row['school_year_id'],
        (int)$row['grade_level_id']
    )) {
        return null;
    }

    return array_merge($row, [
        'descriptive_evidence' => DescriptiveProgressionService::evidenceForEnrollment(
            $conn,
            (int)$row['enrollment_id']
        ),
    ]);
}

function validatePromotionEligibility(PDO $conn, int $learnerId, int $targetSchoolYearId, int $selectedGradeLevelId, ?int $enrollmentTypeId = null, bool $override = false): array {
    // Grade 1 descriptive records do not create numeric final grades or a
    // general average. Resolve their promotion from complete PACE ratings
    // before consulting any legacy/stale numeric progression row.
    $descriptivePrior = getLatestPriorDescriptiveEnrollment($conn, $learnerId, $targetSchoolYearId);
    if ($descriptivePrior) {
        $evidence = $descriptivePrior['descriptive_evidence'];
        if (empty($evidence['complete'])) {
            $missingTerms = array_map(
                static fn(int $term): string => 'Term ' . $term,
                array_values(array_map('intval', $evidence['missing_terms'] ?? []))
            );
            return [
                'valid' => false,
                'requires_override' => false,
                'message' => 'Grade 1 promotion is blocked until all required descriptive PACE A-E ratings for Terms 1-3 are complete'
                    . ($missingTerms ? ' (' . implode(', ', $missingTerms) . ')' : '') . '.',
                'previous_school_year_id' => (int)$descriptivePrior['school_year_id'],
                'previous_school_year_label' => $descriptivePrior['year_label'],
            ];
        }

        $nextStmt = $conn->prepare(
            'SELECT next_grade_level_id
             FROM grade_level_progression
             WHERE grade_level_id = :grade_level_id
             LIMIT 1'
        );
        $nextStmt->execute([':grade_level_id' => (int)$descriptivePrior['grade_level_id']]);
        $recommendedGradeLevelId = (int)($nextStmt->fetchColumn() ?: 0);
        if ($recommendedGradeLevelId === $selectedGradeLevelId) {
            return [
                'valid' => true,
                'requires_override' => false,
                'message' => 'Selected grade matches the complete Grade 1 descriptive PACE promotion recommendation.',
                'recommended_grade_level_id' => $recommendedGradeLevelId,
                'previous_final_status' => 'Promoted',
                'previous_school_year_id' => (int)$descriptivePrior['school_year_id'],
                'previous_school_year_label' => $descriptivePrior['year_label'],
            ];
        }

        $recommendedNameStmt = $conn->prepare('SELECT grade_name FROM grade_levels WHERE grade_level_id = :grade_level_id LIMIT 1');
        $recommendedNameStmt->execute([':grade_level_id' => $recommendedGradeLevelId]);
        $recommendedName = (string)($recommendedNameStmt->fetchColumn() ?: 'the next grade');
        return [
            'valid' => false,
            'requires_override' => $override || isPromotionValidationOverridable($enrollmentTypeId),
            'message' => 'Grade mismatch: complete Grade 1 descriptive records recommend ' . $recommendedName . ' for the target school year.',
            'recommended_grade_level_id' => $recommendedGradeLevelId,
            'recommended_grade_name' => $recommendedName,
            'previous_final_status' => 'Promoted',
            'previous_school_year_id' => (int)$descriptivePrior['school_year_id'],
            'previous_school_year_label' => $descriptivePrior['year_label'],
        ];
    }

    $promotion = getLatestPromotionForLearner($conn, $learnerId, $targetSchoolYearId);
    if (!$promotion) {
        return ['valid' => true, 'requires_override' => false, 'message' => 'No prior promotion record on file.'];
    }

    $finalStatus = $promotion['final_status'];
    if ($finalStatus === 'Completed' && empty($promotion['next_grade_level_id'])) {
        return [
            'valid' => false,
            'requires_override' => $override,
            'message' => 'This learner has already completed the terminal grade level and should not be re-enrolled.',
            'previous_final_status' => $finalStatus,
            'previous_school_year_id' => (int)$promotion['school_year_id'],
            'previous_school_year_label' => $promotion['year_label'],
        ];
    }

    $recommendedGradeLevelId = $promotion['next_grade_level_id'] ? (int)$promotion['next_grade_level_id'] : (int)$promotion['current_grade_level_id'];
    if ($recommendedGradeLevelId === $selectedGradeLevelId) {
        return [
            'valid' => true,
            'requires_override' => false,
            'message' => 'Selected grade matches promotion recommendation.',
            'recommended_grade_level_id' => $recommendedGradeLevelId,
            'recommended_grade_name' => $promotion['next_grade_name'] ?? $promotion['current_grade_name'],
            'previous_final_status' => $finalStatus,
        ];
    }

    $message = 'Grade mismatch: based on the ' . ($promotion['year_label'] ?? 'previous') . ' record, the learner is ' . $finalStatus
        . ' and should enroll in ' . ($promotion['next_grade_name'] ?? $promotion['current_grade_name'])
        . ' for the target school year.';

    return [
        'valid' => false,
        'requires_override' => $override || isPromotionValidationOverridable($enrollmentTypeId),
        'message' => $message,
        'recommended_grade_level_id' => $recommendedGradeLevelId,
        'recommended_grade_name' => $promotion['next_grade_name'] ?? $promotion['current_grade_name'],
        'previous_final_status' => $finalStatus,
        'previous_school_year_id' => (int)$promotion['school_year_id'],
        'previous_school_year_label' => $promotion['year_label'],
    ];
}

$operation = $_GET['operation'] ?? '';
$readRoles = ['admin'];
$writeRoles = ['admin'];

if (in_array($operation, ['getAllEnrollments', 'createEnrollment', 'updateEnrollment', 'deleteEnrollment'], true)) {
    $readRoles[] = 'registrar';
    $readRoles[] = 'teacher';
}
if (in_array($operation, ['createEnrollment', 'updateEnrollment', 'deleteEnrollment'], true)) {
    $writeRoles[] = 'registrar';
    $writeRoles[] = 'teacher';
}

$session = auth_enforce_roles($operation, $readRoles, $writeRoles);
try {
    switch ($operation) {
        case 'getAllEnrollments': getAllEnrollments($conn, $session); break;
        case 'createEnrollment': createEnrollment($conn, $session); break;
        case 'updateEnrollment': updateEnrollment($conn, $session); break;
        case 'deleteEnrollment': deleteEnrollment($conn); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (ApplicationIntegrityException $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    respond(['success' => false, 'message' => $e->getMessage()], $e->getCode());
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllEnrollments(PDO $conn, array $session): void {
    $isTeacher = (($session['role_key'] ?? '') === 'teacher');
    $employeeId = $isTeacher ? getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0)) : 0;

    $sql = "SELECT e.enrollment_id, e.enrollment_date, e.enrollment_type_id, et.type_name,
                   e.entry_classification,
                   e.enrollment_status, e.status_updated_at,
                   e.grade_level_id, gl.grade_name, e.section_id, sec.section_name,
                   e.school_year_id, sy.year_label, sy.year_start, sy.year_end,
                   e.curriculum_id, cur.curriculum_name, cur.curriculum_code,
                   e.learner_id, CONCAT(l.last_name, ', ', l.first_name) AS learner_name
            FROM enrollments e
            JOIN learners l ON e.learner_id = l.learner_id
            LEFT JOIN enrollment_types et ON e.enrollment_type_id = et.enrollment_type_id
            LEFT JOIN grade_levels gl ON e.grade_level_id = gl.grade_level_id
            LEFT JOIN sections sec ON e.section_id = sec.section_id
            LEFT JOIN school_years sy ON e.school_year_id = sy.school_year_id
            LEFT JOIN curricula cur ON e.curriculum_id = cur.curriculum_id
            WHERE e.is_deleted = 0";

    if ($isTeacher) {
        // Teachers can only see enrollments for sections where they have an
        // assigned subject. Adviser status alone does not grant learner-list access.
        $sql .= " AND (
                    e.section_id IN (
                        SELECT section_id FROM class_offerings
                        WHERE teacher_id = :teacher_id AND is_deleted = 0
                    )
                 )";
    }

    $sql .= " ORDER BY e.enrollment_id DESC";
    $stmt = $conn->prepare($sql);
    
    if ($isTeacher) {
        $stmt->bindValue(':teacher_id', $employeeId, PDO::PARAM_INT);
    }
    
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function createEnrollment(PDO $conn, array $session): void {
    $data = getJsonInput();
    if (empty($data['learner_id']) || empty($data['school_year_id']) || empty($data['grade_level_id']) || empty($data['section_id'])) {
        respond(['success' => false, 'message' => 'Learner, school year, grade level, and section are required'], 422);
    }

    $schoolYearId = (int)$data['school_year_id'];
    $gradeLevelId = (int)$data['grade_level_id'];
    $sectionId = (int)$data['section_id'];

    // Teachers can only enroll students in sections they teach or advise
    $isTeacher = (($session['role_key'] ?? '') === 'teacher');
    if ($isTeacher) {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        $checkSql = "SELECT 1 FROM sections WHERE section_id = :sid AND adviser_id = :teacher_id AND is_deleted = 0
                     UNION
                     SELECT 1 FROM class_offerings WHERE section_id = :sid AND teacher_id = :teacher_id AND is_deleted = 0
                     LIMIT 1";
        $checkStmt = $conn->prepare($checkSql);
        $checkStmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
        $checkStmt->bindValue(':teacher_id', $employeeId, PDO::PARAM_INT);
        $checkStmt->execute();
        if (!$checkStmt->fetchColumn()) {
            respond(['success' => false, 'message' => 'Access denied: You can only enroll students in sections you teach or advise'], 403);
        }
    }

    validateSectionConsistency($conn, $sectionId, $schoolYearId, $gradeLevelId);

    $resolvedCurriculumId = resolveAndValidateCurriculum(
        $conn,
        isset($data['curriculum_id']) && $data['curriculum_id'] !== '' ? (int)$data['curriculum_id'] : null,
        $schoolYearId,
        $gradeLevelId
    );

    $enrollmentTypeId = !empty($data['enrollment_type_id']) ? (int)$data['enrollment_type_id'] : null;
    $entryClassification = EnrollmentEntryClassificationService::normalize($data['entry_classification'] ?? null)
        ?? EnrollmentEntryClassificationService::fromEnrollmentTypeId($conn, $enrollmentTypeId);

    // DepEd progression validation: warn if selected grade does not match the learner's
    // most recent promotion decision (Promoted / Conditionally Promoted / Retained / Completed).
    $overridePromotion = !empty($data['override_promotion_validation']);
    $promotionCheck = $entryClassification === 'Transfer-In'
        ? ['valid' => true, 'requires_override' => false, 'message' => 'Transfer-In enrollment uses the imported placement.']
        : validatePromotionEligibility(
            $conn,
            (int)$data['learner_id'],
            $schoolYearId,
            $gradeLevelId,
            $enrollmentTypeId,
            $overridePromotion
        );
    if (!$promotionCheck['valid'] && empty($promotionCheck['requires_override'])) {
        respond(['success' => false, 'message' => $promotionCheck['message'], 'promotion_check' => $promotionCheck], 422);
    }
    if (!$promotionCheck['valid'] && !$overridePromotion) {
        respond(['success' => false, 'message' => $promotionCheck['message'], 'promotion_check' => $promotionCheck, 'requires_override' => true], 422);
    }

    // Default to today's date (server time) when not provided.
    $enrollmentDate = !empty($data['enrollment_date']) ? $data['enrollment_date'] : date('Y-m-d');

    try {
        $enrollmentStatus = (new EnrollmentLifecycleService($conn))->normalizeStatus($data['enrollment_status'] ?? 'Enrolled');
    } catch (InvalidArgumentException $e) {
        respond(['success' => false, 'message' => $e->getMessage()], 422);
    }

    if (($session['role_key'] ?? '') === 'teacher' && $enrollmentStatus !== 'Enrolled') {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        $adviserCheck = $conn->prepare(
            'SELECT 1 FROM sections
             WHERE section_id = :section_id
               AND school_year_id = :school_year_id
               AND adviser_id = :adviser_id
               AND is_deleted = 0
             LIMIT 1'
        );
        $adviserCheck->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
        $adviserCheck->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $adviserCheck->bindValue(':adviser_id', $employeeId, PDO::PARAM_INT);
        $adviserCheck->execute();
        if (!$adviserCheck->fetchColumn()) {
            respond(['success' => false, 'message' => 'Only the class adviser assigned to this section can create a non-active enrollment status.'], 403);
        }
    }

    $enrollmentId = 0;
    $account = null;

    try {
        $conn->beginTransaction();

        // promotion_status was removed from the schema; tolerat=e legacy payloads by ignoring it.
        $resolvedCurriculumId = app_integrity_validate_enrollment($conn, [
            'section_id' => $sectionId,
            'school_year_id' => $schoolYearId,
            'grade_level_id' => $gradeLevelId,
            'curriculum_id' => $resolvedCurriculumId,
            'enrollment_status' => $enrollmentStatus,
            'is_deleted' => 0,
        ]);
        $stmt = $conn->prepare('INSERT INTO enrollments (learner_id, school_year_id, grade_level_id, section_id, enrollment_type_id, entry_classification, curriculum_id, enrollment_date, enrollment_status) VALUES (:learner_id, :school_year_id, :grade_level_id, :section_id, :enrollment_type_id, :entry_classification, :curriculum_id, :enrollment_date, :enrollment_status)');
        $stmt->bindValue(':learner_id', $data['learner_id'], PDO::PARAM_INT);
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':grade_level_id', $gradeLevelId, PDO::PARAM_INT);
        $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
        $stmt->bindValue(
            ':enrollment_type_id',
            $enrollmentTypeId,
            $enrollmentTypeId === null ? PDO::PARAM_NULL : PDO::PARAM_INT
        );
        bindNullable($stmt, ':entry_classification', $entryClassification);
        $stmt->bindValue(':curriculum_id', $resolvedCurriculumId, $resolvedCurriculumId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->bindValue(':enrollment_date', $enrollmentDate);
        $stmt->bindValue(':enrollment_status', $enrollmentStatus);
        $stmt->execute();
        $enrollmentId = (int)$conn->lastInsertId();

        $movementService = new EnrollmentMovementService($conn);
        $manualMovementContext = [
            'source_type' => EnrollmentMovementService::SOURCE_MANUAL_ENROLLMENT,
            'user_id' => (int)($session['user_id'] ?? 0),
        ];
        $movementService->recordStatusChange(
            $enrollmentId,
            null,
            $enrollmentStatus,
            $manualMovementContext
        );
        $movementService->recordTransferIn(
            $enrollmentId,
            null,
            $entryClassification,
            $manualMovementContext
        );

        // Auto-create/link learner login account.
        $account = ensureLearnerUserAccount($conn, (int)$data['learner_id']);

        // Audit log (inside transaction so it rolls back on error)
        audit_log($conn, 'enrollments', $enrollmentId, 'INSERT', null, [
            'enrollment_id' => $enrollmentId,
            'learner_id' => (int)$data['learner_id'],
            'school_year_id' => $schoolYearId,
            'grade_level_id' => $gradeLevelId,
            'section_id' => $sectionId,
            'enrollment_status' => $enrollmentStatus,
        ]);

        $conn->commit();
    } catch (PDOException $e) {
        if ($conn && $conn->inTransaction()) {
            $conn->rollBack();
        }
        if ((string)$e->getCode() === '23000') {
            respond(['success' => false, 'message' => 'Duplicate record (username/LRN conflict).'], 409);
        }
        // Triggers use SIGNAL SQLSTATE '45000'
        if ((string)$e->getCode() === '45000') {
            respond(['success' => false, 'message' => $e->getMessage()], 409);
        }
        throw $e;
    } catch (Exception $e) {
        if ($conn && $conn->inTransaction()) {
            $conn->rollBack();
        }
        throw $e;
    }

    // Create in-app notifications for admin + teacher.
    try {
        $infoStmt = $conn->prepare(
            "SELECT CONCAT(l.last_name, ', ', l.first_name) AS learner_name,
                    sy.year_label,
                    gl.grade_name,
                    sec.section_name
             FROM enrollments e
             JOIN learners l ON e.learner_id = l.learner_id
             LEFT JOIN school_years sy ON e.school_year_id = sy.school_year_id
             LEFT JOIN grade_levels gl ON e.grade_level_id = gl.grade_level_id
             LEFT JOIN sections sec ON e.section_id = sec.section_id
             WHERE e.enrollment_id = :id"
        );
        $infoStmt->bindValue(':id', $enrollmentId, PDO::PARAM_INT);
        $infoStmt->execute();
        $info = $infoStmt->fetch(PDO::FETCH_ASSOC) ?: [];

        $learnerName = (string)($info['learner_name'] ?? '');
        $yearLabel = (string)($info['year_label'] ?? '');
        $gradeName = (string)($info['grade_name'] ?? '');
        $sectionName = (string)($info['section_name'] ?? '');

        $title = 'New Enrollment';
        $parts = array_values(array_filter([
            $learnerName !== '' ? "Learner: {$learnerName}" : null,
            $yearLabel !== '' ? "S.Y.: {$yearLabel}" : null,
            $gradeName !== '' ? "Grade: {$gradeName}" : null,
            $sectionName !== '' ? "Section: {$sectionName}" : null,
        ]));
        $message = count($parts) ? implode(' • ', $parts) : 'A new enrollment was created.';

        // If we created an account, append a short note for staff.
        if (is_array($account) && !empty($account['created']) && !empty($account['username'])) {
            $message .= ' • Learner login created (username: ' . (string)$account['username'] . ')';
        }

        $adminRoleId = notifications_get_role_id($conn, 'admin');
        $teacherRoleId = notifications_get_role_id($conn, 'teacher');
        if ($adminRoleId !== null) {
            notifications_create_for_role($conn, (int)$adminRoleId, 'Announcement', $title, $message, 'enrollments', $enrollmentId, null, null, (int)($session['user_id'] ?? 0));
        }
        if ($teacherRoleId !== null) {
            notifications_create_for_role($conn, (int)$teacherRoleId, 'Announcement', $title, $message, 'enrollments', $enrollmentId, null, null, (int)($session['user_id'] ?? 0));
        }
    } catch (Exception $e) {
        // Never block enrollment creation if notifications fail.
    }

    respond([
        'success' => true,
        'message' => 'Enrollment created',
        'enrollment_id' => $enrollmentId,
        'learner_account' => [
            'created' => (bool)($account['created'] ?? false),
            'linked' => (bool)($account['linked'] ?? false),
            'username' => (string)($account['username'] ?? ''),
        ]
    ]);
}

function updateEnrollment(PDO $conn, array $session = []): void {
    $data = getJsonInput();
    if (empty($data['enrollment_id']) || empty($data['learner_id']) || empty($data['school_year_id']) || empty($data['grade_level_id']) || empty($data['section_id'])) {
        respond(['success' => false, 'message' => 'Enrollment ID, learner, school year, grade level, and section are required'], 422);
    }

    $schoolYearId = (int)$data['school_year_id'];
    $gradeLevelId = (int)$data['grade_level_id'];
    $sectionId = (int)$data['section_id'];

    validateSectionConsistency($conn, $sectionId, $schoolYearId, $gradeLevelId);

    $resolvedCurriculumId = resolveAndValidateCurriculum(
        $conn,
        isset($data['curriculum_id']) && $data['curriculum_id'] !== '' ? (int)$data['curriculum_id'] : null,
        $schoolYearId,
        $gradeLevelId
    );

    $enrollmentTypeProvided = array_key_exists('enrollment_type_id', $data);
    $enrollmentTypeId = $enrollmentTypeProvided && $data['enrollment_type_id'] !== ''
        ? (int)$data['enrollment_type_id'] : null;
    $entryClassification = EnrollmentEntryClassificationService::normalize($data['entry_classification'] ?? null);
    if ($entryClassification === null && $enrollmentTypeProvided) {
        $entryClassification = EnrollmentEntryClassificationService::fromEnrollmentTypeId($conn, $enrollmentTypeId);
    }

    $existingClassification = null;
    if (!$enrollmentTypeProvided && empty($data['entry_classification'])) {
        $existingStmt = $conn->prepare('SELECT entry_classification FROM enrollments WHERE enrollment_id = :id LIMIT 1');
        $existingStmt->bindValue(':id', (int)$data['enrollment_id'], PDO::PARAM_INT);
        $existingStmt->execute();
        $existingClassification = $existingStmt->fetchColumn();
        $entryClassification = $existingClassification === false ? null : $existingClassification;
    }

    // DepEd progression validation on grade/school-year changes.
    $overridePromotion = !empty($data['override_promotion_validation']);
    $promotionCheck = $entryClassification === 'Transfer-In'
        ? ['valid' => true, 'requires_override' => false, 'message' => 'Transfer-In enrollment uses the imported placement.']
        : validatePromotionEligibility(
            $conn,
            (int)$data['learner_id'],
            $schoolYearId,
            $gradeLevelId,
            $enrollmentTypeId,
            $overridePromotion
        );
    if (!$promotionCheck['valid'] && empty($promotionCheck['requires_override'])) {
        respond(['success' => false, 'message' => $promotionCheck['message'], 'promotion_check' => $promotionCheck], 422);
    }
    if (!$promotionCheck['valid'] && !$overridePromotion) {
        respond(['success' => false, 'message' => $promotionCheck['message'], 'promotion_check' => $promotionCheck, 'requires_override' => true], 422);
    }

    // If enrollment_date is omitted/blank, keep existing enrollment_date.
    $enrollmentStatusIsSet = array_key_exists('enrollment_status', $data) ? 1 : 0;

    $oldRow = audit_fetch_old($conn, 'enrollments', 'enrollment_id', (int)$data['enrollment_id']);
    if (!$oldRow) {
        respond(['success' => false, 'message' => 'Enrollment not found'], 404);
    }

    $enrollmentStatus = $enrollmentStatusIsSet === 1 ? ($data['enrollment_status'] ?? '') : '';
    if ($enrollmentStatusIsSet === 1 && $enrollmentStatus !== '') {
        try {
            $enrollmentStatus = (new EnrollmentLifecycleService($conn))->normalizeStatus($enrollmentStatus);
        } catch (InvalidArgumentException $e) {
            respond(['success' => false, 'message' => $e->getMessage()], 422);
        }

        $roleKey = (string)($session['role_key'] ?? '');
        if ($roleKey === 'teacher') {
            $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
            $adviserCheck = $conn->prepare(
                'SELECT 1 FROM sections
                 WHERE section_id = :section_id
                   AND school_year_id = :school_year_id
                   AND adviser_id = :adviser_id
                   AND is_deleted = 0
                 LIMIT 1'
            );
            $adviserCheck->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
            $adviserCheck->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
            $adviserCheck->bindValue(':adviser_id', $employeeId, PDO::PARAM_INT);
            $adviserCheck->execute();
            if (!$adviserCheck->fetchColumn()) {
                respond(['success' => false, 'message' => 'Enrollment status is locked. Only the class adviser assigned to this section can update it.'], 403);
            }
        } elseif (!in_array($roleKey, ['admin', 'registrar'], true)) {
            respond(['success' => false, 'message' => 'Enrollment status is locked for this account.'], 403);
        }
    }
    // promotion_status was removed from the schema; tolerate legacy payloads by ignoring it.

    $setParts = [
        'learner_id = :learner_id',
        'school_year_id = :school_year_id',
        'grade_level_id = :grade_level_id',
        'section_id = :section_id',
        'enrollment_type_id = :enrollment_type_id',
        'entry_classification = :entry_classification',
        'curriculum_id = :curriculum_id',
        'enrollment_date = COALESCE(NULLIF(:enrollment_date, ""), enrollment_date)'
    ];

    $sql = 'UPDATE enrollments SET ' . implode(', ', $setParts) . ' WHERE enrollment_id = :enrollment_id';

    try {
        $conn->beginTransaction();
        $resolvedCurriculumId = app_integrity_validate_enrollment($conn, [
        'section_id' => $sectionId,
        'school_year_id' => $schoolYearId,
        'grade_level_id' => $gradeLevelId,
        'curriculum_id' => $resolvedCurriculumId,
        'enrollment_status' => $enrollmentStatusIsSet === 1 && $enrollmentStatus !== '' ? $enrollmentStatus : 'Enrolled',
        'is_deleted' => 0,
        ], (int)$data['enrollment_id']);

        $stmt = $conn->prepare($sql);
        $stmt->bindValue(':learner_id', $data['learner_id'], PDO::PARAM_INT);
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':grade_level_id', $gradeLevelId, PDO::PARAM_INT);
        $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
        $stmt->bindValue(
            ':enrollment_type_id',
            $enrollmentTypeId,
            $enrollmentTypeId === null ? PDO::PARAM_NULL : PDO::PARAM_INT
        );
        bindNullable($stmt, ':entry_classification', $entryClassification);
        $stmt->bindValue(':curriculum_id', $resolvedCurriculumId, $resolvedCurriculumId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->bindValue(':enrollment_date', !empty($data['enrollment_date']) ? $data['enrollment_date'] : '');
        if ($enrollmentStatusIsSet === 1) {
            $stmt->bindValue(':enrollment_status', $enrollmentStatus);
        }
        $stmt->bindValue(':enrollment_id', $data['enrollment_id'], PDO::PARAM_INT);
        $stmt->execute();

        (new EnrollmentMovementService($conn))->recordTransferIn(
            (int)$data['enrollment_id'],
            $oldRow['entry_classification'] ?? null,
            $entryClassification,
            [
                'source_type' => EnrollmentMovementService::SOURCE_MANUAL_ENROLLMENT,
                'user_id' => (int)($session['user_id'] ?? 0),
            ]
        );

        if ($enrollmentStatusIsSet === 1
            && $enrollmentStatus !== ''
            && ($oldRow['enrollment_status'] ?? '') !== $enrollmentStatus) {
            (new EnrollmentLifecycleService($conn))->setStatus(
                (int)$data['enrollment_id'],
                $enrollmentStatus,
                'manualEnrollmentUpdate',
                'Status changed from the Enrollments masterfile.',
                [
                    'source_type' => EnrollmentMovementService::SOURCE_MANUAL_ENROLLMENT,
                    'user_id' => (int)($_SESSION['user_id'] ?? 0),
                ]
            );
        }

        audit_log($conn, 'enrollments', (int)$data['enrollment_id'], 'UPDATE', $oldRow, [
            'enrollment_id' => (int)$data['enrollment_id'],
            'learner_id' => (int)$data['learner_id'],
            'school_year_id' => $schoolYearId,
            'grade_level_id' => $gradeLevelId,
            'section_id' => $sectionId,
            'enrollment_status' => $enrollmentStatusIsSet === 1 && $enrollmentStatus !== ''
                ? $enrollmentStatus
                : ($oldRow['enrollment_status'] ?? null),
        ]);

        $conn->commit();

        respond(['success' => true, 'message' => 'Enrollment updated']);
    } catch (ApplicationIntegrityException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => $e->getMessage()], $e->getCode());
    } catch (PDOException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        if ((string)$e->getCode() === '45000') {
            respond(['success' => false, 'message' => $e->getMessage()], 409);
        }
        throw $e;
    }
}

function deleteEnrollment(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['enrollment_id'])) {
        respond(['success' => false, 'message' => 'Enrollment ID is required'], 422);
    }
    $stmt = $conn->prepare('UPDATE enrollments SET is_deleted = 1, deleted_at = NOW() WHERE enrollment_id = :enrollment_id');
    $stmt->bindValue(':enrollment_id', $data['enrollment_id'], PDO::PARAM_INT);
    $stmt->execute();

    $oldRow = audit_fetch_old($conn, 'enrollments', 'enrollment_id', (int)$data['enrollment_id']);
    audit_log($conn, 'enrollments', (int)$data['enrollment_id'], 'DELETE', $oldRow, null);

    respond(['success' => true, 'message' => 'Enrollment deleted']);
}
?>
