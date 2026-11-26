<?php
header('Content-Type: application/json');
require_once __DIR__ . '/../utils/cors.php';

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/audit.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';

/**
 * Class Schedules API
 *
 * Writes go to class_schedules. teacher_id is denormalized from class_offerings
 * by ApplicationIntegrityService, which also enforces teacher conflict
 * detection and start_time < end_time ordering.
 *
 * Read roles : admin, teacher, registrar, learners
 * Write roles: admin/registrar (any), teacher (only schedules for offerings they own)
 */

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
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

function getAssignedTeacherIdForSchedule(PDO $conn, array $schedule): int {
    $classId = (int)($schedule['class_id'] ?? 0);
    if ($classId <= 0) {
        return (int)($schedule['teacher_id'] ?? 0);
    }

    $stmt = $conn->prepare(
        'SELECT teacher_id
         FROM class_offerings
         WHERE class_id = :class_id AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $stmt->execute();
    return (int)($stmt->fetchColumn() ?: 0);
}

function getActiveSchoolYearId(PDO $conn): int {
    return (int)($conn->query(
        'SELECT school_year_id
         FROM school_years
         WHERE is_active = 1 AND is_deleted = 0
         ORDER BY year_start DESC
         LIMIT 1'
    )->fetchColumn() ?: 0);
}

$VALID_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_WEEKLY_SCHEDULE_ENTRIES_PER_OFFERING = 5;

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

function columnExists(PDO $conn, string $table, string $column): bool {
    static $cache = [];
    if (!preg_match('/^[A-Za-z0-9_]+$/', $table) || !preg_match('/^[A-Za-z0-9_]+$/', $column)) return false;
    $key = $table . '.' . $column;
    if (array_key_exists($key, $cache)) return $cache[$key];
    $stmt = $conn->query("SHOW COLUMNS FROM `$table` LIKE " . $conn->quote($column));
    $cache[$key] = (bool)$stmt->fetch(PDO::FETCH_ASSOC);
    return $cache[$key];
}

function getSectionGradeLevelId(PDO $conn, int $sectionId): ?int {
    $stmt = $conn->prepare('SELECT grade_level_id FROM sections WHERE section_id = :section_id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ? (int)$row['grade_level_id'] : null;
}

function getCurriculumIdForSchoolYear(PDO $conn, int $schoolYearId): ?int {
    return app_integrity_get_curriculum_id_for_school_year($conn, $schoolYearId);
}

function getCurriculumSubjectsForGrade(PDO $conn, ?int $curriculumId, ?int $gradeLevelId): array {
    if (!$curriculumId || !$gradeLevelId) return [];
    $subjectCodeSelect = columnExists($conn, 'subjects', 'subject_code')
        ? 's.subject_code'
        : 'NULL AS subject_code';
    $stmt = $conn->prepare(
        "SELECT cs.subject_id, {$subjectCodeSelect}, s.subject_name,
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

/**
 * Return the schedule-facing time profile for one curriculum subject.
 * meeting_minutes is the total daily allowance for the subject. The legacy
 * weekly_minutes value remains a compatibility fallback until each subject
 * has been reviewed in the curriculum editor.
 */
function getSubjectScheduleSettings(PDO $conn, ?int $curriculumId, ?int $gradeLevelId, int $subjectId): array {
    if (!$curriculumId || !$gradeLevelId || $subjectId <= 0) return [];

    $meetingMinutes = columnExists($conn, 'curriculum_subjects', 'meeting_minutes')
        ? 'COALESCE(cs.meeting_minutes, cs.weekly_minutes)'
        : 'cs.weekly_minutes';
    $meetingsPerWeek = columnExists($conn, 'curriculum_subjects', 'meetings_per_week')
        ? 'cs.meetings_per_week'
        : 'NULL';
    $stmt = $conn->prepare(
        "SELECT {$meetingMinutes} AS meeting_minutes,
                {$meetingsPerWeek} AS meetings_per_week,
                cs.weekly_minutes
         FROM curriculum_subjects cs
         WHERE cs.curriculum_id = :curriculum_id
           AND cs.grade_level_id = :grade_level_id
           AND cs.subject_id = :subject_id
           AND cs.is_deleted = 0
         ORDER BY cs.curriculum_subject_id DESC
         LIMIT 1"
    );
    $stmt->execute([
        ':curriculum_id' => $curriculumId,
        ':grade_level_id' => $gradeLevelId,
        ':subject_id' => $subjectId,
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return [];

    return [
        'meeting_minutes' => $row['meeting_minutes'] === null ? null : (int)$row['meeting_minutes'],
        'meetings_per_week' => $row['meetings_per_week'] === null ? null : (int)$row['meetings_per_week'],
        'weekly_minutes' => $row['weekly_minutes'] === null ? null : (int)$row['weekly_minutes'],
    ];
}

function validateSubjectScheduleDuration(PDO $conn, ?int $curriculumId, ?int $gradeLevelId, int $subjectId, string $startTime, string $endTime, int $schoolYearId, int $sectionId, string $dayOfWeek, ?int $excludeScheduleId = null): void {
    $settings = getSubjectScheduleSettings($conn, $curriculumId, $gradeLevelId, $subjectId);
    $dailyLimitMinutes = (int)($settings['meeting_minutes'] ?? 0);
    if ($dailyLimitMinutes <= 0) return;

    $actualMinutes = durationMins($startTime, $endTime);
    $slotSubjectIds = getWeeklySlotCapSubjectIds($conn, $subjectId, $schoolYearId, $sectionId);
    $existingDailyMinutes = getSubjectScheduledMinutesOnDay(
        $conn,
        $schoolYearId,
        $sectionId,
        $slotSubjectIds,
        $dayOfWeek,
        $excludeScheduleId
    );
    if ($existingDailyMinutes + $actualMinutes > $dailyLimitMinutes) {
        respond([
            'success' => false,
            'message' => "This subject has {$existingDailyMinutes} of {$dailyLimitMinutes} daily minutes scheduled on {$dayOfWeek}. Adding {$actualMinutes} more would exceed the daily allowance.",
            'daily_limit_minutes' => $dailyLimitMinutes,
            'existing_daily_minutes' => $existingDailyMinutes,
            'requested_minutes' => $actualMinutes,
        ], 422);
    }
}

function normalizeSubjectCode(?string $code): string {
    return strtoupper(trim((string)$code));
}

function isMapehComponentName(?string $subjectName): bool {
    $name = strtolower(trim((string)$subjectName));
    if ($name === '') return false;
    if (str_contains($name, 'mapeh') && str_contains($name, 'component')) return true;
    if (str_contains($name, 'mapeh')) return false;
    return (bool)preg_match('/\b(music|arts|physical education|health|pe|p\.e\.)\b/i', $name);
}

function isMapehComponentRow(array $row, bool $allowNameFallback = false): bool {
    $code = normalizeSubjectCode($row['subject_code'] ?? '');
    $area = normalizeSubjectCode($row['area_code'] ?? '');
    $name = strtolower((string)($row['subject_name'] ?? ''));
    if (str_contains($name, 'mapeh') && !str_contains($name, 'component')) return false;
    if (str_contains($name, 'mapeh') && str_contains($name, 'component')) return true;
    if ($area === 'MAPEH') {
        if ($code === 'MAPEH') return false;
        if ($code !== '' || preg_match('/\b(music|arts|physical education|health|pe)\b/i', $name)) return true;
    }
    return $allowNameFallback && isMapehComponentName($name);
}

function isMapehClusterRow(array $row): bool {
    $code = normalizeSubjectCode($row['subject_code'] ?? '');
    $area = normalizeSubjectCode($row['area_code'] ?? '');
    $name = strtolower((string)($row['subject_name'] ?? ''));
    if (isMapehComponentRow($row)) return false;
    return $code === 'MAPEH' || $area === 'MAPEH' || str_contains($name, 'mapeh');
}

function getSchedulableSubjectIds(PDO $conn, ?int $curriculumId, ?int $gradeLevelId): array {
    $rows = getCurriculumSubjectsForGrade($conn, $curriculumId, $gradeLevelId);
    $subjectIds = array_values(array_unique(array_map('intval', array_column($rows, 'subject_id'))));
    $clusterIds = array_values(array_map(
        'intval',
        array_column(array_filter($rows, 'isMapehClusterRow'), 'subject_id')
    ));
    $hasCluster = count($clusterIds) > 0;
    $componentIds = [];
    foreach ($rows as $row) {
        if (isMapehComponentRow($row, $hasCluster)) {
            $componentIds[] = (int)($row['subject_id'] ?? 0);
        }
    }
    $componentIds = array_values(array_unique(array_filter($componentIds, static fn($id) => $id > 0)));

    if ($componentIds && $clusterIds) {
        $subjectIds = array_values(array_diff($subjectIds, $componentIds));
    }
    return $subjectIds;
}

function getWeeklySlotCapSubjectIds(PDO $conn, int $subjectId, int $schoolYearId, int $sectionId): array {
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    $gradeLevelId = getSectionGradeLevelId($conn, $sectionId);
    $rows = getCurriculumSubjectsForGrade($conn, $curriculumId, $gradeLevelId);
    $mapehComponentIds = [];
    foreach ($rows as $row) {
        if (isMapehComponentRow($row, true)) {
            $mapehComponentIds[] = (int)($row['subject_id'] ?? 0);
        }
    }
    $mapehComponentIds = array_values(array_unique(array_filter($mapehComponentIds, static fn($id) => $id > 0)));

    // The schedule selector presents grouped MAPEH components as one option,
    // so their five-slot allowance must be counted as one combined total.
    if (count($mapehComponentIds) > 1 && in_array($subjectId, $mapehComponentIds, true)) {
        return $mapehComponentIds;
    }
    return [$subjectId];
}

function getSubjectScheduledMinutesOnDay(PDO $conn, int $schoolYearId, int $sectionId, array $subjectIds, string $dayOfWeek, ?int $excludeScheduleId = null): int {
    $subjectIds = array_values(array_unique(array_filter(array_map('intval', $subjectIds), static fn($id) => $id > 0)));
    if ($schoolYearId <= 0 || $sectionId <= 0 || !$subjectIds || $dayOfWeek === '') return 0;

    $subjectPlaceholders = implode(',', array_map(
        static fn($index) => ':daily_subject_' . $index,
        array_keys($subjectIds)
    ));
    $sql = "SELECT COALESCE(SUM(TIME_TO_SEC(cs.end_time) - TIME_TO_SEC(cs.start_time)), 0) / 60
            FROM class_schedules cs
            JOIN class_offerings co ON co.class_id = cs.class_id AND co.is_deleted = 0
            WHERE co.section_id = :daily_section_id
              AND co.school_year_id = :daily_school_year_id
              AND co.subject_id IN ($subjectPlaceholders)
              AND cs.school_year_id = :daily_schedule_school_year_id
              AND cs.day_of_week = :daily_day_of_week
              AND cs.schedule_type = 'class'
              AND cs.is_deleted = 0";
    if ($excludeScheduleId !== null && $excludeScheduleId > 0) {
        $sql .= ' AND cs.schedule_id <> :daily_exclude_schedule_id';
    }

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':daily_section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':daily_school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':daily_schedule_school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':daily_day_of_week', $dayOfWeek);
    if ($excludeScheduleId !== null && $excludeScheduleId > 0) {
        $stmt->bindValue(':daily_exclude_schedule_id', $excludeScheduleId, PDO::PARAM_INT);
    }
    foreach ($subjectIds as $index => $subjectId) {
        $stmt->bindValue(':daily_subject_' . $index, $subjectId, PDO::PARAM_INT);
    }
    $stmt->execute();
    return (int)round((float)$stmt->fetchColumn());
}

function countSubjectScheduleDays(PDO $conn, int $schoolYearId, int $sectionId, array $subjectIds, ?int $excludeScheduleId = null): int {
    $subjectIds = array_values(array_unique(array_filter(array_map('intval', $subjectIds), static fn($id) => $id > 0)));
    if ($schoolYearId <= 0 || $sectionId <= 0 || !$subjectIds) return 0;

    $subjectPlaceholders = implode(',', array_map(
        static fn($index) => ':weekly_subject_' . $index,
        array_keys($subjectIds)
    ));
    $sql = "SELECT COUNT(DISTINCT cs.day_of_week)
            FROM class_schedules cs
            JOIN class_offerings co ON co.class_id = cs.class_id AND co.is_deleted = 0
            WHERE co.section_id = :weekly_section_id
              AND co.school_year_id = :weekly_school_year_id
              AND co.subject_id IN ($subjectPlaceholders)
              AND cs.school_year_id = :weekly_schedule_school_year_id
              AND cs.schedule_type = 'class'
              AND cs.is_deleted = 0";
    if ($excludeScheduleId !== null && $excludeScheduleId > 0) {
        $sql .= ' AND cs.schedule_id <> :weekly_exclude_schedule_id';
    }

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':weekly_section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':weekly_school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':weekly_schedule_school_year_id', $schoolYearId, PDO::PARAM_INT);
    if ($excludeScheduleId !== null && $excludeScheduleId > 0) {
        $stmt->bindValue(':weekly_exclude_schedule_id', $excludeScheduleId, PDO::PARAM_INT);
    }
    foreach ($subjectIds as $index => $subjectId) {
        $stmt->bindValue(':weekly_subject_' . $index, $subjectId, PDO::PARAM_INT);
    }
    $stmt->execute();
    return (int)$stmt->fetchColumn();
}

$operation = $_GET['operation'] ?? '';
$session = auth_enforce_roles($operation, ['admin', 'teacher', 'registrar', 'learners'], ['admin', 'teacher', 'registrar']);

try {
    switch ($operation) {
        case 'getAllSchedules':
            getAllSchedules($conn, $session);
            break;
        case 'getMySchedule':
            getMySchedule($conn, $session);
            break;
        case 'getOfferingsForSchedule':
            getOfferingsForSchedule($conn, $session);
            break;
        case 'createClassSchedule':
            createClassSchedule($conn, $session);
            break;
        case 'updateClassSchedule':
            updateClassSchedule($conn, $session);
            break;
        case 'deleteClassSchedule':
            deleteClassSchedule($conn, $session);
            break;
        case 'getClassSchedulePdf':
            exportPdf($conn, $session);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (ApplicationIntegrityException $e) {
    respond(['success' => false, 'message' => $e->getMessage()], $e->getCode());
} catch (PDOException $e) {
    // Trigger-raised SQLSTATE 45000 surfaces as part of the message.
    $msg = $e->getMessage();
    if (str_contains($msg, '45000')) {
        respond(['success' => false, 'message' => 'Schedule conflict: ' . $msg], 409);
    }
    respond(['success' => false, 'message' => 'Server error: ' . $msg], 500);
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

/* ════════════════════════════════════════════════════════════════
   DATA FETCHERS (used by read endpoints + PDF export)
   ════════════════════════════════════════════════════════════════ */

/**
 * Fetch schedules with the same permission rules as getAllSchedules.
 * Returns a plain array of rows instead of responding.
 */
function fetchAllSchedules(PDO $conn, array $session, array $filters): array {
    $roleKey      = $session['role_key'] ?? '';
    $isViewOnly   = in_array($roleKey, ['teacher', 'learners'], true);
    $schoolYearId = $isViewOnly ? getActiveSchoolYearId($conn) : (int)($filters['school_year_id'] ?? 0);
    $sectionId    = (int)($filters['section_id'] ?? 0);
    $gradeLevelId = (int)($filters['grade_level_id'] ?? 0);
    $teacherId    = (int)($filters['teacher_id'] ?? 0);

    if ($isViewOnly) {
        // The read-only grid is intentionally not filterable, including by
        // manually supplied query parameters.
        $sectionId = 0;
        $gradeLevelId = 0;
        $teacherId = 0;
    }

    // View-only roles are always bounded to the active school year. Learners
    // are additionally restricted to their own enrolled section.
    if ($roleKey === 'learners') {
        return fetchMySchedule($conn, $session, $schoolYearId > 0 ? $schoolYearId : null);
    }

    if ($schoolYearId <= 0) {
        $schoolYearId = getActiveSchoolYearId($conn);
    }
    if ($schoolYearId <= 0) {
        throw new Exception('school_year_id is required (no active school year found)', 422);
    }

    $isTeacher = $roleKey === 'teacher';
    $employeeId = $isTeacher ? getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0)) : 0;

    $sql = "SELECT cs.schedule_id, cs.class_id, cs.schedule_type, cs.activity_name,
                   COALESCE(co.teacher_id, cs.teacher_id) AS teacher_id,
                   cs.day_of_week,
                   TIME_FORMAT(cs.start_time, '%H:%i') AS start_time,
                   TIME_FORMAT(cs.end_time, '%H:%i') AS end_time,
                   cs.school_year_id, cs.section_id,
                   co.subject_id, sub.subject_name,
                   sec.section_name, gl.grade_name, sy.year_label,
                   CONCAT(emp.last_name, ', ', emp.first_name) AS teacher_name
            FROM class_schedules cs
            LEFT JOIN class_offerings co ON cs.class_id = co.class_id AND co.is_deleted = 0
            LEFT JOIN subjects sub       ON co.subject_id = sub.subject_id
            LEFT JOIN sections sec       ON cs.section_id = sec.section_id
            LEFT JOIN grade_levels gl    ON sec.grade_level_id = gl.grade_level_id
            LEFT JOIN school_years sy    ON cs.school_year_id = sy.school_year_id
            LEFT JOIN employees emp      ON emp.employee_id = COALESCE(co.teacher_id, cs.teacher_id)
            WHERE cs.is_deleted = 0
              AND cs.school_year_id = :school_year_id";

    $params = [':school_year_id' => $schoolYearId];

    if ($isTeacher) {
        // Teachers see their own subject schedules plus manual activities
        // published for the active school year.
        $sql .= " AND (cs.schedule_type <> 'class' OR COALESCE(co.teacher_id, cs.teacher_id) = :teacher_id)";
        $params[':teacher_id'] = $employeeId;
    } else {
        if ($teacherId > 0) {
            $sql .= " AND cs.schedule_type = 'class' AND COALESCE(co.teacher_id, cs.teacher_id) = :teacher_id";
            $params[':teacher_id'] = $teacherId;
        }
        if ($sectionId > 0) {
            $sql .= ' AND cs.section_id = :section_id';
            $params[':section_id'] = $sectionId;
        }
        if ($gradeLevelId > 0) {
            $sql .= ' AND sec.grade_level_id = :grade_level_id';
            $params[':grade_level_id'] = $gradeLevelId;
        }
    }

    $sql .= ' ORDER BY FIELD(cs.day_of_week, "Mon","Tue","Wed","Thu","Fri","Sat"), cs.start_time, COALESCE(sub.subject_name, cs.activity_name)';
    $stmt = $conn->prepare($sql);
    foreach ($params as $k => $v) {
        $stmt->bindValue($k, $v, is_int($v) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $stmt->execute();
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

/**
 * Fetch a learner's own schedule (same rules as getMySchedule).
 */
function fetchMySchedule(PDO $conn, array $session, ?int $schoolYearId = null): array {
    $roleKey = $session['role_key'] ?? '';
    $userId  = (int)($session['user_id'] ?? 0);

    if ($roleKey !== 'learners') {
        throw new Exception('This endpoint is for learners only', 403);
    }
    if ($userId <= 0) {
        throw new Exception('Not authenticated', 401);
    }

    $lStmt = $conn->prepare(
        'SELECT learner_id FROM learners WHERE user_id = :uid AND is_deleted = 0 LIMIT 1'
    );
    $lStmt->bindValue(':uid', $userId, PDO::PARAM_INT);
    $lStmt->execute();
    $learnerId = (int)($lStmt->fetchColumn() ?: 0);
    if ($learnerId <= 0) {
        throw new Exception('Learner profile not found for this account', 403);
    }

    if ($roleKey === 'learners' || $schoolYearId === null || $schoolYearId <= 0) {
        $schoolYearId = getActiveSchoolYearId($conn);
    }
    if ($schoolYearId <= 0) {
        throw new Exception('No active school year found', 422);
    }

    $eStmt = $conn->prepare(
        'SELECT section_id, grade_level_id FROM enrollments
          WHERE learner_id = :lid AND school_year_id = :syid
            AND is_deleted = 0 AND section_id IS NOT NULL
          ORDER BY enrollment_id DESC LIMIT 1'
    );
    $eStmt->bindValue(':lid',  $learnerId,    PDO::PARAM_INT);
    $eStmt->bindValue(':syid', $schoolYearId, PDO::PARAM_INT);
    $eStmt->execute();
    $enrollment = $eStmt->fetch(PDO::FETCH_ASSOC);

    if (!$enrollment || (int)($enrollment['section_id'] ?? 0) <= 0) {
        throw new Exception('No enrollment with a section found for this learner in the selected school year', 404);
    }

    $sectionId = (int)$enrollment['section_id'];

    $sql = "SELECT cs.schedule_id, cs.class_id, cs.schedule_type, cs.activity_name,
                   COALESCE(co.teacher_id, cs.teacher_id) AS teacher_id,
                   cs.day_of_week,
                   TIME_FORMAT(cs.start_time, '%H:%i') AS start_time,
                   TIME_FORMAT(cs.end_time, '%H:%i')   AS end_time,
                   cs.school_year_id, cs.section_id,
                   co.subject_id, sub.subject_name,
                   sec.section_name, gl.grade_name, sy.year_label,
                   CONCAT(emp.last_name, ', ', emp.first_name) AS teacher_name
            FROM class_schedules cs
            LEFT JOIN class_offerings co ON cs.class_id = co.class_id AND co.is_deleted = 0
            LEFT JOIN subjects sub       ON co.subject_id = sub.subject_id
            LEFT JOIN sections sec       ON cs.section_id = sec.section_id
            LEFT JOIN grade_levels gl    ON sec.grade_level_id = gl.grade_level_id
            LEFT JOIN school_years sy    ON cs.school_year_id = sy.school_year_id
            LEFT JOIN employees emp      ON emp.employee_id = COALESCE(co.teacher_id, cs.teacher_id)
            WHERE cs.is_deleted = 0
              AND cs.school_year_id = :school_year_id
              AND cs.section_id = :section_id
            ORDER BY FIELD(cs.day_of_week, 'Mon','Tue','Wed','Thu','Fri','Sat'),
                     cs.start_time, COALESCE(sub.subject_name, cs.activity_name)";

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':section_id',     $sectionId,    PDO::PARAM_INT);
    $stmt->execute();
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

/* ════════════════════════════════════════════════════════════════
   READ — getAllSchedules
   ════════════════════════════════════════════════════════════════ */
function getAllSchedules(PDO $conn, array $session): void {
    try {
        $rows = fetchAllSchedules($conn, $session, $_GET);
        respond($rows);
    } catch (Exception $e) {
        respond(['success' => false, 'message' => $e->getMessage()], $e->getCode() >= 400 && $e->getCode() < 600 ? $e->getCode() : 500);
    }
}

/* ════════════════════════════════════════════════════════════════
   READ — getMySchedule  (learner self-service)
   Looks up the logged-in learner's active enrollment, derives their
   section_id + school_year_id, and returns the class schedule for
   that section. Learners are read-only; no section filter override.
   ════════════════════════════════════════════════════════════════ */
function getMySchedule(PDO $conn, array $session): void {
    try {
        // Learner schedule display is always bounded to the active school year.
        $rows = fetchMySchedule($conn, $session, null);
        respond($rows);
    } catch (Exception $e) {
        respond(['success' => false, 'message' => $e->getMessage()], $e->getCode() >= 400 && $e->getCode() < 600 ? $e->getCode() : 500);
    }
}

/* ════════════════════════════════════════════════════════════════
   READ — getOfferingsForSchedule
   Returns active class offerings eligible to be scheduled for a
   given section + school year. Used to populate the offering dropdown
   in the Add Schedule modal.
   ════════════════════════════════════════════════════════════════ */
function getOfferingsForSchedule(PDO $conn, array $session): void {
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $sectionId    = (int)($_GET['section_id'] ?? 0);
    if ($schoolYearId <= 0 || $sectionId <= 0) {
        respond(['success' => false, 'message' => 'school_year_id and section_id are required'], 422);
    }

    $isTeacher = ($session['role_key'] ?? '') === 'teacher';
    $employeeId = $isTeacher ? getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0)) : 0;

    $gradeLevelId = getSectionGradeLevelId($conn, $sectionId);
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    $schedulableSubjectIds = getSchedulableSubjectIds($conn, $curriculumId, $gradeLevelId);
    if (!$schedulableSubjectIds) {
        respond([]);
    }

    // Use the latest active offering per subject, matching the class-offerings module.
    $canonicalOfferings = canonicalClassOfferingsSql();
    $subjectPlaceholders = implode(',', array_map(fn($i) => ':subject_' . $i, array_keys($schedulableSubjectIds)));

    $subjectCodeSelect = columnExists($conn, 'subjects', 'subject_code')
        ? 'sub.subject_code'
        : 'NULL AS subject_code';
    $meetingMinutesSelect = columnExists($conn, 'curriculum_subjects', 'meeting_minutes')
        ? 'COALESCE(cs_time.meeting_minutes, cs_time.weekly_minutes)'
        : 'cs_time.weekly_minutes';
    $meetingsPerWeekSelect = columnExists($conn, 'curriculum_subjects', 'meetings_per_week')
        ? 'cs_time.meetings_per_week'
        : 'NULL';
    $sql = "SELECT co.class_id, co.subject_id, sub.subject_name, {$subjectCodeSelect},
                   co.teacher_id, CONCAT(emp.last_name, ', ', emp.first_name) AS teacher_name,
                   {$meetingMinutesSelect} AS meeting_minutes,
                   {$meetingsPerWeekSelect} AS meetings_per_week,
                   (SELECT COUNT(DISTINCT cs.day_of_week) FROM class_schedules cs
                     WHERE cs.class_id = co.class_id
                       AND cs.school_year_id = co.school_year_id
                       AND cs.schedule_type = 'class'
                       AND cs.is_deleted = 0) AS schedule_count
            FROM ($canonicalOfferings) co
            JOIN subjects sub  ON co.subject_id = sub.subject_id
            JOIN employees emp ON co.teacher_id = emp.employee_id
            JOIN sections sec  ON sec.section_id = co.section_id AND sec.is_deleted = 0
            LEFT JOIN curriculum_subjects cs_time
              ON cs_time.curriculum_id = :curriculum_id
             AND cs_time.grade_level_id = sec.grade_level_id
             AND cs_time.subject_id = co.subject_id
             AND cs_time.is_deleted = 0
            WHERE co.school_year_id = :school_year_id
              AND co.section_id = :section_id
              AND co.subject_id IN ($subjectPlaceholders)";
    $params = [
        ':curriculum_id' => $curriculumId,
        ':school_year_id' => $schoolYearId,
        ':section_id' => $sectionId,
    ];
    foreach ($schedulableSubjectIds as $idx => $subjectId) {
        $params[':subject_' . $idx] = $subjectId;
    }

    if ($isTeacher) {
        $sql .= ' AND co.teacher_id = :teacher_id';
        $params[':teacher_id'] = $employeeId;
    }
    $sql .= ' ORDER BY sub.subject_name ASC';
    $stmt = $conn->prepare($sql);
    foreach ($params as $k => $v) {
        $stmt->bindValue($k, $v, PDO::PARAM_INT);
    }
    $stmt->execute();
    $offerings = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Some grade-level curricula store MAPEH as separate "Music and Arts"
    // and "Physical Education and Health" offerings without a parent row.
    // Keep one schedule choice for the shared MAPEH learning area in that case.
    $mapehParentIndex = null;
    $mapehComponentIndexes = [];
    foreach ($offerings as $index => $offering) {
        $code = normalizeSubjectCode($offering['subject_code'] ?? '');
        $name = strtolower(trim((string)($offering['subject_name'] ?? '')));
        if ($code === 'MAPEH' || (str_contains($name, 'mapeh') && !str_contains($name, 'component'))) {
            $mapehParentIndex = $index;
        } elseif (isMapehComponentName($name)) {
            $mapehComponentIndexes[] = $index;
        }
    }

    if ($mapehParentIndex !== null) {
        $offerings = array_values(array_filter(
            $offerings,
            static fn($offering) => !isMapehComponentName($offering['subject_name'] ?? '')
        ));
    } elseif (count($mapehComponentIndexes) > 1) {
        $parentOption = $offerings[$mapehComponentIndexes[0]];
        $parentOption['subject_name'] = 'MAPEH';
        $parentOption['subject_code'] = 'MAPEH';
        $mapehSubjectIds = array_values(array_unique(array_map(
            static fn($index) => (int)($offerings[$index]['subject_id'] ?? 0),
            $mapehComponentIndexes
        )));
        $parentOption['schedule_count'] = countSubjectScheduleDays(
            $conn,
            $schoolYearId,
            $sectionId,
            $mapehSubjectIds
        );
        $componentIndexSet = array_fill_keys($mapehComponentIndexes, true);
        $offerings = array_values(array_filter(
            $offerings,
            static fn($offering, $index) => !isset($componentIndexSet[$index]),
            ARRAY_FILTER_USE_BOTH
        ));
        $offerings[] = $parentOption;
    }

    $offerings = array_values(array_filter(
        $offerings,
        static fn($offering) => (int)($offering['schedule_count'] ?? 0) < MAX_WEEKLY_SCHEDULE_ENTRIES_PER_OFFERING
    ));

    respond($offerings);
}

/* ════════════════════════════════════════════════════════════════
   WRITE — createClassSchedule
   ════════════════════════════════════════════════════════════════ */
function createClassSchedule(PDO $conn, array $session): void {
    global $VALID_DAYS;
    $data = getJsonInput();

    $scheduleType = strtolower(trim((string)($data['schedule_type'] ?? 'class')));
    if (!in_array($scheduleType, ['class', 'fixed_activity'], true)) {
        respond(['success' => false, 'message' => 'schedule_type must be class or fixed_activity.'], 422);
    }
    $classId      = isset($data['class_id']) && $data['class_id'] !== '' ? (int)$data['class_id'] : null;
    $schoolYearId = (int)($data['school_year_id'] ?? 0);
    $sectionId    = (int)($data['section_id'] ?? 0);
    $dayOfWeek    = (string)($data['day_of_week'] ?? '');
    $startTime    = (string)($data['start_time'] ?? '');
    $endTime      = (string)($data['end_time'] ?? '');
    $activityName = trim((string)($data['activity_name'] ?? ''));

    if ($scheduleType === 'class' && ($classId === null || $classId <= 0)) {
        respond(['success' => false, 'message' => 'class_id is required'], 422);
    }
    if ($scheduleType === 'fixed_activity' && (($session['role_key'] ?? '') === 'teacher')) {
        respond(['success' => false, 'message' => 'Only administrators and registrars can publish manual activities.'], 403);
    }

    if (!in_array($dayOfWeek, $VALID_DAYS, true)) {
        respond(['success' => false, 'message' => 'day_of_week must be one of Mon, Tue, Wed, Thu, Fri, Sat'], 422);
    }
    if ($startTime === '' || $endTime === '') {
        respond(['success' => false, 'message' => 'start_time and end_time are required'], 422);
    }

    // Normalize time inputs to HH:MM:SS.
    $startTime = normalizeTime($startTime);
    $endTime   = normalizeTime($endTime);
    if ($startTime === null || $endTime === null) {
        respond(['success' => false, 'message' => 'Invalid time format (use HH:MM or HH:MM:SS)'], 422);
    }

    if ($scheduleType === 'fixed_activity') {
        if ($activityName === '') {
            respond(['success' => false, 'message' => 'activity_name is required for a manual activity'], 422);
        }
        if (mb_strlen($activityName) > 100) {
            respond(['success' => false, 'message' => 'activity_name must be 100 characters or fewer'], 422);
        }
        if ($schoolYearId <= 0 || $sectionId <= 0) {
            respond(['success' => false, 'message' => 'school_year_id and section_id are required for a manual activity'], 422);
        }

        $contextStmt = $conn->prepare(
            'SELECT
                EXISTS(SELECT 1 FROM school_years WHERE school_year_id = :school_year_id AND is_deleted = 0) AS valid_school_year,
                EXISTS(SELECT 1 FROM sections WHERE section_id = :section_id AND school_year_id = :section_school_year_id AND is_deleted = 0) AS valid_section'
        );
        $contextStmt->execute([
            ':school_year_id' => $schoolYearId,
            ':section_id' => $sectionId,
            ':section_school_year_id' => $schoolYearId,
        ]);
        $context = $contextStmt->fetch(PDO::FETCH_ASSOC) ?: [];
        if ((int)($context['valid_school_year'] ?? 0) !== 1 || (int)($context['valid_section'] ?? 0) !== 1) {
            respond(['success' => false, 'message' => 'The selected school year and section do not match an active section.'], 422);
        }

        $conn->beginTransaction();
        try {
            app_integrity_prepare_schedule($conn, [
                'class_id' => null,
                'teacher_id' => null,
                'school_year_id' => $schoolYearId,
                'day_of_week' => $dayOfWeek,
                'start_time' => $startTime,
                'end_time' => $endTime,
            ]);
            $stmt = $conn->prepare(
                'INSERT INTO class_schedules (class_id, teacher_id, schedule_type, activity_name, school_year_id, section_id, day_of_week, start_time, end_time)
                 VALUES (NULL, NULL, :schedule_type, :activity_name, :school_year_id, :section_id, :day_of_week, :start_time, :end_time)'
            );
            $stmt->bindValue(':schedule_type', $scheduleType);
            $stmt->bindValue(':activity_name', $activityName);
            $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
            $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
            $stmt->bindValue(':day_of_week', $dayOfWeek);
            $stmt->bindValue(':start_time', $startTime);
            $stmt->bindValue(':end_time', $endTime);
            $stmt->execute();
            $scheduleId = (int)$conn->lastInsertId();
            $conn->commit();
        } catch (PDOException $e) {
            if ($conn->inTransaction()) $conn->rollBack();
            throw conflictException($e);
        } catch (Throwable $e) {
            if ($conn->inTransaction()) $conn->rollBack();
            throw $e;
        }

        audit_log($conn, 'class_schedules', $scheduleId, 'INSERT', null, [
            'schedule_id' => $scheduleId,
            'schedule_type' => $scheduleType,
            'activity_name' => $activityName,
            'school_year_id' => $schoolYearId,
            'section_id' => $sectionId,
            'day_of_week' => $dayOfWeek,
            'start_time' => $startTime,
            'end_time' => $endTime,
        ]);
        respond(['success' => true, 'message' => 'Manual activity scheduled', 'schedule_id' => $scheduleId]);
    }

    // Derive school_year_id and section_id for class schedules from class_offerings
    $subjectId = 0;
    $metaStmt = $conn->prepare('SELECT school_year_id, section_id, subject_id FROM class_offerings WHERE class_id = :class_id AND is_deleted = 0 LIMIT 1');
    $metaStmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $metaStmt->execute();
    $meta = $metaStmt->fetch(PDO::FETCH_ASSOC);
    if ($meta) {
        // Class schedules must always belong to the class offering's school year and section.
        $schoolYearId = (int)$meta['school_year_id'];
        $sectionId    = (int)$meta['section_id'];
        $subjectId    = (int)$meta['subject_id'];
    }
    if ($schoolYearId <= 0 || $sectionId <= 0) {
        respond(['success' => false, 'message' => 'Could not derive school_year_id and section_id from class_offering'], 422);
    }
    $gradeLevelId = getSectionGradeLevelId($conn, $sectionId);
    $curriculumId = getCurriculumIdForSchoolYear($conn, $schoolYearId);
    validateSubjectScheduleDuration(
        $conn,
        $curriculumId,
        $gradeLevelId,
        $subjectId,
        $startTime,
        $endTime,
        $schoolYearId,
        $sectionId,
        $dayOfWeek
    );
    $schedulableSubjectIds = getSchedulableSubjectIds($conn, $curriculumId, $gradeLevelId);
    if (!in_array($subjectId, $schedulableSubjectIds, true)) {
        respond(['success' => false, 'message' => 'This class offering subject is not schedulable for the section curriculum and grade level'], 422);
    }

    // Authorization: teachers may only schedule their own offerings.
    $isTeacher = ($session['role_key'] ?? '') === 'teacher';
    if ($isTeacher) {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        $ownerCheck = $conn->prepare('SELECT teacher_id FROM class_offerings WHERE class_id = :class_id AND is_deleted = 0 LIMIT 1');
        $ownerCheck->bindValue(':class_id', $classId, PDO::PARAM_INT);
        $ownerCheck->execute();
        $ownerId = (int)($ownerCheck->fetchColumn() ?: 0);
        if ($ownerId !== $employeeId) {
            respond(['success' => false, 'message' => 'Not authorized to schedule this class offering'], 403);
        }
    }

    $conn->beginTransaction();
    try {
        $slotCapSubjectIds = getWeeklySlotCapSubjectIds($conn, $subjectId, $schoolYearId, $sectionId);
        $slotCapPlaceholders = implode(',', array_map(
            static fn($index) => ':slot_subject_' . $index,
            array_keys($slotCapSubjectIds)
        ));

        // Serialize slot additions for this offering (including grouped MAPEH
        // components) so concurrent requests cannot exceed the weekly cap.
        $offeringLock = $conn->prepare(
            'SELECT class_id FROM class_offerings
             WHERE section_id = :section_id
               AND school_year_id = :school_year_id
               AND subject_id IN (' . $slotCapPlaceholders . ')
               AND is_deleted = 0
             FOR UPDATE'
        );
        $offeringLock->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
        $offeringLock->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        foreach ($slotCapSubjectIds as $index => $slotSubjectId) {
            $offeringLock->bindValue(':slot_subject_' . $index, $slotSubjectId, PDO::PARAM_INT);
        }
        $offeringLock->execute();
        $lockedOfferingIds = $offeringLock->fetchAll(PDO::FETCH_COLUMN);
        if (!$lockedOfferingIds) {
            $conn->rollBack();
            respond(['success' => false, 'message' => 'Class offering not found or inactive.'], 422);
        }

        $weeklyCountStmt = $conn->prepare(
            "SELECT COUNT(DISTINCT cs.day_of_week)
             FROM class_schedules cs
             JOIN class_offerings co ON co.class_id = cs.class_id AND co.is_deleted = 0
             WHERE co.section_id = :section_id
               AND co.school_year_id = :school_year_id
               AND co.subject_id IN ($slotCapPlaceholders)
               AND cs.school_year_id = :schedule_school_year_id
               AND cs.schedule_type = 'class'
               AND cs.is_deleted = 0"
        );
        $weeklyCountStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
        $weeklyCountStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $weeklyCountStmt->bindValue(':schedule_school_year_id', $schoolYearId, PDO::PARAM_INT);
        foreach ($slotCapSubjectIds as $index => $slotSubjectId) {
            $weeklyCountStmt->bindValue(':slot_subject_' . $index, $slotSubjectId, PDO::PARAM_INT);
        }
        $weeklyCountStmt->execute();
        if ((int)$weeklyCountStmt->fetchColumn() >= MAX_WEEKLY_SCHEDULE_ENTRIES_PER_OFFERING) {
            $conn->rollBack();
            respond([
                'success' => false,
                'message' => 'This class offering has reached the maximum of 5 scheduled days per week.',
            ], 422);
        }

        $prepared = app_integrity_prepare_schedule($conn, [
            'class_id' => $classId,
            'teacher_id' => null,
            'school_year_id' => $schoolYearId,
            'day_of_week' => $dayOfWeek,
            'start_time' => $startTime,
            'end_time' => $endTime,
        ]);
        $teacherId = $prepared['teacher_id'];
        $stmt = $conn->prepare(
            'INSERT INTO class_schedules (class_id, teacher_id, schedule_type, activity_name, school_year_id, section_id, day_of_week, start_time, end_time)
             VALUES (:class_id, :teacher_id, :schedule_type, :activity_name, :school_year_id, :section_id, :day_of_week, :start_time, :end_time)'
        );
        $stmt->bindValue(':class_id',       $classId, $classId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->bindValue(':teacher_id',     $teacherId, $teacherId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->bindValue(':schedule_type',  $scheduleType);
        $stmt->bindValue(':activity_name',  null, PDO::PARAM_NULL);
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':section_id',     $sectionId, PDO::PARAM_INT);
        $stmt->bindValue(':day_of_week',    $dayOfWeek);
        $stmt->bindValue(':start_time',     $startTime);
        $stmt->bindValue(':end_time',       $endTime);
        $stmt->execute();
        $scheduleId = (int)$conn->lastInsertId();
        $conn->commit();
    } catch (PDOException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw conflictException($e);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
    audit_log($conn, 'class_schedules', $scheduleId, 'INSERT', null, [
        'schedule_id'    => $scheduleId,
        'class_id'       => $classId,
        'schedule_type'  => 'class',
        'school_year_id' => $schoolYearId,
        'section_id'     => $sectionId,
        'day_of_week'    => $dayOfWeek,
        'start_time'     => $startTime,
        'end_time'       => $endTime,
    ]);

    respond(['success' => true, 'message' => 'Schedule created', 'schedule_id' => $scheduleId]);
}

/* ════════════════════════════════════════════════════════════════
   WRITE — updateClassSchedule
   class_id is immutable here; teachers are scoped via the schedule's
   teacher_id (denormalized) which equals the offering's teacher_id.
   ════════════════════════════════════════════════════════════════ */
function updateClassSchedule(PDO $conn, array $session): void {
    global $VALID_DAYS;
    $data = getJsonInput();

    $scheduleId   = (int)($data['schedule_id'] ?? 0);
    $dayOfWeek    = (string)($data['day_of_week'] ?? '');
    $startTime    = (string)($data['start_time'] ?? '');
    $endTime      = (string)($data['end_time'] ?? '');
    $activityName = array_key_exists('activity_name', $data)
        ? trim((string)$data['activity_name'])
        : null;

    if ($scheduleId <= 0) {
        respond(['success' => false, 'message' => 'schedule_id is required'], 422);
    }
    if (!in_array($dayOfWeek, $VALID_DAYS, true)) {
        respond(['success' => false, 'message' => 'day_of_week must be one of Mon, Tue, Wed, Thu, Fri, Sat'], 422);
    }
    if ($startTime === '' || $endTime === '') {
        respond(['success' => false, 'message' => 'start_time and end_time are required'], 422);
    }

    $startTime = normalizeTime($startTime);
    $endTime   = normalizeTime($endTime);
    if ($startTime === null || $endTime === null) {
        respond(['success' => false, 'message' => 'Invalid time format (use HH:MM or HH:MM:SS)'], 422);
    }

    // Load existing row for auth + audit.
    $load = $conn->prepare('SELECT * FROM class_schedules WHERE schedule_id = :schedule_id AND is_deleted = 0 LIMIT 1');
    $load->bindValue(':schedule_id', $scheduleId, PDO::PARAM_INT);
    $load->execute();
    $oldRow = $load->fetch(PDO::FETCH_ASSOC);
    if (!$oldRow) {
        respond(['success' => false, 'message' => 'Schedule not found'], 404);
    }

    $scheduleType = (string)($oldRow['schedule_type'] ?? 'class');
    if (!in_array($scheduleType, ['class', 'fixed_activity'], true)) {
        respond(['success' => false, 'message' => 'This schedule entry type cannot be edited here.'], 422);
    }

    $isTeacher = ($session['role_key'] ?? '') === 'teacher';
    if ($scheduleType === 'fixed_activity' && $isTeacher) {
        respond(['success' => false, 'message' => 'Only administrators and registrars can edit manual activities.'], 403);
    }
    if ($isTeacher) {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        if (getAssignedTeacherIdForSchedule($conn, $oldRow) !== $employeeId) {
            respond(['success' => false, 'message' => 'Not authorized to edit this schedule'], 403);
        }
    }

    if ($scheduleType === 'fixed_activity') {
        $activityName = $activityName === null ? trim((string)($oldRow['activity_name'] ?? '')) : $activityName;
        if ($activityName === '') {
            respond(['success' => false, 'message' => 'activity_name is required for a manual activity'], 422);
        }
        if (mb_strlen($activityName) > 100) {
            respond(['success' => false, 'message' => 'activity_name must be 100 characters or fewer'], 422);
        }
    } else {
        $activityName = null;
        $classId = (int)($oldRow['class_id'] ?? 0);
        $metaStmt = $conn->prepare(
            'SELECT school_year_id, section_id, subject_id
             FROM class_offerings
             WHERE class_id = :class_id AND is_deleted = 0
             LIMIT 1'
        );
        $metaStmt->execute([':class_id' => $classId]);
        $meta = $metaStmt->fetch(PDO::FETCH_ASSOC);
        if (!$meta) {
            respond(['success' => false, 'message' => 'Class offering not found or inactive.'], 422);
        }
        $gradeLevelId = getSectionGradeLevelId($conn, (int)$meta['section_id']);
        $curriculumId = getCurriculumIdForSchoolYear($conn, (int)$meta['school_year_id']);
        validateSubjectScheduleDuration(
            $conn,
            $curriculumId,
            $gradeLevelId,
            (int)$meta['subject_id'],
            $startTime,
            $endTime,
            (int)$meta['school_year_id'],
            (int)$meta['section_id'],
            $dayOfWeek,
            $scheduleId
        );
    }

    $conn->beginTransaction();
    try {
        app_integrity_prepare_schedule($conn, [
            'class_id' => $oldRow['class_id'] ?? null,
            'teacher_id' => $oldRow['teacher_id'] ?? null,
            'school_year_id' => $oldRow['school_year_id'] ?? 0,
            'day_of_week' => $dayOfWeek,
            'start_time' => $startTime,
            'end_time' => $endTime,
        ], $scheduleId);
        $stmt = $conn->prepare(
            'UPDATE class_schedules
                SET day_of_week    = :day_of_week,
                    start_time     = :start_time,
                    end_time       = :end_time,
                    activity_name  = :activity_name
              WHERE schedule_id = :schedule_id'
        );
        $stmt->bindValue(':day_of_week',    $dayOfWeek);
        $stmt->bindValue(':start_time',     $startTime);
        $stmt->bindValue(':end_time',       $endTime);
        $stmt->bindValue(':activity_name',  $activityName, $activityName === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue(':schedule_id',    $scheduleId, PDO::PARAM_INT);
        $stmt->execute();
        $conn->commit();
    } catch (PDOException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw conflictException($e);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }

    audit_log($conn, 'class_schedules', $scheduleId, 'UPDATE', $oldRow, [
        'schedule_id'    => $scheduleId,
        'day_of_week'    => $dayOfWeek,
        'start_time'     => $startTime,
        'end_time'       => $endTime,
        'activity_name'  => $activityName,
    ]);

    respond(['success' => true, 'message' => 'Schedule updated']);
}

/* ════════════════════════════════════════════════════════════════
   WRITE — deleteClassSchedule (soft delete)
   ════════════════════════════════════════════════════════════════ */
function deleteClassSchedule(PDO $conn, array $session): void {
    $data = getJsonInput();
    $scheduleId = (int)($data['schedule_id'] ?? 0);
    if ($scheduleId <= 0) {
        respond(['success' => false, 'message' => 'schedule_id is required'], 422);
    }

    $load = $conn->prepare('SELECT * FROM class_schedules WHERE schedule_id = :schedule_id AND is_deleted = 0 LIMIT 1');
    $load->bindValue(':schedule_id', $scheduleId, PDO::PARAM_INT);
    $load->execute();
    $oldRow = $load->fetch(PDO::FETCH_ASSOC);
    if (!$oldRow) {
        respond(['success' => false, 'message' => 'Schedule not found'], 404);
    }
    $isTeacher = ($session['role_key'] ?? '') === 'teacher';
    if (($oldRow['schedule_type'] ?? 'class') === 'fixed_activity' && $isTeacher) {
        respond(['success' => false, 'message' => 'Only administrators and registrars can delete manual activities.'], 403);
    }
    if ($isTeacher) {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        if (getAssignedTeacherIdForSchedule($conn, $oldRow) !== $employeeId) {
            respond(['success' => false, 'message' => 'Not authorized to delete this schedule'], 403);
        }
    }

    $stmt = $conn->prepare('UPDATE class_schedules SET is_deleted = 1, deleted_at = NOW() WHERE schedule_id = :schedule_id');
    $stmt->bindValue(':schedule_id', $scheduleId, PDO::PARAM_INT);
    $stmt->execute();

    audit_log($conn, 'class_schedules', $scheduleId, 'DELETE', $oldRow, null);

    respond(['success' => true, 'message' => 'Schedule deleted']);
}

/* ════════════════════════════════════════════════════════════════
   PDF EXPORT — getClassSchedulePdf
   Loads schedule data, maps it to the files/template.js format, and
   proxies to the headless-Chrome PDF service defined in files/server.js.
   ════════════════════════════════════════════════════════════════ */
function exportPdf(PDO $conn, array $session): void {
    $data = getJsonInput();
    $format = strtolower(trim((string)($data['format'] ?? '')));
    if (!in_array($format, ['program', 'teacher', 'learner'], true)) {
        respond(['success' => false, 'message' => 'format must be one of: program, teacher, learner'], 400);
    }

    try {
        $roleKey = $session['role_key'] ?? '';
        $isLearner = $roleKey === 'learners';

        // 1. Load schedule rows
        if ($isLearner) {
            $schoolYearId = (int)($data['school_year_id'] ?? 0);
            $rows = fetchMySchedule($conn, $session, $schoolYearId > 0 ? $schoolYearId : null);
        } else {
            $rows = fetchAllSchedules($conn, $session, [
                'school_year_id' => $data['school_year_id'] ?? 0,
                'section_id'     => $data['section_id'] ?? 0,
                'grade_level_id' => $data['grade_level_id'] ?? 0,
                'teacher_id'     => $data['teacher_id'] ?? 0,
            ]);
        }

        if (empty($rows)) {
            respond(['success' => false, 'message' => 'No schedule data to export.'], 404);
        }

        // 2. Build meta
        $first = $rows[0];
        $schoolYearId = (int)($first['school_year_id'] ?? 0);
        $sectionId    = (int)($first['section_id'] ?? 0);
        $gradeName    = (string)($first['grade_name'] ?? '');
        $sectionName  = (string)($first['section_name'] ?? '');
        $yearLabel    = (string)($first['year_label'] ?? '');

        $settings = loadSchoolSettingsMap($conn);
        $school   = (string)($settings['school_name'] ?? $settings['schoolName'] ?? 'School Name');
        $schoolId = (string)($settings['school_id'] ?? $settings['schoolId'] ?? '');
        $head     = (string)($settings['school_head_name'] ?? $settings['school_head'] ?? $settings['principal_name'] ?? '');

        $adviser = '';
        if ($sectionId > 0) {
            $advStmt = $conn->prepare(
                "SELECT CONCAT(COALESCE(e.last_name, ''), CASE WHEN e.last_name IS NOT NULL THEN ', ' ELSE '' END, COALESCE(e.first_name, '')) AS adviser_name
                 FROM sections s
                 LEFT JOIN employees e ON s.adviser_id = e.employee_id
                 WHERE s.section_id = :section_id AND s.is_deleted = 0
                 LIMIT 1"
            );
            $advStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
            $advStmt->execute();
            $adviser = (string)($advStmt->fetchColumn() ?? '');
        }

        $meta = [
            'school'        => $school,
            'gradeSection'  => trim("$gradeName — $sectionName"),
            'schoolYear'    => $yearLabel,
            'adviser'       => $adviser,
            // Extra context the template does not use but may help debugging.
            '_schoolId'     => $schoolId,
            '_head'         => $head,
        ];

        // 3. Map DB rows to template.js row shape
        $templateRows = array_map(function ($row) use ($format) {
            $start = (string)($row['start_time'] ?? '');
            $end   = (string)($row['end_time'] ?? '');
            $mins  = durationMins($start, $end);
            $day   = strtolower((string)($row['day_of_week'] ?? ''));
            $teacher = (string)($row['teacher_name'] ?? '');
            $name = trim((string)($row['subject_name'] ?? ''));
            if ($name === '') $name = trim((string)($row['activity_name'] ?? ''));

            return [
                'start'   => formatTime($start),
                'end'     => formatTime($end),
                'mins'    => $mins,
                'name'    => $name,
                'teacher' => $teacher,
                'room'    => (string)($row['room'] ?? ''),
                'type'    => (string)($row['schedule_type'] ?? 'class'),
                'day'     => $day,
            ];
        }, $rows);

        // 4. Call the Node PDF service
        $serviceUrl = getenv('PDF_SERVICE_URL') ?: 'http://localhost:3001/api/export-pdf';
        $filename   = sprintf('ClassSchedule_%s_%s.pdf', ucfirst($format), preg_replace('/[^A-Za-z0-9_-]/', '_', $sectionName ?: 'export'));

        $payload = json_encode([
            'format'   => $format,
            'meta'     => $meta,
            'rows'     => $templateRows,
            'filename' => $filename,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        if (!extension_loaded('curl')) {
            respond(['success' => false, 'message' => 'cURL extension is required for PDF export'], 500);
        }

        $ch = curl_init($serviceUrl);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'Accept: application/pdf',
            ],
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT        => 60,
            CURLOPT_FOLLOWLOCATION => true,
        ]);
        $pdfBody = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlErr  = curl_error($ch);
        curl_close($ch);

        if ($pdfBody === false || $curlErr !== '') {
            respond(['success' => false, 'message' => 'Could not reach PDF service: ' . $curlErr], 503);
        }
        if ($httpCode !== 200) {
            respond(['success' => false, 'message' => 'PDF service returned HTTP ' . $httpCode . ': ' . substr($pdfBody, 0, 500)], 503);
        }

        // 5. Stream PDF to client
        if (!headers_sent()) {
            header('Content-Type: application/pdf');
            header('Content-Disposition: attachment; filename="' . $filename . '"');
            header('Content-Length: ' . strlen($pdfBody));
            header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
        }
        echo $pdfBody;
        exit;

    } catch (Exception $e) {
        respond(['success' => false, 'message' => $e->getMessage()], $e->getCode() >= 400 && $e->getCode() < 600 ? $e->getCode() : 500);
    }
}

function loadSchoolSettingsMap(PDO $conn): array {
    $stmt = $conn->prepare("SELECT setting_key, setting_value FROM school_settings WHERE is_deleted = 0");
    $stmt->execute();
    $map = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $map[$row['setting_key']] = $row['setting_value'];
    }
    return $map;
}

function formatTime(string $time24): string {
    if (!preg_match('/^(\d{1,2}):(\d{2})(?::\d{2})?$/', $time24, $m)) {
        return $time24;
    }
    $h = (int)$m[1];
    $min = $m[2];
    $ampm = $h >= 12 ? 'PM' : 'AM';
    $h12 = $h % 12;
    if ($h12 === 0) $h12 = 12;
    return "$h12:$min $ampm";
}

function durationMins(string $start, string $end): int {
    $toMins = function (string $t): int {
        $parts = explode(':', $t);
        $h = (int)($parts[0] ?? 0);
        $m = (int)($parts[1] ?? 0);
        return $h * 60 + $m;
    };
    return max(0, $toMins($end) - $toMins($start));
}

/* ════════════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════════════ */
function normalizeTime(string $value): ?string {
    $value = trim($value);
    if ($value === '') return null;
    // Accept HH:MM or HH:MM:SS.
    if (preg_match('/^\d{1,2}:\d{2}(:\d{2})?$/', $value)) {
        $parts = explode(':', $value);
        $h = str_pad((string)(int)$parts[0], 2, '0', STR_PAD_LEFT);
        $m = str_pad((string)(int)$parts[1], 2, '0', STR_PAD_LEFT);
        $s = isset($parts[2]) ? str_pad((string)(int)$parts[2], 2, '0', STR_PAD_LEFT) : '00';
        if ((int)$h > 23 || (int)$m > 59) return null;
        return "$h:$m:$s";
    }
    return null;
}

function conflictException(PDOException $e): PDOException {
    // The 45000 signal from triggers already carries a clear message;
    // just bubble it up so the catch block can map it to HTTP 409.
    return $e;
}
?>
