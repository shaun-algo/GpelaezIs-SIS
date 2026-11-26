<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/grading_period_lifecycle.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function getMaxPeriodsForSchoolYear(PDO $conn, int $schoolYearId): int {
    $stmt = $conn->prepare('SELECT grading_system_type FROM school_years WHERE school_year_id = :sy AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $type = $stmt->fetchColumn();
    if ($type === false) {
        throw new InvalidArgumentException('School year not found');
    }
    return match ((string)$type) {
        'Semester' => 2,
        'Three-Term', 'Trimester' => 3,
        default => 4,
    };
}

function normalizeStatus($data, ?int $periodNo = null): string {
    $status = trim((string)($data['status'] ?? ''));
    $statusId = isset($data['grading_period_status_id']) ? (int)$data['grading_period_status_id'] : 0;
    if ($status === '' && $statusId > 0) {
        $idMap = [1 => 'Open', 2 => 'Submitted', 3 => 'Approved', 4 => 'Locked'];
        $status = $idMap[$statusId] ?? '';
    }
    if ($status === '') {
        $status = 'Locked';
    }
    return $status;
}

function findNextAvailablePeriodNo(PDO $conn, int $schoolYearId, int $maxPeriods): ?int {
    $stmt = $conn->prepare(
        'SELECT period_no FROM grading_periods WHERE school_year_id = :sy AND is_deleted = 0 ORDER BY period_no ASC'
    );
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $used = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));

    for ($i = 1; $i <= $maxPeriods; $i++) {
        if (!in_array($i, $used, true)) {
            return $i;
        }
    }
    return null;
}

function isSchoolYearActive(PDO $conn, int $schoolYearId): bool {
    $stmt = $conn->prepare('SELECT is_active FROM school_years WHERE school_year_id = :sy AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    return (int)$stmt->fetchColumn() === 1;
}

function lockPeriodsForInactiveSchoolYears(PDO $conn): void {
    $conn->exec("UPDATE grading_periods gp
                 INNER JOIN school_years sy ON sy.school_year_id = gp.school_year_id
                 SET gp.status = 'Locked'
                 WHERE (sy.is_active = 0 OR sy.is_deleted = 1)
                   AND gp.is_deleted = 0
                   AND gp.status_mode = 'automatic'
                   AND gp.status <> 'Locked'");
}

function normalizeOptionalPeriodDate($value, string $field): ?string {
    if ($value === null || $value === '') {
        return null;
    }

    $date = trim((string)$value);
    $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
    $errors = DateTimeImmutable::getLastErrors();
    if (!$parsed || ($errors !== false && ($errors['warning_count'] > 0 || $errors['error_count'] > 0))
        || $parsed->format('Y-m-d') !== $date) {
        throw new InvalidArgumentException("{$field} must be a valid date in YYYY-MM-DD format");
    }
    return $date;
}

function validatePeriodDates(PDO $conn, int $schoolYearId, ?string $dateStart, ?string $dateEnd, ?int $excludePeriodId = null): void {
    if ($dateStart && $dateEnd && $dateStart > $dateEnd) {
        throw new InvalidArgumentException('End date must be on or after start date');
    }

    $schoolYearStmt = $conn->prepare(
        'SELECT date_start, date_end FROM school_years WHERE school_year_id = :sy AND is_deleted = 0 LIMIT 1'
    );
    $schoolYearStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $schoolYearStmt->execute();
    $schoolYear = $schoolYearStmt->fetch(PDO::FETCH_ASSOC);
    if (!$schoolYear) {
        throw new InvalidArgumentException('School year not found');
    }

    if ($dateStart !== null || $dateEnd !== null) {
        $schoolStart = $schoolYear['date_start'] ? substr((string)$schoolYear['date_start'], 0, 10) : null;
        $schoolEnd = $schoolYear['date_end'] ? substr((string)$schoolYear['date_end'], 0, 10) : null;
        if (!$schoolStart || !$schoolEnd) {
            throw new InvalidArgumentException('Set the school-year start and end dates before assigning grading-period dates');
        }
        if ($schoolStart > $schoolEnd) {
            throw new InvalidArgumentException('The school-year end date must be on or after its start date');
        }
        foreach ([$dateStart, $dateEnd] as $periodDate) {
            if ($periodDate !== null && ($periodDate < $schoolStart || $periodDate > $schoolEnd)) {
                throw new InvalidArgumentException('Grading-period dates must fall within the configured school-year dates');
            }
        }
    }

    $candidateDates = array_values(array_filter([$dateStart, $dateEnd], static fn($date) => $date !== null));
    if (!$candidateDates) {
        return;
    }

    $overlapSql = 'SELECT period_name FROM grading_periods
                   WHERE school_year_id = :sy AND is_deleted = 0
                     AND date_start IS NOT NULL AND date_end IS NOT NULL';
    if ($excludePeriodId !== null) {
        $overlapSql .= ' AND grading_period_id <> :exclude_id';
    }
    if ($dateStart !== null && $dateEnd !== null) {
        $overlapSql .= ' AND date_start <= :candidate_end AND date_end >= :candidate_start';
    } else {
        $overlapSql .= ' AND date_start <= :candidate_date AND date_end >= :candidate_date';
    }
    $overlapSql .= ' LIMIT 1';
    $overlapStmt = $conn->prepare($overlapSql);
    $overlapStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    if ($excludePeriodId !== null) {
        $overlapStmt->bindValue(':exclude_id', $excludePeriodId, PDO::PARAM_INT);
    }
    if ($dateStart !== null && $dateEnd !== null) {
        $overlapStmt->bindValue(':candidate_start', $dateStart);
        $overlapStmt->bindValue(':candidate_end', $dateEnd);
    } else {
        $overlapStmt->bindValue(':candidate_date', $candidateDates[0]);
    }
    $overlapStmt->execute();
    $overlap = $overlapStmt->fetchColumn();
    if ($overlap !== false) {
        throw new InvalidArgumentException("Grading-period dates overlap \"{$overlap}\"");
    }
}

$operation = $_GET['operation'] ?? '';
// Teachers need read access for grade encoding workflows; keep writes admin-only.
$session = auth_enforce_roles($operation, ['admin', 'teacher', 'registrar', 'learners'], ['admin']);
try {
    sync_automatic_grading_period_statuses($conn);
} catch (Throwable $e) {
    error_log('Grading-period lifecycle sync failed: ' . $e->getMessage());
}
try {
    switch ($operation) {
        case 'getAllGradingPeriods': getAllGradingPeriods($conn); break;
        case 'createGradingPeriod': createGradingPeriod($conn); break;
        case 'updateGradingPeriod': updateGradingPeriod($conn); break;
        case 'deleteGradingPeriod': deleteGradingPeriod($conn); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (InvalidArgumentException $e) {
    respond(['success' => false, 'message' => $e->getMessage()], 422);
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function gradingPeriodHasDependencies(PDO $conn, int $gradingPeriodId): bool {
    $stmt = $conn->prepare(
        'SELECT EXISTS(
            SELECT 1 FROM attendance WHERE grading_period_id = ?
            UNION ALL SELECT 1 FROM grades WHERE grading_period_id = ?
            UNION ALL SELECT 1 FROM report_cards WHERE grading_period_id = ?
            UNION ALL SELECT 1 FROM risk_assessments WHERE grading_period_id = ?
        )'
    );
    $stmt->execute(array_fill(0, 4, $gradingPeriodId));
    return (bool)$stmt->fetchColumn();
}

function getAllGradingPeriods(PDO $conn): void {
    lockPeriodsForInactiveSchoolYears($conn);
    $schoolYearId = isset($_GET['school_year_id']) && $_GET['school_year_id'] !== '' ? (int)$_GET['school_year_id'] : null;

    $sql = "SELECT gp.grading_period_id, gp.period_name, gp.period_no, gp.date_start, gp.date_end,
                   gp.school_year_id, sy.year_label, sy.year_start, sy.year_end, sy.grading_system_type,
                   gp.status AS status_name,
                   gp.status_mode,
                   CASE gp.status
                       WHEN 'Open' THEN 1
                       WHEN 'Submitted' THEN 2
                       WHEN 'Approved' THEN 3
                       WHEN 'Locked' THEN 4
                   END AS grading_period_status_id
            FROM grading_periods gp
            LEFT JOIN school_years sy ON gp.school_year_id = sy.school_year_id
            WHERE gp.is_deleted = 0";
    $params = [];
    if ($schoolYearId) {
        $sql .= ' AND gp.school_year_id = :sy';
        $params[':sy'] = $schoolYearId;
    }
    $sql .= ' ORDER BY gp.school_year_id DESC, gp.period_no ASC, gp.grading_period_id DESC';
    $stmt = $conn->prepare($sql);
    $stmt->execute($params);
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function createGradingPeriod(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['school_year_id']) || empty($data['period_name'])) {
        respond(['success' => false, 'message' => 'School year and period name are required'], 422);
    }

    $schoolYearId = (int)$data['school_year_id'];
    $maxPeriods = getMaxPeriodsForSchoolYear($conn, $schoolYearId);

    $periodNo = isset($data['period_no']) && is_numeric($data['period_no']) ? (int)$data['period_no'] : null;
    if ($periodNo === null) {
        // Fill the first available slot (e.g. 1, 2, or 3) instead of MAX+1,
        // so deleting a period and re-adding does not exceed the system limit.
        $periodNo = findNextAvailablePeriodNo($conn, $schoolYearId, $maxPeriods);
    }
    if ($periodNo === null) {
        respond(['success' => false, 'message' => "This school year already has the maximum {$maxPeriods} grading period(s)"], 422);
    }
    if ($periodNo < 1 || $periodNo > $maxPeriods) {
        respond(['success' => false, 'message' => "period_no must be between 1 and {$maxPeriods} for this school year's grading system"], 422);
    }

    $duplicateStmt = $conn->prepare('SELECT 1 FROM grading_periods WHERE school_year_id = :sy AND period_no = :pn AND is_deleted = 0 LIMIT 1');
    $duplicateStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $duplicateStmt->bindValue(':pn', $periodNo, PDO::PARAM_INT);
    $duplicateStmt->execute();
    if ($duplicateStmt->fetchColumn()) {
        respond(['success' => false, 'message' => "period_no {$periodNo} already exists for this school year"], 422);
    }

    $duplicateNameStmt = $conn->prepare('SELECT 1 FROM grading_periods WHERE school_year_id = :sy AND period_name = :pn AND is_deleted = 0 LIMIT 1');
    $duplicateNameStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $duplicateNameStmt->bindValue(':pn', $data['period_name']);
    $duplicateNameStmt->execute();
    if ($duplicateNameStmt->fetchColumn()) {
        respond(['success' => false, 'message' => "A grading period named \"{$data['period_name']}\" already exists for this school year"], 422);
    }

    $status = normalizeStatus($data, $periodNo);
    $statusMode = trim((string)($data['status_mode'] ?? '')) ?: 'automatic';
    $allowed = ['Open','Submitted','Approved','Locked'];
    if (!in_array($status, $allowed, true)) {
        respond(['success' => false, 'message' => 'Invalid status'], 422);
    }
    if (!in_array($statusMode, ['automatic', 'manual'], true)) {
        respond(['success' => false, 'message' => 'Invalid grading-period status mode'], 422);
    }
    if ($statusMode === 'manual' && !auth_is_admin($GLOBALS['session'] ?? [])) {
        respond(['success' => false, 'message' => 'Only an administrator can use manual grading-period status control'], 403);
    }
    $schoolYearActive = isSchoolYearActive($conn, $schoolYearId);
    if ($status === 'Open' && !$schoolYearActive && $statusMode !== 'manual') {
        respond([
            'success' => false,
            'message' => 'Cannot open this period because its school year is inactive.'
        ], 422);
    }
    if (!$schoolYearActive && $statusMode !== 'manual') {
        $status = 'Locked';
    }

    try {
        $dateStart = normalizeOptionalPeriodDate($data['date_start'] ?? null, 'Start date');
        $dateEnd = normalizeOptionalPeriodDate($data['date_end'] ?? null, 'End date');
        validatePeriodDates($conn, $schoolYearId, $dateStart, $dateEnd);
    } catch (InvalidArgumentException $e) {
        respond(['success' => false, 'message' => $e->getMessage()], 422);
    }

    try {
        $stmt = $conn->prepare('INSERT INTO grading_periods (school_year_id, period_name, period_no, status, status_mode, date_start, date_end) VALUES (:school_year_id, :period_name, :period_no, :status, :status_mode, :date_start, :date_end)');
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':period_name', $data['period_name']);
        $stmt->bindValue(':period_no', $periodNo, PDO::PARAM_INT);
        $stmt->bindValue(':status', $status);
        $stmt->bindValue(':status_mode', $statusMode);
        $stmt->bindValue(':date_start', $dateStart);
        $stmt->bindValue(':date_end', $dateEnd);
        $stmt->execute();
        sync_automatic_grading_period_statuses($conn);
        respond(['success' => true, 'message' => 'Grading period created', 'grading_period_id' => $conn->lastInsertId()]);
    } catch (PDOException $e) {
        if ($e->getCode() === '23000') {
            respond(['success' => false, 'message' => 'Duplicate grading period for this school year. Check period number or name.'], 422);
        }
        throw $e;
    }
}

function updateGradingPeriod(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['grading_period_id']) || empty($data['school_year_id']) || empty($data['period_name'])) {
        respond(['success' => false, 'message' => 'ID, school year, and period name are required'], 422);
    }

    $schoolYearId = (int)$data['school_year_id'];
    $gradingPeriodId = (int)$data['grading_period_id'];
    $maxPeriods = getMaxPeriodsForSchoolYear($conn, $schoolYearId);

    $currentStmt = $conn->prepare(
        'SELECT school_year_id, period_no, period_name, status, status_mode FROM grading_periods WHERE grading_period_id = :grading_period_id AND is_deleted = 0 LIMIT 1'
    );
    $currentStmt->bindValue(':grading_period_id', $gradingPeriodId, PDO::PARAM_INT);
    $currentStmt->execute();
    $current = $currentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$current) {
        respond(['success' => false, 'message' => 'Grading period not found'], 404);
    }

    $periodNo = isset($data['period_no']) && is_numeric($data['period_no']) ? (int)$data['period_no'] : null;

    // If period_no not supplied, preserve the existing one. If the existing row
    // has no period_no, auto-assign the next available slot.
    if ($periodNo === null) {
        $currentStmt = $conn->prepare('SELECT period_no FROM grading_periods WHERE grading_period_id = :gpid AND is_deleted = 0 LIMIT 1');
        $currentStmt->bindValue(':gpid', $gradingPeriodId, PDO::PARAM_INT);
        $currentStmt->execute();
        $currentPeriodNo = $currentStmt->fetchColumn();
        if ($currentPeriodNo === false || $currentPeriodNo === null) {
            $periodNo = findNextAvailablePeriodNo($conn, $schoolYearId, $maxPeriods);
        } else {
            $periodNo = (int)$currentPeriodNo;
        }
    }

    if ($periodNo !== null) {
        if ($periodNo < 1 || $periodNo > $maxPeriods) {
            respond(['success' => false, 'message' => "period_no must be between 1 and {$maxPeriods} for this school year's grading system"], 422);
        }
        $duplicateStmt = $conn->prepare('SELECT 1 FROM grading_periods WHERE school_year_id = :sy AND period_no = :pn AND grading_period_id <> :gpid AND is_deleted = 0 LIMIT 1');
        $duplicateStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $duplicateStmt->bindValue(':pn', $periodNo, PDO::PARAM_INT);
        $duplicateStmt->bindValue(':gpid', $gradingPeriodId, PDO::PARAM_INT);
        $duplicateStmt->execute();
        if ($duplicateStmt->fetchColumn()) {
            respond(['success' => false, 'message' => "period_no {$periodNo} already exists for this school year"], 422);
        }
    } else {
        respond(['success' => false, 'message' => "No available period number for this school year's grading system"], 422);
    }

    $identityChanged = (int)$current['school_year_id'] !== $schoolYearId
        || (int)$current['period_no'] !== $periodNo;
    if ($identityChanged && gradingPeriodHasDependencies($conn, $gradingPeriodId)) {
        respond(['success' => false, 'message' => 'Cannot change the school year or number of a grading period that already has related records'], 422);
    }

    // Preserve existing status when the modal edit does not include a status field.
    $statusInput = trim((string)($data['status'] ?? ''));
    $statusIdInput = isset($data['grading_period_status_id']) ? (int)$data['grading_period_status_id'] : 0;
    if ($statusInput === '' && $statusIdInput === 0) {
        $status = (string)($current['status'] ?? 'Locked');
    } else {
        $status = normalizeStatus($data);
    }

    $statusModeInput = trim((string)($data['status_mode'] ?? ''));
    $statusMode = $statusModeInput !== '' ? $statusModeInput : (string)($current['status_mode'] ?? 'automatic');
    $admin = auth_is_admin($GLOBALS['session'] ?? []);
    if (!in_array($statusMode, ['automatic', 'manual'], true)) {
        respond(['success' => false, 'message' => 'Invalid grading-period status mode'], 422);
    }
    if ($statusMode === 'manual' && !$admin) {
        respond(['success' => false, 'message' => 'Only an administrator can use manual grading-period status control'], 403);
    }

    $allowed = ['Open','Submitted','Approved','Locked'];
    if (!in_array($status, $allowed, true)) {
        respond(['success' => false, 'message' => 'Invalid status'], 422);
    }
    $schoolYearActive = isSchoolYearActive($conn, $schoolYearId);
    if ($status === 'Open' && !$schoolYearActive && $statusMode !== 'manual') {
        respond([
            'success' => false,
            'message' => 'Cannot open this period because its school year is inactive.'
        ], 422);
    }
    if (!$schoolYearActive && $statusMode !== 'manual') {
        $status = 'Locked';
    }

    try {
        $dateStart = normalizeOptionalPeriodDate($data['date_start'] ?? null, 'Start date');
        $dateEnd = normalizeOptionalPeriodDate($data['date_end'] ?? null, 'End date');
        validatePeriodDates($conn, $schoolYearId, $dateStart, $dateEnd, $gradingPeriodId);
    } catch (InvalidArgumentException $e) {
        respond(['success' => false, 'message' => $e->getMessage()], 422);
    }

    // Duplicate name check for a different row.
    $duplicateNameStmt = $conn->prepare('SELECT 1 FROM grading_periods WHERE school_year_id = :sy AND period_name = :pn AND grading_period_id <> :gpid AND is_deleted = 0 LIMIT 1');
    $duplicateNameStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $duplicateNameStmt->bindValue(':pn', $data['period_name']);
    $duplicateNameStmt->bindValue(':gpid', $gradingPeriodId, PDO::PARAM_INT);
    $duplicateNameStmt->execute();
    if ($duplicateNameStmt->fetchColumn()) {
        respond(['success' => false, 'message' => "A grading period named \"{$data['period_name']}\" already exists for this school year"], 422);
    }

    try {
        $stmt = $conn->prepare('UPDATE grading_periods SET school_year_id = :school_year_id, period_name = :period_name, period_no = :period_no, status = :status, status_mode = :status_mode, date_start = :date_start, date_end = :date_end WHERE grading_period_id = :grading_period_id');
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':period_name', $data['period_name']);
        $stmt->bindValue(':period_no', $periodNo, PDO::PARAM_INT);
        $stmt->bindValue(':status', $status);
        $stmt->bindValue(':status_mode', $statusMode);
        $stmt->bindValue(':date_start', $dateStart);
        $stmt->bindValue(':date_end', $dateEnd);
        $stmt->bindValue(':grading_period_id', $gradingPeriodId, PDO::PARAM_INT);
        $stmt->execute();
        sync_automatic_grading_period_statuses($conn);
        respond(['success' => true, 'message' => 'Grading period updated']);
    } catch (PDOException $e) {
        if ($e->getCode() === '23000') {
            respond(['success' => false, 'message' => 'Duplicate grading period for this school year. Check period number or name.'], 422);
        }
        throw $e;
    }
}

function deleteGradingPeriod(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['grading_period_id'])) {
        respond(['success' => false, 'message' => 'Grading period ID is required'], 422);
    }
    $gradingPeriodId = (int)$data['grading_period_id'];
    if (gradingPeriodHasDependencies($conn, $gradingPeriodId)) {
        respond(['success' => false, 'message' => 'Cannot delete a grading period that already has related records'], 422);
    }
    $stmt = $conn->prepare('UPDATE grading_periods SET is_deleted = 1, deleted_at = NOW() WHERE grading_period_id = :grading_period_id');
    $stmt->bindValue(':grading_period_id', $data['grading_period_id'], PDO::PARAM_INT);
    $stmt->execute();
    respond(['success' => true, 'message' => 'Grading period deleted']);
}
