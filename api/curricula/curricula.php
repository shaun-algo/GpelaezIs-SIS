<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';

require_once __DIR__ . '/../utils/auth.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
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

function curriculumSubjectTimeSelect(PDO $conn, string $alias = 'cs'): string {
    $meetingMinutes = columnExists($conn, 'curriculum_subjects', 'meeting_minutes')
        ? "COALESCE({$alias}.meeting_minutes, {$alias}.weekly_minutes) AS meeting_minutes"
        : "{$alias}.weekly_minutes AS meeting_minutes";
    $meetingsPerWeek = columnExists($conn, 'curriculum_subjects', 'meetings_per_week')
        ? "{$alias}.meetings_per_week"
        : 'NULL AS meetings_per_week';
    return "{$meetingMinutes}, {$meetingsPerWeek}";
}

function curriculumSubjectTimeInsertParts(PDO $conn): array {
    $columns = ['weekly_minutes'];
    $placeholders = [':weekly_minutes'];
    if (columnExists($conn, 'curriculum_subjects', 'meeting_minutes')) {
        $columns[] = 'meeting_minutes';
        $placeholders[] = ':meeting_minutes';
    }
    if (columnExists($conn, 'curriculum_subjects', 'meetings_per_week')) {
        $columns[] = 'meetings_per_week';
        $placeholders[] = ':meetings_per_week';
    }
    return [$columns, $placeholders];
}

function curriculumSubjectTimeValues(PDO $conn, array $row): array {
    $meetingMinutes = $row['meeting_minutes'] ?? $row['weekly_minutes'] ?? null;
    $values = [
        ':weekly_minutes' => ($meetingMinutes === '' || $meetingMinutes === null) ? null : (int)$meetingMinutes,
    ];
    if (columnExists($conn, 'curriculum_subjects', 'meeting_minutes')) {
        $values[':meeting_minutes'] = $values[':weekly_minutes'];
    }
    if (columnExists($conn, 'curriculum_subjects', 'meetings_per_week')) {
        $value = $row['meetings_per_week'] ?? null;
        $values[':meetings_per_week'] = ($value === '' || $value === null) ? null : (int)$value;
    }
    return $values;
}

/**
 * The curriculum editor stores learning areas per curriculum edition so a
 * later MATATAG revision can change its grouping without changing historical
 * report cards. Keep the baseline K to 10 areas in one place for curricula
 * created after the seed data was imported.
 */
function curriculumLearningAreaDefinitions(): array {
    return [
        ['code' => 'LANG', 'name' => 'Languages (MTB-MLE / Filipino / English)', 'sort_order' => 1],
        ['code' => 'MATH', 'name' => 'Mathematics', 'sort_order' => 2],
        ['code' => 'SCI', 'name' => 'Science', 'sort_order' => 3],
        ['code' => 'SOAPSS', 'name' => 'Social Studies (Araling Panlipunan)', 'sort_order' => 4],
        ['code' => 'VALUES', 'name' => 'Values Education (EsP)', 'sort_order' => 5],
        ['code' => 'MAPEH', 'name' => 'MAPEH', 'sort_order' => 6],
        ['code' => 'GMRC', 'name' => 'Good Manners and Right Conduct (GMRC)', 'sort_order' => 7],
        ['code' => 'MAKAB', 'name' => 'Makabansa', 'sort_order' => 8],
        ['code' => 'TECHVOC', 'name' => 'Technology and Livelihood (EPP / TLE)', 'sort_order' => 9],
    ];
}

function curriculumLearningAreaCodeForSubject(?string $subjectName): ?string {
    $name = strtolower(trim((string)$subjectName));
    $name = preg_replace('/\s+/', ' ', $name) ?? '';
    if ($name === '') return null;

    if (preg_match('/\b(mapeh|music|arts|physical education|health|p\.e\.|\bpe\b)\b/', $name)) return 'MAPEH';
    if (preg_match('/\b(filipino|english|mother tongue|reading and literacy|language)\b/', $name)) return 'LANG';
    if (preg_match('/\b(mathematics|math)\b/', $name)) return 'MATH';
    if (preg_match('/\bscience\b/', $name)) return 'SCI';
    if (preg_match('/\b(araling panlipunan|social studies|\bap\b)\b/', $name)) return 'SOAPSS';
    if (preg_match('/\b(gmrc|good manners|right conduct)\b/', $name)) return 'GMRC';
    if (preg_match('/\b(makabansa)\b/', $name)) return 'MAKAB';
    if (preg_match('/\b(values education|edukasyon sa pagpapakatao|\besp\b)\b/', $name)) return 'VALUES';
    if (preg_match('/\b(epp|tle|technology|livelihood)\b/', $name)) return 'TECHVOC';
    return null;
}

function ensureCurriculumLearningAreas(PDO $conn, int $curriculumId): array {
    if ($curriculumId <= 0) return [];

    $insert = $conn->prepare(
        'INSERT INTO curriculum_learning_areas
            (curriculum_id, area_code, area_name, sort_order, is_deleted, deleted_at)
         VALUES (:curriculum_id, :area_code, :area_name, :sort_order, 0, NULL)
         ON DUPLICATE KEY UPDATE
            area_name = VALUES(area_name),
            sort_order = VALUES(sort_order),
            is_deleted = 0,
            deleted_at = NULL'
    );
    foreach (curriculumLearningAreaDefinitions() as $area) {
        $insert->execute([
            ':curriculum_id' => $curriculumId,
            ':area_code' => $area['code'],
            ':area_name' => $area['name'],
            ':sort_order' => $area['sort_order'],
        ]);
    }

    $stmt = $conn->prepare(
        'SELECT area_id, curriculum_id, area_code, area_name, sort_order
         FROM curriculum_learning_areas
         WHERE curriculum_id = :curriculum_id AND is_deleted = 0
         ORDER BY sort_order, area_id'
    );
    $stmt->execute([':curriculum_id' => $curriculumId]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function getCurriculumLearningAreas(PDO $conn): void {
    $id = (int)($_GET['curriculum_id'] ?? 0);
    if (!$id) { respond(['success' => false, 'message' => 'curriculum_id required'], 422); }
    $stmt = $conn->prepare(
        'SELECT area_id, curriculum_id, area_code, area_name, sort_order
         FROM curriculum_learning_areas
         WHERE curriculum_id = :curriculum_id AND is_deleted = 0
         ORDER BY sort_order, area_id'
    );
    $stmt->execute([':curriculum_id' => $id]);
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function getActiveSchoolYear(PDO $conn): ?array {
    $stmt = $conn->query(
        'SELECT school_year_id, year_start, year_end, year_label
         FROM school_years
         WHERE is_deleted = 0 AND is_active = 1
         ORDER BY year_start DESC, school_year_id DESC
         LIMIT 1'
    );
    $row = $stmt ? $stmt->fetch(PDO::FETCH_ASSOC) : false;
    return $row ?: null;
}

function curriculumHasHistoricalUse(PDO $conn, int $curriculumId): bool {
    if ($curriculumId <= 0) return false;

    $activeYear = getActiveSchoolYear($conn);
    $historicalCutoff = $activeYear && $activeYear['year_end'] !== null && $activeYear['year_end'] !== ''
        ? (int)$activeYear['year_end']
        : (int)date('Y');

    $historyStmt = $conn->prepare(
        "SELECT 1
         FROM school_years sy
         JOIN curriculum_school_year_map csm
           ON csm.school_year_id = sy.school_year_id
          AND csm.curriculum_id = :mapped_curriculum_id
          AND csm.is_deleted = 0
         WHERE sy.is_deleted = 0
           AND sy.year_end < :mapped_cutoff
         UNION ALL
         SELECT 1
         FROM school_years sy
         JOIN enrollments e
           ON e.school_year_id = sy.school_year_id
          AND e.curriculum_id = :enrolled_curriculum_id
          AND e.is_deleted = 0
         WHERE sy.is_deleted = 0
           AND sy.year_end < :enrolled_cutoff
         LIMIT 1"
    );
    $historyStmt->execute([
        ':mapped_curriculum_id' => $curriculumId,
        ':mapped_cutoff' => $historicalCutoff,
        ':enrolled_curriculum_id' => $curriculumId,
        ':enrolled_cutoff' => $historicalCutoff,
    ]);
    return (bool)$historyStmt->fetchColumn();
}

function findActiveYearCurriculumMapping(PDO $conn, int $curriculumId, int $schoolYearId): bool {
    if ($curriculumId <= 0 || $schoolYearId <= 0) return false;
    $stmt = $conn->prepare(
        'SELECT 1
         FROM curriculum_school_year_map
         WHERE curriculum_id = :curriculum_id
           AND school_year_id = :school_year_id
           AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->execute([
        ':curriculum_id' => $curriculumId,
        ':school_year_id' => $schoolYearId,
    ]);
    return (bool)$stmt->fetchColumn();
}

function nextActiveYearCurriculumCode(PDO $conn, string $sourceCode, int $yearStart): string {
    $base = substr(trim($sourceCode), 0, 21) . '-SY' . $yearStart;
    $candidate = $base;
    $suffix = 2;
    do {
        $stmt = $conn->prepare('SELECT 1 FROM curricula WHERE curriculum_code = :code LIMIT 1');
        $stmt->execute([':code' => $candidate]);
        if (!$stmt->fetchColumn()) return $candidate;
        $suffixText = '-' . $suffix++;
        $candidate = substr($base, 0, 30 - strlen($suffixText)) . $suffixText;
    } while (true);
}

function assertAnotherActiveCurriculumExists(PDO $conn, int $excludedCurriculumId = 0): void {
    $stmt = $conn->prepare(
        'SELECT COUNT(*)
         FROM curricula
         WHERE is_deleted = 0
           AND is_active = 1
           AND curriculum_id <> :curriculum_id'
    );
    $stmt->execute([':curriculum_id' => $excludedCurriculumId]);
    if ((int)$stmt->fetchColumn() === 0) {
        throw new InvalidArgumentException('At least one active curriculum must remain. Activate another curriculum before deactivating this one.');
    }
}

function deactivateOtherCurricula(PDO $conn, int $curriculumId): void {
    $stmt = $conn->prepare(
        'UPDATE curricula
         SET is_active = 0
         WHERE is_deleted = 0
           AND curriculum_id <> :curriculum_id'
    );
    $stmt->execute([':curriculum_id' => $curriculumId]);
}

function forkCurriculumForActiveYear(PDO $conn, int $sourceId, array $activeYear): int {
    $sourceStmt = $conn->prepare(
        'SELECT curriculum_code, curriculum_name, description, effective_from, effective_until, is_active
         FROM curricula
         WHERE curriculum_id = :id AND is_deleted = 0
         LIMIT 1'
    );
    $sourceStmt->execute([':id' => $sourceId]);
    $source = $sourceStmt->fetch(PDO::FETCH_ASSOC);
    if (!$source) {
        throw new InvalidArgumentException('Curriculum not found or archived.');
    }

    $newCode = nextActiveYearCurriculumCode($conn, (string)$source['curriculum_code'], (int)$activeYear['year_start']);
    $insertCurriculum = $conn->prepare(
        'INSERT INTO curricula
            (curriculum_code, curriculum_name, description, effective_from, effective_until, is_active, created_by)
         VALUES (:code, :name, :description, :effective_from, :effective_until, :is_active, :created_by)'
    );
    $insertCurriculum->execute([
        ':code' => $newCode,
        ':name' => $source['curriculum_name'],
        ':description' => trim((string)($source['description'] ?? '')) . ' Active-year settings for ' . $activeYear['year_label'],
        ':effective_from' => (int)$activeYear['year_start'],
        ':effective_until' => $source['effective_until'],
        ':is_active' => 1,
        ':created_by' => !empty($_SESSION['user_id']) ? (int)$_SESSION['user_id'] : null,
    ]);
    $newId = (int)$conn->lastInsertId();
    deactivateOtherCurricula($conn, $newId);

    $gradeStmt = $conn->prepare(
        'SELECT grade_level_id, sort_order
         FROM curriculum_grade_levels
         WHERE curriculum_id = :id AND is_deleted = 0
         ORDER BY sort_order, cgl_id'
    );
    $gradeStmt->execute([':id' => $sourceId]);
    $insertGrade = $conn->prepare(
        'INSERT INTO curriculum_grade_levels (curriculum_id, grade_level_id, sort_order, is_deleted, deleted_at)
         VALUES (:curriculum_id, :grade_level_id, :sort_order, 0, NULL)'
    );
    while ($row = $gradeStmt->fetch(PDO::FETCH_ASSOC)) {
        $insertGrade->execute([
            ':curriculum_id' => $newId,
            ':grade_level_id' => (int)$row['grade_level_id'],
            ':sort_order' => $row['sort_order'] !== null ? (int)$row['sort_order'] : null,
        ]);
    }

    $areaMap = [];
    $areaStmt = $conn->prepare(
        'SELECT area_id, area_code, area_name, sort_order
         FROM curriculum_learning_areas
         WHERE curriculum_id = :id AND is_deleted = 0
         ORDER BY sort_order, area_id'
    );
    $areaStmt->execute([':id' => $sourceId]);
    $insertArea = $conn->prepare(
        'INSERT INTO curriculum_learning_areas
            (curriculum_id, area_code, area_name, sort_order, is_deleted, deleted_at)
         VALUES (:curriculum_id, :area_code, :area_name, :sort_order, 0, NULL)'
    );
    while ($row = $areaStmt->fetch(PDO::FETCH_ASSOC)) {
        $insertArea->execute([
            ':curriculum_id' => $newId,
            ':area_code' => $row['area_code'],
            ':area_name' => $row['area_name'],
            ':sort_order' => $row['sort_order'] !== null ? (int)$row['sort_order'] : null,
        ]);
        $areaMap[(int)$row['area_id']] = (int)$conn->lastInsertId();
    }

    $subjectStmt = $conn->prepare(
        'SELECT cs.grade_level_id, cs.subject_id, cs.is_required, cs.weekly_minutes, cs.sort_order, cs.learning_area_id, cs.notes, ' . curriculumSubjectTimeSelect($conn) . '
         FROM curriculum_subjects cs
         WHERE cs.curriculum_id = :id AND cs.is_deleted = 0
         ORDER BY cs.grade_level_id, cs.sort_order, cs.curriculum_subject_id'
    );
    $subjectStmt->execute([':id' => $sourceId]);
    [$timeColumns, $timePlaceholders] = curriculumSubjectTimeInsertParts($conn);
    $insertSubject = $conn->prepare(
        'INSERT INTO curriculum_subjects
            (curriculum_id, grade_level_id, subject_id, is_required, ' . implode(', ', $timeColumns) . ', sort_order, learning_area_id, notes, is_deleted, deleted_at)
         VALUES (:curriculum_id, :grade_level_id, :subject_id, :is_required, ' . implode(', ', $timePlaceholders) . ', :sort_order, :learning_area_id, :notes, 0, NULL)'
    );
    while ($row = $subjectStmt->fetch(PDO::FETCH_ASSOC)) {
        $insertSubject->execute(array_merge([
            ':curriculum_id' => $newId,
            ':grade_level_id' => (int)$row['grade_level_id'],
            ':subject_id' => (int)$row['subject_id'],
            ':is_required' => (int)$row['is_required'],
            ':sort_order' => $row['sort_order'] !== null ? (int)$row['sort_order'] : null,
            ':learning_area_id' => $areaMap[(int)$row['learning_area_id']] ?? null,
            ':notes' => $row['notes'],
        ], curriculumSubjectTimeValues($conn, $row)));
    }

    $passingStmt = $conn->prepare(
        'SELECT grade_level_id, subject_id, passing_mark, notes
         FROM curriculum_passing_marks
         WHERE curriculum_id = :id AND is_deleted = 0
         ORDER BY passing_mark_id'
    );
    $passingStmt->execute([':id' => $sourceId]);
    $insertPassing = $conn->prepare(
        'INSERT INTO curriculum_passing_marks
            (curriculum_id, grade_level_id, subject_id, passing_mark, notes)
         VALUES (:curriculum_id, :grade_level_id, :subject_id, :passing_mark, :notes)'
    );
    while ($row = $passingStmt->fetch(PDO::FETCH_ASSOC)) {
        $insertPassing->execute([
            ':curriculum_id' => $newId,
            ':grade_level_id' => $row['grade_level_id'],
            ':subject_id' => $row['subject_id'],
            ':passing_mark' => $row['passing_mark'],
            ':notes' => $row['notes'],
        ]);
    }

    $conn->prepare(
        'UPDATE curriculum_school_year_map
         SET is_primary = 0
         WHERE school_year_id = :school_year_id AND is_deleted = 0'
    )->execute([':school_year_id' => (int)$activeYear['school_year_id']]);
    $conn->prepare(
        'INSERT INTO curriculum_school_year_map (curriculum_id, school_year_id, is_primary, is_deleted, deleted_at)
         VALUES (:curriculum_id, :school_year_id, 1, 0, NULL)'
    )->execute([
        ':curriculum_id' => $newId,
        ':school_year_id' => (int)$activeYear['school_year_id'],
    ]);

    // Existing learners in the active year should follow the active-year
    // settings. Previous-year enrollments retain the historical curriculum ID.
    $conn->prepare(
        'UPDATE enrollments
         SET curriculum_id = :new_curriculum_id
         WHERE school_year_id = :school_year_id
           AND curriculum_id = :source_curriculum_id
           AND is_deleted = 0'
    )->execute([
        ':new_curriculum_id' => $newId,
        ':school_year_id' => (int)$activeYear['school_year_id'],
        ':source_curriculum_id' => $sourceId,
    ]);

    ensureCurriculumLearningAreas($conn, $newId);
    return $newId;
}

function prepareCurriculumSettingsMutation(PDO $conn, int $curriculumId): int {
    if ($curriculumId <= 0 || !curriculumHasHistoricalUse($conn, $curriculumId)) {
        return $curriculumId;
    }

    $activeYear = getActiveSchoolYear($conn);
    if ($activeYear && findActiveYearCurriculumMapping($conn, $curriculumId, (int)$activeYear['school_year_id'])) {
        return forkCurriculumForActiveYear($conn, $curriculumId, $activeYear);
    }

    if ($conn->inTransaction()) $conn->rollBack();
    respond([
        'success' => false,
        'code' => 'HISTORICAL_CURRICULUM_LOCKED',
        'message' => 'This curriculum is used only by previous school-year records and cannot be changed.',
    ], 409);
    return $curriculumId;
}

function assertSchoolYearMappingMutable(PDO $conn, int $schoolYearId): void {
    if ($schoolYearId <= 0) return;

    $targetStmt = $conn->prepare(
        'SELECT year_end
         FROM school_years
         WHERE school_year_id = :school_year_id AND is_deleted = 0
         LIMIT 1'
    );
    $targetStmt->execute([':school_year_id' => $schoolYearId]);
    $targetYearEnd = $targetStmt->fetchColumn();
    if ($targetYearEnd === false || $targetYearEnd === null || $targetYearEnd === '') return;

    $activeStmt = $conn->query(
        "SELECT year_end
         FROM school_years
         WHERE is_deleted = 0 AND is_active = 1
         ORDER BY year_start DESC, school_year_id DESC
         LIMIT 1"
    );
    $activeYearEnd = $activeStmt ? $activeStmt->fetchColumn() : false;
    $cutoff = $activeYearEnd !== false && $activeYearEnd !== null && $activeYearEnd !== ''
        ? (int)$activeYearEnd
        : (int)date('Y');

    if ((int)$targetYearEnd < $cutoff) {
        respond([
            'success' => false,
            'code' => 'HISTORICAL_SCHOOL_YEAR_LOCKED',
            'message' => 'Previous school-year curriculum mappings are locked so historical report cards remain unchanged.',
        ], 409);
    }
}

function normalizeCurriculumSubjectName(?string $name): string {
    $normalized = strtolower(trim((string)$name));
    $normalized = preg_replace('/\s+/', ' ', $normalized);
    return $normalized ?? '';
}

function getMapehSubjectKind(?string $subjectName, ?string $subjectCode = null): ?string {
    $name = normalizeCurriculumSubjectName($subjectName);
    $code = strtoupper(trim((string)$subjectCode));

    if ($name === '' && $code === '') return null;

    if ($code === 'MAPEH' || (str_contains($name, 'mapeh') && !str_contains($name, 'component'))) {
        return 'parent';
    }
    if (preg_match('/\bmusic\s*(and|&)\s*arts?\b/', $name)) {
        return 'grouped_component';
    }
    if (preg_match('/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/', $name)) {
        return 'grouped_component';
    }
    if (in_array($code, ['MUSIC', 'ARTS', 'PE', 'P.E.', 'HEALTH'], true)) {
        return 'component';
    }
    if (preg_match('/\b(music|arts|physical education|health|pe|p\.e\.)\b/', $name)) {
        return 'component';
    }
    if (str_contains($name, 'mapeh')) {
        return 'component';
    }

    return null;
}

function validateMapehSubjectRows(PDO $conn, array $rows): void {
    $subjectIds = [];
    foreach ($rows as $row) {
        $sid = (int)($row['subject_id'] ?? 0);
        if ($sid) $subjectIds[$sid] = true;
    }
    if (!$subjectIds) return;

    $subjectCodeSelect = columnExists($conn, 'subjects', 'subject_code')
        ? 'subject_code'
        : 'NULL AS subject_code';

    $ids = array_keys($subjectIds);
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $conn->prepare(
        "SELECT subject_id, subject_name, {$subjectCodeSelect}
         FROM subjects
         WHERE subject_id IN ({$placeholders}) AND is_deleted = 0"
    );
    foreach ($ids as $index => $id) {
        $stmt->bindValue($index + 1, $id, PDO::PARAM_INT);
    }
    $stmt->execute();

    $subjects = [];
    while ($subject = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $subjects[(int)$subject['subject_id']] = $subject;
    }

    $byGrade = [];
    foreach ($rows as $row) {
        $gradeLevelId = (int)($row['grade_level_id'] ?? 0);
        $subjectId = (int)($row['subject_id'] ?? 0);
        if (!$gradeLevelId || !$subjectId || empty($subjects[$subjectId])) continue;

        $subject = $subjects[$subjectId];
        $kind = getMapehSubjectKind($subject['subject_name'] ?? '', $subject['subject_code'] ?? null);
        if (!$kind) continue;

        if (!isset($byGrade[$gradeLevelId])) {
            $byGrade[$gradeLevelId] = [
                'component' => [],
                'grouped_component' => [],
                'parent' => [],
            ];
        }
        $byGrade[$gradeLevelId][$kind][] = $subject['subject_name'] ?? 'MAPEH subject';
    }

    foreach ($byGrade as $gradeLevelId => $group) {
        if (!empty($group['component']) && !empty($group['grouped_component'])) {
            $gradeName = getGradeNameForValidation($conn, $gradeLevelId);
            respond([
                'success' => false,
                'message' => "{$gradeName} already has MAPEH component subjects. Remove the existing MAPEH setup before adding another MAPEH subject type.",
                'code' => 'MAPEH_SETUP_CONFLICT',
                'details' => [
                    'grade_level_id' => $gradeLevelId,
                    'component_subjects' => array_values(array_unique($group['component'])),
                    'grouped_components' => array_values(array_unique($group['grouped_component'])),
                ],
            ], 422);
        }
    }
}

function buildMapehSubjectGroups(PDO $conn, array $rows): array {
    $subjectIds = [];
    foreach ($rows as $row) {
        $sid = (int)($row['subject_id'] ?? 0);
        if ($sid) $subjectIds[$sid] = true;
    }
    if (!$subjectIds) return [];

    $subjectCodeSelect = columnExists($conn, 'subjects', 'subject_code')
        ? 'subject_code'
        : 'NULL AS subject_code';

    $ids = array_keys($subjectIds);
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $conn->prepare(
        "SELECT subject_id, subject_name, {$subjectCodeSelect}
         FROM subjects
         WHERE subject_id IN ({$placeholders}) AND is_deleted = 0"
    );
    foreach ($ids as $index => $id) {
        $stmt->bindValue($index + 1, $id, PDO::PARAM_INT);
    }
    $stmt->execute();

    $subjects = [];
    while ($subject = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $subjects[(int)$subject['subject_id']] = $subject;
    }

    $groups = [];
    foreach ($rows as $row) {
        $gradeLevelId = (int)($row['grade_level_id'] ?? 0);
        $subjectId = (int)($row['subject_id'] ?? 0);
        if (!$gradeLevelId || !$subjectId || empty($subjects[$subjectId])) continue;

        $subject = $subjects[$subjectId];
        $kind = getMapehSubjectKind($subject['subject_name'] ?? '', $subject['subject_code'] ?? null);
        if (!$kind) continue;

        if (!isset($groups[$gradeLevelId])) {
            $groups[$gradeLevelId] = [];
        }
        $groups[$gradeLevelId][$subjectId] = [
            'subject_id' => $subjectId,
            'subject_name' => $subject['subject_name'] ?? 'MAPEH subject',
            'kind' => $kind,
        ];
    }

    return $groups;
}

function validateAgainstExistingMapehSetup(PDO $conn, int $curriculumId, array $incomingRows): void {
    $incomingGroups = buildMapehSubjectGroups($conn, $incomingRows);
    if (!$incomingGroups) return;

    $subjectCodeSelect = columnExists($conn, 'subjects', 'subject_code')
        ? 's.subject_code'
        : 'NULL AS subject_code';

    $stmt = $conn->prepare(
        "SELECT cs.grade_level_id, cs.subject_id, s.subject_name, {$subjectCodeSelect}
         FROM curriculum_subjects cs
         JOIN subjects s ON s.subject_id = cs.subject_id AND s.is_deleted = 0
         WHERE cs.curriculum_id = :curriculum_id AND cs.is_deleted = 0"
    );
    $stmt->bindValue(':curriculum_id', $curriculumId, PDO::PARAM_INT);
    $stmt->execute();

    $existingGroups = [];
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $kind = getMapehSubjectKind($row['subject_name'] ?? '', $row['subject_code'] ?? null);
        if (!$kind) continue;
        $gradeLevelId = (int)$row['grade_level_id'];
        $subjectId = (int)$row['subject_id'];
        if (!isset($existingGroups[$gradeLevelId])) {
            $existingGroups[$gradeLevelId] = [];
        }
        $existingGroups[$gradeLevelId][$subjectId] = [
            'subject_id' => $subjectId,
            'subject_name' => $row['subject_name'] ?? 'MAPEH subject',
            'kind' => $kind,
        ];
    }

    foreach ($incomingGroups as $gradeLevelId => $incomingSubjects) {
        if (empty($existingGroups[$gradeLevelId])) continue;

        $newSubjectIds = array_diff(array_keys($incomingSubjects), array_keys($existingGroups[$gradeLevelId]));
        if (!$newSubjectIds) continue;

        $gradeName = getGradeNameForValidation($conn, (int)$gradeLevelId);
        respond([
            'success' => false,
            'message' => "{$gradeName} already has MAPEH component subjects. Remove the existing MAPEH setup before adding another MAPEH subject type.",
            'code' => 'MAPEH_SETUP_CONFLICT',
            'details' => [
                'grade_level_id' => (int)$gradeLevelId,
                'existing_mapeh_subjects' => array_values(array_map(
                    fn($subject) => $subject['subject_name'],
                    $existingGroups[$gradeLevelId]
                )),
                'rejected_mapeh_subjects' => array_values(array_map(
                    fn($subjectId) => $incomingSubjects[$subjectId]['subject_name'],
                    $newSubjectIds
                )),
            ],
        ], 422);
    }
}

function getGradeNameForValidation(PDO $conn, int $gradeLevelId): string {
    static $cache = [];
    if (isset($cache[$gradeLevelId])) return $cache[$gradeLevelId];
    $stmt = $conn->prepare('SELECT grade_name FROM grade_levels WHERE grade_level_id = :id LIMIT 1');
    $stmt->bindValue(':id', $gradeLevelId, PDO::PARAM_INT);
    $stmt->execute();
    $cache[$gradeLevelId] = $stmt->fetchColumn() ?: "Grade level {$gradeLevelId}";
    return $cache[$gradeLevelId];
}

$operation = $_GET['operation'] ?? '';
// Archive names reuse the established soft-delete permissions and validations.
$operation = (['archiveCurriculum' => 'deleteCurriculum', 'archiveSchoolYearMap' => 'deleteSchoolYearMap'])[$operation] ?? $operation;
$session = auth_enforce_roles($operation, ['admin', 'teacher', 'registrar'], ['admin']);
try {
    switch ($operation) {
        case 'getAllCurricula':           getAllCurricula($conn); break;
        case 'getCurriculumById':         getCurriculumById($conn); break;
        case 'getCurriculaForSchoolYear': getCurriculaForSchoolYear($conn); break;
        case 'getPrimaryCurriculumForSchoolYear': getPrimaryCurriculumForSchoolYear($conn); break;
        case 'createCurriculum':          createCurriculum($conn); break;
        case 'cloneCurriculum':           cloneCurriculum($conn); break;
        case 'updateCurriculum':          updateCurriculum($conn); break;
        case 'deleteCurriculum':          deleteCurriculum($conn); break;
        case 'getCurriculumLearningAreas': getCurriculumLearningAreas($conn); break;
        // Sub-table: curriculum_subjects
        case 'getCurriculumSubjects':     getCurriculumSubjects($conn); break;
        case 'saveCurriculumSubjects':    saveCurriculumSubjects($conn); break;
        // Sub-table: curriculum_grade_levels
        case 'getCurriculumGradeLevels':  getCurriculumGradeLevels($conn); break;
        case 'saveCurriculumGradeLevels': saveCurriculumGradeLevels($conn); break;
        // Sub-table: curriculum_passing_marks
        case 'getPassingMarks':           getPassingMarks($conn); break;
        case 'savePassingMarks':          savePassingMarks($conn); break;
        // Sub-table: curriculum_school_year_map
        case 'getSchoolYearMap':          getSchoolYearMap($conn); break;
        case 'saveSchoolYearMap':         saveSchoolYearMap($conn); break;
        case 'deleteSchoolYearMap':        deleteSchoolYearMap($conn, $session); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (InvalidArgumentException $e) {
    respond(['success' => false, 'message' => $e->getMessage()], 422);
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

// ─── Curricula CRUD ───────────────────────────────────────────────

function getAllCurricula(PDO $conn): void {
    $sql = "SELECT curriculum_id, curriculum_code, curriculum_name, description,
                   effective_from, effective_until, is_active, created_at
            FROM curricula
            WHERE is_deleted = 0
            ORDER BY is_active DESC, effective_from DESC, curriculum_id DESC";
    $stmt = $conn->prepare($sql);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function getCurriculumById(PDO $conn): void {
    $id = (int)($_GET['curriculum_id'] ?? 0);
    if (!$id) { respond(['success' => false, 'message' => 'curriculum_id required'], 422); }

    $stmt = $conn->prepare("SELECT * FROM curricula WHERE curriculum_id = :id AND is_deleted = 0 LIMIT 1");
    $stmt->bindValue(':id', $id, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) { respond(['success' => false, 'message' => 'Curriculum not found'], 404); }
    respond(['success' => true, 'data' => $row]);
}

function getPrimaryCurriculumForSchoolYear(PDO $conn): void {
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    if ($schoolYearId > 0) {
        $stmt = $conn->prepare(
            "SELECT c.curriculum_id, c.curriculum_code, c.curriculum_name, c.effective_from, c.effective_until, c.is_active,
                    m.school_year_id, m.is_primary
             FROM curriculum_school_year_map m
             JOIN curricula c ON c.curriculum_id = m.curriculum_id AND c.is_deleted = 0
             WHERE m.school_year_id = :school_year_id
               AND m.is_deleted = 0
             ORDER BY COALESCE(m.is_primary, 0) DESC, m.map_id ASC
             LIMIT 1"
        );
        $stmt->execute([':school_year_id' => $schoolYearId]);
        respond(['success' => true, 'data' => $stmt->fetch(PDO::FETCH_ASSOC) ?: null]);
    }

    $stmt = $conn->prepare(
        "SELECT c.curriculum_id, c.curriculum_code, c.curriculum_name, c.effective_from, c.effective_until, c.is_active
         FROM curricula c
         WHERE c.is_deleted = 0
         ORDER BY c.is_active DESC, c.effective_from DESC, c.curriculum_id DESC
         LIMIT 1"
    );
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    respond(['success' => true, 'data' => $row ?: null]);
}

function getCurriculaForSchoolYear(PDO $conn): void {
    $gradeLevelId = (int)($_GET['grade_level_id'] ?? 0);
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);

    $sql =
        "SELECT c.curriculum_id, c.curriculum_code, c.curriculum_name, c.effective_from, c.effective_until, c.is_active,
                " . ($schoolYearId > 0
                    ? "COALESCE(m.is_primary, 0) AS is_primary, CASE WHEN m.map_id IS NULL THEN 0 ELSE 1 END AS is_mapped"
                    : "c.is_active AS is_primary, 0 AS is_mapped") . "
         FROM curricula c
         " . ($schoolYearId > 0
            ? "LEFT JOIN curriculum_school_year_map m ON m.curriculum_id = c.curriculum_id
                AND m.school_year_id = :school_year_id
                AND m.is_deleted = 0\n"
            : "") .
         ($gradeLevelId > 0
            ? "JOIN curriculum_grade_levels cgl ON cgl.curriculum_id = c.curriculum_id AND cgl.is_deleted = 0 AND cgl.grade_level_id = :gid\n"
            : "") .
        "WHERE c.is_deleted = 0
         ORDER BY c.is_active DESC, c.effective_from DESC, c.curriculum_id DESC";

    $stmt = $conn->prepare($sql);
    if ($schoolYearId > 0) {
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    }
    if ($gradeLevelId > 0) {
        $stmt->bindValue(':gid', $gradeLevelId, PDO::PARAM_INT);
    }
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function createCurriculum(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['curriculum_code']) || empty($data['curriculum_name']) || empty($data['effective_from'])) {
        respond(['success' => false, 'message' => 'Curriculum code, name, and effective year are required'], 422);
    }

    $isActive = isset($data['is_active']) ? (int)!!$data['is_active'] : 1;
    $conn->beginTransaction();
    try {
        if ($isActive === 1) {
            deactivateOtherCurricula($conn, 0);
        } else {
            assertAnotherActiveCurriculumExists($conn, 0);
        }

        $stmt = $conn->prepare(
            'INSERT INTO curricula (curriculum_code, curriculum_name, description, effective_from, effective_until, is_active, created_by)
             VALUES (:code, :name, :description, :from, :until, :active, :created_by)'
        );
        $stmt->execute([
            ':code' => trim($data['curriculum_code']),
            ':name' => trim($data['curriculum_name']),
            ':description' => $data['description'] ?? null,
            ':from' => $data['effective_from'],
            ':until' => $data['effective_until'] ?? null,
            ':active' => $isActive,
            ':created_by' => $data['created_by'] ?? null,
        ]);
        $newId = (int)$conn->lastInsertId();
        ensureCurriculumLearningAreas($conn, $newId);
        $conn->commit();
        respond(['success' => true, 'message' => 'Curriculum created', 'curriculum_id' => $newId]);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
}

function cloneCurriculum(PDO $conn): void {
    $data = getJsonInput();
    $sourceId = (int)($data['source_curriculum_id'] ?? 0);
    $code = trim((string)($data['curriculum_code'] ?? ''));
    $name = trim((string)($data['curriculum_name'] ?? ''));
    $effectiveFrom = trim((string)($data['effective_from'] ?? ''));

    if ($sourceId <= 0 || $code === '' || $name === '' || $effectiveFrom === '') {
        respond([
            'success' => false,
            'message' => 'Source curriculum, code, name, and effective year are required',
        ], 422);
    }

    if (!preg_match('/^\d{4}$/', $effectiveFrom)) {
        respond(['success' => false, 'message' => 'Effective year must be a four-digit year'], 422);
    }

    $sourceStmt = $conn->prepare(
        'SELECT curriculum_id, curriculum_name
         FROM curricula
         WHERE curriculum_id = :id AND is_deleted = 0
         LIMIT 1'
    );
    $sourceStmt->execute([':id' => $sourceId]);
    $source = $sourceStmt->fetch(PDO::FETCH_ASSOC);
    if (!$source) {
        respond(['success' => false, 'message' => 'Source curriculum was not found or is archived'], 404);
    }

    $duplicateStmt = $conn->prepare('SELECT 1 FROM curricula WHERE curriculum_code = :code LIMIT 1');
    $duplicateStmt->execute([':code' => $code]);
    if ($duplicateStmt->fetchColumn()) {
        respond(['success' => false, 'message' => 'A curriculum with this code already exists'], 422);
    }

    $subjectCodeSelect = columnExists($conn, 'subjects', 'subject_code')
        ? 's.subject_code'
        : 'NULL AS subject_code';

    $conn->beginTransaction();
    try {
        $insertCurriculum = $conn->prepare(
            'INSERT INTO curricula
                (curriculum_code, curriculum_name, description, effective_from, effective_until, is_active, created_by)
             VALUES (:code, :name, :description, :effective_from, :effective_until, :is_active, :created_by)'
        );
        $isActive = isset($data['is_active']) ? (int)!!$data['is_active'] : 1;
        if ($isActive === 1) {
            deactivateOtherCurricula($conn, 0);
        } else {
            assertAnotherActiveCurriculumExists($conn, 0);
        }

        $insertCurriculum->execute([
            ':code' => $code,
            ':name' => $name,
            ':description' => array_key_exists('description', $data)
                ? ($data['description'] === null ? null : trim((string)$data['description']))
                : 'Copied from ' . ($source['curriculum_name'] ?? 'the previous curriculum'),
            ':effective_from' => $effectiveFrom,
            ':effective_until' => $data['effective_until'] ?? null,
            ':is_active' => $isActive,
            ':created_by' => !empty($_SESSION['user_id']) ? (int)$_SESSION['user_id'] : null,
        ]);
        $newId = (int)$conn->lastInsertId();
        if ($isActive === 1) {
            deactivateOtherCurricula($conn, $newId);
        }
        ensureCurriculumLearningAreas($conn, $newId);

        $gradeStmt = $conn->prepare(
            'SELECT grade_level_id, sort_order
             FROM curriculum_grade_levels
             WHERE curriculum_id = :id AND is_deleted = 0
             ORDER BY sort_order, cgl_id'
        );
        $gradeStmt->execute([':id' => $sourceId]);
        $insertGrade = $conn->prepare(
            'INSERT INTO curriculum_grade_levels
                (curriculum_id, grade_level_id, sort_order, is_deleted, deleted_at)
             VALUES (:curriculum_id, :grade_level_id, :sort_order, 0, NULL)'
        );
        while ($grade = $gradeStmt->fetch(PDO::FETCH_ASSOC)) {
            $insertGrade->execute([
                ':curriculum_id' => $newId,
                ':grade_level_id' => (int)$grade['grade_level_id'],
                ':sort_order' => $grade['sort_order'] !== null ? (int)$grade['sort_order'] : null,
            ]);
        }

        $areaMap = [];
        $areaStmt = $conn->prepare(
            'SELECT area_id, area_code, area_name, sort_order
             FROM curriculum_learning_areas
             WHERE curriculum_id = :id AND is_deleted = 0
             ORDER BY sort_order, area_id'
        );
        $areaStmt->execute([':id' => $sourceId]);
        $insertArea = $conn->prepare(
            'INSERT INTO curriculum_learning_areas
                (curriculum_id, area_code, area_name, sort_order, is_deleted, deleted_at)
             VALUES (:curriculum_id, :area_code, :area_name, :sort_order, 0, NULL)'
        );
        while ($area = $areaStmt->fetch(PDO::FETCH_ASSOC)) {
            $insertArea->execute([
                ':curriculum_id' => $newId,
                ':area_code' => $area['area_code'],
                ':area_name' => $area['area_name'],
                ':sort_order' => $area['sort_order'] !== null ? (int)$area['sort_order'] : null,
            ]);
            $areaMap[(int)$area['area_id']] = (int)$conn->lastInsertId();
        }

        $subjectStmt = $conn->prepare(
            "SELECT cs.grade_level_id, cs.subject_id, s.subject_name, {$subjectCodeSelect},
                    cs.is_required, cs.weekly_minutes, cs.sort_order, cs.learning_area_id, cs.notes,
                    " . curriculumSubjectTimeSelect($conn) . "
             FROM curriculum_subjects cs
             JOIN subjects s ON s.subject_id = cs.subject_id AND s.is_deleted = 0
             WHERE cs.curriculum_id = :id AND cs.is_deleted = 0
             ORDER BY cs.grade_level_id, cs.sort_order, cs.curriculum_subject_id"
        );
        $subjectStmt->execute([':id' => $sourceId]);
        $sourceRows = $subjectStmt->fetchAll(PDO::FETCH_ASSOC);

        $mapehSubjectIds = [];
        $mapehSubjectNames = [
            'parent' => 'Music, Arts, Physical Education and Health (MAPEH)',
            'grouped_component_1' => 'Music and Arts',
            'grouped_component_2' => 'Physical Education and Health',
        ];
        foreach ($mapehSubjectNames as $key => $subjectName) {
            $subjectLookup = $conn->prepare(
                'SELECT subject_id
                 FROM subjects
                 WHERE subject_name = :subject_name AND is_deleted = 0
                 ORDER BY subject_id
                 LIMIT 1'
            );
            $subjectLookup->execute([':subject_name' => $subjectName]);
            $subjectId = $subjectLookup->fetchColumn();
            if ($subjectId === false) {
                $subjectInsert = $conn->prepare(
                    'INSERT INTO subjects (subject_name, description, is_deleted, deleted_at)
                     VALUES (:subject_name, :description, 0, NULL)'
                );
                $subjectInsert->execute([
                    ':subject_name' => $subjectName,
                    ':description' => $key === 'parent'
                        ? 'MAPEH parent subject'
                        : 'MAPEH grouped component subject',
                ]);
                $subjectId = $conn->lastInsertId();
            }
            $mapehSubjectIds[$key] = (int)$subjectId;
        }

        $passingStmt = $conn->prepare(
            'SELECT grade_level_id, subject_id, passing_mark, notes
             FROM curriculum_passing_marks
             WHERE curriculum_id = :id AND is_deleted = 0
             ORDER BY passing_mark_id'
        );
        $passingStmt->execute([':id' => $sourceId]);
        $sourcePassingRows = $passingStmt->fetchAll(PDO::FETCH_ASSOC);

        $rowsByGrade = [];
        foreach ($sourceRows as $row) {
            $gradeLevelId = (int)$row['grade_level_id'];
            $rowsByGrade[$gradeLevelId][] = $row;
        }
        $passingByKey = [];
        foreach ($sourcePassingRows as $row) {
            $passingByKey[(int)($row['grade_level_id'] ?? 0) . '-' . (int)($row['subject_id'] ?? 0)] = $row;
        }

        $clonedRows = [];
        foreach ($rowsByGrade as $gradeLevelId => $gradeRows) {
            $mapehRows = array_values(array_filter($gradeRows, function (array $row): bool {
                return getMapehSubjectKind($row['subject_name'] ?? '', $row['subject_code'] ?? null) !== null;
            }));

            if ($mapehRows) {
                // New-year copies use one canonical grouped MAPEH setup. This
                // removes legacy four-component rows from the new curriculum
                // without altering the historical source curriculum.
                $base = $mapehRows[0];
                foreach ($mapehRows as $candidate) {
                    if (getMapehSubjectKind($candidate['subject_name'] ?? '', $candidate['subject_code'] ?? null) === 'parent') {
                        $base = $candidate;
                        break;
                    }
                }
                $sortBase = $base['sort_order'] !== null ? (int)$base['sort_order'] : null;
                $mapehSortOffset = 0;
                foreach ([
                    'parent' => $base,
                    'grouped_component_1' => $base,
                    'grouped_component_2' => $base,
                ] as $key => $template) {
                    $clonedRows[] = [
                        'grade_level_id' => $gradeLevelId,
                        'subject_id' => $mapehSubjectIds[$key],
                        'is_required' => (int)$template['is_required'],
                        'weekly_minutes' => $template['weekly_minutes'],
                        'meeting_minutes' => $template['meeting_minutes'],
                        'meetings_per_week' => $template['meetings_per_week'],
                        'sort_order' => $sortBase === null ? null : $sortBase + $mapehSortOffset,
                        'learning_area_id' => $template['learning_area_id'],
                        'notes' => $template['notes'],
                    ];
                    $mapehSortOffset++;
                }
                continue;
            }

            foreach ($gradeRows as $row) {
                $clonedRows[] = [
                    'grade_level_id' => $gradeLevelId,
                    'subject_id' => (int)$row['subject_id'],
                    'is_required' => (int)$row['is_required'],
                    'weekly_minutes' => $row['weekly_minutes'],
                    'meeting_minutes' => $row['meeting_minutes'],
                    'meetings_per_week' => $row['meetings_per_week'],
                    'sort_order' => $row['sort_order'] !== null ? (int)$row['sort_order'] : null,
                    'learning_area_id' => $row['learning_area_id'],
                    'notes' => $row['notes'],
                ];
            }
        }

        [$timeColumns, $timePlaceholders] = curriculumSubjectTimeInsertParts($conn);
        $insertSubject = $conn->prepare(
            'INSERT INTO curriculum_subjects
                (curriculum_id, grade_level_id, subject_id, is_required, ' . implode(', ', $timeColumns) . ', sort_order, learning_area_id, notes, is_deleted, deleted_at)
             VALUES (:curriculum_id, :grade_level_id, :subject_id, :is_required, ' . implode(', ', $timePlaceholders) . ', :sort_order, :learning_area_id, :notes, 0, NULL)'
        );
        foreach ($clonedRows as $row) {
            $insertSubject->execute(array_merge([
                ':curriculum_id' => $newId,
                ':grade_level_id' => $row['grade_level_id'],
                ':subject_id' => $row['subject_id'],
                ':is_required' => $row['is_required'],
                ':sort_order' => $row['sort_order'],
                ':learning_area_id' => $areaMap[(int)$row['learning_area_id']] ?? null,
                ':notes' => $row['notes'],
            ], curriculumSubjectTimeValues($conn, $row)));
        }

        $insertPassing = $conn->prepare(
            'INSERT INTO curriculum_passing_marks
                (curriculum_id, grade_level_id, subject_id, passing_mark, notes)
             VALUES (:curriculum_id, :grade_level_id, :subject_id, :passing_mark, :notes)'
        );
        $clonedSubjectKeys = [];
        foreach ($clonedRows as $row) {
            $clonedSubjectKeys[(int)$row['grade_level_id'] . '-' . (int)$row['subject_id']] = true;
        }

        foreach ($sourcePassingRows as $row) {
            $gradeLevelId = (int)($row['grade_level_id'] ?? 0);
            $subjectId = (int)($row['subject_id'] ?? 0);
            $subjectName = '';
            foreach ($sourceRows as $sourceRow) {
                if ((int)$sourceRow['subject_id'] === $subjectId) {
                    $subjectName = $sourceRow['subject_name'] ?? '';
                    break;
                }
            }
            if (getMapehSubjectKind($subjectName) !== null) continue;
            if ($subjectId > 0 && empty($clonedSubjectKeys[$gradeLevelId . '-' . $subjectId])) continue;
            $insertPassing->execute([
                ':curriculum_id' => $newId,
                ':grade_level_id' => $row['grade_level_id'],
                ':subject_id' => $row['subject_id'],
                ':passing_mark' => $row['passing_mark'],
                ':notes' => $row['notes'],
            ]);
        }

        foreach ($rowsByGrade as $gradeLevelId => $gradeRows) {
            $mapehRows = array_values(array_filter($gradeRows, function (array $row): bool {
                return getMapehSubjectKind($row['subject_name'] ?? '', $row['subject_code'] ?? null) !== null;
            }));
            if (!$mapehRows) continue;

            $mapehPassing = null;
            foreach ($mapehRows as $row) {
                $candidate = $passingByKey[$gradeLevelId . '-' . (int)$row['subject_id']] ?? null;
                if ($candidate) {
                    $mapehPassing = $candidate;
                    break;
                }
            }
            $passingMark = $mapehPassing['passing_mark'] ?? 75;
            $notes = $mapehPassing['notes'] ?? null;
            foreach ([$mapehSubjectIds['parent'], $mapehSubjectIds['grouped_component_1'], $mapehSubjectIds['grouped_component_2']] as $subjectId) {
                $insertPassing->execute([
                    ':curriculum_id' => $newId,
                    ':grade_level_id' => $gradeLevelId,
                    ':subject_id' => $subjectId,
                    ':passing_mark' => $passingMark,
                    ':notes' => $notes,
                ]);
            }
        }

        $activeYearStmt = $conn->query(
            'SELECT school_year_id, year_label
             FROM school_years
             WHERE is_active = 1 AND is_deleted = 0
             ORDER BY year_start DESC, school_year_id DESC
             LIMIT 1'
        );
        $activeYear = $activeYearStmt ? $activeYearStmt->fetch(PDO::FETCH_ASSOC) : false;
        if ($activeYear) {
            $conn->prepare(
                'UPDATE curriculum_school_year_map
                 SET is_primary = 0
                 WHERE school_year_id = :school_year_id AND is_deleted = 0'
            )->execute([':school_year_id' => (int)$activeYear['school_year_id']]);
            $conn->prepare(
                'INSERT INTO curriculum_school_year_map (curriculum_id, school_year_id, is_primary, is_deleted, deleted_at)
                 VALUES (:curriculum_id, :school_year_id, 1, 0, NULL)'
            )->execute([
                ':curriculum_id' => $newId,
                ':school_year_id' => (int)$activeYear['school_year_id'],
            ]);
        }

        $conn->commit();
        respond([
            'success' => true,
            'message' => $activeYear
                ? 'New curriculum copied, assigned to the active school year, and given a clean grouped MAPEH setup'
                : 'New curriculum copied with a clean grouped MAPEH setup',
            'curriculum_id' => $newId,
            'source_curriculum_id' => $sourceId,
            'school_year_id' => $activeYear ? (int)$activeYear['school_year_id'] : null,
            'school_year_label' => $activeYear['year_label'] ?? null,
            'requires_school_year_mapping' => !$activeYear,
        ]);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
}

function updateCurriculum(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['curriculum_id']) || empty($data['curriculum_code']) || empty($data['curriculum_name']) || empty($data['effective_from'])) {
        respond(['success' => false, 'message' => 'Curriculum ID, code, name, and effective year are required'], 422);
    }
    $conn->beginTransaction();
    try {
        $curriculumId = prepareCurriculumSettingsMutation($conn, (int)$data['curriculum_id']);
        $isActive = isset($data['is_active']) ? (int)!!$data['is_active'] : 1;
        if ($isActive === 1) {
            deactivateOtherCurricula($conn, $curriculumId);
        } else {
            assertAnotherActiveCurriculumExists($conn, $curriculumId);
        }
        $curriculumCode = trim($data['curriculum_code']);
        if ($curriculumId !== (int)$data['curriculum_id']) {
            $sourceCodeStmt = $conn->prepare('SELECT curriculum_code FROM curricula WHERE curriculum_id = :id LIMIT 1');
            $sourceCodeStmt->execute([':id' => $curriculumId]);
            $detachedCode = (string)$sourceCodeStmt->fetchColumn();
            $sourceCodeStmt = $conn->prepare('SELECT curriculum_code FROM curricula WHERE curriculum_id = :id LIMIT 1');
            $sourceCodeStmt->execute([':id' => (int)$data['curriculum_id']]);
            $sourceCode = (string)$sourceCodeStmt->fetchColumn();
            if ($curriculumCode === $sourceCode) {
                $curriculumCode = $detachedCode;
            }
        }

        $stmt = $conn->prepare(
            'UPDATE curricula
             SET curriculum_code = :code, curriculum_name = :name, description = :description,
                 effective_from = :from, effective_until = :until, is_active = :active
             WHERE curriculum_id = :id AND is_deleted = 0'
        );
        $stmt->execute([
            ':code' => $curriculumCode,
            ':name' => trim($data['curriculum_name']),
            ':description' => $data['description'] ?? null,
            ':from' => $data['effective_from'],
            ':until' => $data['effective_until'] ?? null,
            ':active' => $isActive,
            ':id' => $curriculumId,
        ]);
        $conn->commit();
        respond([
            'success' => true,
            'message' => 'Curriculum updated',
            'curriculum_id' => $curriculumId,
            'detached_from_historical' => $curriculumId !== (int)$data['curriculum_id'],
        ]);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
}

function deleteCurriculum(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['curriculum_id'])) {
        respond(['success' => false, 'message' => 'Curriculum ID is required'], 422);
    }
    $stmt = $conn->prepare('UPDATE curricula SET is_deleted = 1, deleted_at = NOW() WHERE curriculum_id = :id');
    $stmt->bindValue(':id', $data['curriculum_id'], PDO::PARAM_INT);
    $stmt->execute();
    respond(['success' => true, 'message' => 'Curriculum archived']);
}

// ─── Curriculum Subjects ──────────────────────────────────────────

function getCurriculumSubjects(PDO $conn): void {
    $id = (int)($_GET['curriculum_id'] ?? 0);
    if (!$id) { respond(['success' => false, 'message' => 'curriculum_id required'], 422); }

    $subjectCodeSelect = columnExists($conn, 'subjects', 'subject_code')
        ? 's.subject_code'
        : 'NULL AS subject_code';

    $stmt = $conn->prepare(
        "SELECT cs.curriculum_subject_id, cs.curriculum_id, cs.grade_level_id, gl.grade_name,
                cs.subject_id, s.subject_name, {$subjectCodeSelect},
                cs.learning_area_id, cla.area_code, cla.area_name,
                cs.is_required, cs.weekly_minutes, cs.sort_order, cs.notes,
                " . curriculumSubjectTimeSelect($conn) . "
         FROM curriculum_subjects cs
         LEFT JOIN grade_levels gl ON cs.grade_level_id = gl.grade_level_id
         LEFT JOIN subjects s ON cs.subject_id = s.subject_id
         LEFT JOIN curriculum_learning_areas cla ON cla.area_id = cs.learning_area_id AND cla.is_deleted = 0
         WHERE cs.curriculum_id = :id AND cs.is_deleted = 0
         ORDER BY cs.grade_level_id, cs.sort_order, cs.curriculum_subject_id"
    );
    $stmt->bindValue(':id', $id, PDO::PARAM_INT);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function saveCurriculumSubjects(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['curriculum_id']) || !isset($data['subjects'])) {
        respond(['success' => false, 'message' => 'curriculum_id and subjects array are required'], 422);
    }
    $requestedCurriculumId = (int)$data['curriculum_id'];
    $subjectRows = is_array($data['subjects']) ? $data['subjects'] : [];
    $hasPassingMarks = array_key_exists('passing_marks', $data);
    if ($hasPassingMarks && !is_array($data['passing_marks'])) {
        respond(['success' => false, 'message' => 'passing_marks must be an array'], 422);
    }
    $passingRows = $hasPassingMarks ? $data['passing_marks'] : [];
    $conn->beginTransaction();
    try {
        $curriculumId = prepareCurriculumSettingsMutation($conn, $requestedCurriculumId);
        $areas = ensureCurriculumLearningAreas($conn, $curriculumId);
        $areasById = [];
        $areasByCode = [];
        foreach ($areas as $area) {
            $areasById[(int)$area['area_id']] = $area;
            $areasByCode[strtoupper((string)$area['area_code'])] = $area;
        }
        validateMapehSubjectRows($conn, $subjectRows);
        validateAgainstExistingMapehSetup($conn, $curriculumId, $subjectRows);

        $conn->prepare('UPDATE curriculum_subjects SET is_deleted = 1, deleted_at = NOW() WHERE curriculum_id = :id AND is_deleted = 0')
             ->execute([':id' => $curriculumId]);

        [$timeColumns, $timePlaceholders] = curriculumSubjectTimeInsertParts($conn);
        $timeUpdates = array_map(static fn(string $column): string => "{$column} = VALUES({$column})", $timeColumns);
        $stmt = $conn->prepare(
            'INSERT INTO curriculum_subjects (curriculum_id, grade_level_id, subject_id, is_required, ' . implode(', ', $timeColumns) . ', sort_order, learning_area_id, notes, is_deleted, deleted_at)
             VALUES (:cid, :gl, :sid, :required, ' . implode(', ', $timePlaceholders) . ', :sort, :learning_area_id, :notes, 0, NULL)
             ON DUPLICATE KEY UPDATE
               is_deleted = 0,
               deleted_at = NULL,
               is_required = VALUES(is_required),
               ' . implode(",\n               ", $timeUpdates) . ',
               sort_order = VALUES(sort_order),
               learning_area_id = VALUES(learning_area_id),
               notes = VALUES(notes)'
        );

        $seen = [];
        $nextSortOrderByGrade = [];
        foreach ($data['subjects'] as $row) {
            $gl = (int)($row['grade_level_id'] ?? 0);
            $sid = (int)($row['subject_id'] ?? 0);
            if (!$gl || !$sid) continue;

            $key = "{$gl}-{$sid}";
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            // The request array is the editor's canonical sequence. Reindex
            // each grade server-side so the report card always receives a
            // contiguous, deterministic order even if a client sends gaps.
            $sortOrder = ($nextSortOrderByGrade[$gl] ?? 0) + 1;
            $nextSortOrderByGrade[$gl] = $sortOrder;

            $learningAreaId = (int)($row['learning_area_id'] ?? 0);
            if ($learningAreaId > 0 && empty($areasById[$learningAreaId])) {
                // Historical-curriculum edits can be forked above. In that
                // case the source area_id is intentionally different, so use
                // the stable area code sent by the editor below.
                $learningAreaId = 0;
            }
            if (!$learningAreaId && !empty($row['learning_area_code'])) {
                $area = $areasByCode[strtoupper(trim((string)$row['learning_area_code']))] ?? null;
                $learningAreaId = (int)($area['area_id'] ?? 0);
            }
            if (!$learningAreaId) {
                $subjectStmt = $conn->prepare('SELECT subject_name FROM subjects WHERE subject_id = :subject_id AND is_deleted = 0 LIMIT 1');
                $subjectStmt->execute([':subject_id' => $sid]);
                $subjectAreaCode = curriculumLearningAreaCodeForSubject($subjectStmt->fetchColumn() ?: null);
                $learningAreaId = (int)($areasByCode[$subjectAreaCode]['area_id'] ?? 0);
            }
            if (!$learningAreaId && !empty($row['learning_area_id'])) {
                throw new InvalidArgumentException('The selected learning area does not belong to this curriculum.');
            }

            $stmt->execute(array_merge([
                ':cid'      => $curriculumId,
                ':gl'       => $gl,
                ':sid'      => $sid,
                ':required' => isset($row['is_required']) ? (int)$row['is_required'] : 1,
                ':sort'     => $sortOrder,
                ':learning_area_id' => $learningAreaId ?: null,
                ':notes'    => $row['notes'] ?? null,
            ], curriculumSubjectTimeValues($conn, $row)));
        }

        if ($hasPassingMarks) {
            $conn->prepare('UPDATE curriculum_passing_marks SET is_deleted = 1, deleted_at = NOW() WHERE curriculum_id = :id AND is_deleted = 0')
                 ->execute([':id' => $curriculumId]);

            $markStmt = $conn->prepare(
                'INSERT INTO curriculum_passing_marks (curriculum_id, grade_level_id, subject_id, passing_mark, notes)
                 VALUES (:cid, :gl, :sid, :mark, :notes)
                 ON DUPLICATE KEY UPDATE
                   passing_mark = VALUES(passing_mark),
                   notes = VALUES(notes),
                   is_deleted = 0,
                   deleted_at = NULL'
            );
            $seenMarks = [];
            foreach ($passingRows as $row) {
                $gl = (int)($row['grade_level_id'] ?? 0);
                $sid = (int)($row['subject_id'] ?? 0);
                $mark = $row['passing_mark'] ?? null;
                if (!$gl || !$sid || $mark === null || $mark === '' || !is_numeric($mark) || (float)$mark < 0 || (float)$mark > 100) {
                    throw new InvalidArgumentException('Each subject must have a passing mark from 0 to 100');
                }

                $key = "{$gl}-{$sid}";
                if (isset($seenMarks[$key])) continue;
                $seenMarks[$key] = true;
                $markStmt->execute([
                    ':cid'   => $curriculumId,
                    ':gl'    => $gl,
                    ':sid'   => $sid,
                    ':mark'  => (float)$mark,
                    ':notes' => $row['notes'] ?? null,
                ]);
            }
        }
        $conn->commit();
        respond([
            'success' => true,
            'message' => $hasPassingMarks ? 'Curriculum subjects and passing marks saved' : 'Curriculum subjects saved',
            'curriculum_id' => $curriculumId,
            'detached_from_historical' => $curriculumId !== $requestedCurriculumId,
        ]);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
}

// ─── Curriculum Grade Levels ──────────────────────────────────────

function getCurriculumGradeLevels(PDO $conn): void {
    $id = (int)($_GET['curriculum_id'] ?? 0);
    if (!$id) { respond(['success' => false, 'message' => 'curriculum_id required'], 422); }

    $stmt = $conn->prepare(
        "SELECT cgl.cgl_id, cgl.curriculum_id, cgl.grade_level_id, gl.grade_name, cgl.sort_order
         FROM curriculum_grade_levels cgl
         LEFT JOIN grade_levels gl ON cgl.grade_level_id = gl.grade_level_id
         WHERE cgl.curriculum_id = :id AND cgl.is_deleted = 0
         ORDER BY cgl.sort_order, cgl.cgl_id"
    );
    $stmt->bindValue(':id', $id, PDO::PARAM_INT);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function saveCurriculumGradeLevels(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['curriculum_id']) || !isset($data['grade_level_ids'])) {
        respond(['success' => false, 'message' => 'curriculum_id and grade_level_ids are required'], 422);
    }
    $requestedCurriculumId = (int)$data['curriculum_id'];

    $conn->beginTransaction();
    try {
        $curriculumId = prepareCurriculumSettingsMutation($conn, $requestedCurriculumId);
        $conn->prepare('UPDATE curriculum_grade_levels SET is_deleted = 1, deleted_at = NOW() WHERE curriculum_id = :id AND is_deleted = 0')
             ->execute([':id' => $curriculumId]);

        $stmt = $conn->prepare('INSERT INTO curriculum_grade_levels (curriculum_id, grade_level_id, sort_order) VALUES (:cid, :gl, :sort)');
        foreach ($data['grade_level_ids'] as $i => $glId) {
            $stmt->execute([':cid' => $curriculumId, ':gl' => (int)$glId, ':sort' => $i + 1]);
        }
        $conn->commit();
        respond([
            'success' => true,
            'message' => 'Grade levels saved',
            'curriculum_id' => $curriculumId,
            'detached_from_historical' => $curriculumId !== $requestedCurriculumId,
        ]);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
}

// ─── Curriculum Grading Components ───────────────────────────────

// ─── Curriculum Passing Marks ─────────────────────────────────────

function getPassingMarks(PDO $conn): void {
    $id = (int)($_GET['curriculum_id'] ?? 0);
    if (!$id) { respond(['success' => false, 'message' => 'curriculum_id required'], 422); }

    $stmt = $conn->prepare(
        "SELECT cpm.passing_mark_id, cpm.curriculum_id, cpm.grade_level_id, gl.grade_name,
                cpm.subject_id, s.subject_name, cpm.passing_mark, cpm.notes
         FROM curriculum_passing_marks cpm
         LEFT JOIN grade_levels gl ON cpm.grade_level_id = gl.grade_level_id
         LEFT JOIN subjects s ON cpm.subject_id = s.subject_id
         WHERE cpm.curriculum_id = :id AND cpm.is_deleted = 0
         ORDER BY cpm.grade_level_id, cpm.subject_id"
    );
    $stmt->bindValue(':id', $id, PDO::PARAM_INT);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function savePassingMarks(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['curriculum_id']) || !isset($data['marks'])) {
        respond(['success' => false, 'message' => 'curriculum_id and marks are required'], 422);
    }
    $requestedCurriculumId = (int)$data['curriculum_id'];

    $conn->beginTransaction();
    try {
        $curriculumId = prepareCurriculumSettingsMutation($conn, $requestedCurriculumId);
        $conn->prepare('UPDATE curriculum_passing_marks SET is_deleted = 1, deleted_at = NOW() WHERE curriculum_id = :id AND is_deleted = 0')
             ->execute([':id' => $curriculumId]);

        $stmt = $conn->prepare(
            'INSERT INTO curriculum_passing_marks (curriculum_id, grade_level_id, subject_id, passing_mark, notes)
             VALUES (:cid, :gl, :sid, :mark, :notes)
             ON DUPLICATE KEY UPDATE
               passing_mark = VALUES(passing_mark),
               notes = VALUES(notes),
               is_deleted = 0,
               deleted_at = NULL'
        );
        $seen = [];
        foreach ($data['marks'] as $row) {
            $gradeLevelId = (int)($row['grade_level_id'] ?? 0);
            $subjectId = (int)($row['subject_id'] ?? 0);
            $key = "{$gradeLevelId}-{$subjectId}";
            if (!$gradeLevelId || !$subjectId || isset($seen[$key])) continue;
            $seen[$key] = true;
            $stmt->execute([
                ':cid'   => $curriculumId,
                ':gl'    => $gradeLevelId,
                ':sid'   => $subjectId,
                ':mark'  => $row['passing_mark'] ?? 60.00,
                ':notes' => $row['notes'] ?? null,
            ]);
        }
        $conn->commit();
        respond([
            'success' => true,
            'message' => 'Passing marks saved',
            'curriculum_id' => $curriculumId,
            'detached_from_historical' => $curriculumId !== $requestedCurriculumId,
        ]);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
}

// ─── Curriculum School Year Map ───────────────────────────────────

function getSchoolYearMap(PDO $conn): void {
    $id = (int)($_GET['curriculum_id'] ?? 0);
    if (!$id) { respond(['success' => false, 'message' => 'curriculum_id required'], 422); }

    $stmt = $conn->prepare(
        "SELECT csym.map_id, csym.curriculum_id, csym.school_year_id, sy.year_label, csym.is_primary
         FROM curriculum_school_year_map csym
         LEFT JOIN school_years sy ON csym.school_year_id = sy.school_year_id
         WHERE csym.curriculum_id = :id AND csym.is_deleted = 0
         ORDER BY sy.year_start DESC"
    );
    $stmt->bindValue(':id', $id, PDO::PARAM_INT);
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function saveSchoolYearMap(PDO $conn): void {
    $data = getJsonInput();
    if (empty($data['curriculum_id']) || empty($data['school_year_id'])) {
        respond(['success' => false, 'message' => 'curriculum_id and school_year_id are required'], 422);
    }
    $requestedCurriculumId = (int)$data['curriculum_id'];
    $schoolYearId  = (int)$data['school_year_id'];
    $isPrimary     = isset($data['is_primary']) ? (int)$data['is_primary'] : 1;

    $curriculumExists = $conn->prepare('SELECT 1 FROM curricula WHERE curriculum_id = :id AND is_deleted = 0 LIMIT 1');
    $curriculumExists->execute([':id' => $requestedCurriculumId]);
    if (!$curriculumExists->fetchColumn()) {
        respond(['success' => false, 'message' => 'Curriculum not found or archived'], 422);
    }
    $schoolYearExists = $conn->prepare('SELECT 1 FROM school_years WHERE school_year_id = :id AND is_deleted = 0 LIMIT 1');
    $schoolYearExists->execute([':id' => $schoolYearId]);
    if (!$schoolYearExists->fetchColumn()) {
        respond(['success' => false, 'message' => 'School year not found or archived'], 422);
    }
    assertSchoolYearMappingMutable($conn, $schoolYearId);

    $conn->beginTransaction();
    try {
        $curriculumId = prepareCurriculumSettingsMutation($conn, $requestedCurriculumId);

        if ($isPrimary === 1) {
            $conn->prepare(
                'UPDATE curriculum_school_year_map
                 SET is_primary = 0
                 WHERE school_year_id = :school_year_id
                   AND is_deleted = 0'
            )->execute([':school_year_id' => $schoolYearId]);
        }

        // Upsert: check if mapping already exists
        $check = $conn->prepare('SELECT map_id FROM curriculum_school_year_map WHERE curriculum_id = :cid AND school_year_id = :sid LIMIT 1');
        $check->execute([':cid' => $curriculumId, ':sid' => $schoolYearId]);
        $existing = $check->fetchColumn();

        if ($existing) {
            $conn->prepare('UPDATE curriculum_school_year_map SET is_primary = :p, is_deleted = 0, deleted_at = NULL WHERE map_id = :mid')
                 ->execute([':p' => $isPrimary, ':mid' => $existing]);
        } else {
            $conn->prepare('INSERT INTO curriculum_school_year_map (curriculum_id, school_year_id, is_primary) VALUES (:cid, :sid, :p)')
                 ->execute([':cid' => $curriculumId, ':sid' => $schoolYearId, ':p' => $isPrimary]);
        }
        $conn->commit();
        respond([
            'success' => true,
            'message' => 'School year map saved',
            'curriculum_id' => $curriculumId,
            'detached_from_historical' => $curriculumId !== $requestedCurriculumId,
        ]);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
}

function deleteSchoolYearMap(PDO $conn, array $session): void {
    if (!auth_is_admin($session)) {
        respond(['success' => false, 'message' => 'Admin access required'], 403);
    }

    $data = getJsonInput();
    if (empty($data['curriculum_id']) || empty($data['school_year_id'])) {
        respond(['success' => false, 'message' => 'curriculum_id and school_year_id are required'], 422);
    }
    $curriculumId = (int)$data['curriculum_id'];
    $schoolYearId = (int)$data['school_year_id'];

    $stmt = $conn->prepare(
        'UPDATE curriculum_school_year_map
         SET is_deleted = 1, deleted_at = NOW()
         WHERE curriculum_id = :cid AND school_year_id = :sid AND is_deleted = 0'
    );
    $stmt->execute([':cid' => $curriculumId, ':sid' => $schoolYearId]);
    respond(['success' => true, 'message' => 'School year mapping removed']);
}
?>
