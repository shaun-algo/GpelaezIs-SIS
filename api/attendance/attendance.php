<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';

const ATTENDANCE_META_CONTRACT_VERSION = 'attendance.getMeta.v2';
const ATTENDANCE_COLUMN_INFO_CACHE_TTL_SECONDS = 300;

function debug_attendance($msg, $data = null): void {
    if (getenv('ATTENDANCE_DEBUG') !== '1') return;
    $log = date('Y-m-d H:i:s ') . "[attendance.php {$msg}]";
    if ($data !== null) $log .= ' ' . json_encode($data);
    $log .= "\n";
    @file_put_contents('/tmp/attendance_debug.log', $log, FILE_APPEND | LOCK_EX);
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

function requireTeacherCanAccessSection(PDO $conn, int $employeeId, int $sectionId, int $schoolYearId): void {
    $stmt = $conn->prepare(
        'SELECT 1 FROM DUAL
         WHERE EXISTS (
             SELECT 1 FROM class_offerings co
             WHERE co.section_id = :sid AND co.school_year_id = :sy AND co.is_deleted = 0
               AND co.teacher_id = :eid
         ) OR EXISTS (
             SELECT 1 FROM sections s
             WHERE s.section_id = :adviser_sid AND s.school_year_id = :adviser_sy
               AND s.is_deleted = 0 AND s.adviser_id = :adviser_eid
         )
         LIMIT 1'
    );
    $stmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':eid', $employeeId, PDO::PARAM_INT);
    $stmt->bindValue(':adviser_sid', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':adviser_sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':adviser_eid', $employeeId, PDO::PARAM_INT);
    $stmt->execute();
    if (!$stmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Not authorized for this section. Assign the teacher as adviser or assign a subject offering first.'], 403);
    }
}

function requireTeacherOwnsClassOffering(PDO $conn, int $employeeId, int $classId, int $sectionId, int $schoolYearId): void {
    // `class_id = 0` is used by the UI for section-level (non-subject) attendance.
    // A teacher still needs at least one assigned subject in the section.
    if ($classId <= 0) {
        requireTeacherCanAccessSection($conn, $employeeId, $sectionId, $schoolYearId);
        return;
    }

    $stmt = $conn->prepare(
        'SELECT class_id
         FROM class_offerings
        WHERE class_id = :class_id
           AND is_deleted = 0
           AND section_id = :sid
           AND school_year_id = :sy
           AND (teacher_id = :eid OR EXISTS (
               SELECT 1 FROM sections s
               WHERE s.section_id = :adviser_sid AND s.school_year_id = :adviser_sy
                 AND s.is_deleted = 0 AND s.adviser_id = :adviser_eid
           ))
         LIMIT 1'
    );
    $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $stmt->bindValue(':eid', $employeeId, PDO::PARAM_INT);
    $stmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':adviser_sid', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':adviser_sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':adviser_eid', $employeeId, PDO::PARAM_INT);
    $stmt->execute();
    if (!$stmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Not authorized for this class offering or adviser assignment'], 403);
    }
}

function classIdForDb(?int $classId): ?int {
    return ($classId !== null && $classId > 0) ? $classId : null;
}

function requireAttendanceGradingPeriodContext(PDO $conn, int $gradingPeriodId, int $schoolYearId): void {
    $stmt = $conn->prepare(
        'SELECT 1
         FROM grading_periods
         WHERE grading_period_id = :grading_period_id
           AND school_year_id = :school_year_id
           AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':grading_period_id', $gradingPeriodId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    if (!$stmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Grading period does not belong to the selected school year'], 422);
    }
}

function requireAttendanceClassContext(PDO $conn, ?int $classId, int $sectionId, int $schoolYearId): void {
    if ($classId === null) return;

    $stmt = $conn->prepare(
        'SELECT 1
         FROM class_offerings
         WHERE class_id = :class_id
           AND section_id = :section_id
           AND school_year_id = :school_year_id
           AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    if (!$stmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Class offering does not belong to the selected section and school year'], 422);
    }
}

/**
 * Attendance remains visible for every live enrollment while the school year
 * is active, including Completed learners who are waiting for progression or
 * promotion processing. Only a dropped or transferred-out enrollment leaves
 * the attendance roster. Keep NULL as live for legacy rows.
 */
function attendanceActiveEnrollmentCondition(string $alias = ''): string {
    $prefix = $alias === '' ? '' : rtrim($alias, '.') . '.';
    return "({$prefix}enrollment_status NOT IN ('Dropped', 'Transferred Out') OR {$prefix}enrollment_status IS NULL)";
}

function requireAttendanceEnrollmentContext(PDO $conn, int $enrollmentId, int $sectionId, int $schoolYearId): void {
    $stmt = $conn->prepare(
        'SELECT 1
         FROM enrollments
         WHERE enrollment_id = :enrollment_id
           AND section_id = :section_id
           AND school_year_id = :school_year_id
           AND is_deleted = 0
           AND ' . attendanceActiveEnrollmentCondition() . '
         LIMIT 1'
    );
    $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    if (!$stmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Enrollment does not belong to the selected section and school year or is not currently Enrolled'], 422);
    }
}

function monthBounds(string $ym): array {
    // ym format: YYYY-MM
    if (!preg_match('/^\d{4}-\d{2}$/', $ym)) {
        respond(['success' => false, 'message' => 'Invalid month format. Expected YYYY-MM.'], 422);
    }
    [$y, $m] = array_map('intval', explode('-', $ym));
    if ($y < 2000 || $y > 2100 || $m < 1 || $m > 12) {
        respond(['success' => false, 'message' => 'Invalid month value.'], 422);
    }
    $start = sprintf('%04d-%02d-01', $y, $m);
    $end = date('Y-m-t', strtotime($start));
    return [$y, $m, $start, $end];
}

function countWeekdaysInMonth(int $year, int $month): int {
    $start = new DateTime(sprintf('%04d-%02d-01', $year, $month));
    $end = new DateTime($start->format('Y-m-t'));
    $end = $end->modify('+1 day');

    $count = 0;
    for ($d = clone $start; $d < $end; $d->modify('+1 day')) {
        $dow = (int)$d->format('N'); // 1=Mon..7=Sun
        if ($dow >= 1 && $dow <= 5) $count++;
    }
    return $count;
}

function countWeekdaysBetween(?string $startDate, ?string $endDate): int {
    if (!$startDate || !$endDate) return 0;
    try {
        $start = new DateTime($startDate);
        $end = (new DateTime($endDate))->modify('+1 day');
    } catch (Throwable $e) {
        return 0;
    }
    if ($end <= $start) return 0;

    $count = 0;
    for ($d = clone $start; $d < $end; $d->modify('+1 day')) {
        $dow = (int)$d->format('N');
        if ($dow >= 1 && $dow <= 5) $count++;
    }
    return $count;
}

function normalizeAttendanceCalendarDate(?string $value): ?string {
    $date = substr(trim((string)$value), 0, 10);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) return null;
    [$year, $month, $day] = array_map('intval', explode('-', $date));
    return checkdate($month, $day, $year) ? $date : null;
}

function learnerAttendanceCalendarRanges(PDO $conn, int $schoolYearId, ?string $schoolStart, ?string $schoolEnd): array {
    $schoolRangeStart = normalizeAttendanceCalendarDate($schoolStart);
    $schoolRangeEnd = normalizeAttendanceCalendarDate($schoolEnd);
    $schoolRangeConfigured = $schoolRangeStart !== null
        && $schoolRangeEnd !== null
        && $schoolRangeStart <= $schoolRangeEnd;

    $periodStmt = $conn->prepare(
        'SELECT date_start, date_end
         FROM grading_periods
         WHERE school_year_id = :school_year_id
           AND is_deleted = 0
         ORDER BY period_no ASC, grading_period_id ASC'
    );
    $periodStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $periodStmt->execute();
    $periodRows = $periodStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $periodRanges = [];
    $allPeriodsConfigured = count($periodRows) > 0;
    foreach ($periodRows as $period) {
        $periodStart = normalizeAttendanceCalendarDate($period['date_start'] ?? null);
        $periodEnd = normalizeAttendanceCalendarDate($period['date_end'] ?? null);
        if ($periodStart === null || $periodEnd === null || $periodStart > $periodEnd) {
            $allPeriodsConfigured = false;
            continue;
        }
        $periodRanges[] = [$periodStart, $periodEnd];
    }

    // Prefer the complete period calendar when every active period has dates.
    // Otherwise use the school-year range; if that is also unavailable, use
    // the valid period ranges as the best available configured calendar.
    if ($allPeriodsConfigured && $periodRanges) {
        $ranges = $periodRanges;
    } elseif ($schoolRangeConfigured) {
        $ranges = [[$schoolRangeStart, $schoolRangeEnd]];
    } else {
        $ranges = $periodRanges;
    }

    if ($schoolRangeConfigured && $allPeriodsConfigured && $periodRanges) {
        $ranges = [];
        foreach ($periodRanges as [$periodStart, $periodEnd]) {
            $clippedStart = max($periodStart, $schoolRangeStart);
            $clippedEnd = min($periodEnd, $schoolRangeEnd);
            if ($clippedStart <= $clippedEnd) {
                $ranges[] = [$clippedStart, $clippedEnd];
            }
        }
    }

    if (!$ranges) return [];

    usort($ranges, static function (array $left, array $right): int {
        return [$left[0], $left[1]] <=> [$right[0], $right[1]];
    });

    $merged = [];
    foreach ($ranges as [$rangeStart, $rangeEnd]) {
        $lastIndex = count($merged) - 1;
        if ($lastIndex >= 0 && $rangeStart <= $merged[$lastIndex][1]) {
            if ($rangeEnd > $merged[$lastIndex][1]) $merged[$lastIndex][1] = $rangeEnd;
            continue;
        }
        $merged[] = [$rangeStart, $rangeEnd];
    }
    return $merged;
}

function learnerAttendanceDateInRanges(?string $date, array $ranges): bool {
    $normalized = normalizeAttendanceCalendarDate($date);
    if ($normalized === null) return false;
    foreach ($ranges as [$rangeStart, $rangeEnd]) {
        if ($normalized >= $rangeStart && $normalized <= $rangeEnd) return true;
    }
    return false;
}

$operation = $_GET['operation'] ?? '';
$readRoles = ($operation === 'getMyAttendance')
    ? ['admin', 'teacher', 'adviser', 'advisor', 'learners']
    : ['admin', 'teacher', 'adviser', 'advisor'];
$writeRoles = ['teacher', 'adviser', 'advisor'];
$session = auth_enforce_roles($operation, $readRoles, $writeRoles);
if (!auth_is_read_operation($operation) && auth_is_admin($session)) {
    auth_abort(403, 'Attendance records can only be entered by assigned advisers or teachers.');
}

try {
    switch ($operation) {
        case 'getMeta': getMeta($conn, $session); break;
        case 'getSectionRoster': getSectionRoster($conn, $session); break;
        case 'getDayAttendance': getDayAttendance($conn, $session); break;
        case 'saveDayAttendance': saveDayAttendance($conn, $session); break;
        case 'getMonthAttendance': getMonthAttendance($conn, $session); break;
        case 'saveMonthAttendance': saveMonthAttendance($conn, $session); break;
        case 'getMonthlyGrid': getMonthlyGrid($conn, $session); break;
        case 'saveMonthlyGrid': saveMonthlyGrid($conn, $session); break;
        case 'computeMonthlySummary': computeMonthlySummary($conn, $session); break;
        case 'getMonthlySummary': getMonthlySummary($conn, $session); break;
        case 'getMyAttendance': getMyAttendance($conn, $session); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Throwable $e) {
    error_log('[attendance.php] op=' . $operation . ' method=' . ($_SERVER['REQUEST_METHOD'] ?? '') . ' err=' . $e->getMessage());
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function attendanceColumnInfo(PDO $conn): array {
    static $requestCache = [];

    $cacheKey = 'attendance_column_info:' . ATTENDANCE_META_CONTRACT_VERSION;
    if (array_key_exists($cacheKey, $requestCache)) {
        return $requestCache[$cacheKey];
    }

    if (function_exists('apcu_fetch') && filter_var(ini_get('apc.enabled'), FILTER_VALIDATE_BOOLEAN)) {
        $found = false;
        $cached = apcu_fetch($cacheKey, $found);
        if ($found && is_array($cached)) {
            $requestCache[$cacheKey] = $cached;
            return $cached;
        }
    }

    $cols = [];
    $allowedStatuses = [];
    $gradingPeriodNullable = false;

    $stmt = $conn->query("SHOW COLUMNS FROM attendance");
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as $r) {
        $name = $r['Field'] ?? '';
        if ($name) $cols[$name] = true;
        if ($name === 'grading_period_id') {
            $gradingPeriodNullable = strtoupper((string)($r['Null'] ?? '')) === 'YES';
        }
        if ($name === 'status') {
            $type = (string)($r['Type'] ?? '');
            if (preg_match("/^enum\((.*)\)$/i", $type, $m)) {
                // $m[1] contains comma-separated quoted values.
                preg_match_all("/'([^']*)'/", $m[1], $vals);
                $allowedStatuses = $vals[1] ?? [];
            }
        }
    }

    $info = [
        'cols' => $cols,
        'has_session' => isset($cols['session']),
        'has_nls_reason' => isset($cols['nls_reason']),
        'has_transfer_note' => isset($cols['transfer_note']),
        'grading_period_nullable' => $gradingPeriodNullable,
        'allowed_statuses' => $allowedStatuses,
    ];

    if (function_exists('apcu_store') && filter_var(ini_get('apc.enabled'), FILTER_VALIDATE_BOOLEAN)) {
        apcu_store($cacheKey, $info, ATTENDANCE_COLUMN_INFO_CACHE_TTL_SECONDS);
    }

    $requestCache[$cacheKey] = $info;
    return $info;
}

function attendanceColumnExists(PDO $conn, string $table, string $column): bool {
    static $cache = [];
    if (!preg_match('/^[A-Za-z0-9_]+$/', $table) || !preg_match('/^[A-Za-z0-9_]+$/', $column)) {
        return false;
    }
    $key = $table . '.' . $column;
    if (array_key_exists($key, $cache)) return $cache[$key];
    $stmt = $conn->query("SHOW COLUMNS FROM `{$table}` LIKE " . $conn->quote($column));
    $cache[$key] = (bool)($stmt && $stmt->fetch(PDO::FETCH_ASSOC));
    return $cache[$key];
}

function attendanceEquivalentsFromStatus(?string $status): array {
    $st = strtoupper(trim((string)$status));
    if (in_array($st, ['H', 'HOLIDAY', 'NC', 'NO CLASSES', 'NO-CLASS'], true)) {
        return ['present' => 0.0, 'absent' => 0.0, 'late' => 0, 'hd' => 0, 'other' => 0];
    }
    if (in_array($st, ['P', 'PRESENT', 'OFFICIAL BUSINESS'], true)) {
        return ['present' => 1.0, 'absent' => 0.0, 'late' => 0, 'hd' => 0, 'other' => 0];
    }
    if (in_array($st, ['A', 'ABSENT', 'EXCUSED', 'NLPA'], true)) {
        return ['present' => 0.0, 'absent' => 1.0, 'late' => 0, 'hd' => 0, 'other' => 0];
    }
    if (in_array($st, ['L', 'LATE', 'TARDY', 'T', 'CUTTING', 'C'], true)) {
        return ['present' => 1.0, 'absent' => 0.0, 'late' => 1, 'hd' => 0, 'other' => 0];
    }
    if (in_array($st, ['HD', 'HALF', 'HALF-DAY', 'HALFDAY', 'HALF DAY'], true)) {
        return ['present' => 0.5, 'absent' => 0.5, 'late' => 0, 'hd' => 1, 'other' => 0];
    }
    return ['present' => 0.0, 'absent' => 0.0, 'late' => 0, 'hd' => 0, 'other' => 1];
}

function normalizeStatusForDb(PDO $conn, string $requestedStatus, ?string $remarks): array {
    $info = attendanceColumnInfo($conn);
    $allowed = $info['allowed_statuses'] ?? [];

    $status = trim($requestedStatus);
    $remarksOut = $remarks;
    if ($remarksOut !== null) {
        $remarksOut = trim((string)$remarksOut);
        if ($remarksOut === '') $remarksOut = null;
    }

    // Direct canonical matches
    if (in_array($status, $allowed, true)) {
        return [$status, $remarksOut];
    }

    // DepEd term synonyms
    $synonyms = [
        'Half-day'  => ['HD', 'Half Day', 'HalfDay', 'Undertime'],
        'NLPA'      => ['No Longer Participating', 'No Longer Participating in Learning Activities', 'Dropped'],
    ];
    foreach ($synonyms as $canonical => $aliases) {
        if (in_array($canonical, $allowed, true) && in_array($status, $aliases, true)) {
            return [$canonical, $remarksOut];
        }
    }

    // Back-compat mapping for legacy enum values that may no longer be in the allowed list.
    if ($status === 'Cutting') {
        $remarksOut = $remarksOut ? ("Cutting; " . $remarksOut) : 'Cutting';
        $fallback = in_array('Late', $allowed, true) ? 'Late' : (in_array('Absent', $allowed, true) ? 'Absent' : 'Absent');
        return [$fallback, $remarksOut];
    }
    if ($status === 'Official Business') {
        $remarksOut = $remarksOut ? ("Official Business; " . $remarksOut) : 'Official Business';
        $fallback = in_array('Excused', $allowed, true) ? 'Excused' : (in_array('Present', $allowed, true) ? 'Present' : 'Excused');
        return [$fallback, $remarksOut];
    }
    // HD -> Half-day when both exist, otherwise degrade to Absent with a remark.
    if ($status === 'HD') {
        if (in_array('Half-day', $allowed, true)) {
            return ['Half-day', $remarksOut ? ("Half-day; " . $remarksOut) : 'Half-day'];
        }
        $remarksOut = $remarksOut ? ("Half-day; " . $remarksOut) : 'Half-day';
        $fallback = in_array('Absent', $allowed, true) ? 'Absent' : (in_array('Present', $allowed, true) ? 'Present' : 'Absent');
        return [$fallback, $remarksOut];
    }

    respond(['success' => false, 'message' => 'Unsupported attendance status for current database schema.'], 422);
}

function getMeta(PDO $conn, array $session): void {
    // Versioned client contract: expose domain capabilities, not table/column names.
    // The schema probe behind this response is cached so clients can request meta
    // freely without tying themselves to deployment-specific migrations.
    $info = attendanceColumnInfo($conn);
    respond([
        'success' => true,
        'contract_version' => ATTENDANCE_META_CONTRACT_VERSION,
        'cache_ttl_seconds' => ATTENDANCE_COLUMN_INFO_CACHE_TTL_SECONDS,
        'capabilities' => [
            'session_encoding' => (bool)($info['has_session'] ?? false),
            'non_learner_status_reason' => (bool)($info['has_nls_reason'] ?? false),
            'transfer_note' => (bool)($info['has_transfer_note'] ?? false),
        ],
        'allowed_statuses' => $info['allowed_statuses'] ?? [],
        // Whole-day adviser encoding: we treat a single record per date as authoritative.
        'recommended_session' => 'AM',
    ]);
}

function getSectionRoster(PDO $conn, array $session): void {
    $sectionId = (int)($_GET['section_id'] ?? 0);
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    if ($sectionId <= 0 || $schoolYearId <= 0) {
        respond(['success' => false, 'message' => 'section_id and school_year_id are required'], 422);
    }

    if (in_array(($session['role_key'] ?? ''), ['teacher', 'adviser', 'advisor'], true)) {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        requireTeacherCanAccessSection($conn, $employeeId, $sectionId, $schoolYearId);
    }

    $stmt = $conn->prepare(
        "SELECT e.enrollment_id,
                e.learner_id,
                l.lrn,
              l.gender,
                l.last_name,
                l.first_name,
                l.middle_name,
                l.name_extension,
                CONCAT(l.last_name, ', ', l.first_name,
                       CASE WHEN l.middle_name IS NULL OR l.middle_name = '' THEN '' ELSE CONCAT(' ', l.middle_name) END,
                       CASE WHEN l.name_extension IS NULL OR l.name_extension = '' THEN '' ELSE CONCAT(' ', l.name_extension) END
                ) AS learner_name
         FROM enrollments e
         JOIN learners l ON l.learner_id = e.learner_id
         WHERE e.is_deleted = 0
           AND l.is_deleted = 0
           AND e.section_id = :section_id
           AND e.school_year_id = :school_year_id
           AND " . attendanceActiveEnrollmentCondition('e') . "
         ORDER BY l.last_name ASC, l.first_name ASC, l.middle_name ASC, e.enrollment_id ASC"
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function getDayAttendance(PDO $conn, array $sessionInfo): void {
    $sectionId = (int)($_GET['section_id'] ?? 0);
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $gradingPeriodId = (int)($_GET['grading_period_id'] ?? 0);
    $date = (string)($_GET['date'] ?? '');
    $requestedSession = strtoupper(trim((string)($_GET['session'] ?? 'AM')));
    $classId = (int)($_GET['class_id'] ?? 0);

    if ($sectionId <= 0 || $schoolYearId <= 0 || $gradingPeriodId <= 0 || $date === '') {
        respond(['success' => false, 'message' => 'section_id, school_year_id, grading_period_id, and date are required'], 422);
    }
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        respond(['success' => false, 'message' => 'Invalid date format. Expected YYYY-MM-DD.'], 422);
    }
    requireAttendanceGradingPeriodContext($conn, $gradingPeriodId, $schoolYearId);

    // DepEd whole-day encoding: regardless of AM/PM capability, use one authoritative record per day.
    if (!in_array($requestedSession, ['AM', 'PM'], true)) {
        $requestedSession = 'AM';
    }

    $info = attendanceColumnInfo($conn);
    $classIdDb = classIdForDb($classId);
    requireAttendanceClassContext($conn, $classIdDb, $sectionId, $schoolYearId);

    if (in_array(($sessionInfo['role_key'] ?? ''), ['teacher', 'adviser', 'advisor'], true)) {
        $employeeId = getEmployeeIdForUser($conn, (int)($sessionInfo['user_id'] ?? 0));
        requireTeacherOwnsClassOffering($conn, $employeeId, $classId, $sectionId, $schoolYearId);
    }

    // Whole-day: always read the AM record when the schema has AM/PM.
    $whereSession = $info['has_session'] ? "AND a.session = 'AM'" : '';
    $classWhere = $classIdDb === null ? 'a.class_id IS NULL' : 'a.class_id = :class_id';

    $selectSession = $info['has_session'] ? ', a.session' : '';
    $sql = "SELECT a.attendance_id, a.enrollment_id, a.attendance_date, a.status, a.remarks" . $selectSession . "
         FROM attendance a
         JOIN enrollments e ON e.enrollment_id = a.enrollment_id
         WHERE a.is_deleted = 0
           AND e.is_deleted = 0
           AND e.section_id = :section_id
           AND e.school_year_id = :school_year_id
           AND " . attendanceActiveEnrollmentCondition('e') . "
           AND a.grading_period_id = :grading_period_id
           AND $classWhere
           AND a.attendance_date = :attendance_date
           $whereSession";
    debug_attendance('getDayAttendance SQL', ['sql' => $sql, 'whereSession' => $whereSession, 'selectSession' => $selectSession, 'has_session' => $info['has_session']]);
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':grading_period_id', $gradingPeriodId, PDO::PARAM_INT);
    if ($classIdDb !== null) {
        $stmt->bindValue(':class_id', $classIdDb, PDO::PARAM_INT);
    }
    $stmt->bindValue(':attendance_date', $date);
    debug_attendance('getDayAttendance binds', ['binds_done' => true]);
    $stmt->execute();
    debug_attendance('getDayAttendance execute success');

    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function saveDayAttendance(PDO $conn, array $sessionInfo): void {
    $data = getJsonInput();
    $sectionId = (int)($data['section_id'] ?? 0);
    $schoolYearId = (int)($data['school_year_id'] ?? 0);
    $gradingPeriodId = (int)($data['grading_period_id'] ?? 0);
    $classId = (int)($data['class_id'] ?? 0);
    $classIdDb = classIdForDb($classId);
    $date = (string)($data['date'] ?? '');
    $requestedSession = strtoupper(trim((string)($data['session'] ?? 'AM')));
    $entries = $data['entries'] ?? null;

    if ($sectionId <= 0 || $schoolYearId <= 0 || $gradingPeriodId <= 0 || $date === '' || !is_array($entries)) {
        respond(['success' => false, 'message' => 'section_id, school_year_id, grading_period_id, date, and entries[] are required'], 422);
    }
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        respond(['success' => false, 'message' => 'Invalid date format. Expected YYYY-MM-DD.'], 422);
    }
    requireAttendanceGradingPeriodContext($conn, $gradingPeriodId, $schoolYearId);

    if (!in_array($requestedSession, ['AM', 'PM'], true)) {
        $requestedSession = 'AM';
    }

    $info = attendanceColumnInfo($conn);
    requireAttendanceClassContext($conn, $classIdDb, $sectionId, $schoolYearId);
    // Whole-day adviser attendance: always write to the AM slot if AM/PM exists.
    $session = $info['has_session'] ? 'AM' : null;

    if (in_array(($sessionInfo['role_key'] ?? ''), ['teacher', 'adviser', 'advisor'], true)) {
        $employeeId = getEmployeeIdForUser($conn, (int)($sessionInfo['user_id'] ?? 0));
        requireTeacherOwnsClassOffering($conn, $employeeId, $classId, $sectionId, $schoolYearId);
    }

    $userId = (int)($sessionInfo['user_id'] ?? 0);

    $cols = ['enrollment_id', 'class_id', 'grading_period_id', 'attendance_date'];
    if ($info['has_session']) $cols[] = 'session';
    $cols = array_merge($cols, ['status', 'remarks', 'recorded_by']);

    $placeholders = array_map(fn($c) => ':' . $c, $cols);
    $sql = "INSERT INTO attendance (" . implode(',', $cols) . ")\n" .
           "VALUES (" . implode(',', $placeholders) . ")\n" .
           "ON DUPLICATE KEY UPDATE\n" .
           "  grading_period_id = VALUES(grading_period_id),\n" .
           ($info['has_session'] ? "  session = VALUES(session),\n" : "") .
           "  status = VALUES(status),\n" .
           "  remarks = VALUES(remarks),\n" .
           "  recorded_by = VALUES(recorded_by),\n" .
           "  recorded_at = CURRENT_TIMESTAMP,\n" .
           "  is_deleted = 0,\n" .
           "  deleted_at = NULL";

    $stmt = $conn->prepare($sql);

    $saved = 0;
    $conn->beginTransaction();
    try {
        foreach ($entries as $row) {
            $enrollmentId = (int)($row['enrollment_id'] ?? 0);
            $statusReq = (string)($row['status'] ?? '');
            $remarks = $row['remarks'] ?? null;
            if ($enrollmentId <= 0) continue;
            $statusReq = trim($statusReq);
            if ($statusReq === '') continue;

            requireAttendanceEnrollmentContext($conn, $enrollmentId, $sectionId, $schoolYearId);

            [$status, $remarksOut] = normalizeStatusForDb($conn, $statusReq, $remarks);

            if ($remarksOut !== null && strlen($remarksOut) > 255) {
                $remarksOut = substr($remarksOut, 0, 255);
            }

            $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
            $stmt->bindValue(':class_id', $classIdDb, $classIdDb === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
            $stmt->bindValue(':grading_period_id', $gradingPeriodId, PDO::PARAM_INT);
            $stmt->bindValue(':attendance_date', $date);
            if ($info['has_session']) {
                $stmt->bindValue(':session', $session);
            }
            $stmt->bindValue(':status', $status);
            $stmt->bindValue(':remarks', $remarksOut, $remarksOut === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
            $stmt->bindValue(':recorded_by', $userId > 0 ? $userId : null, $userId > 0 ? PDO::PARAM_INT : PDO::PARAM_NULL);
            debug_attendance('saveDayAttendance before execute', ['cols_count' => count($cols), 'ph_count' => count($placeholders), 'has_session' => $info['has_session']]);
            $stmt->execute();
            debug_attendance('saveDayAttendance execute success');
            $saved++;
        }
        $conn->commit();
        respond(['success' => true, 'message' => 'Attendance saved', 'saved' => $saved]);
    } catch (PDOException $e) {
        $conn->rollBack();
        $msg = $e->getMessage();
        if (str_contains($msg, 'Invalid grading_period_id')) {
            respond(['success' => false, 'message' => 'Invalid grading period for this enrollment/school year.'], 422);
        }
        if (str_contains($msg, 'Invalid class_id')) {
            respond(['success' => false, 'message' => 'Invalid class offering (class_id) for this enrollment.'], 422);
        }
        throw $e;
    }
}

function getMonthAttendance(PDO $conn, array $sessionInfo): void {
    $sectionId = (int)($_GET['section_id'] ?? 0);
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $gradingPeriodId = (int)($_GET['grading_period_id'] ?? 0);
    $ym = (string)($_GET['month'] ?? '');
    $classId = (int)($_GET['class_id'] ?? 0);
    $classIdDb = classIdForDb($classId);
    // DepEd whole-day: read from AM slot if schema supports sessions.
    $requestedSession = strtoupper((string)($_GET['session'] ?? 'AM'));

    if ($sectionId <= 0 || $schoolYearId <= 0 || $gradingPeriodId <= 0 || $ym === '') {
        respond(['success' => false, 'message' => 'section_id, school_year_id, grading_period_id, and month are required'], 422);
    }
    requireAttendanceGradingPeriodContext($conn, $gradingPeriodId, $schoolYearId);
    requireAttendanceClassContext($conn, $classIdDb, $sectionId, $schoolYearId);

    [, , $start, $end] = monthBounds($ym);

    if (in_array(($sessionInfo['role_key'] ?? ''), ['teacher', 'adviser', 'advisor'], true)) {
        $employeeId = getEmployeeIdForUser($conn, (int)($sessionInfo['user_id'] ?? 0));
        requireTeacherOwnsClassOffering($conn, $employeeId, $classId, $sectionId, $schoolYearId);
    }

    $col = attendanceColumnInfo($conn);
    $hasSession = (bool)($col['has_session'] ?? false);
    $selectSession = $hasSession ? ', a.session' : '';
    $whereSession = $hasSession ? " AND a.session = 'AM'" : '';
    $classWhere = $classIdDb === null ? 'a.class_id IS NULL' : 'a.class_id = :class_id';

    $stmt = $conn->prepare(
        "SELECT a.attendance_id, a.enrollment_id, a.attendance_date, a.status, a.remarks{$selectSession}
         FROM attendance a
         JOIN enrollments e ON e.enrollment_id = a.enrollment_id
         WHERE a.is_deleted = 0
           AND e.is_deleted = 0
           AND e.section_id = :section_id
           AND e.school_year_id = :school_year_id
           AND " . attendanceActiveEnrollmentCondition('e') . "
           AND a.grading_period_id = :grading_period_id
           AND $classWhere
           AND a.attendance_date BETWEEN :start_date AND :end_date{$whereSession}"
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':grading_period_id', $gradingPeriodId, PDO::PARAM_INT);
    if ($classIdDb !== null) {
        $stmt->bindValue(':class_id', $classIdDb, PDO::PARAM_INT);
    }
    $stmt->bindValue(':start_date', $start);
    $stmt->bindValue(':end_date', $end);
    $stmt->execute();

    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

/** Resolve a month against the selected school year and enforce section scope. */
function monthlyAttendanceContext(PDO $conn, array $session, int $sectionId, int $schoolYearId, string $ym): array {
    if ($sectionId <= 0 || $schoolYearId <= 0 || $ym === '') {
        respond(['success' => false, 'message' => 'section_id, school_year_id, and month are required'], 422);
    }
    [$year, $month, $monthStart, $monthEnd] = monthBounds($ym);
    $yearStmt = $conn->prepare(
        'SELECT date_start, date_end
         FROM school_years
         WHERE school_year_id = :school_year_id AND is_deleted = 0
         LIMIT 1'
    );
    $yearStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $yearStmt->execute();
    $schoolYear = $yearStmt->fetch(PDO::FETCH_ASSOC);
    if (!$schoolYear) {
        respond(['success' => false, 'message' => 'Selected school year was not found.'], 422);
    }
    $schoolStart = substr((string)($schoolYear['date_start'] ?? ''), 0, 10);
    $schoolEnd = substr((string)($schoolYear['date_end'] ?? ''), 0, 10);
    if (($schoolStart !== '' && $monthEnd < $schoolStart) || ($schoolEnd !== '' && $monthStart > $schoolEnd)) {
        respond(['success' => false, 'message' => 'Selected month is outside the selected school year.'], 422);
    }

    $sectionStmt = $conn->prepare(
        'SELECT 1 FROM sections
         WHERE section_id = :section_id AND school_year_id = :school_year_id AND is_deleted = 0
         LIMIT 1'
    );
    $sectionStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $sectionStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $sectionStmt->execute();
    if (!$sectionStmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'Section does not belong to the selected school year.'], 422);
    }

    if (in_array(($session['role_key'] ?? ''), ['teacher', 'adviser', 'advisor'], true)) {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        requireTeacherCanAccessSection($conn, $employeeId, $sectionId, $schoolYearId);
    }

    $start = $schoolStart !== '' && $schoolStart > $monthStart ? $schoolStart : $monthStart;
    $end = $schoolEnd !== '' && $schoolEnd < $monthEnd ? $schoolEnd : $monthEnd;
    return [
        'year' => $year,
        'month' => $month,
        'month_start' => $monthStart,
        'month_end' => $monthEnd,
        'start' => $start,
        'end' => $end,
        'school_start' => $schoolStart,
        'school_end' => $schoolEnd,
    ];
}

function getMonthlyGrid(PDO $conn, array $session): void {
    $sectionId = (int)($_GET['section_id'] ?? 0);
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $ym = trim((string)($_GET['month'] ?? ''));
    $context = monthlyAttendanceContext($conn, $session, $sectionId, $schoolYearId, $ym);
    $info = attendanceColumnInfo($conn);
    $whereSession = !empty($info['has_session']) ? " AND a.session = 'AM'" : '';

    $stmt = $conn->prepare(
        "SELECT a.attendance_id, a.enrollment_id, a.attendance_date, a.status, a.remarks
         FROM attendance a
         JOIN enrollments e ON e.enrollment_id = a.enrollment_id
         JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
         WHERE a.is_deleted = 0
           AND e.is_deleted = 0
           AND " . attendanceActiveEnrollmentCondition('e') . "
           AND e.section_id = :section_id
           AND e.school_year_id = :school_year_id
           AND (a.class_id IS NULL OR a.class_id = 0)
           AND a.attendance_date BETWEEN :start_date AND :end_date{$whereSession}
         ORDER BY a.attendance_date ASC, a.enrollment_id ASC, a.attendance_id ASC"
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':start_date', $context['start']);
    $stmt->bindValue(':end_date', $context['end']);
    $stmt->execute();
    respond(['success' => true, 'month' => $ym, 'records' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
}

function monthlySymbolForStoredStatus(string $status): ?string {
    return match (strtolower(trim($status))) {
        'p', 'present', 'official business' => 'P',
        'absent', 'a', 'excused', 'nlpa' => 'X',
        'late', 'l', 'tardy', 't' => 'L',
        'cutting', 'c' => 'C',
        'half-day', 'half day', 'halfday', 'hd' => 'HD',
        'holiday', 'h' => 'H',
        'no classes', 'no class', 'no-class', 'nc' => 'NC',
        default => null,
    };
}

function buildMonthlyAttendanceSummaries(PDO $conn, int $sectionId, int $schoolYearId, string $ym, array $context, int $userId): array {
    $info = attendanceColumnInfo($conn);
    $whereSession = !empty($info['has_session']) ? " AND a.session = 'AM'" : '';
    $dailySession = !empty($info['has_session']) ? " AND daily.session = 'AM'" : '';
    $latestSession = !empty($info['has_session']) ? " AND latest.session = 'AM'" : '';
    $weekdayCount = countWeekdaysBetween($context['start'], $context['end']);

    $closedStmt = $conn->prepare(
        "SELECT COUNT(DISTINCT a.attendance_date)
         FROM attendance a
         JOIN enrollments e ON e.enrollment_id = a.enrollment_id
         WHERE a.is_deleted = 0 AND e.is_deleted = 0
           AND " . attendanceActiveEnrollmentCondition('e') . "
           AND e.section_id = :section_id AND e.school_year_id = :school_year_id
           AND (a.class_id IS NULL OR a.class_id = 0)
           AND a.attendance_id = (
               SELECT MAX(latest.attendance_id)
               FROM attendance latest
               WHERE latest.enrollment_id = a.enrollment_id
                 AND latest.attendance_date = a.attendance_date
                 AND latest.is_deleted = 0
                 AND (latest.class_id IS NULL OR latest.class_id = 0){$latestSession}
           )
           AND UPPER(a.status) IN ('HOLIDAY', 'H', 'NO CLASSES', 'NO CLASS', 'NO-CLASS', 'NC')
           AND a.attendance_date BETWEEN :start_date AND :end_date
           AND DAYOFWEEK(a.attendance_date) BETWEEN 2 AND 6{$whereSession}"
    );
    $closedStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $closedStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $closedStmt->bindValue(':start_date', $context['start']);
    $closedStmt->bindValue(':end_date', $context['end']);
    $closedStmt->execute();
    $schoolDays = max(0, $weekdayCount - (int)$closedStmt->fetchColumn());

    $rowsStmt = $conn->prepare(
        "SELECT e.enrollment_id,
                COALESCE(SUM(CASE WHEN UPPER(daily.status) IN ('P', 'PRESENT', 'OFFICIAL BUSINESS', 'LATE', 'L', 'TARDY', 'T', 'CUTTING', 'C') THEN 1
                                  WHEN UPPER(daily.status) IN ('HALF-DAY', 'HALF DAY', 'HALFDAY', 'HD') THEN 0.5 ELSE 0 END), 0) AS days_present,
                COALESCE(SUM(CASE WHEN UPPER(daily.status) IN ('HALF-DAY', 'HALF DAY', 'HALFDAY', 'HD') THEN 0.5
                                  WHEN UPPER(daily.status) IN ('ABSENT', 'A', 'EXCUSED', 'NLPA') THEN 1 ELSE 0 END), 0) AS days_absent,
                COALESCE(SUM(CASE WHEN UPPER(daily.status) IN ('LATE', 'L', 'TARDY', 'T', 'CUTTING', 'C') THEN 1 ELSE 0 END), 0) AS days_late
         FROM enrollments e
         LEFT JOIN attendance daily
           ON daily.enrollment_id = e.enrollment_id
          AND daily.is_deleted = 0
          AND (daily.class_id IS NULL OR daily.class_id = 0)
          AND daily.attendance_date BETWEEN :start_date AND :end_date{$dailySession}
          AND daily.attendance_id = (
              SELECT MAX(latest.attendance_id)
              FROM attendance latest
              WHERE latest.enrollment_id = daily.enrollment_id
                AND latest.attendance_date = daily.attendance_date
                AND latest.is_deleted = 0
                AND (latest.class_id IS NULL OR latest.class_id = 0){$latestSession}
          )
         WHERE e.is_deleted = 0 AND " . attendanceActiveEnrollmentCondition('e') . "
           AND e.section_id = :section_id AND e.school_year_id = :school_year_id
         GROUP BY e.enrollment_id"
    );
    $rowsStmt->bindValue(':start_date', $context['start']);
    $rowsStmt->bindValue(':end_date', $context['end']);
    $rowsStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $rowsStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $rowsStmt->execute();
    $summaryRows = $rowsStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $upsert = $conn->prepare(
        "INSERT INTO attendance_monthly_summaries
            (enrollment_id, school_year_id, month_no, total_school_days, days_present, days_absent, days_late, days_excused, computed_by)
         VALUES (:enrollment_id, :school_year_id, :month_no, :total_school_days, :days_present, :days_absent, :days_late, 0, :computed_by)
         ON DUPLICATE KEY UPDATE
            total_school_days = VALUES(total_school_days),
            days_present = VALUES(days_present),
            days_absent = VALUES(days_absent),
            days_late = VALUES(days_late),
            days_excused = 0,
            computed_by = VALUES(computed_by),
            computed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP,
            is_deleted = 0,
            deleted_at = NULL"
    );
    $monthNo = (int)$context['month'];
    foreach ($summaryRows as $row) {
        $absent = (float)($row['days_absent'] ?? 0);
        $present = (float)($row['days_present'] ?? 0);
        $upsert->bindValue(':enrollment_id', (int)$row['enrollment_id'], PDO::PARAM_INT);
        $upsert->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $upsert->bindValue(':month_no', $monthNo, PDO::PARAM_INT);
        $upsert->bindValue(':total_school_days', $schoolDays, PDO::PARAM_INT);
        $upsert->bindValue(':days_present', $present);
        $upsert->bindValue(':days_absent', $absent);
        $upsert->bindValue(':days_late', (int)($row['days_late'] ?? 0), PDO::PARAM_INT);
        $upsert->bindValue(':computed_by', $userId > 0 ? $userId : null, $userId > 0 ? PDO::PARAM_INT : PDO::PARAM_NULL);
        $upsert->execute();
    }
    return ['saved' => count($summaryRows), 'total_school_days' => $schoolDays];
}

function saveMonthlyGrid(PDO $conn, array $session): void {
    $data = getJsonInput();
    $sectionId = (int)($data['section_id'] ?? 0);
    $schoolYearId = (int)($data['school_year_id'] ?? 0);
    $ym = trim((string)($data['month'] ?? ''));
    $entries = $data['entries'] ?? null;
    if (!is_array($entries)) {
        respond(['success' => false, 'message' => 'entries[] is required'], 422);
    }
    $context = monthlyAttendanceContext($conn, $session, $sectionId, $schoolYearId, $ym);

    $info = attendanceColumnInfo($conn);
    if (empty($info['grading_period_nullable'])) {
        respond(['success' => false, 'message' => 'Monthly attendance needs the schema update that makes grading period optional. Apply monthly_sf2_attendance.sql first.'], 409);
    }
    $allowedStatuses = $info['allowed_statuses'] ?? [];
    foreach (['Present', 'Absent', 'Late', 'Cutting', 'Holiday', 'No Classes'] as $requiredStatus) {
        if (!in_array($requiredStatus, $allowedStatuses, true)) {
            respond(['success' => false, 'message' => 'Monthly attendance statuses are not installed. Apply monthly_sf2_attendance.sql first.'], 409);
        }
    }

    $rosterStmt = $conn->prepare(
        "SELECT e.enrollment_id
         FROM enrollments e JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
         WHERE e.is_deleted = 0 AND " . attendanceActiveEnrollmentCondition('e') . "
           AND e.section_id = :section_id AND e.school_year_id = :school_year_id"
    );
    $rosterStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $rosterStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $rosterStmt->execute();
    $enrollmentIds = array_map('intval', $rosterStmt->fetchAll(PDO::FETCH_COLUMN) ?: []);
    $enrollmentSet = array_fill_keys($enrollmentIds, true);

    $dates = [];
    if ($context['start'] <= $context['end']) {
        $cursor = new DateTime($context['start']);
        $last = new DateTime($context['end']);
        for (; $cursor <= $last; $cursor->modify('+1 day')) {
            if ((int)$cursor->format('N') <= 5) $dates[] = $cursor->format('Y-m-d');
        }
    }
    $expectedCount = count($enrollmentIds) * count($dates);
    if (count($entries) !== $expectedCount) {
        respond(['success' => false, 'message' => 'The monthly grid changed while it was open. Reload the month before saving.'], 409);
    }
    $symbolToStatus = ['', 'P', 'X', 'A', 'L', 'C', 'HD', 'H', 'NC'];
    $statusBySymbol = ['P' => 'Present', 'X' => 'Absent', 'A' => 'Absent', 'L' => 'Late', 'C' => 'Cutting', 'HD' => 'Half-day', 'H' => 'Holiday', 'NC' => 'No Classes'];
    $normalized = [];
    $dailyClosures = [];
    foreach ($entries as $entry) {
        $enrollmentId = (int)($entry['enrollment_id'] ?? 0);
        $date = (string)($entry['attendance_date'] ?? '');
        $symbol = strtoupper(trim((string)($entry['symbol'] ?? '')));
        if (!isset($enrollmentSet[$enrollmentId]) || !in_array($date, $dates, true) || !in_array($symbol, $symbolToStatus, true)) {
            respond(['success' => false, 'message' => 'Monthly grid contains an invalid learner, date, or attendance symbol.'], 422);
        }
        $key = $enrollmentId . '|' . $date;
        if (isset($normalized[$key])) {
            respond(['success' => false, 'message' => 'Monthly grid contains a duplicate learner/date cell.'], 422);
        }
        $normalized[$key] = ['enrollment_id' => $enrollmentId, 'date' => $date, 'symbol' => $symbol];
        if (in_array($symbol, ['H', 'NC'], true)) {
            if (isset($dailyClosures[$date]) && $dailyClosures[$date] !== $symbol) {
                respond(['success' => false, 'message' => 'A date cannot be both a holiday and a no-class day.'], 422);
            }
            $dailyClosures[$date] = $symbol;
        }
    }
    foreach ($dates as $date) {
        if (!isset($dailyClosures[$date])) continue;
        foreach ($enrollmentIds as $enrollmentId) {
            $entry = $normalized[$enrollmentId . '|' . $date] ?? null;
            if (!$entry || $entry['symbol'] !== $dailyClosures[$date]) {
                respond(['success' => false, 'message' => 'H and NC apply to the entire class date. Mark every learner in that date column consistently.'], 422);
            }
        }
    }

    $userId = (int)($session['user_id'] ?? 0);
    $info = attendanceColumnInfo($conn);
    $sessionSelect = !empty($info['has_session']) ? " AND session = 'AM'" : '';
    $existingStmt = $conn->prepare(
        "SELECT a.enrollment_id, a.attendance_date, a.status, a.is_deleted
         FROM attendance a
         JOIN enrollments e ON e.enrollment_id = a.enrollment_id
         WHERE e.section_id = :section_id AND e.school_year_id = :school_year_id
           AND (a.class_id IS NULL OR a.class_id = 0)
           AND a.attendance_date BETWEEN :start_date AND :end_date{$sessionSelect}"
    );
    $existingStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $existingStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $existingStmt->bindValue(':start_date', $context['start']);
    $existingStmt->bindValue(':end_date', $context['end']);
    $existingStmt->execute();
    $existingRows = [];
    foreach ($existingStmt->fetchAll(PDO::FETCH_ASSOC) as $existing) {
        $key = (int)$existing['enrollment_id'] . '|' . substr((string)$existing['attendance_date'], 0, 10);
        $existingRows[$key][] = [
            'status' => (string)($existing['status'] ?? ''),
            'is_deleted' => (int)($existing['is_deleted'] ?? 0) === 1,
        ];
    }
    $whereSession = !empty($info['has_session']) ? " AND session = 'AM'" : '';
    $update = $conn->prepare(
        "UPDATE attendance
         SET grading_period_id = NULL, status = :status, remarks = NULL, recorded_by = :recorded_by,
             recorded_at = CURRENT_TIMESTAMP, is_deleted = 0, deleted_at = NULL
         WHERE enrollment_id = :enrollment_id AND (class_id IS NULL OR class_id = 0)
           AND attendance_date = :attendance_date{$whereSession}"
    );
    $clear = $conn->prepare(
        "UPDATE attendance
         SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, recorded_by = :recorded_by,
             recorded_at = CURRENT_TIMESTAMP
         WHERE enrollment_id = :enrollment_id AND (class_id IS NULL OR class_id = 0)
           AND attendance_date = :attendance_date{$whereSession}"
    );
    $insertColumns = ['enrollment_id', 'class_id', 'grading_period_id', 'attendance_date'];
    if (!empty($info['has_session'])) $insertColumns[] = 'session';
    $insertColumns = array_merge($insertColumns, ['status', 'remarks', 'recorded_by']);
    $insertValues = [' :enrollment_id', 'NULL', 'NULL', ' :attendance_date'];
    if (!empty($info['has_session'])) $insertValues[] = "'AM'";
    $insertValues = array_merge($insertValues, [':status', 'NULL', ':recorded_by']);
    $insert = $conn->prepare('INSERT INTO attendance (' . implode(',', $insertColumns) . ') VALUES (' . implode(',', $insertValues) . ')');

    $saved = 0;
    $conn->beginTransaction();
    try {
        foreach ($normalized as $key => $entry) {
            $symbol = $entry['symbol'];
            $existing = $existingRows[$key] ?? [];

            // Blank means the teacher has not encoded this learner/date. Remove
            // any previously saved monthly record instead of defaulting it to P.
            if ($symbol === '') {
                $hasActiveExisting = false;
                foreach ($existing as $stored) {
                    if (!$stored['is_deleted']) {
                        $hasActiveExisting = true;
                        break;
                    }
                }
                if (!$hasActiveExisting) continue;
                $clear->bindValue(':recorded_by', $userId > 0 ? $userId : null, $userId > 0 ? PDO::PARAM_INT : PDO::PARAM_NULL);
                $clear->bindValue(':enrollment_id', $entry['enrollment_id'], PDO::PARAM_INT);
                $clear->bindValue(':attendance_date', $entry['date']);
                $clear->execute();
                $saved++;
                continue;
            }

            $status = $statusBySymbol[$symbol];
            $alreadyMatches = count($existing) > 0;
            foreach ($existing as $stored) {
                if ($stored['is_deleted'] || monthlySymbolForStoredStatus($stored['status']) !== $symbol) {
                    $alreadyMatches = false;
                    break;
                }
            }
            if ($alreadyMatches) continue;

            if ($existing) {
                $update->bindValue(':status', $status, PDO::PARAM_STR);
                $update->bindValue(':recorded_by', $userId > 0 ? $userId : null, $userId > 0 ? PDO::PARAM_INT : PDO::PARAM_NULL);
                $update->bindValue(':enrollment_id', $entry['enrollment_id'], PDO::PARAM_INT);
                $update->bindValue(':attendance_date', $entry['date']);
                $update->execute();
            } else {
                $insert->bindValue(':enrollment_id', $entry['enrollment_id'], PDO::PARAM_INT);
                $insert->bindValue(':attendance_date', $entry['date']);
                $insert->bindValue(':status', $status, PDO::PARAM_STR);
                $insert->bindValue(':recorded_by', $userId > 0 ? $userId : null, $userId > 0 ? PDO::PARAM_INT : PDO::PARAM_NULL);
                $insert->execute();
            }
            $saved++;
        }
        $summary = buildMonthlyAttendanceSummaries($conn, $sectionId, $schoolYearId, $ym, $context, $userId);
        $conn->commit();
        respond([
            'success' => true,
            'message' => 'Monthly attendance saved and report-card totals refreshed.',
            'saved' => $saved,
            'summary_rows' => $summary['saved'],
            'total_school_days' => $summary['total_school_days'],
        ]);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
}

function saveMonthAttendance(PDO $conn, array $session): void {
    $data = getJsonInput();
    $sectionId = (int)($data['section_id'] ?? 0);
    $schoolYearId = (int)($data['school_year_id'] ?? 0);
    $gradingPeriodId = (int)($data['grading_period_id'] ?? 0);
    $classId = (int)($data['class_id'] ?? 0);
    $classIdDb = classIdForDb($classId);
    $entries = $data['entries'] ?? null;

    if ($sectionId <= 0 || $schoolYearId <= 0 || $gradingPeriodId <= 0 || !is_array($entries)) {
        respond(['success' => false, 'message' => 'section_id, school_year_id, grading_period_id, and entries[] are required'], 422);
    }
    requireAttendanceGradingPeriodContext($conn, $gradingPeriodId, $schoolYearId);
    requireAttendanceClassContext($conn, $classIdDb, $sectionId, $schoolYearId);

    if (in_array(($session['role_key'] ?? ''), ['teacher', 'adviser', 'advisor'], true)) {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        requireTeacherOwnsClassOffering($conn, $employeeId, $classId, $sectionId, $schoolYearId);
    }

    $userId = (int)($session['user_id'] ?? 0);

    $info = attendanceColumnInfo($conn);
    $cols = ['enrollment_id', 'class_id', 'grading_period_id', 'attendance_date'];
    if ($info['has_session']) $cols[] = 'session';
    $cols = array_merge($cols, ['status', 'remarks', 'recorded_by']);
    $placeholders = array_map(fn($c) => ':' . $c, $cols);

    $sql = "INSERT INTO attendance (" . implode(',', $cols) . ")
            VALUES (" . implode(',', $placeholders) . ")
            ON DUPLICATE KEY UPDATE
                grading_period_id = VALUES(grading_period_id),
                " . ($info['has_session'] ? "session = VALUES(session)," : "") . "
                status = VALUES(status),
                remarks = VALUES(remarks),
                recorded_by = VALUES(recorded_by),
                recorded_at = CURRENT_TIMESTAMP,
                is_deleted = 0,
                deleted_at = NULL";

    $stmt = $conn->prepare($sql);

    $saved = 0;
    $conn->beginTransaction();
    try {
        foreach ($entries as $row) {
            $enrollmentId = (int)($row['enrollment_id'] ?? 0);
            $date = (string)($row['attendance_date'] ?? '');
            $status = (string)($row['status'] ?? '');
            $remarks = $row['remarks'] ?? null;

            if ($enrollmentId <= 0 || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
                continue;
            }

            // allow blank to mean "no record" (skip)
            $status = trim($status);
            if ($status === '') {
                continue;
            }

            requireAttendanceEnrollmentContext($conn, $enrollmentId, $sectionId, $schoolYearId);

            [$statusNorm, $remarksOut] = normalizeStatusForDb($conn, $status, $remarks);
            if ($remarksOut !== null && strlen($remarksOut) > 255) {
                $remarksOut = substr($remarksOut, 0, 255);
            }

            $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
            $stmt->bindValue(':class_id', $classIdDb, $classIdDb === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
            $stmt->bindValue(':grading_period_id', $gradingPeriodId, PDO::PARAM_INT);
            $stmt->bindValue(':attendance_date', $date);
            if ($info['has_session']) {
                $stmt->bindValue(':session', 'AM');
            }
            $stmt->bindValue(':status', $statusNorm);
            $stmt->bindValue(':remarks', $remarksOut, $remarksOut === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
            $stmt->bindValue(':recorded_by', $userId > 0 ? $userId : null, $userId > 0 ? PDO::PARAM_INT : PDO::PARAM_NULL);
            $stmt->execute();
            $saved++;
        }

        $conn->commit();
        respond(['success' => true, 'message' => 'Attendance saved', 'saved' => $saved]);
    } catch (PDOException $e) {
        $conn->rollBack();
        // Surface validation trigger errors cleanly.
        $msg = $e->getMessage();
        if (str_contains($msg, 'Invalid grading_period_id')) {
            respond(['success' => false, 'message' => 'Invalid grading period for this enrollment/school year.'], 422);
        }
        if (str_contains($msg, 'Invalid class_id')) {
            respond(['success' => false, 'message' => 'Invalid class offering (class_id) for this enrollment.'], 422);
        }
        throw $e;
    }
}

function computeMonthlySummary(PDO $conn, array $session): void {
    $data = getJsonInput();
    $sectionId = (int)($data['section_id'] ?? 0);
    $schoolYearId = (int)($data['school_year_id'] ?? 0);
    $ym = trim((string)($data['month'] ?? ''));
    $context = monthlyAttendanceContext($conn, $session, $sectionId, $schoolYearId, $ym);
    $userId = (int)($session['user_id'] ?? 0);
    $conn->beginTransaction();
    try {
        $summary = buildMonthlyAttendanceSummaries($conn, $sectionId, $schoolYearId, $ym, $context, $userId);
        $conn->commit();
        respond([
            'success' => true,
            'message' => 'Monthly attendance summary refreshed',
            'saved' => $summary['saved'],
            'total_school_days' => $summary['total_school_days'],
        ]);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
}

function getMonthlySummary(PDO $conn, array $session): void {
    $sectionId = (int)($_GET['section_id'] ?? 0);
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $ym = (string)($_GET['month'] ?? '');
    if ($sectionId <= 0 || $schoolYearId <= 0 || $ym === '') {
        respond(['success' => false, 'message' => 'section_id, school_year_id, and month are required'], 422);
    }

    if (in_array(($session['role_key'] ?? ''), ['teacher', 'adviser', 'advisor'], true)) {
        $employeeId = getEmployeeIdForUser($conn, (int)($session['user_id'] ?? 0));
        requireTeacherCanAccessSection($conn, $employeeId, $sectionId, $schoolYearId);
    }

    [, $month, , ] = monthBounds($ym);
    $monthNo = (int)$month;

    $stmt = $conn->prepare(
        "SELECT s.enrollment_id,
                s.total_school_days,
                s.days_present,
                s.days_absent,
                s.days_late,
                s.days_excused
         FROM attendance_monthly_summaries s
         JOIN enrollments e ON e.enrollment_id = s.enrollment_id
         WHERE s.is_deleted = 0
           AND e.is_deleted = 0
           AND e.section_id = :section_id
           AND s.school_year_id = :school_year_id
           AND " . attendanceActiveEnrollmentCondition('e') . "
           AND s.month_no = :month_no"
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':month_no', $monthNo, PDO::PARAM_INT);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function getMyAttendance(PDO $conn, array $session): void {
    $userId = (int)($session['user_id'] ?? 0);
    $learnerId = getLearnerIdForUser($conn, $userId);

    $availableYearsStmt = $conn->prepare(
        'SELECT sy.school_year_id, sy.year_label, sy.year_start, sy.year_end
         FROM attendance a
         JOIN enrollments e ON e.enrollment_id = a.enrollment_id
                            AND e.is_deleted = 0
         JOIN school_years sy ON sy.school_year_id = e.school_year_id
                              AND sy.is_deleted = 0
         WHERE e.learner_id = :learner_id
           AND a.is_deleted = 0
           AND (a.class_id IS NULL OR a.class_id = 0)
         GROUP BY sy.school_year_id, sy.year_label, sy.year_start, sy.year_end
         HAVING COUNT(a.attendance_id) > 0
         ORDER BY sy.year_start ASC, sy.school_year_id ASC'
    );
    $availableYearsStmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $availableYearsStmt->execute();
    $availableSchoolYears = $availableYearsStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $month = trim($_GET['month'] ?? '');
    $gradingPeriodId = (int)($_GET['grading_period_id'] ?? 0);

    if ($schoolYearId > 0 && $gradingPeriodId > 0) {
        requireAttendanceGradingPeriodContext($conn, $gradingPeriodId, $schoolYearId);
    }

    // Get the learner's enrollment, optionally scoped to a school year.
    $enrollmentSql =
        'SELECT e.enrollment_id, e.section_id, e.school_year_id, e.grade_level_id,
                sy.date_start, sy.date_end
         FROM enrollments e
         JOIN school_years sy ON sy.school_year_id = e.school_year_id
                             AND sy.is_deleted = 0
         WHERE e.learner_id = :learner_id
           AND e.is_deleted = 0';
    if ($schoolYearId > 0) {
        $enrollmentSql .= ' AND e.school_year_id = :school_year_id';
    }
    $enrollmentSql .= ' ORDER BY e.enrollment_id DESC LIMIT 1';

    $eStmt = $conn->prepare($enrollmentSql);
    $eStmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    if ($schoolYearId > 0) {
        $eStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    }
    $eStmt->execute();
    $enrollment = $eStmt->fetch(PDO::FETCH_ASSOC);
    if (!$enrollment) {
        respond([
            'success' => true,
            'enrollment_id' => null,
            'school_year_id' => $schoolYearId > 0 ? $schoolYearId : null,
            'section_id' => null,
            'records' => [],
            'summary' => ['present' => 0.0, 'absent' => 0.0, 'late' => 0, 'hd' => 0, 'other' => 0],
            'monthly_summary' => [],
            'whole_day_summary' => [
                'total' => 0,
                'recorded' => 0,
                'present' => 0.0,
                'absent' => 0.0,
                'late' => 0,
                'hd' => 0,
                'other' => 0,
                'attendance_percentage' => null,
            ],
            'has_enrollment' => false,
            'available_school_years' => $availableSchoolYears,
            'message' => 'No enrollment is linked to your learner account for the selected school year.',
        ]);
    }

    $enrollmentId = (int)($enrollment['enrollment_id'] ?? 0);

    // Fetch attendance records for this enrollment.
    $learnerSessionFilter = !empty(attendanceColumnInfo($conn)['has_session']) ? " AND a.session = 'AM'" : '';
    $latestSessionFilter = !empty(attendanceColumnInfo($conn)['has_session']) ? " AND a2.session = 'AM'" : '';
    $sql =
        "SELECT a.attendance_id, a.class_id, a.attendance_date, a.status, a.remarks, a.grading_period_id,
                gp.period_name
         FROM attendance a
         LEFT JOIN grading_periods gp ON gp.grading_period_id = a.grading_period_id
         WHERE a.enrollment_id = :enrollment_id
           AND a.is_deleted = 0
           AND (a.class_id IS NULL OR a.class_id = 0){$learnerSessionFilter}
           AND a.attendance_id = (
               SELECT MAX(a2.attendance_id)
               FROM attendance a2
               WHERE a2.enrollment_id = a.enrollment_id
                 AND a2.attendance_date = a.attendance_date
                 AND (a2.class_id IS NULL OR a2.class_id = 0)
                 AND a2.is_deleted = 0{$latestSessionFilter}
           )";
    $params = [':enrollment_id' => $enrollmentId];

    if ($month !== '' && preg_match('/^\d{4}-\d{2}$/', $month)) {
        $sql .= ' AND a.attendance_date LIKE :month';
        $params[':month'] = $month . '%';
    }
    if ($gradingPeriodId > 0) {
        $sql .= ' AND a.grading_period_id = :grading_period_id';
        $params[':grading_period_id'] = $gradingPeriodId;
    }

    $sql .= ' ORDER BY a.attendance_date DESC, a.attendance_id DESC';
    $stmt = $conn->prepare($sql);
    foreach ($params as $k => $v) {
        $stmt->bindValue($k, $v, is_int($v) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $stmt->execute();
    $records = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    // Compute whole-day equivalents for learner-facing summaries.
    // Present/Late/Cutting/Official Business = 1 present day.
    // Absent/Excused/NLPA = 1 absent day.
    // HD/Half-day = 0.5 present + 0.5 absent.
    $calendarRanges = learnerAttendanceCalendarRanges(
        $conn,
        (int)$enrollment['school_year_id'],
        $enrollment['date_start'] ?? null,
        $enrollment['date_end'] ?? null
    );
    $calendarConfigured = count($calendarRanges) > 0;
    $startDate = $calendarConfigured ? $calendarRanges[0][0] : null;
    $endDate = $calendarConfigured ? $calendarRanges[count($calendarRanges) - 1][1] : null;
    $closureDates = [];
    if ($calendarConfigured) {
        $closureSessionFilter = !empty(attendanceColumnInfo($conn)['has_session']) ? " AND session = 'AM'" : '';
        $closureStmt = $conn->prepare(
            "SELECT DISTINCT attendance_date
             FROM attendance
             WHERE enrollment_id = :enrollment_id
               AND is_deleted = 0
               AND (class_id IS NULL OR class_id = 0)
               AND status IN ('Holiday', 'No Classes')
               AND attendance_date BETWEEN :start_date AND :end_date
               AND DAYOFWEEK(attendance_date) BETWEEN 2 AND 6{$closureSessionFilter}"
        );
        $closureStmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
        $closureStmt->bindValue(':start_date', $startDate);
        $closureStmt->bindValue(':end_date', $endDate);
        $closureStmt->execute();
        foreach ($closureStmt->fetchAll(PDO::FETCH_COLUMN) as $closureDate) {
            $dateKey = substr((string)$closureDate, 0, 10);
            if (learnerAttendanceDateInRanges($dateKey, $calendarRanges)) {
                $closureDates[$dateKey] = true;
            }
        }
    }

    $monthlySchoolDays = [];
    if ($calendarConfigured) {
        try {
            foreach ($calendarRanges as [$rangeStart, $rangeEnd]) {
                $day = new DateTime($rangeStart);
                $lastDay = new DateTime($rangeEnd);
                while ($day <= $lastDay) {
                    $dateKey = $day->format('Y-m-d');
                    if ((int)$day->format('N') <= 5 && !isset($closureDates[$dateKey])) {
                        $monthKey = $day->format('Y-m');
                        $monthlySchoolDays[$monthKey] = ($monthlySchoolDays[$monthKey] ?? 0) + 1;
                    }
                    $day->modify('+1 day');
                }
            }
        } catch (Throwable $e) {
            $monthlySchoolDays = [];
        }
    }

    $totalSchoolDays = $calendarConfigured ? array_sum($monthlySchoolDays) : null;
    $summary = ['present' => 0.0, 'absent' => 0.0, 'late' => 0, 'hd' => 0, 'other' => 0];
    $wholeDaySummary = [
        'total' => $totalSchoolDays,
        'recorded' => 0,
        'present' => 0.0,
        'absent' => 0.0,
        'late' => 0,
        'hd' => 0,
        'other' => 0,
        'attendance_percentage' => null,
    ];
    $monthlySummary = [];
    foreach ($monthlySchoolDays as $monthKey => $schoolDays) {
        $monthlySummary[$monthKey] = [
            'month' => $monthKey,
            'month_label' => date('F Y', strtotime($monthKey . '-01')),
            'school_days' => (int)$schoolDays,
            'recorded' => 0,
            'present' => 0.0,
            'absent' => 0.0,
            'late' => 0,
            'hd' => 0,
            'other' => 0,
            'attendance_percentage' => null,
        ];
    }
    foreach ($records as $r) {
        $recordDate = normalizeAttendanceCalendarDate($r['attendance_date'] ?? null);
        if ($calendarConfigured && !learnerAttendanceDateInRanges($recordDate, $calendarRanges)) {
            continue;
        }
        $eq = attendanceEquivalentsFromStatus($r['status'] ?? '');
        $summary['present'] += $eq['present'];
        $summary['absent'] += $eq['absent'];
        $summary['late'] += $eq['late'];
        $summary['hd'] += $eq['hd'];
        $summary['other'] += $eq['other'];

        $wholeDaySummary['recorded']++;
        $wholeDaySummary['present'] += $eq['present'];
        $wholeDaySummary['absent'] += $eq['absent'];
        $wholeDaySummary['late'] += $eq['late'];
        $wholeDaySummary['hd'] += $eq['hd'];
        $wholeDaySummary['other'] += $eq['other'];

        $monthKey = substr((string)($r['attendance_date'] ?? ''), 0, 7);
        if ($monthKey !== '') {
            if (!isset($monthlySummary[$monthKey])) {
                $monthlySummary[$monthKey] = [
                    'month' => $monthKey,
                    'month_label' => date('F Y', strtotime($monthKey . '-01')),
                    'school_days' => $calendarConfigured ? 0 : null,
                    'recorded' => 0,
                    'present' => 0.0,
                    'absent' => 0.0,
                    'late' => 0,
                    'hd' => 0,
                    'other' => 0,
                    'attendance_percentage' => null,
                ];
            }
            $monthlySummary[$monthKey]['recorded']++;
            $monthlySummary[$monthKey]['present'] += $eq['present'];
            $monthlySummary[$monthKey]['absent'] += $eq['absent'];
            $monthlySummary[$monthKey]['late'] += $eq['late'];
            $monthlySummary[$monthKey]['hd'] += $eq['hd'];
            $monthlySummary[$monthKey]['other'] += $eq['other'];
        }
    }
    foreach ($monthlySummary as &$monthSummary) {
        $monthSummary['attendance_percentage'] = $monthSummary['school_days'] !== null && $monthSummary['school_days'] > 0
            ? round(($monthSummary['present'] / $monthSummary['school_days']) * 100, 2)
            : null;
    }
    unset($monthSummary);
    ksort($monthlySummary);
    $monthlySummary = array_values($monthlySummary);
    $wholeDaySummary['attendance_percentage'] = $totalSchoolDays !== null && $totalSchoolDays > 0
        ? round(($wholeDaySummary['present'] / $totalSchoolDays) * 100, 2)
        : null;

    respond([
        'success' => true,
        'enrollment_id' => $enrollmentId,
        'school_year_id' => (int)$enrollment['school_year_id'],
        'section_id' => (int)$enrollment['section_id'],
        'records' => $records,
        'summary' => $summary,
        'monthly_summary' => $monthlySummary,
        'whole_day_summary' => $wholeDaySummary,
        'calendar_configured' => $calendarConfigured,
        'calendar_message' => $calendarConfigured
            ? null
            : 'School-year or grading-period dates are not configured for this school year.',
        'available_school_years' => $availableSchoolYears,
    ]);
}
