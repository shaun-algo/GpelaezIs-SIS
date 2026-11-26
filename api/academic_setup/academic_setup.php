<?php
header('Content-Type: application/json');
require_once __DIR__ . '/../utils/cors.php';
require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';
require_once __DIR__ . '/../utils/audit.php';
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

function periodConfig(string $gradingSystemType): array {
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

function tableHasColumn(PDO $conn, string $tableName, string $columnName): bool {
    $stmt = $conn->prepare(
        'SELECT 1
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = :table_name
           AND COLUMN_NAME = :column_name
         LIMIT 1'
    );
    $stmt->execute([':table_name' => $tableName, ':column_name' => $columnName]);
    return (bool)$stmt->fetchColumn();
}

function getAllowedGradingSystems(PDO $conn): array {
    try {
        $stmt = $conn->query('SHOW COLUMNS FROM school_years LIKE "grading_system_type"');
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $type = (string)($row['Type'] ?? '');
        if (preg_match_all("/'([^']+)'/", $type, $matches) && !empty($matches[1])) {
            $systems = [];
            foreach ($matches[1] as $system) {
                $canonical = strtolower(trim($system)) === 'trimester' ? 'Three-Term' : $system;
                if (!in_array($canonical, $systems, true)) {
                    $systems[] = $canonical;
                }
            }
            return $systems;
        }
    } catch (Exception $e) {
        // Fall back to the application-level set below.
    }
    return ['Quarterly', 'Three-Term'];
}

function getUniqueActiveCurriculum(PDO $conn): array {
    $stmt = $conn->query(
        'SELECT curriculum_id, curriculum_code, curriculum_name, description,
                effective_from, effective_until, is_active
         FROM curricula
         WHERE is_deleted = 0 AND is_active = 1
         ORDER BY curriculum_id DESC'
    );
    $rows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];

    if (count($rows) === 0) {
        throw new InvalidArgumentException('No active curriculum is configured. Activate one curriculum before creating an academic year.');
    }
    if (count($rows) > 1) {
        throw new InvalidArgumentException('Academic Year Setup requires exactly one active curriculum. Deactivate duplicate active curricula first.');
    }

    return $rows[0];
}

function normalizeAcademicYear(PDO $conn, array $data): array {
    $yearStart = isset($data['year_start']) ? (int)$data['year_start'] : 0;
    $yearEnd = isset($data['year_end']) ? (int)$data['year_end'] : 0;
    if ($yearStart <= 0 || $yearEnd <= 0) {
        throw new InvalidArgumentException('School year range is required.');
    }
    if ($yearEnd !== $yearStart + 1) {
        throw new InvalidArgumentException('School year must follow the next-year format, for example 2026-2027.');
    }

    $dateStart = trim((string)($data['date_start'] ?? ''));
    $dateEnd = trim((string)($data['date_end'] ?? ''));
    if ($dateStart === '' || $dateEnd === '') {
        throw new InvalidArgumentException('Official start date and end date are required.');
    }
    if ($dateStart > $dateEnd) {
        throw new InvalidArgumentException('End date must be on or after start date.');
    }
    $schoolYearDateStart = $dateStart;
    $schoolYearDateEnd = $dateEnd;

    $gradingSystemType = trim((string)($data['grading_system_type'] ?? ''));
    if (strtolower($gradingSystemType) === 'trimester') {
        $gradingSystemType = 'Three-Term';
    }
    $allowed = getAllowedGradingSystems($conn);
    if (!in_array($gradingSystemType, $allowed, true)) {
        throw new InvalidArgumentException('Invalid grading system.');
    }

    $configuredPeriods = periodConfig($gradingSystemType);
    $submittedPeriods = is_array($data['period_dates'] ?? null) ? $data['period_dates'] : [];
    $periodsByNo = [];
    foreach ($submittedPeriods as $period) {
        if (!is_array($period)) {
            throw new InvalidArgumentException('Provide a date range for each grading period.');
        }
        $periodNo = isset($period['period_no']) ? (int)$period['period_no'] : 0;
        if ($periodNo < 1 || $periodNo > count($configuredPeriods) || isset($periodsByNo[$periodNo])) {
            throw new InvalidArgumentException('Provide a date range for each grading period.');
        }
        $periodsByNo[$periodNo] = $period;
    }
    if (count($periodsByNo) !== count($configuredPeriods)) {
        throw new InvalidArgumentException('Provide a date range for each grading period.');
    }
    $periodDates = [];
    $previousEnd = null;
    foreach ($configuredPeriods as $configuredPeriod) {
        $periodNo = (int)$configuredPeriod['period_no'];
        $period = $periodsByNo[$periodNo] ?? [];
        // The first grading period always begins with the official school-year
        // start. Keep this mapping authoritative at the API boundary so older
        // clients or stale browser state cannot save a different first start.
        if ($periodNo === 1) {
            $period['date_start'] = $schoolYearDateStart;
        }
        $periodStart = normalizeSetupDate($period['date_start'] ?? '', "Period {$periodNo} start date");
        $periodEnd = normalizeSetupDate($period['date_end'] ?? '', "Period {$periodNo} end date");
        if ($periodStart > $periodEnd) {
            throw new InvalidArgumentException("Period {$periodNo} end date must be on or after its start date.");
        }
        if ($periodStart < $schoolYearDateStart || $periodEnd > $schoolYearDateEnd) {
            throw new InvalidArgumentException("Period {$periodNo} dates must fall within the school-year dates.");
        }
        if ($previousEnd !== null && $periodStart <= $previousEnd) {
            throw new InvalidArgumentException('Period dates must be in order and must not overlap.');
        }
        $periodDates[$periodNo] = ['date_start' => $periodStart, 'date_end' => $periodEnd];
        $previousEnd = $periodEnd;
    }

    $activeCurriculum = getUniqueActiveCurriculum($conn);
    $curriculumId = (int)$activeCurriculum['curriculum_id'];

    return [
        'year_start' => $yearStart,
        'year_end' => $yearEnd,
        'year_label' => $yearStart . '-' . $yearEnd,
        'date_start' => $schoolYearDateStart,
        'date_end' => $schoolYearDateEnd,
        'grading_system_type' => $gradingSystemType,
        'period_dates' => $periodDates,
        'is_active' => isset($data['is_active']) ? (int)!!$data['is_active'] : 1,
        'curriculum_id' => $curriculumId,
    ];
}

function normalizeSetupDate($value, string $field): string {
    $date = trim((string)$value);
    $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
    $errors = DateTimeImmutable::getLastErrors();
    if (!$parsed || ($errors !== false && ($errors['warning_count'] > 0 || $errors['error_count'] > 0))
        || $parsed->format('Y-m-d') !== $date) {
        throw new InvalidArgumentException("{$field} must be a valid date in YYYY-MM-DD format.");
    }
    return $date;
}

function getLatestSchoolYear(PDO $conn): ?array {
    $stmt = $conn->query(
        'SELECT school_year_id, year_start, year_end, year_label, date_start, date_end, grading_system_type, is_active
         FROM school_years
         WHERE is_deleted = 0
         ORDER BY year_end DESC, year_start DESC, school_year_id DESC
         LIMIT 1'
    );
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function getActiveSchoolYearCount(PDO $conn): int {
    $stmt = $conn->query(
        'SELECT COUNT(*)
         FROM school_years
         WHERE is_deleted = 0 AND is_active = 1'
    );
    return (int)($stmt ? $stmt->fetchColumn() : 0);
}

function getSuggestedYear(PDO $conn): array {
    $latest = getLatestSchoolYear($conn);
    $nextStart = $latest ? ((int)$latest['year_end']) : (int)date('Y');
    if ($nextStart <= 0) {
        $nextStart = (int)date('Y');
    }
    $nextEnd = $nextStart + 1;
    return [
        'year_start' => $nextStart,
        'year_end' => $nextEnd,
        'year_label' => $nextStart . '-' . $nextEnd,
    ];
}

function teacherExists(PDO $conn, int $employeeId): bool {
    if ($employeeId <= 0) {
        return false;
    }
    $stmt = $conn->prepare(
        'SELECT r.role_name
         FROM employees e
         JOIN (' . user_identity_derived_sql() . ') u ON u.user_id = e.user_id AND u.is_deleted = 0
         JOIN roles r ON r.role_id = u.role_id AND r.is_deleted = 0
         WHERE e.employee_id = :employee_id
           AND e.is_deleted = 0
         LIMIT 1'
    );
    $stmt->execute([':employee_id' => $employeeId]);
    $roleName = $stmt->fetchColumn();
    return $roleName !== false && str_contains(strtolower((string)$roleName), 'teacher');
}

function gradeLevelExists(PDO $conn, int $gradeLevelId): bool {
    $stmt = $conn->prepare('SELECT 1 FROM grade_levels WHERE grade_level_id = :id AND is_deleted = 0 LIMIT 1');
    $stmt->execute([':id' => $gradeLevelId]);
    return (bool)$stmt->fetchColumn();
}

function validateSections(PDO $conn, array $sections): array {
    $normalized = [];
    $seenNames = [];
    $seenAdvisers = [];

    foreach ($sections as $index => $section) {
        $sectionName = trim((string)($section['section_name'] ?? ''));
        $gradeLevelId = isset($section['grade_level_id']) ? (int)$section['grade_level_id'] : 0;
        $adviserId = isset($section['adviser_id']) && $section['adviser_id'] !== '' ? (int)$section['adviser_id'] : null;
        $maxCapacity = isset($section['max_capacity']) && $section['max_capacity'] !== '' ? (int)$section['max_capacity'] : 45;

        if ($sectionName === '' && $gradeLevelId <= 0) {
            continue;
        }
        if ($sectionName === '' || $gradeLevelId <= 0) {
            throw new InvalidArgumentException('Each section must have a grade level and section name.');
        }
        if (!gradeLevelExists($conn, $gradeLevelId)) {
            throw new InvalidArgumentException('One of the selected grade levels no longer exists.');
        }
        if ($maxCapacity <= 0 || $maxCapacity > 60) {
            throw new InvalidArgumentException('Section capacity must be between 1 and 60.');
        }
        if ($adviserId !== null) {
            if (!teacherExists($conn, $adviserId)) {
                throw new InvalidArgumentException('Each adviser must be an employee with a teacher role.');
            }
            if (isset($seenAdvisers[$adviserId])) {
                throw new InvalidArgumentException('An adviser can be assigned to only one section in the setup.');
            }
            $seenAdvisers[$adviserId] = true;
        }

        $sectionNameKey = function_exists('mb_strtolower') ? mb_strtolower($sectionName, 'UTF-8') : strtolower($sectionName);
        $sectionKey = $sectionNameKey;
        if (isset($seenNames[$sectionKey])) {
            throw new InvalidArgumentException('Name already taken.');
        }
        $seenNames[$sectionKey] = true;

        $normalized[] = [
            'section_name' => $sectionName,
            'grade_level_id' => $gradeLevelId,
            'adviser_id' => $adviserId,
            'max_capacity' => $maxCapacity,
            'source_index' => $index,
        ];
    }

    return $normalized;
}

function ensureNoDuplicateSchoolYear(PDO $conn, string $yearLabel, int $yearStart, int $yearEnd): void {
    $stmt = $conn->prepare(
        'SELECT year_label
         FROM school_years
         WHERE (year_label = :year_label OR (year_start = :year_start AND year_end = :year_end))
         LIMIT 1'
    );
    $stmt->execute([
        ':year_label' => $yearLabel,
        ':year_start' => $yearStart,
        ':year_end' => $yearEnd,
    ]);
    if ($stmt->fetchColumn()) {
        throw new InvalidArgumentException('This school year already exists or was previously archived. Update/restore the existing school year if you need to change its grading system.');
    }
}

function ensureAdviserStillAvailable(PDO $conn, int $schoolYearId, ?int $adviserId): void {
    if ($adviserId === null || $adviserId <= 0) {
        return;
    }
    $stmt = $conn->prepare(
        'SELECT 1
         FROM sections
         WHERE is_deleted = 0
           AND school_year_id = :school_year_id
           AND adviser_id = :adviser_id
         LIMIT 1'
    );
    $stmt->execute([':school_year_id' => $schoolYearId, ':adviser_id' => $adviserId]);
    if ($stmt->fetchColumn()) {
        throw new InvalidArgumentException('An adviser became unavailable while saving. Please review section assignments.');
    }
}

function mapCurriculumToSchoolYear(PDO $conn, int $schoolYearId, int $curriculumId): void {
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
        return;
    }

    $conn->prepare(
        'INSERT INTO curriculum_school_year_map (curriculum_id, school_year_id, is_primary)
         VALUES (:curriculum_id, :school_year_id, 1)'
    )->execute([
        ':curriculum_id' => $curriculumId,
        ':school_year_id' => $schoolYearId,
    ]);
}

function getSetupDefaults(PDO $conn): void {
    $gradeStmt = $conn->query(
        'SELECT grade_level_id, grade_name, sort_order
         FROM grade_levels
         WHERE is_deleted = 0
         ORDER BY COALESCE(sort_order, grade_level_id), grade_level_id'
    );

    $teacherStmt = $conn->query(
        'SELECT e.employee_id,
                e.employee_number,
                e.first_name,
                e.middle_name,
                e.last_name,
                e.name_extension
         FROM employees e
         JOIN (' . user_identity_derived_sql() . ') u ON u.user_id = e.user_id AND u.is_deleted = 0
         JOIN roles r ON r.role_id = u.role_id AND r.is_deleted = 0
         WHERE e.is_deleted = 0
           AND LOWER(r.role_name) LIKE "%teacher%"
         ORDER BY e.last_name, e.first_name, e.employee_number'
    );

    $suggested = getSuggestedYear($conn);
    $activeCurriculum = getUniqueActiveCurriculum($conn);
    $allowedSystems = getAllowedGradingSystems($conn);
    $systemRows = [];
    foreach (['Quarterly', 'Three-Term'] as $system) {
        if (!in_array($system, $allowedSystems, true)) {
            continue;
        }
        $systemRows[] = ['value' => $system, 'label' => $system, 'periods' => periodConfig($system)];
    }

    respond([
        'success' => true,
        'latest_school_year' => getLatestSchoolYear($conn),
        'suggested_school_year' => $suggested,
        'grading_systems' => $systemRows,
        'active_curriculum' => $activeCurriculum,
        'grade_levels' => $gradeStmt->fetchAll(PDO::FETCH_ASSOC),
        'teachers' => $teacherStmt->fetchAll(PDO::FETCH_ASSOC),
    ]);
}

function createAcademicYearSetup(PDO $conn): void {
    $data = getJsonInput();
    $schoolYear = normalizeAcademicYear($conn, $data);
    if ($schoolYear['is_active'] !== 1 && getActiveSchoolYearCount($conn) === 0) {
        throw new InvalidArgumentException('At least one active school year must remain. Save this setup as active, or activate it later from the School Years edit action after an active school year exists.');
    }
    // Keep the current setup flow aligned with the supported DepEd scope:
    // Grade 1 is descriptive. Grade 2 and Grade 3 remain numeric defaults
    // until their official templates/instructions are available.
    $gradeModes = GradingPolicyService::defaultElementaryModes();
    $sections = validateSections($conn, is_array($data['sections'] ?? null) ? $data['sections'] : []);
    $periods = periodConfig($schoolYear['grading_system_type']);
    $hasPeriodNo = tableHasColumn($conn, 'grading_periods', 'period_no');
    $hasStatusMode = tableHasColumn($conn, 'grading_periods', 'status_mode');

    try {
        $conn->beginTransaction();

        ensureNoDuplicateSchoolYear($conn, $schoolYear['year_label'], $schoolYear['year_start'], $schoolYear['year_end']);

        if ($schoolYear['is_active'] === 1) {
            $conn->exec('UPDATE school_years SET is_active = 0 WHERE is_deleted = 0');
        }

        $syStmt = $conn->prepare(
            'INSERT INTO school_years
                (year_start, year_end, year_label, date_start, date_end, grading_system_type, is_active)
             VALUES
                (:year_start, :year_end, :year_label, :date_start, :date_end, :grading_system_type, :is_active)'
        );
        $syStmt->execute([
            ':year_start' => $schoolYear['year_start'],
            ':year_end' => $schoolYear['year_end'],
            ':year_label' => $schoolYear['year_label'],
            ':date_start' => $schoolYear['date_start'],
            ':date_end' => $schoolYear['date_end'],
            ':grading_system_type' => $schoolYear['grading_system_type'],
            ':is_active' => $schoolYear['is_active'],
        ]);
        $schoolYearId = (int)$conn->lastInsertId();

        mapCurriculumToSchoolYear($conn, $schoolYearId, $schoolYear['curriculum_id']);

        $periodColumns = ['school_year_id'];
        $periodValues = [':school_year_id'];
        if ($hasPeriodNo) {
            $periodColumns[] = 'period_no';
            $periodValues[] = ':period_no';
        }
        $periodColumns[] = 'period_name';
        $periodValues[] = ':period_name';
        $periodColumns[] = 'status';
        $periodValues[] = ':status';
        if ($hasStatusMode) {
            $periodColumns[] = 'status_mode';
            $periodValues[] = ':status_mode';
        }
        $periodColumns[] = 'date_start';
        $periodValues[] = ':date_start';
        $periodColumns[] = 'date_end';
        $periodValues[] = ':date_end';
        $periodStmt = $conn->prepare(
            'INSERT INTO grading_periods (' . implode(', ', $periodColumns) . ')
             VALUES (' . implode(', ', $periodValues) . ')'
        );
        foreach ($periods as $period) {
            $isFirstOpenPeriod = $schoolYear['is_active'] === 1 && (int)$period['period_no'] === 1;
            $params = [
                ':school_year_id' => $schoolYearId,
                ':period_name' => $period['period_name'],
                // The first term starts open for a newly active school year.
                // Keep it manual so future calendar dates do not immediately
                // close it before administrators can begin testing/encoding.
                ':status' => $isFirstOpenPeriod ? 'Open' : 'Locked',
                ':date_start' => $schoolYear['period_dates'][$period['period_no']]['date_start'] ?? null,
                ':date_end' => $schoolYear['period_dates'][$period['period_no']]['date_end'] ?? null,
            ];
            if ($hasPeriodNo) {
                $params[':period_no'] = (int)$period['period_no'];
            }
            if ($hasStatusMode) {
                $params[':status_mode'] = $isFirstOpenPeriod ? 'manual' : 'automatic';
            }
            $periodStmt->execute($params);
        }

        GradingPolicyService::saveElementaryModes($conn, $schoolYearId, $gradeModes);

        $sectionStmt = $conn->prepare(
            'INSERT INTO sections
                (grade_level_id, section_name, school_year_id, adviser_id, max_capacity)
             VALUES
                (:grade_level_id, :section_name, :school_year_id, :adviser_id, :max_capacity)'
        );
        $createdSections = [];
        foreach ($sections as $section) {
            ensureAdviserStillAvailable($conn, $schoolYearId, $section['adviser_id']);
            $sectionStmt->bindValue(':grade_level_id', $section['grade_level_id'], PDO::PARAM_INT);
            $sectionStmt->bindValue(':section_name', $section['section_name']);
            $sectionStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
            $sectionStmt->bindValue(':adviser_id', $section['adviser_id'], $section['adviser_id'] === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
            $sectionStmt->bindValue(':max_capacity', $section['max_capacity'], PDO::PARAM_INT);
            $sectionStmt->execute();

            $sectionId = (int)$conn->lastInsertId();
            $createdSections[] = $sectionId;
            audit_log($conn, 'sections', $sectionId, 'INSERT', null, [
                'section_id' => $sectionId,
                'section_name' => $section['section_name'],
                'grade_level_id' => $section['grade_level_id'],
                'school_year_id' => $schoolYearId,
            ]);
        }

        audit_log($conn, 'school_years', $schoolYearId, 'INSERT', null, [
            'school_year_id' => $schoolYearId,
            'year_label' => $schoolYear['year_label'],
            'grading_system_type' => $schoolYear['grading_system_type'],
            'grade_1_grading_mode' => $gradeModes[1] ?? 'Descriptive',
            'grade_2_grading_mode' => $gradeModes[2] ?? 'Numeric',
            'grade_3_grading_mode' => $gradeModes[3] ?? 'Numeric',
            'curriculum_id' => $schoolYear['curriculum_id'],
            'sections_created' => count($createdSections),
        ]);

        $conn->commit();

        respond([
            'success' => true,
            'message' => 'Academic year setup completed.',
            'school_year_id' => $schoolYearId,
            'year_label' => $schoolYear['year_label'],
            'curriculum_id' => $schoolYear['curriculum_id'],
            'grading_periods_created' => count($periods),
            'sections_created' => count($createdSections),
            'section_ids' => $createdSections,
        ]);
    } catch (InvalidArgumentException $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        respond(['success' => false, 'message' => $e->getMessage()], 422);
    } catch (PDOException $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        if ($e->getCode() === '23000') {
            respond(['success' => false, 'message' => 'Duplicate setup data detected. Check school year and section names.'], 422);
        }
        throw $e;
    } catch (Exception $e) {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
        throw $e;
    }
}

$operation = $_GET['operation'] ?? '';
$session = auth_enforce_roles($operation, ['admin', 'registrar'], ['admin']);

try {
    switch ($operation) {
        case 'getSetupDefaults':
            getSetupDefaults($conn);
            break;
        case 'createAcademicYearSetup':
            createAcademicYearSetup($conn);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (InvalidArgumentException $e) {
    respond(['success' => false, 'message' => $e->getMessage()], 422);
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}
?>
