<?php
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../services/GradingPolicyService.php';
require_once __DIR__ . '/../utils/auth.php';

function respond($payload, int $code = 200): void {
    if (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8');
    }
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function sf10_format_name(?string $first, ?string $middle, ?string $last, ?string $ext = null): string {
    $first = trim((string)($first ?? ''));
    $middle = trim((string)($middle ?? ''));
    $last = trim((string)($last ?? ''));
    $ext = trim((string)($ext ?? ''));
    return trim(implode(' ', array_filter([$last, $first, $middle, $ext], fn($v) => $v !== '')));
}

function sf10_get_employee_id(PDO $conn, int $userId): int {
    if ($userId <= 0) return 0;
    $stmt = $conn->prepare('SELECT employee_id FROM employees WHERE user_id = :user_id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $stmt->execute();
    return (int)($stmt->fetchColumn() ?: 0);
}

function sf10_column_exists(PDO $conn, string $table, string $column): bool {
    static $cache = [];
    if (!preg_match('/^[A-Za-z0-9_]+$/', $table) || !preg_match('/^[A-Za-z0-9_]+$/', $column)) return false;
    $key = $table . '.' . $column;
    if (array_key_exists($key, $cache)) return $cache[$key];
    $stmt = $conn->query("SHOW COLUMNS FROM `$table` LIKE " . $conn->quote($column));
    $cache[$key] = (bool)$stmt->fetch(PDO::FETCH_ASSOC);
    return $cache[$key];
}

function sf10_table_exists(PDO $conn, string $table): bool {
    static $cache = [];
    if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) return false;
    if (array_key_exists($table, $cache)) return $cache[$table];
    $stmt = $conn->query('SHOW TABLES LIKE ' . $conn->quote($table));
    $cache[$table] = (bool)$stmt->fetch(PDO::FETCH_NUM);
    return $cache[$table];
}

function sf10_get_json_input(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') return [];
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function sf10_bind_nullable(PDOStatement $stmt, string $parameter, $value, int $type = PDO::PARAM_STR): void {
    if ($value === null || $value === '') {
        $stmt->bindValue($parameter, null, PDO::PARAM_NULL);
        return;
    }
    $stmt->bindValue($parameter, $value, $type);
}

function sf10_history_text($value, int $maxLength = 255): ?string {
    $value = trim((string)($value ?? ''));
    if ($value === '') return null;
    return function_exists('mb_substr') ? mb_substr($value, 0, $maxLength) : substr($value, 0, $maxLength);
}

function sf10_history_score($value, string $label): ?float {
    if ($value === null || $value === '' || (is_string($value) && trim($value) === '')) return null;
    if (!is_numeric($value)) {
        throw new InvalidArgumentException($label . ' must be a number between 0 and 100.');
    }
    $score = (float)$value;
    if ($score < 0 || $score > 100) {
        throw new InvalidArgumentException($label . ' must be between 0 and 100.');
    }
    return round($score, 2);
}

function sf10_history_grading_system($value): ?string {
    $normalized = strtolower(trim((string)($value ?? '')));
    if ($normalized === '') return null;
    if (in_array($normalized, ['quarterly', 'quarter', 'q'], true)) return 'Quarterly';
    if (in_array($normalized, ['three-term', 'three term', 'trimester', 'term', 'terms', 't'], true)) return 'Three-Term';
    throw new InvalidArgumentException('Historical record period type must be Quarterly or Three-Term.');
}

function sf10_infer_history_grading_system(?string $storedValue, array $grades = []): string {
    $stored = sf10_history_grading_system($storedValue);
    if ($stored !== null) return $stored;
    foreach ($grades as $grade) {
        if (is_array($grade) && $grade['q4'] !== null && $grade['q4'] !== '') {
            return 'Quarterly';
        }
    }
    return 'Three-Term';
}

function sf10_history_year_start(?string $label): int {
    if (preg_match('/\b(19|20)\d{2}\b/', (string)$label, $match)) return (int)$match[0];
    return 0;
}

function sf10_history_grade_number(?string $label): int {
    return sf10_grade_number($label);
}

function sf10_require_history_tables(PDO $conn): void {
    if (!sf10_table_exists($conn, 'learner_academic_history')
        || !sf10_table_exists($conn, 'learner_academic_history_grades')) {
        respond([
            'success' => false,
            'message' => 'SF10 transfer-history tables are not installed. Apply add_sf10_transfer_history.sql first.',
            'code' => 'SF10_HISTORY_MIGRATION_REQUIRED',
        ], 503);
    }
}

function sf10_fetch_academic_history(PDO $conn, int $learnerId): array {
    if ($learnerId <= 0 || !sf10_table_exists($conn, 'learner_academic_history')) return [];

    $gradingSystemSelect = sf10_column_exists($conn, 'learner_academic_history', 'grading_system_type')
        ? 'h.grading_system_type'
        : 'NULL AS grading_system_type';

    $stmt = $conn->prepare(
        'SELECT h.history_id, h.learner_id, h.enrollment_id,
                h.school_year_label, h.grade_level_id, h.grade_level_label, ' . $gradingSystemSelect . ',
                h.school_name, h.school_id, h.district, h.division, h.region,
                h.section_name, h.adviser_name, h.general_average,
                h.source_type, h.source_reference, h.verified,
                h.created_at, h.updated_at
         FROM learner_academic_history h
         WHERE h.learner_id = :learner_id
           AND h.is_deleted = 0
         ORDER BY h.school_year_label ASC, h.grade_level_label ASC, h.history_id ASC'
    );
    $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $stmt->execute();
    $headers = $stmt->fetchAll(PDO::FETCH_ASSOC);
    if (!$headers) return [];

    $historyIds = array_values(array_filter(array_map(
        static fn(array $row): int => (int)($row['history_id'] ?? 0),
        $headers
    ), static fn(int $id): bool => $id > 0));
    $gradesByHistory = [];
    if ($historyIds && sf10_table_exists($conn, 'learner_academic_history_grades')) {
        $placeholders = implode(',', array_fill(0, count($historyIds), '?'));
        $gradeStmt = $conn->prepare(
            'SELECT history_id, subject_name, subject_code, q1, q2, q3, q4,
                    final_rating, remarks, sort_order
             FROM learner_academic_history_grades
             WHERE history_id IN (' . $placeholders . ')
               AND is_deleted = 0
             ORDER BY history_id ASC, sort_order ASC, history_grade_id ASC'
        );
        foreach ($historyIds as $index => $id) {
            $gradeStmt->bindValue($index + 1, $id, PDO::PARAM_INT);
        }
        $gradeStmt->execute();
        foreach ($gradeStmt->fetchAll(PDO::FETCH_ASSOC) as $grade) {
            $historyId = (int)($grade['history_id'] ?? 0);
            $gradesByHistory[$historyId][] = [
                'subject' => (string)($grade['subject_name'] ?? ''),
                'subject_code' => $grade['subject_code'] ?? null,
                'q1' => $grade['q1'] !== null ? (float)$grade['q1'] : null,
                'q2' => $grade['q2'] !== null ? (float)$grade['q2'] : null,
                'q3' => $grade['q3'] !== null ? (float)$grade['q3'] : null,
                'q4' => $grade['q4'] !== null ? (float)$grade['q4'] : null,
                'final_rating' => $grade['final_rating'] !== null ? (float)$grade['final_rating'] : null,
                'remarks' => (string)($grade['remarks'] ?? ''),
            ];
        }
    }

    return array_map(static function (array $row) use ($gradesByHistory): array {
        $historyId = (int)($row['history_id'] ?? 0);
        $grades = $gradesByHistory[$historyId] ?? [];
        $gradingSystem = sf10_infer_history_grading_system($row['grading_system_type'] ?? null, $grades);
        return [
            'history_id' => $historyId,
            'enrollment_id' => $row['enrollment_id'] !== null ? (int)$row['enrollment_id'] : null,
            'school_year' => (string)($row['school_year_label'] ?? ''),
            'grade_level_id' => $row['grade_level_id'] !== null ? (int)$row['grade_level_id'] : null,
            'grade_level' => (string)($row['grade_level_label'] ?? ''),
            'grade_number' => sf10_history_grade_number($row['grade_level_label'] ?? null),
            'grading_system' => $gradingSystem,
            'grading_system_type' => $gradingSystem,
            'school' => [
                'school_name' => (string)($row['school_name'] ?? ''),
                'school_id' => (string)($row['school_id'] ?? ''),
                'district' => (string)($row['district'] ?? ''),
                'division' => (string)($row['division'] ?? ''),
                'region' => (string)($row['region'] ?? ''),
            ],
            'section' => (string)($row['section_name'] ?? ''),
            'adviser' => (string)($row['adviser_name'] ?? ''),
            'general_average' => $row['general_average'] !== null ? (float)$row['general_average'] : null,
            'source_type' => (string)($row['source_type'] ?? 'Previous School SF10'),
            'source_reference' => (string)($row['source_reference'] ?? ''),
            'verified' => (int)($row['verified'] ?? 0),
            'grades' => $grades,
        ];
    }, $headers);
}

/**
 * Historical SF10 entries are supplied by the previous school and must not
 * inherit the current school's Grade 1 descriptive/PACE display rule when
 * they contain actual numeric learning-area data.
 */
function sf10_history_has_grade_data(array $grades): bool {
    foreach ($grades as $grade) {
        if (!is_array($grade)) continue;
        if (trim((string)($grade['subject'] ?? '')) !== '') return true;
        foreach (['q1', 'q2', 'q3', 'q4', 'final_rating'] as $field) {
            if (isset($grade[$field]) && $grade[$field] !== '') return true;
        }
    }
    return false;
}

function sf10_fetch_preview_overrides(PDO $conn, int $learnerId): array {
    if ($learnerId <= 0 || !sf10_table_exists($conn, 'learner_sf10_preview_overrides')) {
        return ['fields' => []];
    }

    $stmt = $conn->prepare(
        'SELECT overrides_json
         FROM learner_sf10_preview_overrides
         WHERE learner_id = :learner_id
         LIMIT 1'
    );
    $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $stmt->execute();
    $raw = $stmt->fetchColumn();
    $decoded = json_decode((string)($raw ?: ''), true);
    $fields = is_array($decoded) && isset($decoded['fields']) && is_array($decoded['fields'])
        ? $decoded['fields']
        : [];
    return ['fields' => $fields];
}

function sf10_save_preview_overrides(PDO $conn, array $session): void {
    if (!sf10_table_exists($conn, 'learner_sf10_preview_overrides')) {
        respond([
            'success' => false,
            'message' => 'SF10 preview override storage is not installed. Apply create_sf10_preview_overrides.sql first.',
            'code' => 'SF10_PREVIEW_OVERRIDES_MIGRATION_REQUIRED',
        ], 503);
    }

    $data = sf10_get_json_input();
    $learnerId = (int)($data['learner_id'] ?? 0);
    if ($learnerId <= 0) respond(['success' => false, 'message' => 'learner_id is required.'], 422);
    sf10_ensure_learner_access($conn, $session, $learnerId);

    $learnerCheck = $conn->prepare(
        'SELECT learner_id FROM learners WHERE learner_id = :learner_id AND is_deleted = 0 LIMIT 1'
    );
    $learnerCheck->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $learnerCheck->execute();
    if (!$learnerCheck->fetchColumn()) respond(['success' => false, 'message' => 'Learner not found.'], 404);

    $incoming = $data['fields'] ?? [];
    if (!is_array($incoming)) respond(['success' => false, 'message' => 'SF10 preview fields are invalid.'], 422);
    if (count($incoming) > 600) respond(['success' => false, 'message' => 'Too many SF10 preview fields were submitted.'], 422);

    $normalized = [];
    foreach ($incoming as $key => $value) {
        $key = trim((string)$key);
        if ($key === '' || strlen($key) > 180 || !is_scalar($value)) continue;
        $value = (string)$value;
        $value = str_replace(["\r\n", "\r"], "\n", $value);
        $normalized[$key] = function_exists('mb_substr') ? mb_substr($value, 0, 2000) : substr($value, 0, 2000);
    }

    $userId = (int)($session['user_id'] ?? 0) ?: null;
    try {
        $conn->beginTransaction();

        // Seed the learner row before locking it. This makes the read/merge/write
        // sequence safe when two preview saves arrive close together.
        $seed = $conn->prepare(
            'INSERT IGNORE INTO learner_sf10_preview_overrides
                (learner_id, overrides_json)
             VALUES (:learner_id, :overrides_json)'
        );
        $seed->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
        $seed->bindValue(':overrides_json', '{"fields":{}}', PDO::PARAM_STR);
        $seed->execute();

        $lock = $conn->prepare(
            'SELECT overrides_json
             FROM learner_sf10_preview_overrides
             WHERE learner_id = :learner_id
             LIMIT 1
             FOR UPDATE'
        );
        $lock->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
        $lock->execute();
        $rawExisting = $lock->fetchColumn();
        $decodedExisting = json_decode((string)($rawExisting ?: ''), true);
        $existingFields = is_array($decodedExisting) && isset($decodedExisting['fields']) && is_array($decodedExisting['fields'])
            ? $decodedExisting['fields']
            : [];
        $fields = array_merge($existingFields, $normalized);
        $json = json_encode(['fields' => $fields], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            throw new InvalidArgumentException('Unable to encode SF10 preview fields.');
        }

        $stmt = $conn->prepare(
            'UPDATE learner_sf10_preview_overrides
             SET overrides_json = :overrides_json,
                 updated_by = :updated_by
             WHERE learner_id = :learner_id'
        );
        $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
        $stmt->bindValue(':overrides_json', $json, PDO::PARAM_STR);
        sf10_bind_nullable($stmt, ':updated_by', $userId, PDO::PARAM_INT);
        $stmt->execute();
        $conn->commit();
    } catch (Throwable $error) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $error;
    }

    respond([
        'success' => true,
        'message' => 'SF10 preview fields saved.',
        'field_count' => count($normalized),
        'preview_overrides' => ['fields' => $fields],
    ]);
}

function sf10_history_payload(PDO $conn, array $data): array {
    $learnerId = (int)($data['learner_id'] ?? 0);
    if ($learnerId <= 0) throw new InvalidArgumentException('learner_id is required.');

    $historyId = (int)($data['history_id'] ?? 0);
    $schoolYear = sf10_history_text($data['school_year'] ?? $data['school_year_label'] ?? null, 20);
    $gradeLevel = sf10_history_text($data['grade_level'] ?? $data['grade_level_label'] ?? null, 50);
    $schoolName = sf10_history_text($data['school_name'] ?? null, 200);
    $requestedGradingSystem = sf10_history_grading_system($data['grading_system'] ?? $data['grading_system_type'] ?? null);
    if ($schoolYear === null || !preg_match('/^(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}$/', $schoolYear)) {
        throw new InvalidArgumentException('School Year must use the format YYYY-YYYY.');
    }
    if ($gradeLevel === null) throw new InvalidArgumentException('Grade level is required.');
    if ($schoolName === null) throw new InvalidArgumentException('Previous school name is required.');

    // Keep the historical record linked to the local grade masterfile when
    // possible. This is metadata only; it never applies the current grading
    // policy to, or removes values from, the supplied older record.
    $gradeLevelId = (int)($data['grade_level_id'] ?? 0);
    if ($gradeLevelId <= 0) {
        $gradeLevelId = sf10_find_grade_level_id($conn, 0, $gradeLevel);
    }

    $grades = $data['grades'] ?? [];
    if (!is_array($grades)) throw new InvalidArgumentException('Previous-school subject records are invalid.');
    if (count($grades) > 30) throw new InvalidArgumentException('A record may contain up to 30 learning areas.');

    $normalizedGrades = [];
    $seenSubjects = [];
    foreach ($grades as $index => $grade) {
        if (!is_array($grade)) continue;
        $subject = sf10_history_text($grade['subject'] ?? $grade['subject_name'] ?? null, 150);
        $hasScore = false;
        foreach (['q1', 'q2', 'q3', 'q4', 'final_rating'] as $scoreKey) {
            $scoreValue = $grade[$scoreKey] ?? null;
            if ($scoreValue !== null && $scoreValue !== '' && trim((string)$scoreValue) !== '') {
                $hasScore = true;
                break;
            }
        }
        if ($subject === null && !$hasScore) continue;
        if ($subject === null) throw new InvalidArgumentException('Every previous-school grade row needs a learning area.');
        $subjectKey = strtolower(preg_replace('/\s+/', ' ', $subject));
        if (isset($seenSubjects[$subjectKey])) throw new InvalidArgumentException('Duplicate learning area: ' . $subject . '.');
        $seenSubjects[$subjectKey] = true;
        $normalizedGrades[] = [
            'subject' => $subject,
            'subject_code' => sf10_history_text($grade['subject_code'] ?? null, 50),
            'q1' => sf10_history_score($grade['q1'] ?? null, 'Quarter 1'),
            'q2' => sf10_history_score($grade['q2'] ?? null, 'Quarter 2'),
            'q3' => sf10_history_score($grade['q3'] ?? null, 'Quarter 3'),
            'q4' => sf10_history_score($grade['q4'] ?? null, 'Quarter 4'),
            'final_rating' => sf10_history_score($grade['final_rating'] ?? null, 'Final rating'),
            'remarks' => sf10_history_text($grade['remarks'] ?? null, 100),
            'sort_order' => count($normalizedGrades),
        ];
    }

    return [
        'history_id' => $historyId,
        'learner_id' => $learnerId,
        'enrollment_id' => (int)($data['enrollment_id'] ?? 0) ?: null,
        'school_year' => $schoolYear,
        'grade_level_id' => $gradeLevelId > 0 ? $gradeLevelId : null,
        'grade_level' => $gradeLevel,
        'grading_system' => $requestedGradingSystem ?? 'Quarterly',
        'school_name' => $schoolName,
        'school_id' => sf10_history_text($data['school_id'] ?? null, 20),
        'district' => sf10_history_text($data['district'] ?? null, 150),
        'division' => sf10_history_text($data['division'] ?? null, 150),
        'region' => sf10_history_text($data['region'] ?? null, 100),
        'section' => sf10_history_text($data['section'] ?? $data['section_name'] ?? null, 100),
        'adviser' => sf10_history_text($data['adviser'] ?? $data['adviser_name'] ?? null, 200),
        'general_average' => sf10_history_score($data['general_average'] ?? null, 'General average'),
        'source_type' => sf10_history_text($data['source_type'] ?? null, 50) ?? 'Previous School SF10',
        'source_reference' => sf10_history_text($data['source_reference'] ?? null, 255),
        'verified' => !empty($data['verified']) ? 1 : 0,
        'grades' => $normalizedGrades,
    ];
}

function sf10_save_academic_history(PDO $conn, array $session): void {
    sf10_require_history_tables($conn);
    $payload = sf10_history_payload($conn, sf10_get_json_input());
    $learnerId = (int)$payload['learner_id'];

    sf10_ensure_learner_access($conn, $session, $learnerId);
    $learnerCheck = $conn->prepare('SELECT learner_id FROM learners WHERE learner_id = :learner_id AND is_deleted = 0 LIMIT 1');
    $learnerCheck->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $learnerCheck->execute();
    if (!$learnerCheck->fetchColumn()) respond(['success' => false, 'message' => 'Learner not found.'], 404);

    $duplicate = $conn->prepare(
        'SELECT history_id
         FROM learner_academic_history
         WHERE learner_id = :learner_id
           AND school_year_label = :school_year
           AND grade_level_label = :grade_level
           AND LOWER(school_name) = LOWER(:school_name)
           AND is_deleted = 0
           AND history_id <> :history_id
         LIMIT 1'
    );
    $duplicate->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $duplicate->bindValue(':school_year', $payload['school_year']);
    $duplicate->bindValue(':grade_level', $payload['grade_level']);
    $duplicate->bindValue(':school_name', $payload['school_name']);
    $duplicate->bindValue(':history_id', (int)$payload['history_id'], PDO::PARAM_INT);
    $duplicate->execute();
    if ($duplicate->fetchColumn()) {
        respond(['success' => false, 'message' => 'This school year, grade, and previous school record already exists. Edit the existing record instead.'], 409);
    }

    try {
        $conn->beginTransaction();
        $userId = (int)($session['user_id'] ?? 0) ?: null;
        if ((int)$payload['history_id'] > 0) {
            $historyCheck = $conn->prepare(
                'SELECT history_id FROM learner_academic_history
                 WHERE history_id = :history_id AND learner_id = :learner_id AND is_deleted = 0 LIMIT 1'
            );
            $historyCheck->execute([
                ':history_id' => (int)$payload['history_id'],
                ':learner_id' => $learnerId,
            ]);
            if (!$historyCheck->fetchColumn()) {
                throw new InvalidArgumentException('Previous-school record not found.');
            }
            $stmt = $conn->prepare(
                'UPDATE learner_academic_history
                 SET enrollment_id = :enrollment_id, school_year_label = :school_year,
                     grade_level_id = :grade_level_id, grade_level_label = :grade_level,
                     ' . (sf10_column_exists($conn, 'learner_academic_history', 'grading_system_type') ? 'grading_system_type = :grading_system_type,' : '') . '
                     school_name = :school_name, school_id = :school_id,
                     district = :district, division = :division, region = :region,
                     section_name = :section_name, adviser_name = :adviser_name,
                     general_average = :general_average, source_type = :source_type,
                     source_reference = :source_reference, verified = :verified,
                     updated_by = :updated_by
                 WHERE history_id = :history_id AND learner_id = :learner_id'
            );
            $historyId = (int)$payload['history_id'];
        } else {
            $stmt = $conn->prepare(
                'INSERT INTO learner_academic_history
                 (learner_id, enrollment_id, school_year_label, grade_level_id, grade_level_label' .
                 (sf10_column_exists($conn, 'learner_academic_history', 'grading_system_type') ? ', grading_system_type' : '') .
                 ', school_name, school_id, district, division, region, section_name, adviser_name,
                  general_average, source_type, source_reference, verified, created_by, updated_by)
                 VALUES (:learner_id, :enrollment_id, :school_year, :grade_level_id, :grade_level' .
                 (sf10_column_exists($conn, 'learner_academic_history', 'grading_system_type') ? ', :grading_system_type' : '') .
                 ', :school_name, :school_id, :district, :division, :region, :section_name, :adviser_name,
                         :general_average, :source_type, :source_reference, :verified, :created_by, :updated_by)'
            );
            $historyId = 0;
        }
        $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
        sf10_bind_nullable($stmt, ':enrollment_id', $payload['enrollment_id'], PDO::PARAM_INT);
        $stmt->bindValue(':school_year', $payload['school_year']);
        sf10_bind_nullable($stmt, ':grade_level_id', $payload['grade_level_id'], PDO::PARAM_INT);
        $stmt->bindValue(':grade_level', $payload['grade_level']);
        if (sf10_column_exists($conn, 'learner_academic_history', 'grading_system_type')) {
            $stmt->bindValue(':grading_system_type', $payload['grading_system']);
        }
        $stmt->bindValue(':school_name', $payload['school_name']);
        sf10_bind_nullable($stmt, ':school_id', $payload['school_id']);
        sf10_bind_nullable($stmt, ':district', $payload['district']);
        sf10_bind_nullable($stmt, ':division', $payload['division']);
        sf10_bind_nullable($stmt, ':region', $payload['region']);
        sf10_bind_nullable($stmt, ':section_name', $payload['section']);
        sf10_bind_nullable($stmt, ':adviser_name', $payload['adviser']);
        sf10_bind_nullable($stmt, ':general_average', $payload['general_average']);
        $stmt->bindValue(':source_type', $payload['source_type']);
        sf10_bind_nullable($stmt, ':source_reference', $payload['source_reference']);
        $stmt->bindValue(':verified', (int)$payload['verified'], PDO::PARAM_INT);
        if ((int)$payload['history_id'] > 0) {
            sf10_bind_nullable($stmt, ':updated_by', $userId, PDO::PARAM_INT);
            $stmt->bindValue(':history_id', (int)$payload['history_id'], PDO::PARAM_INT);
        } else {
            sf10_bind_nullable($stmt, ':created_by', $userId, PDO::PARAM_INT);
            sf10_bind_nullable($stmt, ':updated_by', $userId, PDO::PARAM_INT);
        }
        $stmt->execute();
        if ($historyId <= 0) $historyId = (int)$conn->lastInsertId();

        $deleteGrades = $conn->prepare(
            'UPDATE learner_academic_history_grades
             SET is_deleted = 1, deleted_at = NOW()
             WHERE history_id = :history_id AND is_deleted = 0'
        );
        $deleteGrades->bindValue(':history_id', $historyId, PDO::PARAM_INT);
        $deleteGrades->execute();

        $insertGrade = $conn->prepare(
            'INSERT INTO learner_academic_history_grades
             (history_id, subject_name, subject_code, q1, q2, q3, q4, final_rating, remarks, sort_order)
             VALUES (:history_id, :subject_name, :subject_code, :q1, :q2, :q3, :q4, :final_rating, :remarks, :sort_order)'
        );
        foreach ($payload['grades'] as $grade) {
            $insertGrade->bindValue(':history_id', $historyId, PDO::PARAM_INT);
            $insertGrade->bindValue(':subject_name', $grade['subject']);
            sf10_bind_nullable($insertGrade, ':subject_code', $grade['subject_code']);
            sf10_bind_nullable($insertGrade, ':q1', $grade['q1']);
            sf10_bind_nullable($insertGrade, ':q2', $grade['q2']);
            sf10_bind_nullable($insertGrade, ':q3', $grade['q3']);
            sf10_bind_nullable($insertGrade, ':q4', $grade['q4']);
            sf10_bind_nullable($insertGrade, ':final_rating', $grade['final_rating']);
            sf10_bind_nullable($insertGrade, ':remarks', $grade['remarks']);
            $insertGrade->bindValue(':sort_order', (int)$grade['sort_order'], PDO::PARAM_INT);
            $insertGrade->execute();
        }
        $conn->commit();
        respond(['success' => true, 'message' => 'Previous-school academic record saved.', 'history_id' => $historyId]);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        if ($e instanceof InvalidArgumentException) throw $e;
        respond(['success' => false, 'message' => 'Unable to save previous-school academic record: ' . $e->getMessage()], 500);
    }
}

function sf10_delete_academic_history(PDO $conn, array $session): void {
    sf10_require_history_tables($conn);
    $data = sf10_get_json_input();
    $historyId = (int)($data['history_id'] ?? $_GET['history_id'] ?? 0);
    if ($historyId <= 0) respond(['success' => false, 'message' => 'history_id is required.'], 422);

    $stmt = $conn->prepare(
        'SELECT learner_id FROM learner_academic_history
         WHERE history_id = :history_id AND is_deleted = 0 LIMIT 1'
    );
    $stmt->bindValue(':history_id', $historyId, PDO::PARAM_INT);
    $stmt->execute();
    $learnerId = (int)($stmt->fetchColumn() ?: 0);
    if ($learnerId <= 0) respond(['success' => false, 'message' => 'Previous-school record not found.'], 404);
    sf10_ensure_learner_access($conn, $session, $learnerId);

    $conn->beginTransaction();
    try {
        $gradeStmt = $conn->prepare(
            'UPDATE learner_academic_history_grades
             SET is_deleted = 1, deleted_at = NOW()
             WHERE history_id = :history_id AND is_deleted = 0'
        );
        $gradeStmt->bindValue(':history_id', $historyId, PDO::PARAM_INT);
        $gradeStmt->execute();
        $historyStmt = $conn->prepare(
            'UPDATE learner_academic_history
             SET is_deleted = 1, deleted_at = NOW(), updated_by = :updated_by
             WHERE history_id = :history_id AND is_deleted = 0'
        );
        sf10_bind_nullable($historyStmt, ':updated_by', (int)($session['user_id'] ?? 0) ?: null, PDO::PARAM_INT);
        $historyStmt->bindValue(':history_id', $historyId, PDO::PARAM_INT);
        $historyStmt->execute();
        $conn->commit();
        respond(['success' => true, 'message' => 'Previous-school academic record archived.']);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => 'Unable to archive previous-school record: ' . $e->getMessage()], 500);
    }
}

function sf10_get_academic_history(PDO $conn, array $session): void {
    $learnerId = (int)($_GET['learner_id'] ?? 0);
    if ($learnerId <= 0) respond(['success' => false, 'message' => 'learner_id is required.'], 422);
    sf10_ensure_learner_access($conn, $session, $learnerId);
    sf10_require_history_tables($conn);
    respond(['success' => true, 'data' => sf10_fetch_academic_history($conn, $learnerId)]);
}

function sf10_history_mapeh_role(?string $subjectName, ?string $subjectCode = null): ?string {
    $name = strtolower(trim(preg_replace('/\s+/', ' ', (string)($subjectName ?? ''))));
    $code = strtoupper(trim((string)($subjectCode ?? '')));
    if ($name === '' && $code === '') return null;
    if ($code === 'MAPEH' || (str_contains($name, 'mapeh') && !str_contains($name, 'component'))) return 'parent';
    if (preg_match('/\bmusic\s*(and|&)\s*arts?\b/', $name)) return 'grouped_music_arts';
    if (preg_match('/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/', $name)) return 'grouped_pe_health';
    if (preg_match('/\b(music|arts|physical education|health|pe|p\.e\.)\b/', $name)) return 'component';
    if (str_contains($name, 'mapeh')) return 'component';
    return null;
}

function sf10_get_history_subject_options(PDO $conn, array $session): void {
    $learnerId = (int)($_GET['learner_id'] ?? 0);
    if ($learnerId <= 0) respond(['success' => false, 'message' => 'learner_id is required.'], 422);
    sf10_ensure_learner_access($conn, $session, $learnerId);

    $requestedGradeId = (int)($_GET['grade_level_id'] ?? 0);
    $gradeLabel = sf10_history_text($_GET['grade_level'] ?? null, 50);
    $gradeLevelId = sf10_find_grade_level_id($conn, $requestedGradeId, $gradeLabel);
    if ($gradeLevelId <= 0) respond(['success' => false, 'message' => 'A valid grade level is required.'], 422);

    // The previous-school year is record metadata only. Subject selectors must
    // follow the curriculum currently marked active, so an older history year
    // cannot load a historical or enrollment-snapshot subject list.
    $schoolYearLabel = sf10_history_text($_GET['school_year'] ?? null, 20);
    $activeCurriculumStmt = $conn->prepare(
        'SELECT c.curriculum_id, c.curriculum_code, c.curriculum_name, c.effective_from
         FROM curricula c
         WHERE c.is_deleted = 0
           AND c.is_active = 1
           AND EXISTS (
               SELECT 1
               FROM curriculum_subjects cs
               WHERE cs.curriculum_id = c.curriculum_id
                 AND cs.grade_level_id = :grade_level_id
                 AND cs.is_deleted = 0
           )
         ORDER BY c.effective_from DESC, c.curriculum_id DESC
         LIMIT 1'
    );
    $activeCurriculumStmt->bindValue(':grade_level_id', $gradeLevelId, PDO::PARAM_INT);
    $activeCurriculumStmt->execute();
    $activeCurriculum = $activeCurriculumStmt->fetch(PDO::FETCH_ASSOC) ?: null;
    $curriculumId = (int)($activeCurriculum['curriculum_id'] ?? 0);
    if ($curriculumId <= 0) {
        respond(['success' => false, 'message' => 'No active curriculum subject setup was found for the selected grade level.'], 422);
    }

    $subjectRows = sf10_fetch_assigned_subjects($conn, 0, 0, $gradeLevelId, $curriculumId);
    $subjects = array_map(static function (array $subject): array {
        $subjectName = trim((string)($subject['subject_name'] ?? ''));
        $subjectCode = $subject['subject_code'] ?? null;
        return [
            'subject_id' => (int)($subject['subject_id'] ?? 0),
            'subject_name' => $subjectName,
            'subject_code' => $subjectCode,
            'sort_order' => (int)($subject['sort_order'] ?? 9999),
            'learning_area_id' => $subject['learning_area_id'] ?? null,
            'learning_area' => $subject['area_name'] ?? null,
            'mapeh_role' => sf10_history_mapeh_role($subjectName, $subjectCode),
        ];
    }, $subjectRows);

    $mapehParent = null;
    $mapehComponents = [];
    foreach ($subjects as $subject) {
        if ($subject['mapeh_role'] === 'parent') $mapehParent = $subject;
        if (in_array($subject['mapeh_role'], ['grouped_music_arts', 'grouped_pe_health'], true)) {
            $mapehComponents[$subject['mapeh_role']] = $subject;
        }
    }

    respond([
        'success' => true,
        'data' => [
            'learner_id' => $learnerId,
            'school_year_id' => null,
            'school_year' => $schoolYearLabel,
            'curriculum_source' => 'active',
            'grade_level_id' => $gradeLevelId,
            'grade_level' => $gradeLabel,
            'curriculum_id' => $curriculumId,
            'curriculum_code' => $activeCurriculum['curriculum_code'] ?? null,
            'curriculum_name' => $activeCurriculum['curriculum_name'] ?? null,
            'subjects' => $subjects,
            'mapeh_setup' => [
                'fixed_group' => $mapehParent !== null
                    && isset($mapehComponents['grouped_music_arts'])
                    && isset($mapehComponents['grouped_pe_health']),
                'parent' => $mapehParent,
                'components' => array_values($mapehComponents),
            ],
        ],
    ]);
}

function sf10_get_school_settings(PDO $conn): array {
    $stmt = $conn->prepare('SELECT setting_key, setting_value FROM school_settings WHERE is_deleted = 0');
    $stmt->execute();
    $map = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $key = (string)($row['setting_key'] ?? '');
        if ($key !== '') {
            $map[$key] = $row['setting_value'] ?? null;
        }
    }
    return $map;
}

function sf10_ensure_section_access(PDO $conn, array $session, int $sectionId, int $schoolYearId = 0): void {
    $roleKey = strtolower((string)($session['role_key'] ?? ''));
    if ($roleKey === 'registrar') return;

    $employeeId = sf10_get_employee_id($conn, (int)($session['user_id'] ?? 0));
    if ($employeeId <= 0) {
        auth_abort(403, 'Teacher profile not found');
    }

    $sql = "SELECT 1
            FROM sections s
            WHERE s.section_id = :section_id
              AND s.is_deleted = 0
              AND EXISTS (
                  SELECT 1
                  FROM class_offerings co
                  WHERE co.section_id = s.section_id
                    AND co.school_year_id = s.school_year_id
                    AND co.teacher_id = :teacher_id
                    AND co.is_deleted = 0
              )";
    if ($schoolYearId > 0) {
        $sql .= ' AND s.school_year_id = :school_year_id';
    }
    $sql .= ' LIMIT 1';

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':teacher_id', $employeeId, PDO::PARAM_INT);
    if ($schoolYearId > 0) {
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    }
    $stmt->execute();
    if (!$stmt->fetchColumn()) {
        auth_abort(403, 'Access denied for this section');
    }
}

function sf10_ensure_learner_access(PDO $conn, array $session, int $learnerId): void {
    $roleKey = strtolower((string)($session['role_key'] ?? ''));
    if ($roleKey === 'registrar') return;

    if ($roleKey === 'learners') {
        $stmt = $conn->prepare('SELECT 1 FROM learners WHERE learner_id = :learner_id AND user_id = :user_id AND is_deleted = 0 LIMIT 1');
        $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
        $stmt->bindValue(':user_id', (int)($session['user_id'] ?? 0), PDO::PARAM_INT);
        $stmt->execute();
        if (!$stmt->fetchColumn()) auth_abort(403, 'Access denied for this learner');
        return;
    }

    $employeeId = sf10_get_employee_id($conn, (int)($session['user_id'] ?? 0));
    if ($employeeId <= 0) auth_abort(403, 'Teacher profile not found');
    $stmt = $conn->prepare(
        'SELECT 1
         FROM enrollments e
         JOIN sections s ON s.section_id = e.section_id AND s.is_deleted = 0
         WHERE e.learner_id = :learner_id
           AND e.is_deleted = 0
           AND EXISTS (
               SELECT 1 FROM class_offerings co
               WHERE co.section_id = e.section_id
                 AND co.school_year_id = e.school_year_id
                 AND co.teacher_id = :teacher_id
                 AND co.is_deleted = 0
           )
         LIMIT 1'
    );
    $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $stmt->bindValue(':teacher_id', $employeeId, PDO::PARAM_INT);
    $stmt->execute();
    if (!$stmt->fetchColumn()) auth_abort(403, 'Access denied for this learner');
}

function sf10_periods_for_school_year(PDO $conn, int $schoolYearId): array {
    $stmt = $conn->prepare(
        'SELECT grading_period_id, period_no, period_name
         FROM grading_periods
         WHERE school_year_id = :school_year_id AND is_deleted = 0
         ORDER BY period_no ASC, grading_period_id ASC'
    );
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $periods = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $no = (int)($row['period_no'] ?? 0);
        if ($no > 0 && $no <= 4) {
            $periods[(int)$row['grading_period_id']] = $no;
        }
    }
    return $periods;
}

function sf10_normalize_subject(string $subjectName): string {
    $s = strtolower(trim($subjectName));
    $s = preg_replace('/\s+/', ' ', $s);
    if (str_contains($s, 'mother tongue')) return 'Mother Tongue';
    if (str_contains($s, 'filipino')) return 'Filipino';
    if (str_contains($s, 'english')) return 'English';
    if (str_contains($s, 'mathematics') || $s === 'math') return 'Mathematics';
    if (str_contains($s, 'science')) return 'Science';
    if (str_contains($s, 'araling panlipunan')) return 'Araling Panlipunan';
    if (str_contains($s, 'epp') || str_contains($s, 'tle') || str_contains($s, 'technology and livelihood')) return 'EPP / TLE';
    if (preg_match('/\bmusic\s*(and|&)\s*arts?\b/i', $s)) return 'Music and Arts';
    if (preg_match('/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/i', $s)) return 'Physical Education and Health';
    if (str_contains($s, 'music')) return 'Music';
    if (str_contains($s, 'arts')) return 'Arts';
    if (str_contains($s, 'physical education') || preg_match('/(^| )pe( |$)/', $s)) return 'Physical Education';
    if (str_contains($s, 'health')) return 'Health';
    if (str_contains($s, 'mapeh')) return 'MAPEH';
    if (str_contains($s, 'pagpapakatao') || str_contains($s, 'gmrc') || str_contains($s, 'good manners')) return 'Eduk. sa Pagpapakatao';
    if (str_contains($s, 'arabic')) return '*Arabic Language';
    if (str_contains($s, 'islamic')) return '*Islamic Values Education';
    return $subjectName;
}

function sf10_subject_key(?string $subjectCode, ?string $subjectName): string {
    $code = strtoupper(trim((string)($subjectCode ?? '')));
    if ($code !== '') return 'CODE:' . $code;
    $name = strtolower(trim((string)($subjectName ?? '')));
    $name = preg_replace('/\s+/', ' ', $name);
    return 'NAME:' . $name;
}

function sf10_grade_number(?string $gradeName): int {
    $name = strtolower(trim((string)($gradeName ?? '')));
    if ($name === '') return 0;
    if (preg_match('/(?:grade|gr\.?|g)\s*[-:]?\s*(\d{1,2})\b/', $name, $matches)) {
        return (int)$matches[1];
    }
    if (preg_match('/\b(\d{1,2})\b/', $name, $matches)) {
        return (int)$matches[1];
    }
    return 0;
}

function sf10_form_for_grade(int $gradeNumber): array {
    if ($gradeNumber >= 7 && $gradeNumber <= 10) {
        return [
            'code' => 'SF10-JHS',
            'level' => 'jhs',
            'title' => "Learner's Permanent Academic Record for Junior High School (SF10-JHS)",
            'grade_min' => 7,
            'grade_max' => 10,
            'certification_title' => 'For Transfer Out / Junior High School Completer Only',
        ];
    }

    return [
        'code' => 'SF10-ES',
        'level' => 'elementary',
        'title' => "Learner's Permanent Academic Record for Elementary School (SF10-ES)",
        'grade_min' => 1,
        'grade_max' => 6,
        'certification_title' => 'For Transfer Out / Elementary School Completer Only',
    ];
}

function sf10_find_school_year_id(PDO $conn, ?string $schoolYearLabel): int {
    static $cache = [];
    $label = trim((string)($schoolYearLabel ?? ''));
    if ($label === '') return 0;
    if (array_key_exists($label, $cache)) return $cache[$label];

    $stmt = $conn->prepare(
        "SELECT school_year_id
         FROM school_years
         WHERE is_deleted = 0
           AND REPLACE(year_label, '–', '-') = REPLACE(:year_label, '–', '-')
         ORDER BY year_start DESC, school_year_id DESC
         LIMIT 1"
    );
    $stmt->bindValue(':year_label', $label, PDO::PARAM_STR);
    $stmt->execute();
    $cache[$label] = (int)($stmt->fetchColumn() ?: 0);
    return $cache[$label];
}

function sf10_find_grade_level_id(PDO $conn, int $gradeLevelId, ?string $gradeName): int {
    if ($gradeLevelId > 0) return $gradeLevelId;
    $gradeNumber = sf10_grade_number($gradeName);
    if ($gradeNumber <= 0) return 0;

    static $idsByGrade = null;
    if ($idsByGrade === null) {
        $idsByGrade = [];
        try {
            $stmt = $conn->query(
                'SELECT grade_level_id, grade_name
                 FROM grade_levels
                 WHERE is_deleted = 0'
            );
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $number = sf10_grade_number($row['grade_name'] ?? null);
                if ($number > 0 && !isset($idsByGrade[$number])) {
                    $idsByGrade[$number] = (int)$row['grade_level_id'];
                }
            }
        } catch (Throwable $_) {
            $idsByGrade = [];
        }
    }
    return (int)($idsByGrade[$gradeNumber] ?? 0);
}

function sf10_resolve_record_policy(
    PDO $conn,
    int $schoolYearId,
    ?string $schoolYearLabel,
    int $gradeLevelId,
    ?string $gradeName
): array {
    $resolvedSchoolYearId = $schoolYearId > 0
        ? $schoolYearId
        : sf10_find_school_year_id($conn, $schoolYearLabel);
    $resolvedGradeLevelId = sf10_find_grade_level_id($conn, $gradeLevelId, $gradeName);
    return GradingPolicyService::resolve(
        $conn,
        $resolvedSchoolYearId,
        $resolvedGradeLevelId,
        $gradeName
    );
}

function sf10_descriptive_gap_record(int $gradeNumber, int $layoutYearStart = 0, string $gradingSystemType = 'Quarterly'): array {
    $record = [
        'enrollment_id' => null,
        'school_year_id' => null,
        'grade_level_id' => null,
        'school_year' => '',
        'grade_level' => 'Grade ' . $gradeNumber,
        'grade_number' => $gradeNumber,
        'section' => '',
        'school' => [
            'school_name' => '',
            'school_id' => '',
            'district' => '',
            'division' => '',
            'region' => '',
        ],
        'adviser' => '',
        'status' => '',
        'source_type' => 'descriptive_gap',
        'source_label' => 'Descriptive grade gap',
        'general_average' => null,
        'grades' => [],
        'grading_mode' => 'Descriptive',
        'grading_system_type' => sf10_history_grading_system($gradingSystemType) ?? 'Quarterly',
        'sf9_template_variant' => 'G' . $gradeNumber,
        'is_descriptive_gap' => true,
    ];
    if ($layoutYearStart > 0) $record['_layout_year_start'] = $layoutYearStart;
    return $record;
}

function sf10_add_missing_descriptive_gaps(
    PDO $conn,
    array $records,
    ?array $policyEnrollment,
    int $selectedGradeNumber
): array {
    if (!$policyEnrollment || $selectedGradeNumber < 1 || $selectedGradeNumber > 6) {
        return $records;
    }

    $policySchoolYearId = (int)($policyEnrollment['school_year_id'] ?? 0);
    $gradingSystemType = sf10_history_grading_system($policyEnrollment['grading_system_type'] ?? null) ?? 'Quarterly';
    $modes = GradingPolicyService::elementaryModeFields($conn, $policySchoolYearId);
    $existingGrades = [];
    foreach ($records as $record) {
        $gradeNumber = (int)($record['grade_number'] ?? sf10_grade_number($record['grade_level'] ?? null));
        if ($gradeNumber >= 1 && $gradeNumber <= 3) $existingGrades[$gradeNumber] = true;
    }

    $currentYearStart = sf10_history_year_start($policyEnrollment['year_label'] ?? null);
    for ($gradeNumber = 1; $gradeNumber <= min(3, $selectedGradeNumber); $gradeNumber++) {
        if (($modes[$gradeNumber] ?? 'Numeric') !== 'Descriptive' || isset($existingGrades[$gradeNumber])) {
            continue;
        }
        $yearOffset = $selectedGradeNumber - $gradeNumber;
        $layoutYearStart = $currentYearStart > 0 && $yearOffset > 0
            ? max(0, $currentYearStart - $yearOffset)
            : 0;
        $records[] = sf10_descriptive_gap_record($gradeNumber, $layoutYearStart, $gradingSystemType);
    }
    return $records;
}

function sf10_resolve_curriculum_id(PDO $conn, int $curriculumId, int $schoolYearId, int $gradeLevelId): int {
    // The enrollment curriculum is the record's curriculum snapshot. It must
    // win over a later school-year mapping so an existing SF10 stays tied to
    // the curriculum assigned to that enrollment.
    if ($curriculumId > 0) {
        return $curriculumId;
    }

    if ($schoolYearId > 0 && $gradeLevelId > 0 && sf10_table_exists($conn, 'curriculum_school_year_map')) {
        $stmt = $conn->prepare(
            'SELECT c.curriculum_id
             FROM curriculum_school_year_map m
             JOIN curricula c ON c.curriculum_id = m.curriculum_id AND c.is_deleted = 0
             LEFT JOIN curriculum_grade_levels cgl ON cgl.curriculum_id = c.curriculum_id
                AND cgl.grade_level_id = :gid
                AND cgl.is_deleted = 0
             WHERE m.school_year_id = :sy
               AND m.is_primary = 1
               AND m.is_deleted = 0
               AND (cgl.cgl_id IS NOT NULL OR NOT EXISTS (
                   SELECT 1 FROM curriculum_grade_levels any_cgl
                   WHERE any_cgl.curriculum_id = c.curriculum_id AND any_cgl.is_deleted = 0
               ))
             ORDER BY m.is_primary DESC, c.is_active DESC, c.effective_from DESC, c.curriculum_id DESC
             LIMIT 1'
        );
        $stmt->bindValue(':gid', $gradeLevelId, PDO::PARAM_INT);
        $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        $mapped = (int)($stmt->fetchColumn() ?: 0);
        if ($mapped > 0) return $mapped;
        return 0;
    }
    if ($schoolYearId > 0) {
        return 0;
    }
    if ($gradeLevelId > 0) {
        $stmt = $conn->prepare(
            'SELECT c.curriculum_id
             FROM curricula c
             JOIN curriculum_subjects cs ON cs.curriculum_id = c.curriculum_id
                AND cs.grade_level_id = :gid
                AND cs.is_deleted = 0
             WHERE c.is_deleted = 0
             ORDER BY c.is_active DESC, c.effective_from DESC, c.curriculum_id DESC
             LIMIT 1'
        );
        $stmt->bindValue(':gid', $gradeLevelId, PDO::PARAM_INT);
        $stmt->execute();
        return (int)($stmt->fetchColumn() ?: 0);
    }
    return 0;
}

function sf10_fetch_assigned_subjects(PDO $conn, int $sectionId, int $schoolYearId, int $gradeLevelId, int $curriculumId): array {
    $subjectCodeSelect = sf10_column_exists($conn, 'subjects', 'subject_code')
        ? 's.subject_code'
        : 'NULL AS subject_code';
    $resolvedCurriculumId = sf10_resolve_curriculum_id($conn, $curriculumId, $schoolYearId, $gradeLevelId);
    if ($resolvedCurriculumId <= 0 && ($sectionId <= 0 || $schoolYearId <= 0)) return [];

    $curriculumRows = [];
    $curriculumSubjectIds = [];
    $curriculumMetaBySubject = [];
    $curriculumMetaByKey = [];

    if ($resolvedCurriculumId > 0 && $gradeLevelId > 0) {
        $stmt = $conn->prepare(
            "SELECT s.subject_id, {$subjectCodeSelect}, s.subject_name,
                    COALESCE(cs.sort_order, 9999) AS sort_order
             FROM curriculum_subjects cs
             JOIN subjects s ON s.subject_id = cs.subject_id
             WHERE cs.curriculum_id = :cid
               AND cs.grade_level_id = :gid
               AND cs.is_deleted = 0
               AND s.is_deleted = 0
             ORDER BY COALESCE(cs.sort_order, 9999), s.subject_name"
        );
        $stmt->bindValue(':cid', $resolvedCurriculumId, PDO::PARAM_INT);
        $stmt->bindValue(':gid', $gradeLevelId, PDO::PARAM_INT);
        $stmt->execute();
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $subjectId = (int)($row['subject_id'] ?? 0);
            if ($subjectId <= 0) continue;
            $curriculumSubjectIds[$subjectId] = true;
            $curriculumMetaBySubject[$subjectId] = $row;
            $curriculumMetaByKey[sf10_subject_key($row['subject_code'] ?? null, $row['subject_name'] ?? null)] = $row;
            $curriculumRows[] = $row;
        }
    }

    $offeringRows = [];
    if ($sectionId > 0 && $schoolYearId > 0) {
        $stmt = $conn->prepare(
            "SELECT co.class_id, s.subject_id, {$subjectCodeSelect}, s.subject_name
             FROM class_offerings co
             JOIN subjects s ON s.subject_id = co.subject_id
             WHERE co.section_id = :sid
               AND co.school_year_id = :sy
               AND co.is_deleted = 0
               AND s.is_deleted = 0
             ORDER BY s.subject_name, co.class_id ASC"
        );
        $stmt->bindValue(':sid', $sectionId, PDO::PARAM_INT);
        $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();

        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $subjectId = (int)($row['subject_id'] ?? 0);
            $subjectKey = sf10_subject_key($row['subject_code'] ?? null, $row['subject_name'] ?? null);
            if ($curriculumSubjectIds
                && $subjectId > 0
                && !isset($curriculumSubjectIds[$subjectId])
                && !isset($curriculumMetaByKey[$subjectKey])) {
                continue;
            }
            $meta = $subjectId > 0 && isset($curriculumMetaBySubject[$subjectId])
                ? $curriculumMetaBySubject[$subjectId]
                : ($curriculumMetaByKey[$subjectKey] ?? null);
            $row['sort_order'] = $meta['sort_order'] ?? 9999;
            $offeringRows[] = $row;
        }
    }

    $subjects = [];
    $offeringsBySubjectId = [];
    $offeringsByKey = [];
    foreach ($offeringRows as $row) {
        $subjectId = (int)($row['subject_id'] ?? 0);
        $subjectKey = sf10_subject_key($row['subject_code'] ?? null, $row['subject_name'] ?? null);
        if ($subjectId > 0) $offeringsBySubjectId[$subjectId][] = $row;
        if ($subjectKey !== 'NAME:') $offeringsByKey[$subjectKey][] = $row;
    }

    if ($curriculumRows) {
        // Curriculum rows are authoritative for the live SF10 template.
        // Offerings only provide class IDs from which grades are read; a
        // missing offering still receives a blank curriculum row.
        foreach ($curriculumRows as $curriculumRow) {
            $subjectId = (int)($curriculumRow['subject_id'] ?? 0);
            $subjectKey = sf10_subject_key($curriculumRow['subject_code'] ?? null, $curriculumRow['subject_name'] ?? null);
            $candidates = $subjectId > 0
                ? ($offeringsBySubjectId[$subjectId] ?? [])
                : ($offeringsByKey[$subjectKey] ?? []);

            if (!$candidates) {
                $curriculumRow['class_id'] = 0;
                $curriculumRow['_candidate_class_ids'] = [];
                $subjects[] = $curriculumRow;
                continue;
            }

            usort($candidates, static fn(array $a, array $b): int => (int)($b['class_id'] ?? 0) <=> (int)($a['class_id'] ?? 0));
            $best = array_merge($curriculumRow, $candidates[0]);
            $best['subject_name'] = $curriculumRow['subject_name'];
            $best['subject_code'] = $curriculumRow['subject_code'] ?? ($candidates[0]['subject_code'] ?? null);
            $best['sort_order'] = $curriculumRow['sort_order'] ?? 9999;
            $best['_candidate_class_ids'] = array_values(array_filter(array_map(
                static fn(array $row) => (int)($row['class_id'] ?? 0),
                $candidates
            ), static fn(int $id) => $id > 0));
            $subjects[] = $best;
        }
    } else {
        // Legacy enrollments without curriculum rows continue to use their
        // section offerings so older records remain readable.
        $bucketed = [];
        foreach ($offeringRows as $row) {
            $subjectKey = sf10_subject_key($row['subject_code'] ?? null, $row['subject_name'] ?? null);
            $bucketed[$subjectKey][] = $row;
        }
        foreach ($bucketed as $candidates) {
            usort($candidates, static fn(array $a, array $b): int => (int)($b['class_id'] ?? 0) <=> (int)($a['class_id'] ?? 0));
            $best = $candidates[0];
            $best['_candidate_class_ids'] = array_values(array_filter(array_map(
                static fn(array $row) => (int)($row['class_id'] ?? 0),
                $candidates
            ), static fn(int $id) => $id > 0));
            $subjects[] = $best;
        }
    }

    usort($subjects, static function (array $a, array $b): int {
        $orderA = (int)($a['sort_order'] ?? 9999);
        $orderB = (int)($b['sort_order'] ?? 9999);
        if ($orderA !== $orderB) return $orderA <=> $orderB;
        return strcmp((string)($a['subject_name'] ?? ''), (string)($b['subject_name'] ?? ''));
    });

    return $subjects;
}

function sf10_fetch_record_grades(PDO $conn, int $enrollmentId, int $schoolYearId, int $sectionId = 0, int $gradeLevelId = 0, int $curriculumId = 0): array {
    $periodMap = sf10_periods_for_school_year($conn, $schoolYearId);
    $subjectCodeSelect = sf10_column_exists($conn, 'subjects', 'subject_code')
        ? 's.subject_code'
        : 'NULL AS subject_code';
    $rows = [];
    $assignedSubjectKeys = [];
    $assignedClassIds = [];

    // The current curriculum/class-offering set is authoritative. Historical
    // grade rows may still exist after a subject is removed or replaced, but
    // they must not recreate that old subject in the live SF10 template.
    foreach (sf10_fetch_assigned_subjects($conn, $sectionId, $schoolYearId, $gradeLevelId, $curriculumId) as $subject) {
        $subjectName = trim((string)($subject['subject_name'] ?? ''));
        if ($subjectName === '') continue;
        $key = sf10_subject_key($subject['subject_code'] ?? null, $subjectName);
        $assignedSubjectKeys[$key] = true;
        $assignedClassId = (int)($subject['class_id'] ?? 0);
        if ($assignedClassId > 0) $assignedClassIds[$assignedClassId] = true;
        foreach (($subject['_candidate_class_ids'] ?? []) as $candidateClassId) {
            $candidateClassId = (int)$candidateClassId;
            if ($candidateClassId > 0) $assignedClassIds[$candidateClassId] = true;
        }
        $rows[$key] = ['subject' => $subjectName, 'q1' => null, 'q2' => null, 'q3' => null, 'q4' => null, 'final_rating' => null, 'remarks' => '', '_sort_order' => (int)($subject['sort_order'] ?? 9999)];
    }

    if ($periodMap) {
        $stmt = $conn->prepare(
            "SELECT co.class_id,
                    s.subject_name,
                    {$subjectCodeSelect},
                    g.grading_period_id,
                    g.quarterly_grade
             FROM grades g
             JOIN class_offerings co ON co.class_id = g.class_id
             JOIN subjects s ON s.subject_id = co.subject_id
             JOIN (
                 SELECT enrollment_id, class_id, grading_period_id, MAX(grade_id) AS latest_grade_id
                 FROM grades
                 WHERE enrollment_id = :enrollment_id
                   AND is_deleted = 0
                 GROUP BY enrollment_id, class_id, grading_period_id
             ) latest ON latest.latest_grade_id = g.grade_id
             WHERE g.enrollment_id = :enrollment_id_outer
               AND g.is_deleted = 0
             ORDER BY s.subject_name ASC, co.class_id ASC"
        );
        $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
        $stmt->bindValue(':enrollment_id_outer', $enrollmentId, PDO::PARAM_INT);
        $stmt->execute();
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $subject = trim((string)($row['subject_name'] ?? ''));
            if ($subject === '') continue;
            $key = sf10_subject_key($row['subject_code'] ?? null, $subject);
            $classId = (int)($row['class_id'] ?? 0);
            if (!$assignedSubjectKeys || !isset($assignedSubjectKeys[$key]) || ($assignedClassIds && !isset($assignedClassIds[$classId]))) continue;
            $periodNo = $periodMap[(int)$row['grading_period_id']] ?? 0;
            if ($periodNo > 0 && $periodNo <= 4) {
                $rows[$key]['q' . $periodNo] = $row['quarterly_grade'] !== null ? (float)$row['quarterly_grade'] : null;
            }
        }
    }

    $finalStmt = $conn->prepare(
        "SELECT co.class_id, s.subject_name, {$subjectCodeSelect}, fg.final_grade, fg.remark
         FROM final_grades fg
         JOIN class_offerings co ON co.class_id = fg.class_id
         JOIN subjects s ON s.subject_id = co.subject_id
         JOIN (
             SELECT enrollment_id, class_id, MAX(final_grade_id) AS latest_final_grade_id
             FROM final_grades
             WHERE enrollment_id = :enrollment_id
               AND is_deleted = 0
             GROUP BY enrollment_id, class_id
         ) latest ON latest.latest_final_grade_id = fg.final_grade_id
         WHERE fg.enrollment_id = :enrollment_id_outer
           AND fg.is_deleted = 0
         ORDER BY s.subject_name ASC, co.class_id ASC"
    );
    $finalStmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
    $finalStmt->bindValue(':enrollment_id_outer', $enrollmentId, PDO::PARAM_INT);
    $finalStmt->execute();
    foreach ($finalStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $subject = trim((string)($row['subject_name'] ?? ''));
        if ($subject === '') continue;
        $key = sf10_subject_key($row['subject_code'] ?? null, $subject);
        $classId = (int)($row['class_id'] ?? 0);
        if (!$assignedSubjectKeys || !isset($assignedSubjectKeys[$key]) || ($assignedClassIds && !isset($assignedClassIds[$classId]))) continue;
        $rows[$key]['final_rating'] = $row['final_grade'] !== null ? (float)$row['final_grade'] : null;
        $rows[$key]['remarks'] = (string)($row['remark'] ?? '');
    }

    foreach ($rows as &$row) {
        if ($row['final_rating'] === null) {
            $vals = array_values(array_filter([$row['q1'], $row['q2'], $row['q3'], $row['q4']], fn($v) => $v !== null));
            if ($vals) {
                $row['final_rating'] = round(array_sum($vals) / count($vals), 2);
                $row['remarks'] = $row['final_rating'] >= 75 ? 'Passed' : 'Failed';
            }
        }
    }
    unset($row);

    $out = array_values($rows);
    usort($out, static function (array $a, array $b): int {
        $orderA = (int)($a['_sort_order'] ?? 9999);
        $orderB = (int)($b['_sort_order'] ?? 9999);
        if ($orderA !== $orderB) return $orderA <=> $orderB;
        return strcmp((string)($a['subject'] ?? ''), (string)($b['subject'] ?? ''));
    });
    return array_map(static function (array $row): array {
        unset($row['_sort_order']);
        return $row;
    }, $out);
}

function sf10_get_sections(PDO $conn, array $session): void {
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    $roleKey = strtolower((string)($session['role_key'] ?? ''));
    $isTeacher = $roleKey === 'teacher';
    $employeeId = $isTeacher ? sf10_get_employee_id($conn, (int)($session['user_id'] ?? 0)) : 0;

    $sql = "SELECT s.section_id, s.section_name, s.school_year_id, s.grade_level_id,
                   gl.grade_name, sy.year_label, sy.is_active
            FROM sections s
            JOIN school_years sy ON sy.school_year_id = s.school_year_id AND sy.is_deleted = 0
            LEFT JOIN grade_levels gl ON gl.grade_level_id = s.grade_level_id
            WHERE s.is_deleted = 0";
    if ($schoolYearId > 0) $sql .= ' AND s.school_year_id = :school_year_id';
    if ($isTeacher) {
        $sql .= " AND EXISTS (
                    SELECT 1 FROM class_offerings co
                    WHERE co.section_id = s.section_id
                      AND co.school_year_id = s.school_year_id
                      AND co.teacher_id = :teacher_id
                      AND co.is_deleted = 0
                  )";
    }
    $sql .= ' ORDER BY sy.year_start DESC, sy.school_year_id DESC, gl.grade_name ASC, s.section_name ASC';

    $stmt = $conn->prepare($sql);
    if ($schoolYearId > 0) $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    if ($isTeacher) {
        $stmt->bindValue(':teacher_id', $employeeId, PDO::PARAM_INT);
    }
    $stmt->execute();
    respond(['success' => true, 'data' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
}

function sf10_get_roster(PDO $conn, array $session): void {
    $sectionId = (int)($_GET['section_id'] ?? 0);
    $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
    if ($sectionId <= 0) respond(['success' => false, 'message' => 'section_id is required'], 422);

    if ($schoolYearId <= 0) {
        $stmt = $conn->prepare('SELECT school_year_id FROM sections WHERE section_id = :section_id AND is_deleted = 0 LIMIT 1');
        $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
        $stmt->execute();
        $schoolYearId = (int)($stmt->fetchColumn() ?: 0);
    }
    sf10_ensure_section_access($conn, $session, $sectionId, $schoolYearId);

    $stmt = $conn->prepare(
        "SELECT e.enrollment_id, e.learner_id, l.lrn,
                CONCAT(l.last_name, ', ', l.first_name,
                    CASE WHEN l.middle_name IS NULL OR l.middle_name = '' THEN '' ELSE CONCAT(' ', l.middle_name) END,
                    CASE WHEN l.name_extension IS NULL OR l.name_extension = '' THEN '' ELSE CONCAT(' ', l.name_extension) END
                ) AS learner_name,
                l.gender,
                gl.grade_name,
                sec.section_name,
                sy.year_label
         FROM enrollments e
         JOIN learners l ON l.learner_id = e.learner_id AND l.is_deleted = 0
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         LEFT JOIN sections sec ON sec.section_id = e.section_id
         LEFT JOIN school_years sy ON sy.school_year_id = e.school_year_id
         WHERE e.is_deleted = 0
           AND e.section_id = :section_id
           AND e.school_year_id = :school_year_id
         ORDER BY l.last_name ASC, l.first_name ASC"
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    respond(['success' => true, 'data' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
}

function sf10_record_sort_key(array $record): array {
    $schoolYearStart = array_key_exists('_layout_year_start', $record)
        ? (int)$record['_layout_year_start']
        : sf10_history_year_start((string)($record['school_year'] ?? ''));
    $gradeNumber = (int)($record['grade_number'] ?? sf10_grade_number($record['grade_level'] ?? null));
    $sourceOrder = (($record['source_type'] ?? '') === 'previous_school') ? 0 : 1;
    return [$schoolYearStart, $gradeNumber, $sourceOrder, (int)($record['history_id'] ?? $record['enrollment_id'] ?? 0)];
}

function sf10_sort_records(array &$records): void {
    usort($records, static function (array $a, array $b): int {
        $left = sf10_record_sort_key($a);
        $right = sf10_record_sort_key($b);
        foreach ($left as $index => $value) {
            if ($value === $right[$index]) continue;
            if (is_string($value) || is_string($right[$index])) return strcmp((string)$value, (string)$right[$index]);
            return $value <=> $right[$index];
        }
        return 0;
    });
}

function sf10_get_data(PDO $conn, array $session): void {
    $learnerId = (int)($_GET['learner_id'] ?? 0);
    $enrollmentId = (int)($_GET['enrollment_id'] ?? 0);
    if ($learnerId <= 0 && $enrollmentId > 0) {
        $stmt = $conn->prepare('SELECT learner_id FROM enrollments WHERE enrollment_id = :enrollment_id AND is_deleted = 0 LIMIT 1');
        $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
        $stmt->execute();
        $learnerId = (int)($stmt->fetchColumn() ?: 0);
    }
    if ($learnerId <= 0) respond(['success' => false, 'message' => 'learner_id or enrollment_id is required'], 422);
    sf10_ensure_learner_access($conn, $session, $learnerId);

    $birthProvinceSelect = sf10_column_exists($conn, 'learners', 'birth_province_text')
        ? "NULLIF(TRIM(l.birth_province_text), '') AS birth_province"
        : 'NULL AS birth_province';
    $birthCitySelect = 'NULL AS birth_city';
    $learnerStmt = $conn->prepare(
        "SELECT l.*, {$birthProvinceSelect}, {$birthCitySelect}
         FROM learners l
         WHERE l.learner_id = :learner_id AND l.is_deleted = 0
         LIMIT 1"
    );
    $learnerStmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $learnerStmt->execute();
    $learner = $learnerStmt->fetch(PDO::FETCH_ASSOC);
    if (!$learner) respond(['success' => false, 'message' => 'Learner not found'], 404);

    $settings = sf10_get_school_settings($conn);
    $school = [
        'school_id' => $settings['school_id'] ?? ($settings['schoolId'] ?? ''),
        'school_name' => $settings['school_name'] ?? ($settings['schoolName'] ?? ''),
        'region' => $settings['region'] ?? ($settings['school_region'] ?? ''),
        'division' => $settings['division'] ?? ($settings['school_division'] ?? ''),
        'district' => $settings['district'] ?? ($settings['school_district'] ?? ''),
        'school_head' => $settings['school_head'] ?? ($settings['principal_name'] ?? ''),
    ];

    $enrollmentStmt = $conn->prepare(
        "SELECT e.enrollment_id, e.school_year_id, e.grade_level_id, e.section_id,
                e.enrollment_status, e.curriculum_id,
                gl.grade_name,
                sec.section_name,
                sec.adviser_id,
                sy.year_label, sy.year_start, sy.year_end,
                sy.grading_system_type,
                ga.general_average,
                emp.first_name AS adviser_first,
                emp.middle_name AS adviser_middle,
                emp.last_name AS adviser_last,
                emp.name_extension AS adviser_ext
         FROM enrollments e
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         LEFT JOIN sections sec ON sec.section_id = e.section_id
         LEFT JOIN school_years sy ON sy.school_year_id = e.school_year_id
         LEFT JOIN general_averages ga ON ga.enrollment_id = e.enrollment_id AND ga.is_deleted = 0
         LEFT JOIN employees emp ON emp.employee_id = sec.adviser_id AND emp.is_deleted = 0
         WHERE e.learner_id = :learner_id
           AND e.is_deleted = 0
         ORDER BY sy.year_start ASC, sy.school_year_id ASC, e.enrollment_id ASC"
    );
    $enrollmentStmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $enrollmentStmt->execute();

    $enrollmentRows = $enrollmentStmt->fetchAll(PDO::FETCH_ASSOC);
    $selectedEnrollment = null;
    foreach ($enrollmentRows as $row) {
        if ($enrollmentId > 0 && (int)$row['enrollment_id'] === $enrollmentId) {
            $selectedEnrollment = $row;
            break;
        }
    }
    if (!$selectedEnrollment && $enrollmentRows) {
        $selectedEnrollment = $enrollmentRows[count($enrollmentRows) - 1];
    }
    $historyRecords = sf10_fetch_academic_history($conn, $learnerId);
    $previewOverrides = sf10_fetch_preview_overrides($conn, $learnerId);
    $selectedGradeNumber = sf10_grade_number($selectedEnrollment['grade_name'] ?? null);
    if ($selectedGradeNumber <= 0 && $historyRecords) {
        $selectedGradeNumber = max(array_map(static fn(array $record): int => (int)($record['grade_number'] ?? 0), $historyRecords));
    }
    $form = sf10_form_for_grade($selectedGradeNumber);

    $records = [];
    foreach ($enrollmentRows as $row) {
        $gradeNumber = sf10_grade_number($row['grade_name'] ?? null);
        if ($gradeNumber < (int)$form['grade_min'] || $gradeNumber > (int)$form['grade_max']) {
            continue;
        }
        $eid = (int)$row['enrollment_id'];
        $policy = sf10_resolve_record_policy(
            $conn,
            (int)$row['school_year_id'],
            $row['year_label'] ?? null,
            (int)($row['grade_level_id'] ?? 0),
            $row['grade_name'] ?? null
        );
        $isDescriptive = $policy['grading_mode'] === 'Descriptive';
        $records[] = [
            'enrollment_id' => $eid,
            'school_year_id' => (int)$row['school_year_id'],
            'grade_level_id' => (int)($row['grade_level_id'] ?? 0),
            'school_year' => $row['year_label'],
            'grade_level' => $row['grade_name'],
            'grade_number' => $gradeNumber,
            'section' => $row['section_name'],
            'school' => $school,
            'adviser' => sf10_format_name($row['adviser_first'] ?? null, $row['adviser_middle'] ?? null, $row['adviser_last'] ?? null, $row['adviser_ext'] ?? null),
            'status' => $row['enrollment_status'],
            'source_type' => 'current_school',
            'source_label' => 'Current school enrollment',
            'general_average' => $isDescriptive || $row['general_average'] === null
                ? null
                : (float)$row['general_average'],
            'grading_mode' => $policy['grading_mode'],
            'grading_system_type' => sf10_history_grading_system($row['grading_system_type'] ?? null) ?? 'Quarterly',
            'sf9_template_variant' => $policy['sf9_template_variant'],
            'is_descriptive_gap' => $isDescriptive,
            'grades' => $isDescriptive ? [] : sf10_fetch_record_grades(
                $conn,
                $eid,
                (int)$row['school_year_id'],
                (int)($row['section_id'] ?? 0),
                (int)($row['grade_level_id'] ?? 0),
                (int)($row['curriculum_id'] ?? 0)
            ),
        ];
    }

    foreach ($historyRecords as $historyRecord) {
        $gradeNumber = (int)($historyRecord['grade_number'] ?? 0);
        if ($gradeNumber < (int)$form['grade_min'] || $gradeNumber > (int)$form['grade_max']) continue;
        $policy = sf10_resolve_record_policy(
            $conn,
            0,
            $historyRecord['school_year'] ?? null,
            (int)($historyRecord['grade_level_id'] ?? 0),
            $historyRecord['grade_level'] ?? null
        );
        // Work on a display copy. academic_history below intentionally keeps
        // the original supplied values available to the transfer-in editor.
        $printHistoryRecord = $historyRecord;
        $hasHistoricalGradeData = sf10_history_has_grade_data((array)($historyRecord['grades'] ?? []));
        $isHistoricalDescriptiveGap = $policy['grading_mode'] === 'Descriptive' && !$hasHistoricalGradeData;
        $printHistoryRecord['source_type'] = 'previous_school';
        $printHistoryRecord['source_label'] = 'Previous school record';
        $printHistoryRecord['grading_mode'] = $isHistoricalDescriptiveGap ? 'Descriptive' : 'Numeric';
        $printHistoryRecord['grading_system_type'] = sf10_history_grading_system($historyRecord['grading_system_type'] ?? null) ?? 'Quarterly';
        $printHistoryRecord['sf9_template_variant'] = $policy['sf9_template_variant'];
        $printHistoryRecord['is_descriptive_gap'] = $isHistoricalDescriptiveGap;
        if ($printHistoryRecord['is_descriptive_gap']) {
            $printHistoryRecord['general_average'] = null;
            $printHistoryRecord['grades'] = [];
        }
        $records[] = $printHistoryRecord;
    }
    $records = sf10_add_missing_descriptive_gaps(
        $conn,
        $records,
        $selectedEnrollment,
        $selectedGradeNumber
    );
    sf10_sort_records($records);
    $records = array_map(static function (array $record): array {
        unset($record['_layout_year_start']);
        return $record;
    }, $records);

    $birthPlace = trim(implode(', ', array_filter([
        $learner['birth_city'] ?? null,
        $learner['birth_province'] ?? null,
    ])));
    if ($birthPlace === '') $birthPlace = (string)($learner['birth_place_text'] ?? '');

    respond([
        'success' => true,
        'data' => [
            'learner' => [
                'learner_id' => (int)$learner['learner_id'],
                'lrn' => $learner['lrn'],
                'last_name' => $learner['last_name'],
                'first_name' => $learner['first_name'],
                'middle_name' => $learner['middle_name'],
                'name_extension' => $learner['name_extension'],
                'full_name' => sf10_format_name($learner['first_name'] ?? null, $learner['middle_name'] ?? null, $learner['last_name'] ?? null, $learner['name_extension'] ?? null),
                'date_of_birth' => $learner['date_of_birth'],
                'sex' => $learner['sex'] ?: (($learner['gender'] ?? '') === 'Female' ? 'F' : (($learner['gender'] ?? '') === 'Male' ? 'M' : '')),
                'gender' => $learner['gender'],
                'birth_place' => $birthPlace,
                'mother_tongue' => $learner['mother_tongue'],
            ],
            'school' => $school,
            'form' => $form,
            'records' => $records,
            'academic_history' => $historyRecords,
            'preview_overrides' => $previewOverrides,
            'history_available' => sf10_table_exists($conn, 'learner_academic_history'),
        ],
    ]);
}

$operation = $_GET['operation'] ?? '';
$session = auth_require();
if (($session['role_key'] ?? '') !== 'registrar') {
    auth_abort(403, 'SF10 is available to registrar accounts only.');
}

try {
    switch ($operation) {
        case 'getSections':
            sf10_get_sections($conn, $session);
            break;
        case 'getRoster':
            sf10_get_roster($conn, $session);
            break;
        case 'getSF10Data':
            sf10_get_data($conn, $session);
            break;
        case 'getAcademicHistory':
            sf10_get_academic_history($conn, $session);
            break;
        case 'getHistorySubjectOptions':
            sf10_get_history_subject_options($conn, $session);
            break;
        case 'saveAcademicHistory':
            sf10_save_academic_history($conn, $session);
            break;
        case 'saveSF10Preview':
            sf10_save_preview_overrides($conn, $session);
            break;
        case 'deleteAcademicHistory':
            sf10_delete_academic_history($conn, $session);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (InvalidArgumentException $e) {
    respond(['success' => false, 'message' => $e->getMessage()], 422);
} catch (RuntimeException $e) {
    respond(['success' => false, 'message' => $e->getMessage()], 500);
} catch (Throwable $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}
