<?php
header('Content-Type: application/json');
require_once __DIR__ . '/../utils/cors.php';

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/grading_period_lifecycle.php';
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

function normalizeSchoolYearDate($value, string $field): ?string {
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

function assertValidSchoolYearCalendarDates(?string $dateStart, ?string $dateEnd): void {
    if (($dateStart === null) !== ($dateEnd === null)) {
        throw new InvalidArgumentException('Enter both the school-year start date and end date');
    }
    if ($dateStart !== null && $dateEnd !== null && $dateStart > $dateEnd) {
        throw new InvalidArgumentException('School-year end date must be on or after its start date');
    }
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

function openFirstPeriodForActiveSchoolYear(PDO $conn, int $schoolYearId): void {
    $hasOpenOrCompletedPeriod = $conn->prepare(
        "SELECT 1
         FROM grading_periods
         WHERE school_year_id = :school_year_id
           AND is_deleted = 0
           AND (
               status <> 'Locked'
               OR (date_start IS NULL OR date_end IS NULL)
           )
         LIMIT 1"
    );
    $hasOpenOrCompletedPeriod->execute([':school_year_id' => $schoolYearId]);
    if ($hasOpenOrCompletedPeriod->fetchColumn()) {
        return;
    }

    $openFirst = $conn->prepare(
        "UPDATE grading_periods
         SET status = 'Open'
         WHERE school_year_id = :school_year_id
           AND period_no = 1
           AND is_deleted = 0
           AND status_mode = 'automatic'
           AND status = 'Locked'
           AND (date_start IS NULL OR date_end IS NULL)"
    );
    $openFirst->execute([':school_year_id' => $schoolYearId]);
}

function getAllowedGradingSystems(): array {
    return ['Quarterly', 'Three-Term'];
}

function canonicalGradingSystemType(?string $value): string {
    $normalized = strtolower(trim((string)$value));
    if (in_array($normalized, ['three-term', 'three term', 'trimester', 'term', 'terms', 't'], true)) {
        return 'Three-Term';
    }
    if ($normalized === 'semester') {
        return 'Semester';
    }
    return 'Quarterly';
}

function getUniqueActiveCurriculumId(PDO $conn): int {
    $stmt = $conn->query(
        'SELECT curriculum_id
         FROM curricula
         WHERE is_deleted = 0 AND is_active = 1
         ORDER BY curriculum_id DESC'
    );
    $ids = $stmt ? array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN)) : [];

    if (count($ids) === 0) {
        throw new InvalidArgumentException('No active curriculum is configured. Set up one active curriculum before creating a school year.');
    }
    if (count($ids) > 1) {
        throw new InvalidArgumentException('School Years requires exactly one active curriculum. Deactivate duplicate active curricula first.');
    }

    return $ids[0];
}

function getActiveSchoolYearCount(PDO $conn): int {
    $stmt = $conn->query(
        'SELECT COUNT(*)
         FROM school_years
         WHERE is_deleted = 0 AND is_active = 1'
    );
    return (int)($stmt ? $stmt->fetchColumn() : 0);
}

function assertValidSchoolYearRange(int $yearStart, int $yearEnd): void {
    if ($yearStart <= 0 || $yearEnd <= 0) {
        throw new InvalidArgumentException('Year start and year end are required');
    }
    if ($yearEnd !== $yearStart + 1) {
        throw new InvalidArgumentException('School year must be consecutive, for example 2026-2027');
    }
}

function assertNoDuplicateSchoolYear(PDO $conn, string $yearLabel, int $yearStart, int $yearEnd, ?int $exceptSchoolYearId = null, bool $includeDeleted = false): void {
    $sql = 'SELECT school_year_id, year_label
            FROM school_years
            WHERE (year_label = :year_label OR (year_start = :year_start AND year_end = :year_end))';
    if (!$includeDeleted) {
        $sql .= ' AND is_deleted = 0';
    }
    if ($exceptSchoolYearId !== null && $exceptSchoolYearId > 0) {
        $sql .= ' AND school_year_id <> :except_id';
    }
    $sql .= ' LIMIT 1';

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':year_label', $yearLabel);
    $stmt->bindValue(':year_start', $yearStart, PDO::PARAM_INT);
    $stmt->bindValue(':year_end', $yearEnd, PDO::PARAM_INT);
    if ($exceptSchoolYearId !== null && $exceptSchoolYearId > 0) {
        $stmt->bindValue(':except_id', $exceptSchoolYearId, PDO::PARAM_INT);
    }
    $stmt->execute();

    $existing = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($existing) {
        throw new InvalidArgumentException('School year ' . $yearLabel . ' already exists or was previously archived. Update/restore the existing school year if you need to change its grading system.');
    }
}

function respondDuplicateSchoolYear(string $message): void {
    respond([
        'success' => false,
        'message' => $message,
        'errors' => [
            'year_start' => $message,
            'year_end' => $message
        ]
    ], 422);
}

$operation = $_GET['operation'] ?? '';
// Archive names reuse the established soft-delete permissions and validations.
$operation = (['archiveSchoolYear' => 'deleteSchoolYear'])[$operation] ?? $operation;
$session = auth_enforce_roles($operation, ['admin', 'teacher', 'registrar', 'learners'], ['admin']);

try {
    switch ($operation) {
        case 'getAllSchoolYears':
            getAllSchoolYears($conn);
            break;
        case 'getElementaryGradingModes':
            getElementaryGradingModes($conn);
            break;
        case 'createSchoolYear':
            createSchoolYear($conn);
            break;
        case 'updateSchoolYear':
            updateSchoolYear($conn);
            break;
        case 'deleteSchoolYear':
            deleteSchoolYear($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllSchoolYears(PDO $conn): void {
    $sql = 'SELECT sy.school_year_id, sy.year_start, sy.year_end, sy.year_label, sy.date_start, sy.date_end,
                   sy.grading_system_type, sy.is_active,
                   cur.curriculum_id, cur.curriculum_code, cur.curriculum_name,
                   CASE
                       WHEN cur.curriculum_id IS NULL THEN NULL
                       ELSE CONCAT(cur.curriculum_code, " - ", cur.curriculum_name)
                   END AS curriculum_display_name
            FROM school_years sy
            LEFT JOIN (
                SELECT m.school_year_id, m.curriculum_id, m.is_primary
                FROM curriculum_school_year_map m
                WHERE m.is_deleted = 0
                  AND NOT EXISTS (
                      SELECT 1
                      FROM curriculum_school_year_map preferred
                      WHERE preferred.school_year_id = m.school_year_id
                        AND preferred.is_deleted = 0
                        AND (
                            COALESCE(preferred.is_primary, 0) > COALESCE(m.is_primary, 0)
                            OR (
                                COALESCE(preferred.is_primary, 0) = COALESCE(m.is_primary, 0)
                                AND preferred.map_id < m.map_id
                            )
                        )
                  )
            ) csy
                ON csy.school_year_id = sy.school_year_id
            LEFT JOIN curricula cur
                ON cur.curriculum_id = csy.curriculum_id
               AND cur.is_deleted = 0
            WHERE sy.is_deleted = 0
            ORDER BY sy.year_start DESC, sy.year_end DESC';
    $stmt = $conn->prepare($sql);
    $stmt->execute();

    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$row) {
        $row['grading_system_type'] = canonicalGradingSystemType($row['grading_system_type']);
        $row['system_name'] = $row['grading_system_type'];
        $row['grading_system_type_id'] = match ($row['grading_system_type']) {
            'Quarterly' => 1,
            'Three-Term' => 2,
            'Semester' => 3,
            default => null,
        };
        $elementaryModes = GradingPolicyService::elementaryModeFields($conn, (int)$row['school_year_id']);
        foreach ($elementaryModes as $gradeNo => $mode) {
            $row["grade_{$gradeNo}_grading_mode"] = $mode;
        }
        // Keep a namespaced copy as well as the flat fields for clients that
        // need to hydrate the three independent selectors explicitly.
        $row['elementary_grading_modes'] = $elementaryModes;
    }
    unset($row);
    respond($rows);
}

function getElementaryGradingModes(PDO $conn): void {
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    if ($schoolYearId <= 0) {
        respond(['success' => false, 'message' => 'School year ID is required'], 422);
    }

    $stmt = $conn->prepare(
        'SELECT school_year_id
         FROM school_years
         WHERE school_year_id = :school_year_id
           AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->execute([':school_year_id' => $schoolYearId]);
    if (!$stmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'School year not found'], 404);
    }

    $modes = GradingPolicyService::elementaryModeFields($conn, $schoolYearId);
    respond([
        'success' => true,
        'school_year_id' => $schoolYearId,
        'modes' => $modes,
        'elementary_grading_modes' => $modes,
    ]);
}

function createSchoolYear(PDO $conn): void {
    $data = getJsonInput();

    $gradingSystemType = trim((string)($data['grading_system_type'] ?? ''));
    $gradingSystemTypeId = isset($data['grading_system_type_id']) ? (int)$data['grading_system_type_id'] : 0;
    if ($gradingSystemType === '' && $gradingSystemTypeId > 0) {
        $idMap = [1 => 'Quarterly', 2 => 'Three-Term'];
        $gradingSystemType = $idMap[$gradingSystemTypeId] ?? '';
    }
    $gradingSystemType = canonicalGradingSystemType($gradingSystemType);
    if (empty($data['year_start']) || empty($data['year_end']) || $gradingSystemType === '') {
        respond(['success' => false, 'message' => 'Year start, year end, and grading system are required'], 422);
    }
    $allowed = getAllowedGradingSystems();
    if (!in_array($gradingSystemType, $allowed, true)) {
        respond(['success' => false, 'message' => 'Invalid grading_system_type'], 422);
    }

    $yearLabel = trim((string)($data['year_label'] ?? ''));
    if ($yearLabel === '') {
        $yearLabel = $data['year_start'] . '-' . $data['year_end'];
    }

    $isActive = isset($data['is_active']) ? (int)!!$data['is_active'] : 0;
    try {
        if ($isActive !== 1 && getActiveSchoolYearCount($conn) === 0) {
            throw new InvalidArgumentException('At least one active school year must remain. Save this school year as active or activate it later from the School Years edit action.');
        }
        $curriculumId = getUniqueActiveCurriculumId($conn);
        $dateStart = normalizeSchoolYearDate($data['date_start'] ?? null, 'School-year start date');
        $dateEnd = normalizeSchoolYearDate($data['date_end'] ?? null, 'School-year end date');
        assertValidSchoolYearRange((int)$data['year_start'], (int)$data['year_end']);
        assertValidSchoolYearCalendarDates($dateStart, $dateEnd);

        $conn->beginTransaction();

        $gradeModes = GradingPolicyService::requestedElementaryModes($data);

        assertNoDuplicateSchoolYear($conn, $yearLabel, (int)$data['year_start'], (int)$data['year_end'], null, true);

        if ($isActive === 1) {
            $conn->exec('UPDATE school_years SET is_active = 0 WHERE is_deleted = 0');
        }

        $stmt = $conn->prepare('INSERT INTO school_years (year_start, year_end, year_label, date_start, date_end, grading_system_type, is_active) VALUES (:year_start, :year_end, :year_label, :date_start, :date_end, :grading_system_type, :is_active)');
        $stmt->bindValue(':year_start', $data['year_start']);
        $stmt->bindValue(':year_end', $data['year_end']);
        $stmt->bindValue(':year_label', $yearLabel);
        $stmt->bindValue(':date_start', $dateStart);
        $stmt->bindValue(':date_end', $dateEnd);
        $stmt->bindValue(':grading_system_type', $gradingSystemType);
        $stmt->bindValue(':is_active', $isActive, PDO::PARAM_INT);
        $stmt->execute();
        $schoolYearId = (int)$conn->lastInsertId();

        ensurePrimaryCurriculumForSchoolYear(
            $conn,
            $schoolYearId,
            $curriculumId
        );

        seedGradingPeriodsForSchoolYear($conn, $schoolYearId, $gradingSystemType, $isActive === 1);
        GradingPolicyService::saveElementaryModes($conn, $schoolYearId, $gradeModes);
        lockPeriodsForInactiveSchoolYears($conn);

        $conn->commit();

        respond(['success' => true, 'message' => 'School year created with grading periods', 'school_year_id' => $schoolYearId]);
    } catch (InvalidArgumentException $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        if (stripos($e->getMessage(), 'already exists or was previously archived') !== false) {
            respondDuplicateSchoolYear($e->getMessage());
        }
        respond(['success' => false, 'message' => $e->getMessage()], 422);
    } catch (Exception $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        respond(['success' => false, 'message' => 'Failed to create school year: ' . $e->getMessage()], 500);
    }
}

function ensurePrimaryCurriculumForSchoolYear(PDO $conn, int $schoolYearId, ?int $requestedCurriculumId = null): int
{
    $curriculumId = $requestedCurriculumId !== null && $requestedCurriculumId > 0
        ? $requestedCurriculumId
        : 0;

    if ($curriculumId <= 0) {
        $existing = $conn->prepare(
            'SELECT curriculum_id
             FROM curriculum_school_year_map
             WHERE school_year_id = :school_year_id
               AND is_primary = 1
               AND is_deleted = 0
             ORDER BY map_id ASC
             LIMIT 1'
        );
        $existing->execute([':school_year_id' => $schoolYearId]);
        $curriculumId = (int)($existing->fetchColumn() ?: 0);
    }

    if ($curriculumId <= 0) {
        $fallback = $conn->query(
            'SELECT curriculum_id
             FROM curricula
             WHERE is_deleted = 0
             ORDER BY is_active DESC, effective_from DESC, curriculum_id DESC
             LIMIT 1'
        );
        $curriculumId = (int)($fallback ? ($fallback->fetchColumn() ?: 0) : 0);
    }

    if ($curriculumId <= 0) {
        throw new InvalidArgumentException('No active curriculum is available. Create and configure a curriculum before creating a school year.');
    }

    $valid = $conn->prepare('SELECT 1 FROM curricula WHERE curriculum_id = :curriculum_id AND is_deleted = 0 LIMIT 1');
    $valid->execute([':curriculum_id' => $curriculumId]);
    if (!$valid->fetchColumn()) {
        throw new InvalidArgumentException('Selected curriculum was not found or is archived.');
    }

    $conn->prepare(
        'UPDATE curriculum_school_year_map
         SET is_primary = 0
         WHERE school_year_id = :school_year_id
           AND is_deleted = 0'
    )->execute([':school_year_id' => $schoolYearId]);

    $existingMap = $conn->prepare(
        'SELECT map_id
         FROM curriculum_school_year_map
         WHERE curriculum_id = :curriculum_id
           AND school_year_id = :school_year_id
         LIMIT 1'
    );
    $existingMap->execute([
        ':curriculum_id' => $curriculumId,
        ':school_year_id' => $schoolYearId,
    ]);
    $mapId = $existingMap->fetchColumn();

    if ($mapId !== false && $mapId !== null) {
        $conn->prepare(
            'UPDATE curriculum_school_year_map
             SET is_primary = 1, is_deleted = 0, deleted_at = NULL
             WHERE map_id = :map_id'
        )->execute([':map_id' => $mapId]);
    } else {
        $conn->prepare(
            'INSERT INTO curriculum_school_year_map (curriculum_id, school_year_id, is_primary)
             VALUES (:curriculum_id, :school_year_id, 1)'
        )->execute([
            ':curriculum_id' => $curriculumId,
            ':school_year_id' => $schoolYearId,
        ]);
    }

    return $curriculumId;
}

function getPeriodConfig(string $gradingSystemType): array
{
    return match ($gradingSystemType) {
        'Semester' => [
            ['period_no' => 1, 'period_name' => '1st Semester'],
            ['period_no' => 2, 'period_name' => '2nd Semester'],
        ],
        'Three-Term', 'Trimester' => [
            ['period_no' => 1, 'period_name' => 'Term 1'],
            ['period_no' => 2, 'period_name' => 'Term 2'],
            ['period_no' => 3, 'period_name' => 'Term 3'],
        ],
        default => [
            ['period_no' => 1, 'period_name' => '1st Quarter'],
            ['period_no' => 2, 'period_name' => '2nd Quarter'],
            ['period_no' => 3, 'period_name' => '3rd Quarter'],
            ['period_no' => 4, 'period_name' => '4th Quarter'],
        ],
    };
}

function seedGradingPeriodsForSchoolYear(PDO $conn, int $schoolYearId, string $gradingSystemType, bool $isActiveSchoolYear = false): void
{
    $check = $conn->prepare('SELECT 1 FROM grading_periods WHERE school_year_id = :sy AND is_deleted = 0 LIMIT 1');
    $check->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $check->execute();
    if ($check->fetchColumn()) {
        return;
    }

    $periods = getPeriodConfig($gradingSystemType);
    $stmt = $conn->prepare(
        'INSERT INTO grading_periods (school_year_id, period_no, period_name, status, status_mode, date_start, date_end)
         VALUES (:school_year_id, :period_no, :period_name, :status, :status_mode, NULL, NULL)'
    );
    foreach ($periods as $p) {
        $isFirstOpenPeriod = $isActiveSchoolYear && (int)$p['period_no'] === 1;
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':period_no', (int)$p['period_no'], PDO::PARAM_INT);
        $stmt->bindValue(':period_name', $p['period_name']);
        $stmt->bindValue(':status', $isFirstOpenPeriod ? 'Open' : 'Locked');
        // Keep the seeded first term open even when its calendar starts in
        // the future. Later terms remain date-driven and automatic.
        $stmt->bindValue(':status_mode', $isFirstOpenPeriod ? 'manual' : 'automatic');
        $stmt->execute();
    }
}

function assertGradingPeriodsFitSchoolYearDates(PDO $conn, int $schoolYearId, ?string $dateStart, ?string $dateEnd): void
{
    $stmt = $conn->prepare(
        'SELECT period_name, date_start, date_end
         FROM grading_periods
         WHERE school_year_id = :school_year_id AND is_deleted = 0
           AND (date_start IS NOT NULL OR date_end IS NOT NULL)'
    );
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $periods = $stmt->fetchAll(PDO::FETCH_ASSOC);
    if (!$periods) {
        return;
    }
    if (!$dateStart || !$dateEnd) {
        throw new InvalidArgumentException('Set both school-year dates before changing dates used by grading periods');
    }
    if ($dateStart > $dateEnd) {
        throw new InvalidArgumentException('School-year end date must be on or after its start date');
    }

    foreach ($periods as $period) {
        $periodStart = $period['date_start'] ? substr((string)$period['date_start'], 0, 10) : null;
        $periodEnd = $period['date_end'] ? substr((string)$period['date_end'], 0, 10) : null;
        foreach ([$periodStart, $periodEnd] as $periodDate) {
            if ($periodDate !== null && ($periodDate < $dateStart || $periodDate > $dateEnd)) {
            throw new InvalidArgumentException(
                'The school-year dates cannot exclude the configured dates for ' . $period['period_name']
            );
            }
        }
    }
}

function prepareSchoolYearGradingPeriodUpdates(
    PDO $conn,
    int $schoolYearId,
    array $requestedPeriods,
    ?string $schoolYearDateStart,
    ?string $schoolYearDateEnd,
    bool $schoolYearIsActive,
    bool $allowManualOverride = false
): array {
    if (!$requestedPeriods) {
        return [];
    }

    $stmt = $conn->prepare(
        'SELECT grading_period_id, period_no, period_name, status, status_mode, date_start, date_end
         FROM grading_periods
         WHERE school_year_id = :school_year_id AND is_deleted = 0
         ORDER BY period_no ASC, grading_period_id ASC'
    );
    $stmt->execute([':school_year_id' => $schoolYearId]);
    $existingRows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $existingById = [];
    foreach ($existingRows as $row) {
        $existingById[(int)$row['grading_period_id']] = $row;
    }

    $updates = [];
    $seenIds = [];
    foreach ($requestedPeriods as $requested) {
        if (!is_array($requested) || empty($requested['grading_period_id'])) {
            throw new InvalidArgumentException('Each grading-period update requires a valid grading period ID');
        }

        $gradingPeriodId = (int)$requested['grading_period_id'];
        if (isset($seenIds[$gradingPeriodId])) {
            throw new InvalidArgumentException('A grading period was submitted more than once');
        }
        $seenIds[$gradingPeriodId] = true;

        $current = $existingById[$gradingPeriodId] ?? null;
        if (!$current) {
            throw new InvalidArgumentException('A grading period no longer belongs to this school year. Reload the School Year and try again.');
        }

        $dateStart = normalizeSchoolYearDate($requested['date_start'] ?? null, 'Grading-period start date');
        $dateEnd = normalizeSchoolYearDate($requested['date_end'] ?? null, 'Grading-period end date');
        if ($dateStart && $dateEnd && $dateStart > $dateEnd) {
            throw new InvalidArgumentException('Grading-period end date must be on or after its start date');
        }
        if (($dateStart || $dateEnd) && (!$schoolYearDateStart || !$schoolYearDateEnd)) {
            throw new InvalidArgumentException('Set both school-year dates before assigning grading-period dates');
        }
        foreach ([$dateStart, $dateEnd] as $periodDate) {
            if ($periodDate !== null
                && (($schoolYearDateStart && $periodDate < $schoolYearDateStart)
                    || ($schoolYearDateEnd && $periodDate > $schoolYearDateEnd))) {
                throw new InvalidArgumentException('Grading-period dates must remain within the school-year dates');
            }
        }

        $status = trim((string)($requested['status'] ?? $current['status'] ?? 'Locked'));
        $statusMode = trim((string)($requested['status_mode'] ?? $current['status_mode'] ?? 'automatic'));
        if (!in_array($statusMode, ['automatic', 'manual'], true)) {
            throw new InvalidArgumentException('Invalid grading-period status mode');
        }
        if ($statusMode === 'manual' && !$allowManualOverride) {
            throw new InvalidArgumentException('Only an administrator can use manual grading-period status control');
        }
        if (!$schoolYearIsActive && $statusMode !== 'manual') {
            $status = 'Locked';
        }
        if (!in_array($status, ['Open', 'Submitted', 'Approved', 'Locked'], true)) {
            throw new InvalidArgumentException('Invalid grading-period status');
        }

        $updates[$gradingPeriodId] = [
            'grading_period_id' => $gradingPeriodId,
            'date_start' => $dateStart,
            'date_end' => $dateEnd,
            'status' => $status,
            'status_mode' => $statusMode,
        ];
    }

    $candidateRows = [];
    foreach ($existingRows as $row) {
        $gradingPeriodId = (int)$row['grading_period_id'];
        $candidate = $updates[$gradingPeriodId] ?? null;
        $candidateRows[] = [
            'grading_period_id' => $gradingPeriodId,
            'period_name' => $row['period_name'],
            'date_start' => $candidate
                ? $candidate['date_start']
                : ($row['date_start'] ? substr((string)$row['date_start'], 0, 10) : null),
            'date_end' => $candidate
                ? $candidate['date_end']
                : ($row['date_end'] ? substr((string)$row['date_end'], 0, 10) : null),
        ];
    }

    for ($i = 0, $count = count($candidateRows); $i < $count; $i++) {
        $left = $candidateRows[$i];
        $leftStart = $left['date_start'] ?: $left['date_end'];
        $leftEnd = $left['date_end'] ?: $left['date_start'];
        if (!$leftStart || !$leftEnd) {
            continue;
        }
        for ($j = $i + 1; $j < $count; $j++) {
            $right = $candidateRows[$j];
            $rightStart = $right['date_start'] ?: $right['date_end'];
            $rightEnd = $right['date_end'] ?: $right['date_start'];
            if ($rightStart && $rightEnd && $leftStart <= $rightEnd && $rightStart <= $leftEnd) {
                throw new InvalidArgumentException(
                    'The configured dates for ' . $left['period_name'] . ' overlap ' . $right['period_name']
                );
            }
        }
    }

    return array_values($updates);
}

function applySchoolYearGradingPeriodUpdates(PDO $conn, array $updates): void
{
    if (!$updates) {
        return;
    }

    $stmt = $conn->prepare(
        'UPDATE grading_periods
         SET status = :status, status_mode = :status_mode, date_start = :date_start, date_end = :date_end
         WHERE grading_period_id = :grading_period_id AND is_deleted = 0'
    );
    foreach ($updates as $update) {
        $stmt->execute([
            ':status' => $update['status'],
            ':status_mode' => $update['status_mode'],
            ':date_start' => $update['date_start'],
            ':date_end' => $update['date_end'],
            ':grading_period_id' => $update['grading_period_id'],
        ]);
    }
}

function gradingPeriodHasDependencies(PDO $conn, int $gradingPeriodId): bool {
    $stmt = $conn->prepare(
        'SELECT EXISTS(
            SELECT 1 FROM attendance WHERE grading_period_id = ? AND is_deleted = 0
            UNION ALL SELECT 1 FROM grades WHERE grading_period_id = ? AND is_deleted = 0
            UNION ALL SELECT 1 FROM report_cards WHERE grading_period_id = ? AND is_deleted = 0
            UNION ALL
            SELECT 1
            FROM risk_assessments ra
            WHERE ra.grading_period_id = ?
              AND ra.is_deleted = 0
              AND NOT (
                  ra.notes LIKE "%No Encoded Grades%"
                  AND NOT EXISTS (
                      SELECT 1
                      FROM risk_indicators ri
                      WHERE ri.risk_assessment_id = ra.risk_assessment_id
                        AND ri.is_deleted = 0
                        AND COALESCE(ri.indicator_type, "") <> "No Encoded Grades"
                  )
              )
        )'
    );
    $stmt->execute(array_fill(0, 4, $gradingPeriodId));
    return (bool)$stmt->fetchColumn();
}

function removeIgnorableRiskAssessmentsForPeriod(PDO $conn, int $gradingPeriodId): void {
    $stmt = $conn->prepare(
        'SELECT ra.risk_assessment_id
         FROM risk_assessments ra
         WHERE ra.grading_period_id = :gpid
           AND ra.is_deleted = 0
           AND ra.notes LIKE "%No Encoded Grades%"
           AND NOT EXISTS (
               SELECT 1
               FROM risk_indicators ri
               WHERE ri.risk_assessment_id = ra.risk_assessment_id
                 AND ri.is_deleted = 0
                 AND COALESCE(ri.indicator_type, "") <> "No Encoded Grades"
           )'
    );
    $stmt->bindValue(':gpid', $gradingPeriodId, PDO::PARAM_INT);
    $stmt->execute();
    $ids = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    if (!$ids) {
        return;
    }

    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $indicatorStmt = $conn->prepare("UPDATE risk_indicators SET is_deleted = 1, deleted_at = NOW() WHERE risk_assessment_id IN ($placeholders) AND is_deleted = 0");
    $indicatorStmt->execute($ids);

    $riskStmt = $conn->prepare("UPDATE risk_assessments SET is_deleted = 1, deleted_at = NOW() WHERE risk_assessment_id IN ($placeholders) AND is_deleted = 0");
    $riskStmt->execute($ids);
}

function reconcileGradingPeriodsForSystemChange(PDO $conn, int $schoolYearId, string $newSystemType): void {
    $targetPeriods = getPeriodConfig($newSystemType);
    $targetMax = count($targetPeriods);

    $stmt = $conn->prepare(
        'SELECT grading_period_id, period_no, period_name, is_deleted
         FROM grading_periods
         WHERE school_year_id = :sy
         ORDER BY period_no ASC, grading_period_id ASC'
    );
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    foreach ($rows as $row) {
        $periodNo = (int)($row['period_no'] ?? 0);
        if ((int)$row['is_deleted'] === 0 && $periodNo > $targetMax) {
            removeIgnorableRiskAssessmentsForPeriod($conn, (int)$row['grading_period_id']);
        }
        if ((int)$row['is_deleted'] === 0 && $periodNo > $targetMax && gradingPeriodHasDependencies($conn, (int)$row['grading_period_id'])) {
            throw new InvalidArgumentException('Cannot change grading system: period ' . $periodNo . ' already has related records');
        }
    }

    $renameArchivedStmt = $conn->prepare(
        'UPDATE grading_periods
         SET period_name = CONCAT(period_name, " (archived ", grading_period_id, ")")
         WHERE school_year_id = :sy
           AND grading_period_id <> :gpid
           AND period_name = :period_name'
    );
    $upsertStmt = $conn->prepare(
        'INSERT INTO grading_periods (school_year_id, period_no, period_name, status, date_start, date_end, is_deleted, deleted_at)
         VALUES (:school_year_id, :period_no, :period_name, :status, NULL, NULL, 0, NULL)
         ON DUPLICATE KEY UPDATE
           period_no = VALUES(period_no),
           period_name = VALUES(period_name),
           is_deleted = 0,
           deleted_at = NULL'
    );
    $restoreByNoStmt = $conn->prepare(
        'UPDATE grading_periods
         SET period_name = :period_name, is_deleted = 0, deleted_at = NULL
         WHERE grading_period_id = :gpid'
    );

    $byNo = [];
    foreach ($rows as $row) {
        $periodNo = (int)($row['period_no'] ?? 0);
        if ($periodNo > 0 && !isset($byNo[$periodNo])) {
            $byNo[$periodNo] = $row;
        }
    }

    foreach ($targetPeriods as $period) {
        $periodNo = (int)$period['period_no'];
        $periodName = (string)$period['period_name'];
        $existing = $byNo[$periodNo] ?? null;

        if ($existing) {
            $gpid = (int)$existing['grading_period_id'];
            $renameArchivedStmt->execute([
                ':sy' => $schoolYearId,
                ':gpid' => $gpid,
                ':period_name' => $periodName,
            ]);
            $restoreByNoStmt->execute([
                ':period_name' => $periodName,
                ':gpid' => $gpid,
            ]);
            continue;
        }

        $upsertStmt->execute([
            ':school_year_id' => $schoolYearId,
            ':period_no' => $periodNo,
            ':period_name' => $periodName,
            ':status' => 'Locked',
        ]);
    }

    $archiveExtraStmt = $conn->prepare(
        'UPDATE grading_periods
         SET is_deleted = 1,
             deleted_at = NOW(),
             period_name = CONCAT(period_name, " (archived ", grading_period_id, ")")
         WHERE school_year_id = :sy
           AND is_deleted = 0
           AND period_no > :target_max'
    );
    $archiveExtraStmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $archiveExtraStmt->bindValue(':target_max', $targetMax, PDO::PARAM_INT);
    $archiveExtraStmt->execute();
}

function updateSchoolYear(PDO $conn): void {
    global $session;
    $allowManualPeriodOverride = auth_is_admin($session ?? []);
    $data = getJsonInput();

    $gradingSystemType = trim((string)($data['grading_system_type'] ?? ''));
    $gradingSystemTypeId = isset($data['grading_system_type_id']) ? (int)$data['grading_system_type_id'] : 0;
    if ($gradingSystemType === '' && $gradingSystemTypeId > 0) {
        $idMap = [1 => 'Quarterly', 2 => 'Three-Term'];
        $gradingSystemType = $idMap[$gradingSystemTypeId] ?? '';
    }
    $gradingSystemType = canonicalGradingSystemType($gradingSystemType);
    if (empty($data['school_year_id']) || empty($data['year_start']) || empty($data['year_end']) || $gradingSystemType === '') {
        respond(['success' => false, 'message' => 'School year ID, years, and grading_system_type (or grading_system_type_id) are required'], 422);
    }
    $allowed = getAllowedGradingSystems();
    if (!in_array($gradingSystemType, $allowed, true)) {
        respond(['success' => false, 'message' => 'Invalid grading_system_type'], 422);
    }

    $yearLabel = trim((string)($data['year_label'] ?? ''));
    if ($yearLabel === '') {
        $yearLabel = $data['year_start'] . '-' . $data['year_end'];
    }

    $currentStmt = $conn->prepare('SELECT grading_system_type, date_start, date_end, is_active FROM school_years WHERE school_year_id = :id AND is_deleted = 0 LIMIT 1');
    $currentStmt->bindValue(':id', $data['school_year_id'], PDO::PARAM_INT);
    $currentStmt->execute();
    $currentYear = $currentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$currentYear) {
        respond(['success' => false, 'message' => 'School year not found'], 404);
    }
    $currentSystem = $currentYear['grading_system_type'];
    $currentIsActive = (int)($currentYear['is_active'] ?? 0);

    $isActive = array_key_exists('is_active', $data)
        ? (int)!!$data['is_active']
        : $currentIsActive;
    if ($currentIsActive === 1 && $isActive !== 1) {
        respond([
            'success' => false,
            'code' => 'ACTIVE_SCHOOL_YEAR_REQUIRED',
            'message' => 'The active school year cannot be deactivated. To switch years, edit the other School Year and set it as active.',
        ], 409);
    }
    if ($currentIsActive !== 1 && $isActive !== 1 && getActiveSchoolYearCount($conn) === 0) {
        respond([
            'success' => false,
            'code' => 'ACTIVE_SCHOOL_YEAR_REQUIRED',
            'message' => 'At least one active school year must remain. Set this school year as active before saving.',
        ], 409);
    }

    try {
        $newDateStart = normalizeSchoolYearDate($data['date_start'] ?? null, 'School-year start date');
        $newDateEnd = normalizeSchoolYearDate($data['date_end'] ?? null, 'School-year end date');
        assertValidSchoolYearRange((int)$data['year_start'], (int)$data['year_end']);
        assertValidSchoolYearCalendarDates($newDateStart, $newDateEnd);

        $conn->beginTransaction();

        $gradeModes = GradingPolicyService::requestedElementaryModes($data);

        assertNoDuplicateSchoolYear($conn, $yearLabel, (int)$data['year_start'], (int)$data['year_end'], (int)$data['school_year_id']);

        $systemChanged = (string)$currentSystem !== $gradingSystemType;
        if ($systemChanged) {
            reconcileGradingPeriodsForSystemChange($conn, (int)$data['school_year_id'], $gradingSystemType);
        }

        $requestedGradingPeriods = $data['grading_periods'] ?? [];
        if (!is_array($requestedGradingPeriods)) {
            throw new InvalidArgumentException('Grading-period updates must be an array');
        }
        $gradingPeriodUpdates = prepareSchoolYearGradingPeriodUpdates(
            $conn,
            (int)$data['school_year_id'],
            $requestedGradingPeriods,
            $newDateStart,
            $newDateEnd,
            $isActive === 1,
            $allowManualPeriodOverride
        );

        if ($newDateStart !== ($currentYear['date_start'] ?: null)
            || $newDateEnd !== ($currentYear['date_end'] ?: null)) {
            assertGradingPeriodsFitSchoolYearDates(
                $conn,
                (int)$data['school_year_id'],
                $newDateStart,
                $newDateEnd
            );
        }

        if ($isActive === 1) {
            $reset = $conn->prepare('UPDATE school_years SET is_active = 0 WHERE is_deleted = 0 AND school_year_id <> :id');
            $reset->bindValue(':id', $data['school_year_id'], PDO::PARAM_INT);
            $reset->execute();
        }

        $stmt = $conn->prepare('UPDATE school_years SET year_start = :year_start, year_end = :year_end, year_label = :year_label, date_start = :date_start, date_end = :date_end, grading_system_type = :grading_system_type, is_active = :is_active WHERE school_year_id = :school_year_id');
        $stmt->bindValue(':year_start', $data['year_start']);
        $stmt->bindValue(':year_end', $data['year_end']);
        $stmt->bindValue(':year_label', $yearLabel);
        $stmt->bindValue(':date_start', $newDateStart);
        $stmt->bindValue(':date_end', $newDateEnd);
        $stmt->bindValue(':grading_system_type', $gradingSystemType);
        $stmt->bindValue(':is_active', $isActive, PDO::PARAM_INT);
        $stmt->bindValue(':school_year_id', $data['school_year_id'], PDO::PARAM_INT);
        $stmt->execute();

        applySchoolYearGradingPeriodUpdates($conn, $gradingPeriodUpdates);

        // Keep the school year's existing primary curriculum. Curriculum
        // version changes are intentional actions in Curriculum Components;
        // editing dates, periods, or active status must not remap history.
        ensurePrimaryCurriculumForSchoolYear(
            $conn,
            (int)$data['school_year_id'],
            null
        );

        if ($isActive === 1 && ((int)($currentYear['is_active'] ?? 0) !== 1 || $systemChanged)) {
            openFirstPeriodForActiveSchoolYear($conn, (int)$data['school_year_id']);
        }
        GradingPolicyService::saveElementaryModes($conn, (int)$data['school_year_id'], $gradeModes);
        lockPeriodsForInactiveSchoolYears($conn);
        sync_automatic_grading_period_statuses($conn);

        $conn->commit();
    } catch (InvalidArgumentException $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        if (stripos($e->getMessage(), 'already exists or was previously archived') !== false) {
            respondDuplicateSchoolYear($e->getMessage());
        }
        respond(['success' => false, 'message' => $e->getMessage()], 422);
    } catch (Exception $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        throw $e;
    }

    respond(['success' => true, 'message' => 'School year updated']);
}

function deleteSchoolYear(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['school_year_id'])) {
        respond(['success' => false, 'message' => 'School year ID is required'], 422);
    }

    $current = $conn->prepare(
        'SELECT is_active
         FROM school_years
         WHERE school_year_id = :school_year_id
           AND is_deleted = 0
         LIMIT 1'
    );
    $current->execute([':school_year_id' => $data['school_year_id']]);
    $isActive = $current->fetchColumn();
    if ($isActive === false) {
        respond(['success' => false, 'message' => 'School year not found'], 404);
    }
    if ((int)$isActive === 1) {
        respond([
            'success' => false,
            'code' => 'ACTIVE_SCHOOL_YEAR_REQUIRED',
            'message' => 'The active school year cannot be archived. To switch years, edit the other School Year and set it as active first.',
        ], 409);
    }

    $stmt = $conn->prepare('UPDATE school_years SET is_deleted = 1, deleted_at = NOW() WHERE school_year_id = :school_year_id');
    $stmt->bindValue(':school_year_id', $data['school_year_id'], PDO::PARAM_INT);
    $stmt->execute();
    lockPeriodsForInactiveSchoolYears($conn);

    respond(['success' => true, 'message' => 'School year archived']);
}
?>
