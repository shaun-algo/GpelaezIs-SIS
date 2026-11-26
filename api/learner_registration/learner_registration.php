<?php
/**
 * learner_registration.php — COMPLETE REWRITE (staging + dry-run import flow)
 *
 * Import pipeline (new):
 *   startLisImport        POST  file-level assertions (School ID / SY) → import_id
 *   stageLisImportRows    POST  raw rows (batched) → sf1_import_staging
 *   validateLisImport     POST  whole-file validation: normalize, resolve, plan, capacity forecast
 *   getLisImportPreview   GET   dry-run report (summary + per-row statuses)
 *   excludeLisImportRows  POST  user removes rows from the plan
 *   commitLisImport       POST  execute plan in per-row transactions (chunked)
 *   finalizeLisImport     POST  safety finalizer (commit auto-finalizes when done)
 *
 * CRUD (kept, repaired):
 *   getAllRegistrations / getRegistrationList / getRegistrationById
 *   createRegistration / updateRegistration / deleteRegistration
 *
 * Requires: 02_learner_input_migration.sql, add_returnee_import_workflow.sql,
 * add_transfer_in_import_support.sql, add_lis_status_import_handling.sql
 * applied (sf1_import_staging and enrollment entry classification,
 * grade_level_aliases, sf1_remark_map,
 * family_members.is_guardian, sync/guard triggers).
 *
 * Removed: all legacy_* dead code, parseLISFullName, normalizeLISDate,
 * normalizeLISSex, determineEnrollmentTypeFromRemarks, duplicate section pickers,
 * inline CORS wildcard headers (utils/cors.php is the single authority).
 */

header('Content-Type: application/json');
require_once __DIR__ . '/../utils/cors.php';

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/password_policy.php';
require_once __DIR__ . '/../utils/account_credentials.php';
require_once __DIR__ . '/../utils/import_age.php';
require_once __DIR__ . '/../services/EnrollmentLifecycleService.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';
require_once __DIR__ . '/../services/DescriptiveProgressionService.php';
require_once __DIR__ . '/../services/ReturneeCaseService.php';
require_once __DIR__ . '/../services/EnrollmentEntryClassificationService.php';
require_once __DIR__ . '/../utils/name_extension_errors.php';
require_once __DIR__ . '/../utils/family_member_name.php';

/* ============================== core plumbing ============================== */

function isArrayList(array $a): bool {
    return $a === [] || array_keys($a) === range(0, count($a) - 1);
}

function respond($payload, int $code = 200): void {
    http_response_code($code);
    if (is_array($payload) && !isset($payload['operation']) && !isArrayList($payload)) {
        $payload['operation'] = $_GET['operation'] ?? '';
    }
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    if (($raw === false || $raw === '') && PHP_SAPI === 'cli') {
        $raw = file_get_contents('php://stdin');
    }
    $data = $raw ? (json_decode($raw, true) ?: []) : [];
    return is_array($data) ? $data : [];
}

function nullIfEmpty($value) {
    if ($value === null) return null;
    if (is_string($value)) {
        $t = trim($value);
        return $t === '' ? null : $t;
    }
    return $value;
}

function intOrNull($value): ?int {
    if ($value === null || $value === '') return null;
    $n = (int)$value;
    return $n > 0 ? $n : null;
}

function bindNullable(PDOStatement $stmt, string $param, $value, int $type = PDO::PARAM_STR): void {
    if ($value === null) {
        $stmt->bindValue($param, null, PDO::PARAM_NULL);
        return;
    }
    $stmt->bindValue($param, $value, $type);
}

function mbLen(string $value): int {
    return function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
}

function tableExists(PDO $conn, string $tableName): bool {
    static $cache = [];
    if (isset($cache[$tableName])) return $cache[$tableName];
    $stmt = $conn->prepare('SELECT 1 FROM information_schema.tables
                            WHERE table_schema = DATABASE() AND table_name = :t LIMIT 1');
    $stmt->bindValue(':t', $tableName);
    $stmt->execute();
    return $cache[$tableName] = (bool)$stmt->fetchColumn();
}

function columnExists(PDO $conn, string $tableName, string $columnName): bool {
    static $cache = [];
    $key = $tableName . '.' . $columnName;
    if (isset($cache[$key])) return $cache[$key];
    $stmt = $conn->prepare('SELECT 1 FROM information_schema.columns
                            WHERE table_schema = DATABASE()
                              AND table_name = :t
                              AND column_name = :c
                            LIMIT 1');
    $stmt->bindValue(':t', $tableName);
    $stmt->bindValue(':c', $columnName);
    $stmt->execute();
    return $cache[$key] = (bool)$stmt->fetchColumn();
}

function normalizeGuardianRelationshipCategory(?string $raw, ?string $guardianName = null,
                                               ?string $fatherName = null, ?string $motherName = null): string {
    $value = nullIfEmpty($raw);
    $name = mb_strtolower(trim((string)($guardianName ?? '')));
    $father = mb_strtolower(trim((string)($fatherName ?? '')));
    $mother = mb_strtolower(trim((string)($motherName ?? '')));

    if ($value === null) {
        if ($name !== '' && ($name === $father || $name === $mother)) return 'Parent';
        return 'Relative';
    }

    $norm = mb_strtolower((string)$value);
    $norm = preg_replace('/[^a-z0-9]+/u', ' ', $norm);
    $norm = trim(preg_replace('/\s+/u', ' ', $norm));

    if (in_array($norm, ['parent', 'father', 'mother', 'nanay', 'tatay', 'mama', 'papa'], true)) {
        return 'Parent';
    }

    $relativeTerms = [
        'relative', 'grandparent', 'grandfather', 'grandmother', 'lolo', 'lola',
        'aunt', 'auntie', 'uncle', 'tita', 'tito', 'sibling', 'brother', 'sister',
        'cousin', 'niece', 'nephew'
    ];
    if (in_array($norm, $relativeTerms, true)) return 'Relative';

    $nonRelativeTerms = [
        'non relative', 'nonrelative', 'not relative', 'legal guardian', 'guardian',
        'friend', 'neighbor', 'neighbour', 'foster parent', 'institution', 'caregiver'
    ];
    if (in_array($norm, $nonRelativeTerms, true)) return 'Non-Relative';

    if (str_contains($norm, 'parent')) return 'Parent';
    if (str_contains($norm, 'relative')) return str_contains($norm, 'non') ? 'Non-Relative' : 'Relative';
    return 'Relative';
}

function requireImportTables(PDO $conn): void {
    foreach (['import_logs', 'import_log_rows', 'import_templates', 'schools', 'sf1_import_staging',
              'grade_level_aliases', 'sf1_remark_map'] as $t) {
        if (!tableExists($conn, $t)) {
            respond(['success' => false,
                     'message' => "Required table `$t` is missing. Apply 02_learner_input_migration.sql first."], 501);
        }
    }
    foreach ([['learners', 'is_lwd'], ['sf1_import_staging', 'detected_lwd']] as [$table, $column]) {
        if (!columnExists($conn, $table, $column)) {
            respond(['success' => false,
                     'message' => "Required column `$table.$column` is missing. Apply add_lis_status_import_handling.sql first."], 501);
        }
    }
}

/**
 * Resolve an imported suffix against the active Name Extensions masterfile.
 * The import parser already canonicalizes common forms such as JR and SR;
 * this final lookup prevents an unseeded suffix from reaching the FK during
 * commit and gives the registrar a row-level correction message instead.
 */
function validateImportNameExtension(PDO $conn, ?string $value): array {
    $extension = nullIfEmpty($value);
    if ($extension === null || !tableExists($conn, 'name_extensions')) {
        return ['valid' => true, 'value' => $extension, 'message' => null];
    }

    $stmt = $conn->prepare('SELECT extension_name
                            FROM name_extensions
                            WHERE extension_name = :extension_name
                              AND is_deleted = 0
                            LIMIT 1');
    $stmt->bindValue(':extension_name', $extension);
    $stmt->execute();
    $approved = $stmt->fetchColumn();
    if ($approved !== false) {
        return ['valid' => true, 'value' => (string)$approved, 'message' => null];
    }

    return [
        'valid' => false,
        'value' => $extension,
        'message' => 'Name extension "' . $extension . '" is not available in the Name Extensions masterfile. Select an approved suffix or leave it blank.',
    ];
}

/* ============================== lookups =================================== */

function getActiveSchool(PDO $conn): ?array {
    if (!tableExists($conn, 'schools')) return null;
    $configuredName = getConfiguredSchoolName($conn);
    if ($configuredName !== null) {
        $stmt = $conn->query('SELECT school_id, deped_school_id, school_name FROM schools
                              WHERE is_active = 1 ORDER BY school_id');
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (normalizeImportSchoolName((string)$row['school_name']) === normalizeImportSchoolName($configuredName)) {
                return $row;
            }
        }

        return [
            'school_id' => null,
            'deped_school_id' => null,
            'school_name' => $configuredName,
        ];
    }

    $stmt = $conn->query('SELECT school_id, deped_school_id, school_name FROM schools
                          WHERE is_active = 1 ORDER BY school_id LIMIT 1');
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function getConfiguredSchoolName(PDO $conn): ?string {
    if (!tableExists($conn, 'school_settings')) return null;
    $stmt = $conn->prepare("SELECT setting_value
                            FROM school_settings
                            WHERE setting_key = 'school_name'
                              AND is_deleted = 0
                              AND setting_value IS NOT NULL
                              AND TRIM(setting_value) <> ''
                            LIMIT 1");
    $stmt->execute();
    $name = nullIfEmpty($stmt->fetchColumn() ?: null);
    return $name === null ? null : (string)$name;
}

function getSchoolByDepedId(PDO $conn, string $depedSchoolId): ?array {
    if (!tableExists($conn, 'schools')) return null;
    $clean = preg_replace('/\D+/', '', $depedSchoolId);
    if ($clean === '') return null;
    $stmt = $conn->prepare('SELECT school_id, deped_school_id, school_name FROM schools
                            WHERE deped_school_id = :id LIMIT 1');
    $stmt->bindValue(':id', $clean);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function normalizeImportHeaderLabel(?string $label): string {
    $s = trim((string)($label ?? ''));
    if ($s === '') return '';
    $s = preg_replace('/\s+/', ' ', $s);
    $s = strtolower($s);
    $s = preg_replace('/[^a-z0-9 #\/\(\)\'.-]+/', '', $s);
    return trim((string)$s);
}

function normalizeImportSchoolName(?string $name): string {
    $s = strtolower(trim((string)($name ?? '')));
    $s = preg_replace('/[^a-z0-9]+/', '', $s);
    return trim((string)$s);
}

function normalizeImportSchoolYearLabel(?string $label): string {
    $s = trim((string)($label ?? ''));
    if ($s === '') return '';
    if (preg_match('/(\d{4})\s*[-–—]\s*(\d{4})/', $s, $m)) {
        return $m[1] . '-' . $m[2];
    }
    return normalizeImportHeaderLabel($s);
}

function normalizeImportMatchText(?string $value): string {
    $s = strtolower(trim((string)($value ?? '')));
    $s = preg_replace('/[^a-z0-9]+/', ' ', $s);
    $s = preg_replace('/\s+/', ' ', (string)$s);
    return trim((string)$s);
}

function importGradeWordToNumber(string $word): ?int {
    static $words = [
        'one' => 1, 'first' => 1,
        'two' => 2, 'second' => 2,
        'three' => 3, 'third' => 3,
        'four' => 4, 'fourth' => 4,
        'five' => 5, 'fifth' => 5,
        'six' => 6, 'sixth' => 6,
        'seven' => 7, 'seventh' => 7,
        'eight' => 8, 'eighth' => 8,
        'nine' => 9, 'ninth' => 9,
        'ten' => 10, 'tenth' => 10,
        'eleven' => 11, 'eleventh' => 11,
        'twelve' => 12, 'twelfth' => 12,
    ];
    $key = strtolower(trim($word));
    return $words[$key] ?? null;
}

function importGradeRomanToNumber(string $roman): ?int {
    static $romans = [
        'i' => 1, 'ii' => 2, 'iii' => 3, 'iv' => 4, 'v' => 5, 'vi' => 6,
        'vii' => 7, 'viii' => 8, 'ix' => 9, 'x' => 10, 'xi' => 11, 'xii' => 12,
    ];
    $key = strtolower(trim($roman));
    return $romans[$key] ?? null;
}

function importGradeCandidateLabels(?string $raw): array {
    $wanted = normalizeImportMatchText($raw);
    if ($wanted === '') return [];

    // Kindergarten is outside this installation's enrollment scope. Returning
    // no candidates makes the import validator report the grade as unsupported
    // instead of attempting a lookup against a legacy Kindergarten seed.
    if (preg_match('/kinder|kindergarten|prep|preparatory/', $wanted)) {
        return [];
    }

    $candidates = [$wanted];

    if (preg_match('/\b0*(\d{1,2})\b/', $wanted, $m)) {
        $gradeNumber = (int)$m[1];
        if ($gradeNumber > 0) {
            $candidates[] = (string)$gradeNumber;
            $candidates[] = 'grade ' . $gradeNumber;
            $candidates[] = 'gr ' . $gradeNumber;
            $candidates[] = 'g ' . $gradeNumber;
            $candidates[] = 'year ' . $gradeNumber;
            $candidates[] = 'level ' . $gradeNumber;
        }
    }

    if (preg_match('/\b(one|first|two|second|three|third|four|fourth|five|fifth|six|sixth|seven|seventh|eight|eighth|nine|ninth|ten|tenth|eleven|eleventh|twelve|twelfth)\b/', $wanted, $m)) {
        $gradeNumber = importGradeWordToNumber($m[1]);
        if ($gradeNumber !== null) {
            $candidates[] = (string)$gradeNumber;
            $candidates[] = 'grade ' . $gradeNumber;
        }
    }

    if (preg_match('/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)\b/', $wanted, $m)) {
        $gradeNumber = importGradeRomanToNumber($m[1]);
        if ($gradeNumber !== null) {
            $candidates[] = (string)$gradeNumber;
            $candidates[] = 'grade ' . $gradeNumber;
        }
    }

    return array_values(array_unique(array_filter($candidates, fn ($value) => $value !== '')));
}

function resolveImportTemplateId(PDO $conn, array $headers): ?int {
    if (!tableExists($conn, 'import_templates')) return null;

    $normalizedHeaders = array_values(array_filter(array_map(
        fn ($header) => normalizeImportHeaderLabel(is_scalar($header) ? (string)$header : ''),
        $headers
    ), fn ($value) => $value !== ''));

    if (!$normalizedHeaders) return null;

    $headerHash = hash('sha256', implode("\n", $normalizedHeaders));
    $stmt = $conn->query('SELECT template_id, header_signature, header_hash FROM import_templates
                          WHERE is_active = 1');
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        if (!empty($row['header_hash']) && hash_equals((string)$row['header_hash'], $headerHash)) {
            return (int)$row['template_id'];
        }

        $signature = json_decode((string)($row['header_signature'] ?? ''), true);
        if (!is_array($signature)) continue;

        $normalizedSignature = array_values(array_filter(array_map(
            fn ($header) => normalizeImportHeaderLabel(is_scalar($header) ? (string)$header : ''),
            $signature
        ), fn ($value) => $value !== ''));

        if ($normalizedSignature && $normalizedSignature === $normalizedHeaders) {
            return (int)$row['template_id'];
        }
    }

    return null;
}

function resolveImportSchool(PDO $conn, ?string $fileSchoolId, ?string $fileSchoolName): ?array {
    $activeSchool = getActiveSchool($conn);
    $targetSchool = $activeSchool;

    $fileSchoolId = nullIfEmpty($fileSchoolId);
    if ($fileSchoolId !== null) {
        $matchedSchool = getSchoolByDepedId($conn, $fileSchoolId);
        if ($matchedSchool === null) {
            respond(['success' => false, 'fatal' => 'school_id_unknown',
                     'message' => "File School ID '{$fileSchoolId}' is not registered in the schools table."], 422);
        }
        $targetSchool = $matchedSchool;
        if ($activeSchool !== null
            && $activeSchool['school_id'] !== null
            && (string)$matchedSchool['school_id'] !== (string)$activeSchool['school_id']) {
            respond(['success' => false, 'fatal' => 'school_id_mismatch',
                     'message' => "File School ID '{$fileSchoolId}' does not match this school's active registration."], 422);
        }
    }

    $fileSchoolName = nullIfEmpty($fileSchoolName);
    if ($fileSchoolName !== null && $targetSchool !== null) {
        if (normalizeImportSchoolName($fileSchoolName) !== normalizeImportSchoolName((string)$targetSchool['school_name'])) {
            respond(['success' => false, 'fatal' => 'school_name_mismatch',
                     'message' => "File School Name '{$fileSchoolName}' does not match the configured school '{$targetSchool['school_name']}'."], 422);
        }
    }

    return $targetSchool;
}

function getActiveSchoolYearId(PDO $conn): ?int {
    $stmt = $conn->query('SELECT school_year_id FROM school_years
                          WHERE is_active = 1 AND is_deleted = 0 ORDER BY year_start DESC LIMIT 1');
    $id = $stmt->fetchColumn();
    return $id ? (int)$id : null;
}

function getLearnerRoleId(PDO $conn): int {
    $stmt = $conn->prepare("SELECT role_id FROM roles
                            WHERE role_name IN ('learners','learner') AND is_deleted = 0 LIMIT 1");
    $stmt->execute();
    $rid = $stmt->fetchColumn();
    return $rid ? (int)$rid : 10;
}

function resolveGradeLevelId(PDO $conn, ?string $raw): ?int {
    $raw = nullIfEmpty($raw);
    if ($raw === null) return null;

    $candidates = importGradeCandidateLabels((string)$raw);
    if (!$candidates) return null;

    $stmt = $conn->prepare('SELECT grade_level_id FROM grade_level_aliases
                            WHERE alias = LOWER(TRIM(:a)) OR alias = :normalized
                            LIMIT 1');
    foreach ($candidates as $candidate) {
        $stmt->bindValue(':a', $candidate);
        $stmt->bindValue(':normalized', $candidate);
        $stmt->execute();
        $id = $stmt->fetchColumn();
        if ($id) return (int)$id;
        $stmt->closeCursor();
    }

    $stmt = $conn->query('SELECT grade_level_id, grade_name FROM grade_levels WHERE is_deleted = 0');
    while ($grade = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $gradeCandidates = importGradeCandidateLabels((string)($grade['grade_name'] ?? ''));
        if (array_intersect($candidates, $gradeCandidates)) {
            return (int)$grade['grade_level_id'];
        }
    }

    return null;
}

function mapSf1Remark(PDO $conn, ?string $remark): array {
    $out = ['learner_status' => null, 'enrollment_status' => 'Enrolled',
            'enrollment_type_id' => null, 'recognized' => false,
            'explicit_returnee' => false, 'entry_classification' => null,
            'is_lwd' => false, 'normalized_key' => ''];
    $key = ReturneeCaseService::normalizeRemark($remark);
    $out['normalized_key'] = $key;
    if ($key === '') { $out['recognized'] = true; return $out; }

    // LWD is a BoSY demographic identifier, not an enrollment lifecycle
    // status. It may be supplied alone or alongside a movement remark.
    $out['is_lwd'] = (bool)preg_match(
        '/(?:^|[\s,;|\/])lwd(?:$|[\s,;|\/])|learner with diss?abilit(?:y|ies)/i',
        $key
    );
    $lookupKey = preg_replace('/(?:^|[\s,;|\/])lwd(?:$|[\s,;|\/])\s*/i', ' ', $key);
    $lookupKey = preg_replace('/learner with diss?abilit(?:y|ies)/i', ' ', (string)$lookupKey);
    $lookupKey = trim(preg_replace('/\s+/', ' ', (string)$lookupKey));
    $lookupKey = trim($lookupKey, " ,;|/");
    if ($lookupKey === '') $lookupKey = $key;

    $hasMapClassification = columnExists($conn, 'sf1_remark_map', 'entry_classification');
    $select = 'learner_status, enrollment_status, enrollment_type_name'
        . ($hasMapClassification ? ', entry_classification' : '');
    $stmt = $conn->prepare("SELECT {$select}
                            FROM sf1_remark_map WHERE raw_remark = :k LIMIT 1");
    $stmt->bindValue(':k', $lookupKey);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row && $lookupKey !== $key) {
        $stmt->bindValue(':k', $key);
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
    }
    if (!$row) {
        // Accept common labels even when a deployment has not yet received
        // the optional remark-map seed update.
        $fallbackKey = $lookupKey;
        if (in_array($fallbackKey, ['balik-aral', 'balik aral', 'balik-aral learner',
                                    'balik aral learner', 'ba', 'b/a', 'returnee', 'returnee learner'], true)) {
            $out['learner_status'] = 'Enrolled';
            $out['enrollment_status'] = 'Enrolled';
            $out['enrollment_type_id'] = ReturneeCaseService::balikAralTypeId($conn);
            $out['recognized'] = true;
            $out['explicit_returnee'] = true;
            $out['entry_classification'] = 'Returnee';
        } elseif (in_array($fallbackKey, ['transfer-in', 'transfer in', 'transferred in',
                                          'transferred-in', 't/i', 'ti'], true)) {
            $out['learner_status'] = 'Enrolled';
            $out['enrollment_status'] = 'Enrolled';
            $out['enrollment_type_id'] = getDefaultEnrollmentTypeId($conn, 'Transfer-In');
            $out['recognized'] = true;
            $out['entry_classification'] = 'Transfer-In';
        } elseif (in_array($fallbackKey, ['transferred out', 'transferred-out', 't/o'], true)) {
            $out['learner_status'] = 'Transferred Out';
            $out['enrollment_status'] = 'Transferred Out';
            $out['recognized'] = true;
        } elseif (in_array($fallbackKey, ['dropped out', 'dropped', 'drp'], true)) {
            $out['learner_status'] = 'Dropped';
            $out['enrollment_status'] = 'Dropped';
            $out['recognized'] = true;
        } elseif (EnrollmentEntryClassificationService::isLateEnrollment($fallbackKey)) {
            $out['learner_status'] = 'Enrolled';
            $out['enrollment_status'] = 'Enrolled';
            $out['recognized'] = true;
            $out['entry_classification'] = EnrollmentEntryClassificationService::CLASSIFICATION_LATE_ENROLLMENT;
        } elseif ($out['is_lwd']) {
            $out['learner_status'] = 'Enrolled';
            $out['enrollment_status'] = 'Enrolled';
            $out['recognized'] = true;
        }
        return $out;
    }
    $out['learner_status'] = $row['learner_status'] ?: null;
    $out['enrollment_status'] = $row['enrollment_status'] ?: 'Enrolled';
    $out['recognized'] = true;
    $out['entry_classification'] = EnrollmentEntryClassificationService::normalize(
        $row['entry_classification'] ?? $lookupKey
    );
    if (!empty($row['enrollment_type_name'])) {
        $t = $conn->prepare('SELECT enrollment_type_id FROM enrollment_types
                             WHERE type_name = :n AND is_deleted = 0 LIMIT 1');
        $t->bindValue(':n', $row['enrollment_type_name']);
        $t->execute();
        $out['enrollment_type_id'] = intOrNull($t->fetchColumn() ?: null);
        $out['entry_classification'] = $out['entry_classification']
            ?? EnrollmentEntryClassificationService::fromEnrollmentTypeName($row['enrollment_type_name']);
        $out['explicit_returnee'] = $out['entry_classification'] === 'Returnee';
    }
    $out['explicit_returnee'] = $out['explicit_returnee']
        || in_array($lookupKey, ['balik-aral', 'balik aral', 'ba', 'b/a', 'returnee'], true);
    return $out;
}

function getImportSchoolYearMeta(PDO $conn, int $schoolYearId): ?array {
    $stmt = $conn->prepare('SELECT school_year_id, year_label, year_start FROM school_years WHERE school_year_id = :id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function getImportGradeName(PDO $conn, int $gradeLevelId): string {
    $stmt = $conn->prepare('SELECT grade_name FROM grade_levels WHERE grade_level_id = :id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':id', $gradeLevelId, PDO::PARAM_INT);
    $stmt->execute();
    return (string)($stmt->fetchColumn() ?: "Grade #{$gradeLevelId}");
}

function getImportSectionName(PDO $conn, ?int $sectionId): string {
    if (!$sectionId) return 'No section';
    $stmt = $conn->prepare('SELECT section_name FROM sections WHERE section_id = :id LIMIT 1');
    $stmt->bindValue(':id', $sectionId, PDO::PARAM_INT);
    $stmt->execute();
    return (string)($stmt->fetchColumn() ?: "Section #{$sectionId}");
}

function getImportNextGradeLevelId(PDO $conn, int $gradeLevelId): ?int {
    if (tableExists($conn, 'grade_level_progression')) {
        $stmt = $conn->prepare('SELECT next_grade_level_id FROM grade_level_progression WHERE grade_level_id = :id LIMIT 1');
        $stmt->bindValue(':id', $gradeLevelId, PDO::PARAM_INT);
        $stmt->execute();
        return intOrNull($stmt->fetchColumn() ?: null);
    }
    $stmt = $conn->prepare(
        'SELECT grade_level_id
         FROM grade_levels
         WHERE is_deleted = 0 AND grade_level_id > :id
         ORDER BY grade_level_id
         LIMIT 1'
    );
    $stmt->bindValue(':id', $gradeLevelId, PDO::PARAM_INT);
    $stmt->execute();
    return intOrNull($stmt->fetchColumn() ?: null);
}

function getLatestPriorImportEnrollment(PDO $conn, int $learnerId, int $targetSchoolYearId): ?array {
    $stmt = $conn->prepare(
        'SELECT e.enrollment_id, e.learner_id, e.school_year_id, e.grade_level_id, e.section_id,
                e.curriculum_id, e.enrollment_status, sy.year_label, sy.year_start,
                gl.grade_name, sec.section_name
         FROM enrollments e
         JOIN school_years sy ON sy.school_year_id = e.school_year_id
         JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         LEFT JOIN sections sec ON sec.section_id = e.section_id
         WHERE e.learner_id = :learner_id
           AND e.school_year_id <> :target_sy
           AND sy.year_start < (SELECT year_start FROM school_years WHERE school_year_id = :target_sy2 LIMIT 1)
           AND e.is_deleted = 0
         ORDER BY sy.year_start DESC, e.enrollment_id DESC
         LIMIT 1'
    );
    $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $stmt->bindValue(':target_sy', $targetSchoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':target_sy2', $targetSchoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function getImportProgressionForEnrollment(PDO $conn, int $enrollmentId): ?array {
    if (!tableExists($conn, 'learner_progression')) return null;
    $stmt = $conn->prepare(
        'SELECT lp.*, ng.grade_name AS next_grade_name, cg.grade_name AS current_grade_name
         FROM learner_progression lp
         LEFT JOIN grade_levels ng ON ng.grade_level_id = lp.next_grade_level_id
         LEFT JOIN grade_levels cg ON cg.grade_level_id = lp.current_grade_level_id
         WHERE lp.enrollment_id = :enrollment_id
         ORDER BY lp.updated_at DESC, lp.progression_id DESC
         LIMIT 1'
    );
    $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function isImportMapehParentSubject(string $subjectName): bool {
    $name = mb_strtolower($subjectName);
    return !str_contains($name, 'component')
        && (
            trim($name) === 'mapeh'
            || str_contains($name, 'music, arts, physical education and health')
            || str_contains($name, 'music arts physical education and health')
        );
}

function isImportMapehComponentSubject(string $subjectName): bool {
    $name = mb_strtolower($subjectName);
    return str_contains($name, 'mapeh component')
        || preg_match('/\b(music|arts|physical education|health)\s*\(mapeh component\)/i', $subjectName);
}

function getImportFinalGradeEvidence(PDO $conn, array $enrollment): array {
    $enrollmentId = (int)$enrollment['enrollment_id'];
    $schoolYearId = (int)$enrollment['school_year_id'];
    $sectionId = (int)$enrollment['section_id'];

    // Grade 1 descriptive SF9 has no numeric final grades or general average.
    // Use the persisted PACE A-E ratings as its promotion evidence instead of
    // allowing the numeric fallback to incorrectly report missing grades.
    $descriptive = DescriptiveProgressionService::evidenceForEnrollment($conn, $enrollmentId);
    if (!empty($descriptive['is_descriptive'])) {
        $missingTerms = array_values(array_map('intval', $descriptive['missing_terms'] ?? []));
        return [
            'expected_count' => (int)($descriptive['expected_total'] ?? 0),
            'actual_count' => (int)($descriptive['actual_total'] ?? 0),
            'missing_subjects' => array_map(static fn(int $term): string => 'Term ' . $term, $missingTerms),
            'failed_subjects' => [],
            'general_average' => null,
            'is_descriptive' => true,
            'descriptive_complete' => (bool)($descriptive['complete'] ?? false),
            'descriptive_evidence' => $descriptive,
        ];
    }

    $subjects = [];
    $stmt = $conn->prepare(
        'SELECT DISTINCT co.subject_id, s.subject_name
         FROM class_offerings co
         JOIN subjects s ON s.subject_id = co.subject_id AND s.is_deleted = 0
         WHERE co.section_id = :section_id
           AND co.school_year_id = :sy
           AND co.is_deleted = 0
         ORDER BY s.subject_name'
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $subjects[(int)$row['subject_id']] = (string)$row['subject_name'];
    }

    $grades = [];
    $stmt = $conn->prepare(
        'SELECT co.subject_id, s.subject_name, fg.final_grade
         FROM final_grades fg
         JOIN class_offerings co ON co.class_id = fg.class_id
                              AND co.school_year_id = :sy
                              AND co.is_deleted = 0
         JOIN subjects s ON s.subject_id = co.subject_id
         WHERE fg.enrollment_id = :enrollment_id
           AND fg.is_deleted = 0
           AND fg.final_grade IS NOT NULL
         ORDER BY s.subject_name'
    );
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
    $stmt->execute();
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $subjectId = (int)$row['subject_id'];
        $grades[$subjectId] = [
            'subject_name' => (string)$row['subject_name'],
            'final_grade' => (float)$row['final_grade'],
        ];
        if (!isset($subjects[$subjectId])) {
            $subjects[$subjectId] = (string)$row['subject_name'];
        }
    }

    $mapehParentSubjectIds = [];
    $mapehComponentSubjectIds = [];
    foreach ($subjects as $subjectId => $subjectName) {
        if (isImportMapehParentSubject($subjectName)) {
            $mapehParentSubjectIds[] = $subjectId;
        } elseif (isImportMapehComponentSubject($subjectName)) {
            $mapehComponentSubjectIds[] = $subjectId;
        }
    }

    $hasMapehParentGrade = false;
    foreach ($mapehParentSubjectIds as $subjectId) {
        if (isset($grades[$subjectId])) {
            $hasMapehParentGrade = true;
            break;
        }
    }

    $hasMapehComponentGrade = false;
    foreach ($mapehComponentSubjectIds as $subjectId) {
        if (isset($grades[$subjectId])) {
            $hasMapehComponentGrade = true;
            break;
        }
    }

    if ($hasMapehComponentGrade) {
        foreach ($mapehParentSubjectIds as $subjectId) {
            unset($subjects[$subjectId]);
        }
    } elseif ($hasMapehParentGrade) {
        foreach ($mapehComponentSubjectIds as $subjectId) {
            unset($subjects[$subjectId]);
        }
    }

    $missing = [];
    foreach ($subjects as $subjectId => $subjectName) {
        if (!isset($grades[$subjectId])) {
            $missing[] = $subjectName;
        }
    }

    $failed = [];
    foreach ($grades as $grade) {
        if ($grade['final_grade'] < 75.00) {
            $failed[] = $grade['subject_name'] . ' (' . rtrim(rtrim(number_format($grade['final_grade'], 2), '0'), '.') . ')';
        }
    }

    $generalAverage = null;
    if ($grades) {
        $generalAverage = round(array_sum(array_column($grades, 'final_grade')) / count($grades), 2);
    }

    return [
        'expected_count' => count($subjects),
        'actual_count' => count($grades),
        'missing_subjects' => $missing,
        'failed_subjects' => $failed,
        'general_average' => $generalAverage,
    ];
}

/**
 * Academic evidence used as a guarded fallback when the source Remarks field
 * is blank. A same-grade re-entry with incomplete or failing prior records is
 * treated as Returnee evidence; a normal next-grade import remains Promote.
 */
function assessImportAcademicReturnee(PDO $conn, int $learnerId, int $targetSchoolYearId, int $targetGradeLevelId): array {
    $prior = getLatestPriorImportEnrollment($conn, $learnerId, $targetSchoolYearId);
    if (!$prior) {
        return ['checked' => false, 'candidate' => false, 'prior' => null, 'reasons' => []];
    }

    if ((int)$prior['grade_level_id'] !== $targetGradeLevelId) {
        return [
            'checked' => true,
            'candidate' => false,
            'prior' => $prior,
            'reasons' => [],
            'same_grade' => false,
        ];
    }

    $reasons = [];
    $evidence = getImportFinalGradeEvidence($conn, $prior);
    if ($evidence['expected_count'] > 0 && $evidence['missing_subjects']) {
        $reasons[] = 'missing final grades in ' . implode(', ', array_slice($evidence['missing_subjects'], 0, 6))
            . (count($evidence['missing_subjects']) > 6 ? ', and others' : '');
    }
    if ($evidence['failed_subjects']) {
        $reasons[] = 'failing final grades in ' . implode(', ', array_slice($evidence['failed_subjects'], 0, 6))
            . (count($evidence['failed_subjects']) > 6 ? ', and others' : '');
    }
    if ($evidence['general_average'] !== null && $evidence['general_average'] < 75.00) {
        $reasons[] = 'general average is ' . rtrim(rtrim(number_format($evidence['general_average'], 2), '0'), '.') . ', below 75';
    }

    return [
        'checked' => true,
        'candidate' => !empty($reasons),
        'prior' => $prior,
        'reasons' => $reasons,
        'same_grade' => true,
    ];
}

function buildPromotionImportMessages(PDO $conn, int $learnerId, int $targetSchoolYearId, int $targetGradeLevelId, int $targetSectionId): array {
    $messages = [];
    $prior = getLatestPriorImportEnrollment($conn, $learnerId, $targetSchoolYearId);
    if (!$prior) {
        return [
            'blocked' => false,
            'messages' => [[
                'severity' => 'W',
                'field' => 'promotion',
                'message' => 'Existing learner has no earlier enrollment record before this school year; import will create a new school-year enrollment.'
            ]],
        ];
    }

    $targetSy = getImportSchoolYearMeta($conn, $targetSchoolYearId);
    $targetGradeName = getImportGradeName($conn, $targetGradeLevelId);
    $targetSectionName = getImportSectionName($conn, $targetSectionId);
    $messages[] = [
        'severity' => 'I',
        'field' => 'promotion',
        'message' => 'Promotion import: latest record is ' . $prior['grade_name'] . ' - ' . ($prior['section_name'] ?: 'No section')
            . ' for ' . ($prior['year_label'] ?: 'previous school year')
            . '; target is ' . $targetGradeName . ' - ' . $targetSectionName
            . ' for ' . (($targetSy['year_label'] ?? null) ?: 'selected school year') . '.',
    ];

    // A stale/legacy numeric progression row must not override the Grade 1
    // descriptive PACE rule.  Grade 1 promotion is valid only after every
    // required rating in Terms 1-3 has been recorded.
    $descriptiveEvidence = DescriptiveProgressionService::evidenceForEnrollment(
        $conn,
        (int)$prior['enrollment_id']
    );
    if (!empty($descriptiveEvidence['is_descriptive'])) {
        if (empty($descriptiveEvidence['complete'])) {
            $missingTerms = array_map(
                static fn(int $term): string => 'Term ' . $term,
                array_values(array_map('intval', $descriptiveEvidence['missing_terms'] ?? []))
            );
            return [
                'blocked' => true,
                'messages' => array_merge($messages, [[
                    'severity' => 'E',
                    'field' => 'promotion',
                    'message' => 'Promotion blocked: Grade 1 descriptive PACE ratings are incomplete ('
                        . ($missingTerms ? implode(', ', $missingTerms) : 'Terms 1, 2, and 3')
                        . '). Complete all required A-E ratings for Terms 1-3 before promotion.',
                ]]),
            ];
        }

        $expectedNextGradeId = getImportNextGradeLevelId($conn, (int)$prior['grade_level_id']);
        if ($expectedNextGradeId && $expectedNextGradeId !== $targetGradeLevelId) {
            return [
                'blocked' => true,
                'messages' => array_merge($messages, [[
                    'severity' => 'E',
                    'field' => 'grade',
                    'message' => 'Promotion blocked: complete Grade 1 descriptive records qualify for '
                        . getImportGradeName($conn, $expectedNextGradeId) . ', not ' . $targetGradeName . '.',
                ]]),
            ];
        }

        $messages[] = [
            'severity' => 'I',
            'field' => 'promotion',
            'message' => 'Promotion validated from Grade 1 descriptive PACE: all required A-E ratings for Terms 1-3 are complete; numeric final grades and general average are not required.',
        ];
        return ['blocked' => false, 'messages' => $messages];
    }

    $progression = getImportProgressionForEnrollment($conn, (int)$prior['enrollment_id']);
    if ($progression) {
        $status = (string)$progression['final_status'];
        $recommendedGradeId = intOrNull($progression['next_grade_level_id'] ?? null) ?? (int)$progression['current_grade_level_id'];
        $recommendedGradeName = $progression['next_grade_name'] ?: ($progression['current_grade_name'] ?: getImportGradeName($conn, $recommendedGradeId));
        $detail = nullIfEmpty($progression['remarks'] ?? null);

        if (in_array($status, ['Retained', 'Conditionally Promoted'], true)) {
            return [
                'blocked' => true,
                'messages' => array_merge($messages, [[
                    'severity' => 'E',
                    'field' => 'promotion',
                    'message' => 'Promotion blocked: latest progression status is ' . $status . ' for '
                        . ($prior['year_label'] ?: 'the previous school year')
                        . '. Recommended grade is ' . $recommendedGradeName
                        . ($detail ? ". Reason: {$detail}" : '.'),
                ]]),
            ];
        }

        if ($status === 'Completed' && empty($progression['next_grade_level_id'])) {
            return [
                'blocked' => true,
                'messages' => array_merge($messages, [[
                    'severity' => 'E',
                    'field' => 'promotion',
                    'message' => 'Promotion blocked: latest progression status is Completed with no next grade level. The learner appears to have completed the terminal grade.',
                ]]),
            ];
        }

        if ($recommendedGradeId !== $targetGradeLevelId) {
            return [
                'blocked' => true,
                'messages' => array_merge($messages, [[
                    'severity' => 'E',
                    'field' => 'grade',
                    'message' => 'Promotion blocked: based on the latest progression record, the learner should enroll in '
                        . $recommendedGradeName . ', not ' . $targetGradeName
                        . ($detail ? ". Reason: {$detail}" : '.'),
                ]]),
            ];
        }

        $messages[] = [
            'severity' => $status === 'Conditionally Promoted' ? 'W' : 'I',
            'field' => 'promotion',
            'message' => 'Promotion validated from latest progression record: ' . $status
                . ($detail ? ". {$detail}" : '.'),
        ];
        return ['blocked' => false, 'messages' => $messages];
    }

    $evidence = getImportFinalGradeEvidence($conn, $prior);
    $reasons = [];
    if ($evidence['expected_count'] <= 0) {
        $reasons[] = 'no subject offerings were found for the latest section';
    }
    if ($evidence['missing_subjects']) {
        $reasons[] = 'missing final grades in ' . implode(', ', array_slice($evidence['missing_subjects'], 0, 6))
            . (count($evidence['missing_subjects']) > 6 ? ', and others' : '');
    }
    if ($evidence['failed_subjects']) {
        $reasons[] = 'failing final grades in ' . implode(', ', array_slice($evidence['failed_subjects'], 0, 6))
            . (count($evidence['failed_subjects']) > 6 ? ', and others' : '');
    }
    if ($evidence['general_average'] !== null && $evidence['general_average'] < 75.00) {
        $reasons[] = 'general average is ' . rtrim(rtrim(number_format($evidence['general_average'], 2), '0'), '.') . ', below 75';
    }

    if ($reasons) {
        return [
            'blocked' => true,
            'messages' => array_merge($messages, [[
                'severity' => 'E',
                'field' => 'promotion',
                'message' => 'Promotion blocked from latest academic record (' . ($prior['year_label'] ?: 'previous school year')
                    . '): ' . implode('; ', $reasons) . '.',
            ]]),
        ];
    }

    $expectedNextGradeId = getImportNextGradeLevelId($conn, (int)$prior['grade_level_id']);
    if ($expectedNextGradeId && $expectedNextGradeId !== $targetGradeLevelId) {
        return [
            'blocked' => true,
            'messages' => array_merge($messages, [[
                'severity' => 'E',
                'field' => 'grade',
                'message' => 'Promotion blocked: latest academic record is complete, but the expected next grade is '
                    . getImportGradeName($conn, $expectedNextGradeId) . ', not ' . $targetGradeName . '.',
            ]]),
        ];
    }

    $messages[] = [
        'severity' => 'I',
        'field' => 'promotion',
        'message' => 'Promotion validated from latest academic record: required final grades are complete and no failing final grade was found.',
    ];
    return ['blocked' => false, 'messages' => $messages];
}

/** DepEd SF1/LIS recognized major languages (warning if import value is outside this set). */
function getDepedMotherTongues(): array {
    return [
        'Akeanon', 'Bikol', 'Blaan', 'Cebuano', 'Chavacano', 'Hiligaynon', 'Ibanag',
        'Ifugao', 'Ilocano', 'Ivatan', 'Kapampangan', 'Kinaray-a', 'Maguindanao',
        'Maranao', 'Meranao', 'Pangasinan', 'Pangasinense', 'Surigaonon', 'Tagalog',
        'Tausug', 'Waray', 'Yakan', 'Binukid', 'Manobo',
    ];
}

function validateMotherTongueForImport(PDO $conn, ?string $raw): array {
    $raw = nullIfEmpty($raw);
    if ($raw === null) {
        return ['value' => null, 'warning' => null];
    }
    // SF1 text is authoritative; reference lists are suggestions, not a whitelist.
    return ['value' => $raw, 'warning' => null];
}

function getLisImportContext(PDO $conn): void {
    requireImportTables($conn);

    $school = getActiveSchool($conn);
    $schoolYearId = getActiveSchoolYearId($conn);
    $yearLabel = null;
    if ($schoolYearId) {
        $stmt = $conn->prepare('SELECT year_label FROM school_years WHERE school_year_id = :id LIMIT 1');
        $stmt->bindValue(':id', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        $yearLabel = nullIfEmpty($stmt->fetchColumn() ?: null);
    }

    $remarks = [];
    $stmt = $conn->query('SELECT raw_remark, learner_status, enrollment_status, enrollment_type_name
                          FROM sf1_remark_map ORDER BY remark_map_id');
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $remarks[] = $row;
    }

    respond([
        'success' => true,
        'school' => $school ? [
            'school_id' => (int)$school['school_id'],
            'deped_school_id' => (string)$school['deped_school_id'],
            'school_name' => (string)$school['school_name'],
        ] : null,
        'active_school_year' => $schoolYearId ? [
            'school_year_id' => $schoolYearId,
            'year_label' => $yearLabel,
        ] : null,
        'mother_tongues' => getDepedMotherTongues(),
        'remark_map' => $remarks,
        // LIS text remains authoritative; no database normalization table is used.
        'value_norms' => [],
        'staging_columns' => [
            'lrn', 'name', 'sex', 'birth_date', 'birth_province', 'age_by_june', 'mother_tongue',
            'ip_group', 'religion', 'house_street', 'barangay', 'municipality', 'province',
            'father_name', 'mother_name', 'guardian_name', 'guardian_rel', 'contact_number',
            'remarks', 'grade_level', 'section',
        ],
    ]);
}

/* ============================== normalizers =============================== */

/** Canonical SF1 name parser (fixed rule: last token of remainder = middle name). */
function parseFullNameForImport(?string $value): ?array {
    $raw = trim(preg_replace('/\s+/', ' ', (string)($value ?? '')));
    if ($raw === '' || !str_contains($raw, ',')) return null;

    $extSet = [
        'JR' => 'Jr.',
        'SR' => 'Sr.',
        'II' => 'II',
        'III' => 'III',
        'IV' => 'IV',
        'V' => 'V',
        'VI' => 'VI',
        'VII' => 'VII',
        'VIII' => 'VIII',
        'IX' => 'IX',
        'X' => 'X',
    ];
    $popExt = function (array &$tokens) use ($extSet): string {
        if (count($tokens) === 0) return '';
        $last = strtoupper(trim(str_replace('.', '', (string)end($tokens))));
        if (array_key_exists($last, $extSet)) { array_pop($tokens); return $extSet[$last]; }
        return '';
    };

    $parts = array_values(array_filter(array_map('trim', explode(',', $raw)), fn ($p) => $p !== ''));
    if (count($parts) < 2) return null;

    $ext = '';
    foreach ($parts as $i => $p) {
        $toks = preg_split('/\s+/', $p) ?: [];
        $e = $popExt($toks);
        if ($e !== '') { $ext = $e; $parts[$i] = implode(' ', $toks); }
    }
    $parts = array_values(array_filter($parts, fn ($p) => trim($p) !== ''));
    if (count($parts) < 2) return null;

    $lastName = $parts[0];
    $inferred = false;
    if (count($parts) >= 3) {
        $firstName  = $parts[1];
        $middleName = trim(implode(' ', array_slice($parts, 2)));
    } else {
        $toks = array_values(array_filter(preg_split('/\s+/', $parts[1]) ?: [], fn ($t) => $t !== ''));
        if (count($toks) === 0) return null;
        if (count($toks) === 1) { $firstName = $toks[0]; $middleName = ''; }
        else { $middleName = array_pop($toks); $firstName = implode(' ', $toks); $inferred = true; }
    }
    if ($firstName === '' || $lastName === '') return null;
    return ['first_name' => $firstName, 'middle_name' => $middleName, 'last_name' => $lastName,
            'name_extension' => $ext, 'full_name_raw' => $raw, 'inferred' => $inferred];
}

/** Strict date normalizer: calendar-validated, DD/MM auto-swap, sliding century, Excel serials. */
function normalizeDateForImport($value, ?string &$note = null): ?string {
    $note = null;
    $s = trim((string)($value ?? ''));
    if ($s === '') return null;
    $fmt = fn (int $y, int $m, int $d) => sprintf('%04d-%02d-%02d', $y, $m, $d);

    if (preg_match('/^(\d{4})-(\d{1,2})-(\d{1,2})$/', $s, $m)) {
        return checkdate((int)$m[2], (int)$m[3], (int)$m[1]) ? $fmt((int)$m[1], (int)$m[2], (int)$m[3]) : null;
    }
    if (preg_match('/^\d{4,6}$/', $s)) {
        $n = (int)$s;
        if ($n > 10000 && $n < 60000) {
            $iso = gmdate('Y-m-d', ($n - 25569) * 86400);
            $note = "Date was an Excel number — auto-converted to {$iso}, please verify";
            return $iso;
        }
        return null;
    }
    if (preg_match('/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/', $s, $m)) {
        $a = (int)$m[1]; $b = (int)$m[2]; $y = (int)$m[3];
        if (checkdate($a, $b, $y)) return $fmt($y, $a, $b);
        if (checkdate($b, $a, $y)) { $note = "Date format was DD/MM/YYYY — auto-corrected, please verify"; return $fmt($y, $b, $a); }
        return null;
    }
    if (preg_match('/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/', $s, $m)) {
        $a = (int)$m[1]; $b = (int)$m[2]; $yy = (int)$m[3];
        $y = $yy <= (int)date('y') ? 2000 + $yy : 1900 + $yy;
        $note = "Year had only 2 digits — assumed {$y}, please verify";
        if (checkdate($a, $b, $y)) return $fmt($y, $a, $b);
        if (checkdate($b, $a, $y)) return $fmt($y, $b, $a);
        return null;
    }
    return null;
}

function normalizeSexForImport(?string $raw): ?string {
    $s = strtoupper(trim((string)($raw ?? '')));
    return ['M' => 'M', 'MALE' => 'M', 'F' => 'F', 'FEMALE' => 'F'][$s] ?? null;
}

function normalizeContactForImport($value, ?string &$note = null): ?string {
    $note = null;
    $v = nullIfEmpty($value);
    if ($v === null) return null;
    if (preg_match('/^\d+(\.\d+)?E\+?\d+$/i', $v)) {
        $v = sprintf('%.0f', (float)$v);
        $note = 'Contact number was in scientific notation — auto-corrected';
    }
    $v = preg_replace('/[\s\-\(\)\.]/', '', $v);
    $v = preg_replace('/^\+?63/', '0', $v);
    if (preg_match('/^9\d{9}$/', $v)) { $v = '0' . $v; $note = trim(($note ? $note . '; ' : '') . 'Leading zero added to contact number'); }
    if (!preg_match('/^09\d{9}$/', $v)) {
        $note = trim(($note ? $note . '; ' : '') . 'Contact number does not look like a valid PH mobile — saved as-is');
        return substr($v, 0, 20);
    }
    return $v;
}

function repairLrnForImport($raw, ?string &$note = null): ?string {
    $note = null;
    $v = trim((string)($raw ?? ''));
    if ($v === '') return null;
    if (preg_match('/^\d+(\.\d+)?E\+?\d+$/i', $v)) {
        $v = sprintf('%.0f', (float)$v);
        $note = 'LRN was in scientific notation (from Excel) — auto-corrected, please verify';
    }
    $v = preg_replace('/[\s\-]/', '', $v);
    if (preg_match('/^\d{11}$/', $v)) {
        $v = '0' . $v;
        $note = trim(($note ? $note . '; ' : '') . 'Leading zero was missing from LRN — auto-corrected, please verify');
    }
    return preg_match('/^\d{12}$/', $v) ? $v : null;
}

/* ============================== accounts ================================== */

function resolveOrCreateLearnerAccount(PDO $conn, string $lrn, string $plainPassword, ?int $providedUserId = null): array {
    if ($providedUserId !== null && $providedUserId > 0) {
        $existing = account_credentials_find_by_legacy_user($conn, $providedUserId);
        $identity = $conn->prepare('SELECT u.role_id, u.username,
            EXISTS(SELECT 1 FROM employees e WHERE e.user_id = u.user_id) AS has_employee
            FROM users u WHERE u.user_id = ?');
        $identity->execute([$providedUserId]);
        $linked = $identity->fetch(PDO::FETCH_ASSOC);
        if (!$linked || $linked['username'] !== null || (int)$linked['has_employee'] || (int)$linked['role_id'] !== getLearnerRoleId($conn)) {
            throw new RuntimeException('Learners require a separate learner identity; staff accounts cannot be linked.');
        }
        return [
            'user_id' => $providedUserId,
            'created' => false,
            'username' => $existing['username'] ?? $lrn,
            'password_hash' => $existing['password'] ?? password_hash($plainPassword, PASSWORD_BCRYPT),
            'role_id' => $existing['role_id'] ?? getLearnerRoleId($conn),
        ];
    }
    $existing = account_credentials_find_by_username($conn, $lrn);
    if ($existing && (int)($existing['is_deleted'] ?? 0) === 0) {
        if (($existing['account_type'] ?? '') !== 'learner') {
            throw new Exception('Account username is already used by another account type');
        }
        throw new Exception('User account for this LRN is already linked to another learner');
    }

    $roleId = getLearnerRoleId($conn);
    return [
        'user_id' => account_identity_create($conn, $roleId),
        'created' => true,
        'username' => $lrn,
        'password_hash' => password_hash($plainPassword, PASSWORD_BCRYPT),
        'role_id' => $roleId,
    ];
}

function resolvePasswordForImport(string $mode, ?string $custom, string $lrn, ?string $dobIso): string {
    $mode = strtolower(trim($mode));
    if ($mode === 'custom') {
        $pw = trim((string)($custom ?? ''));
        if ($pw === '') throw new Exception('Custom default password is required');
        return $pw;
    }
    if ($mode === 'dob') {
        if (!$dobIso) throw new Exception('Valid birth date required for DOB password mode');
        $p = explode('-', $dobIso);
        return $p[1] . $p[2] . $p[0];
    }
    return $lrn;
}

/* ============================== upserts =================================== */

function upsertFamilyMember(PDO $conn, int $learnerId, string $relationship,
                            ?string $fullName, ?string $contactNumber = null,
                            bool $isGuardian = false, ?string $fullNameRaw = null): void {
    $rawName = $fullNameRaw ?? $fullName;
    $relationship = trim($relationship);

    // SF1 rows may legitimately omit all family/guardian names. The import
    // still needs to create the learner and enrollment; only validate and
    // upsert a family row when a name was actually supplied.
    if ($learnerId <= 0 || nullIfEmpty($rawName) === null || $relationship === '') {
        return;
    }

    $name = family_member_prepare_name($conn, $rawName);
    if (!($name['valid'] ?? false)) {
        throw new InvalidArgumentException((string)($name['message'] ?? 'Family member name is invalid.'));
    }
    $fullName = $name['full_name'];
    $fullNameRaw = $name['full_name_raw'];
    if ($fullName === null) return;

    $stmt = $conn->prepare('SELECT family_member_id FROM family_members
                            WHERE learner_id = :lid AND relationship = :rel
                              AND (full_name = :fn OR (:fnr_check IS NOT NULL AND full_name_raw = :fnr))
                            ORDER BY family_member_id DESC LIMIT 1');
    $stmt->bindValue(':lid', $learnerId, PDO::PARAM_INT);
    $stmt->bindValue(':rel', $relationship);
    $stmt->bindValue(':fn', $fullName);
    bindNullable($stmt, ':fnr_check', $fullNameRaw);
    bindNullable($stmt, ':fnr', $fullNameRaw);
    $stmt->execute();
    $id = (int)($stmt->fetchColumn() ?: 0);

    if ($isGuardian) {
        // Serialize guardian replacement before clearing the previous record.
        // This is the application-layer equivalent of the old single-guardian
        // trigger, while preserving the import behavior of replacing the
        // guardian-of-record when the source file names a new guardian.
        $guardLock = $conn->prepare(
            'SELECT family_member_id
             FROM family_members
             WHERE learner_id = :learner_id
               AND is_guardian = 1
               AND is_deleted = 0
             FOR UPDATE'
        );
        $guardLock->execute([':learner_id' => $learnerId]);

        // clear other guardians BEFORE flagging the replacement
        $c = $conn->prepare('UPDATE family_members SET is_guardian = 0
                             WHERE learner_id = :lid AND is_deleted = 0 AND is_guardian = 1
                               AND NOT (relationship = :rel AND full_name = :fn)');
        $c->bindValue(':lid', $learnerId, PDO::PARAM_INT);
        $c->bindValue(':rel', $relationship);
        $c->bindValue(':fn', $fullName);
        $c->execute();

        app_integrity_validate_single_guardian($conn, $learnerId, true, $id > 0 ? $id : null);
    }

    if ($id > 0) {
        $u = $conn->prepare('UPDATE family_members
                             SET is_deleted = 0, deleted_at = NULL,
                                 full_name = :fn,
                                 contact_number = COALESCE(:cn, contact_number),
                                 full_name_raw = COALESCE(:fnr, full_name_raw),
                                 first_name = :first_name, middle_name = :middle_name,
                                 last_name = :last_name, name_extension = :name_extension,
                                 is_guardian = :ig
                             WHERE family_member_id = :id');
        $u->bindValue(':fn', $name['full_name']);
        bindNullable($u, ':cn', nullIfEmpty($contactNumber));
        bindNullable($u, ':fnr', nullIfEmpty($fullNameRaw));
        bindNullable($u, ':first_name', $name['first_name']);
        bindNullable($u, ':middle_name', $name['middle_name']);
        bindNullable($u, ':last_name', $name['last_name']);
        bindNullable($u, ':name_extension', $name['name_extension']);
        $u->bindValue(':ig', $isGuardian ? 1 : 0, PDO::PARAM_INT);
        $u->bindValue(':id', $id, PDO::PARAM_INT);
        $u->execute();
    } else {
        $i = $conn->prepare('INSERT INTO family_members
                             (learner_id, full_name, full_name_raw, first_name, middle_name, last_name,
                              name_extension, relationship, is_guardian, contact_number)
                             VALUES (:lid, :fn, :fnr, :first_name, :middle_name, :last_name,
                                     :name_extension, :rel, :ig, :cn)');
        $i->bindValue(':lid', $learnerId, PDO::PARAM_INT);
        $i->bindValue(':fn', $fullName);
        bindNullable($i, ':fnr', nullIfEmpty($fullNameRaw));
        bindNullable($i, ':first_name', $name['first_name']);
        bindNullable($i, ':middle_name', $name['middle_name']);
        bindNullable($i, ':last_name', $name['last_name']);
        bindNullable($i, ':name_extension', $name['name_extension']);
        $i->bindValue(':rel', $relationship);
        $i->bindValue(':ig', $isGuardian ? 1 : 0, PDO::PARAM_INT);
        bindNullable($i, ':cn', nullIfEmpty($contactNumber));
        $i->execute();
    }
}

function upsertCurrentAddress(PDO $conn, int $learnerId, ?string $street,
                              ?string $provinceText = null, ?string $cityText = null,
                              ?string $barangayText = null): void {
    if ($learnerId <= 0) return;
    if ($street === null && nullIfEmpty($provinceText) === null && nullIfEmpty($cityText) === null
        && nullIfEmpty($barangayText) === null) return;
    // one-active-row invariant: soft-delete existing active CURRENT first
    $d = $conn->prepare("UPDATE learner_addresses SET is_deleted = 1, deleted_at = NOW()
                         WHERE learner_id = :lid AND address_type = 'CURRENT' AND is_deleted = 0");
    $d->bindValue(':lid', $learnerId, PDO::PARAM_INT);
    $d->execute();

    $cols = ['learner_id', 'address_type', 'street_name'];
    $vals = [':lid', "'CURRENT'", ':st'];
    $rawMap = [
        'province_text' => [':pt', nullIfEmpty($provinceText)],
        'city_municipality_text' => [':ct', nullIfEmpty($cityText)],
        'barangay_text' => [':bt', nullIfEmpty($barangayText)],
    ];
    foreach ($rawMap as $col => [$param, $value]) {
        if (columnExists($conn, 'learner_addresses', $col)) {
            $cols[] = $col;
            $vals[] = $param;
        }
    }

    $i = $conn->prepare('INSERT INTO learner_addresses
                         (' . implode(', ', $cols) . ')
                         VALUES (' . implode(', ', $vals) . ')');
    $i->bindValue(':lid', $learnerId, PDO::PARAM_INT);
    bindNullable($i, ':st', $street);
    foreach ($rawMap as $col => [$param, $value]) {
        if (in_array($col, $cols, true)) bindNullable($i, $param, $value);
    }
    $i->execute();
}

function importComparableValue($value): ?string {
    if ($value === null) return null;
    return trim((string)$value);
}

function importIncomingValueDiffers($current, $incoming): bool {
    // Import writes are intentionally partial: blank source cells do not
    // erase existing values. A blank incoming value therefore is not a change.
    if ($incoming === null) return false;
    return importComparableValue($current) !== importComparableValue($incoming);
}

function importFamilyMemberDiffers(PDO $conn, int $learnerId, string $relationship,
                                   ?string $rawName, ?string $contactNumber,
                                   bool $isGuardian = false): bool {
    $rawName = nullIfEmpty($rawName);
    if ($rawName === null) return false;

    try {
        $prepared = family_member_prepare_name($conn, $rawName);
    } catch (Throwable $e) {
        // Preserve the existing commit-time validation error for malformed
        // family names, but do not classify the row as unchanged.
        return true;
    }
    if (!($prepared['valid'] ?? false)) return true;

    $stmt = $conn->prepare(
        'SELECT full_name, full_name_raw, contact_number, is_guardian
         FROM family_members
         WHERE learner_id = :learner_id
           AND relationship = :relationship
           AND is_deleted = 0
         ORDER BY family_member_id DESC'
    );
    $stmt->execute([
        ':learner_id' => $learnerId,
        ':relationship' => $relationship,
    ]);

    $targetName = normalizeImportMatchText($prepared['full_name'] ?? $rawName);
    $targetRaw = normalizeImportMatchText($prepared['full_name_raw'] ?? $rawName);
    $matched = null;
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $family) {
        $sameName = normalizeImportMatchText($family['full_name'] ?? '') === $targetName;
        $sameRaw = $targetRaw !== ''
            && normalizeImportMatchText($family['full_name_raw'] ?? '') === $targetRaw;
        if ($sameName || $sameRaw) {
            $matched = $family;
            break;
        }
    }

    if ($matched === null) return true;
    if (importIncomingValueDiffers($matched['contact_number'] ?? null, $contactNumber)) return true;
    return $isGuardian && (int)($matched['is_guardian'] ?? 0) !== 1;
}

function importCurrentAddressDiffers(PDO $conn, int $learnerId, array $rawRow): bool {
    $incoming = [
        'street_name' => nullIfEmpty($rawRow['raw_house_street'] ?? null),
        'province_text' => nullIfEmpty($rawRow['raw_province'] ?? null),
        'city_municipality_text' => nullIfEmpty($rawRow['raw_municipality'] ?? null),
        'barangay_text' => nullIfEmpty($rawRow['raw_barangay'] ?? null),
    ];
    if (!array_filter($incoming, static fn ($value) => $value !== null)) return false;
    if (!tableExists($conn, 'learner_addresses')) return true;

    $columns = ['street_name'];
    foreach (['province_text', 'city_municipality_text', 'barangay_text'] as $column) {
        if (columnExists($conn, 'learner_addresses', $column)) $columns[] = $column;
    }
    $stmt = $conn->prepare(
        'SELECT ' . implode(', ', $columns) . '
         FROM learner_addresses
         WHERE learner_id = :learner_id
           AND address_type = \'CURRENT\'
           AND is_deleted = 0
         ORDER BY learner_address_id DESC
         LIMIT 1'
    );
    $stmt->execute([':learner_id' => $learnerId]);
    $current = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$current) return true;

    foreach ($incoming as $column => $value) {
        if ($value !== null && importIncomingValueDiffers($current[$column] ?? null, $value)) {
            return true;
        }
    }
    return false;
}

function importExistingRecordHasChanges(PDO $conn, int $learnerId, array $rawRow,
                                       array $values, ?array $matchedEnrollment): bool {
    if (!$matchedEnrollment || !empty($matchedEnrollment['is_deleted'])) return true;

    $stmt = $conn->prepare(
        'SELECT first_name, middle_name, last_name, name_extension, date_of_birth,
                sex, gender, mother_tongue, religion, indigenous_group, is_indigenous,
                is_lwd, address, contact_number, birth_province_text
         FROM learners
         WHERE learner_id = :learner_id
         LIMIT 1'
    );
    $stmt->execute([':learner_id' => $learnerId]);
    $current = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$current) return true;

    foreach ([
        'first_name' => $values['nfn'] ?? null,
        'middle_name' => $values['nmn'] ?? null,
        'last_name' => $values['nln'] ?? null,
        'name_extension' => $values['next_'] ?? null,
        'date_of_birth' => $values['ndob'] ?? null,
        'mother_tongue' => validateMotherTongueForImport($conn, $rawRow['raw_mother_tongue'] ?? null)['value'],
        'religion' => nullIfEmpty($rawRow['raw_religion'] ?? null),
        'contact_number' => $values['ncn'] ?? null,
        'birth_province_text' => nullIfEmpty($rawRow['raw_birth_province'] ?? null),
    ] as $column => $incoming) {
        if (importIncomingValueDiffers($current[$column] ?? null, $incoming)) return true;
    }

    $incomingSex = $values['nsex'] ?? null;
    $incomingIpGroup = nullIfEmpty($rawRow['raw_ip_group'] ?? null);
    if ($incomingSex !== null || $incomingIpGroup !== null) {
        $prepared = app_integrity_prepare_learner($conn, [
            'lrn' => $values['nlrn'] ?? null,
            'date_of_birth' => $values['ndob'] ?? null,
            'sex' => $incomingSex,
            'gender' => $current['gender'] ?? null,
            'indigenous_group' => $incomingIpGroup,
            'is_indigenous' => (int)($current['is_indigenous'] ?? 0),
        ], $current, false);
        if ($incomingSex !== null
            && (importIncomingValueDiffers($current['sex'] ?? null, $prepared['sex'] ?? null)
                || importIncomingValueDiffers($current['gender'] ?? null, $prepared['gender'] ?? null))) {
            return true;
        }
        if ($incomingIpGroup !== null
            && (importIncomingValueDiffers($current['indigenous_group'] ?? null, $prepared['indigenous_group'] ?? null)
                || (int)($current['is_indigenous'] ?? 0) !== (int)($prepared['is_indigenous'] ?? 0))) {
            return true;
        }
    }
    if (!empty($values['detected_lwd']) && (int)($current['is_lwd'] ?? 0) !== 1) return true;

    $flatAddress = nullIfEmpty(implode(', ', array_filter([
        nullIfEmpty($rawRow['raw_house_street'] ?? null),
        nullIfEmpty($rawRow['raw_barangay'] ?? null),
        nullIfEmpty($rawRow['raw_municipality'] ?? null),
        nullIfEmpty($rawRow['raw_province'] ?? null),
    ])));
    if (importIncomingValueDiffers($current['address'] ?? null, $flatAddress)) return true;
    if (importCurrentAddressDiffers($conn, $learnerId, $rawRow)) return true;

    $guardianName = nullIfEmpty($rawRow['raw_guardian_name'] ?? null);
    $fatherName = nullIfEmpty($rawRow['raw_father_name'] ?? null);
    $motherName = nullIfEmpty($rawRow['raw_mother_name'] ?? null);
    $contact = $values['ncn'] ?? null;
    $guardianRelationship = normalizeGuardianRelationshipCategory(
        $rawRow['raw_guardian_rel'] ?? null,
        $guardianName,
        $fatherName,
        $motherName
    );
    if (importFamilyMemberDiffers($conn, $learnerId, 'Father', $fatherName,
            $guardianName || !$fatherName ? null : $contact)) return true;
    if (importFamilyMemberDiffers($conn, $learnerId, 'Mother', $motherName,
            $guardianName || !$motherName || $fatherName ? null : $contact)) return true;
    if (importFamilyMemberDiffers($conn, $learnerId, $guardianRelationship,
            $guardianName, $guardianName ? $contact : null, true)) return true;

    if ((int)($matchedEnrollment['grade_level_id'] ?? 0) !== (int)($values['rgid'] ?? 0)
        || (int)($matchedEnrollment['section_id'] ?? 0) !== (int)($values['rsid'] ?? 0)
        || (string)($matchedEnrollment['enrollment_status'] ?? '') !== (string)($values['res'] ?? '')) {
        return true;
    }
    if (($values['retid'] ?? null) !== null
        && (int)($matchedEnrollment['enrollment_type_id'] ?? 0) !== (int)$values['retid']) {
        return true;
    }
    $incomingClassification = (string)($values['entry_classification'] ?? '');
    // "Update" is a synthetic marker used for an existing learner with no
    // source classification; it is not a value written to the enrollment.
    if ($incomingClassification !== '' && $incomingClassification !== 'Update'
        && (string)($matchedEnrollment['entry_classification'] ?? '') !== $incomingClassification) {
        return true;
    }

    return false;
}

function upsertPreviousSchool(PDO $conn, int $learnerId, int $enrollmentId, array $d): void {
    $g = nullIfEmpty($d['last_grade_level_completed'] ?? null);
    $y = nullIfEmpty($d['last_school_year_completed'] ?? null);
    $s = nullIfEmpty($d['last_school_attended'] ?? null);
    $i = nullIfEmpty($d['last_school_id'] ?? null);
    if ($g === null && $y === null && $s === null && $i === null) return;
    $del = $conn->prepare('UPDATE learner_previous_schools SET is_deleted = 1, deleted_at = NOW()
                           WHERE learner_id = :lid AND is_deleted = 0');
    $del->bindValue(':lid', $learnerId, PDO::PARAM_INT);
    $del->execute();
    $ins = $conn->prepare('INSERT INTO learner_previous_schools
                           (learner_id, enrollment_id, last_grade_level_completed,
                            last_school_year_completed, last_school_attended, last_school_id)
                           VALUES (:lid, :eid, :g, :y, :s, :i)');
    $ins->bindValue(':lid', $learnerId, PDO::PARAM_INT);
    bindNullable($ins, ':eid', $enrollmentId > 0 ? $enrollmentId : null, PDO::PARAM_INT);
    bindNullable($ins, ':g', $g);
    bindNullable($ins, ':y', $y);
    bindNullable($ins, ':s', $s);
    bindNullable($ins, ':i', $i);
    $ins->execute();
}

function buildFullNameRaw(?string $lastName, ?string $firstName, ?string $middleName): ?string {
    $last = nullIfEmpty($lastName);
    $first = nullIfEmpty($firstName);
    if ($last === null || $first === null) return null;
    $middle = nullIfEmpty($middleName);
    return $middle !== null ? "$last, $first $middle" : "$last, $first";
}

function formatAddressFromParts(?string $houseStreet, ?string $barangay, ?string $municipality, ?string $province): ?string {
    $parts = array_filter([$houseStreet, $barangay, $municipality, $province], fn($v) => $v !== null && $v !== '');
    $address = implode(', ', $parts);
    return $address !== '' ? $address : null;
}

/* ============================== dispatch ================================== */

$operation = $_GET['operation'] ?? '';
if ($operation === '' && (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET')) {
    $operation = 'getAllRegistrations';
}

$teacherReadOps  = ['getAllRegistrations', 'getRegistrationList', 'getRegistrationById', 'getEnrollmentStatus', 'getLisImportPreview', 'getLisImportContext', 'checkLrnAvailability'];
$teacherWriteOps = ['createRegistration', 'updateRegistration', 'startLisImport', 'stageLisImportRows', 'validateLisImport', 'excludeLisImportRows', 'commitLisImport', 'finalizeLisImport'];
$learnerReadOps  = ['getAllRegistrations', 'getRegistrationList', 'getRegistrationById'];
$adminProfileWriteOps = ['updateProfileRegistration'];
$statusWriteOps = ['updateEnrollmentStatus'];
$readRoles  = in_array($operation, $teacherReadOps, true)
    ? (in_array($operation, $learnerReadOps, true) ? ['admin', 'teacher', 'registrar', 'learners'] : ['admin', 'teacher', 'registrar'])
    : ['admin', 'registrar'];
$writeRoles = in_array($operation, $adminProfileWriteOps, true)
    ? ['admin']
    : (in_array($operation, $statusWriteOps, true)
        ? ['admin', 'registrar', 'teacher']
        : (in_array($operation, $teacherWriteOps, true) ? ['admin', 'registrar', 'teacher'] : ['admin', 'registrar']));
$session = auth_enforce_roles($operation, $readRoles, $writeRoles);

// Learners may only view their own single registration.
if (($session['role_key'] ?? '') === 'learners' && in_array($operation, ['getAllRegistrations', 'getRegistrationList'], true)) {
    respond(['success' => false, 'message' => 'Not authorized'], 403);
}

try {
    switch ($operation) {
        case 'getAllRegistrations':   getAllRegistrations($conn); break;
        case 'getRegistrationList':   getRegistrationList($conn); break;
        case 'getRegistrationById':   getRegistrationById($conn, $session); break;
        case 'getEnrollmentStatus':   getEnrollmentStatus($conn, $session); break;
        case 'updateProfileRegistration': updateRegistration($conn, $session); break;
        case 'checkLrnAvailability':  checkLrnAvailability($conn); break;
        case 'createRegistration':    createRegistration($conn); break;
        case 'updateRegistration':    updateRegistration($conn, $session); break;
        case 'updateEnrollmentStatus': updateEnrollmentStatus($conn, $session); break;
        case 'deleteRegistration':    deleteRegistration($conn); break;
        case 'startLisImport':        startLisImport($conn, $session); break;
        case 'stageLisImportRows':    stageLisImportRows($conn, $session); break;
        case 'validateLisImport':     validateLisImport($conn, $session); break;
        case 'getLisImportPreview':   getLisImportPreview($conn, $session); break;
        case 'getLisImportContext':   getLisImportContext($conn); break;
        case 'excludeLisImportRows':  excludeLisImportRows($conn, $session); break;
        case 'commitLisImport':       commitLisImport($conn, $session); break;
        case 'finalizeLisImport':     finalizeLisImport($conn, $session); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    error_log('[learner_registration] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    if (is_name_extension_fk_violation($e)) {
        respond(name_extension_fk_error_payload(), 422);
    }
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

/* ======================================================================== */
/* IMPORT PIPELINE                                                          */
/* ======================================================================== */

function startLisImport(PDO $conn, array $session): void {
    requireImportTables($conn);
    $d = getJsonInput();
    $userId = (int)($session['user_id'] ?? 0);
    if ($userId <= 0) respond(['success' => false, 'message' => 'Invalid session'], 401);

    $schoolYearId = intOrNull($d['school_year_id'] ?? null) ?? getActiveSchoolYearId($conn);
    if (!$schoolYearId) respond(['success' => false, 'message' => 'No active school year found'], 409);

    // File-level assertions: fail early on mismatched school metadata, but tolerate missing metadata.
    $school = resolveImportSchool($conn, $d['file_school_id'] ?? null, $d['file_school_name'] ?? null);
    $fileSy = nullIfEmpty($d['file_school_year'] ?? null);
    if ($fileSy !== null && trim($fileSy) !== '') {
        $stmt = $conn->prepare('SELECT year_label FROM school_years WHERE school_year_id = :id LIMIT 1');
        $stmt->bindValue(':id', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        $label = (string)$stmt->fetchColumn();
        if ($label !== '' && normalizeImportSchoolYearLabel($fileSy) !== normalizeImportSchoolYearLabel($label)) {
            respond(['success' => false, 'fatal' => 'school_year_mismatch',
                     'message' => "File School Year '{$fileSy}' does not match the selected school year '{$label}'."], 422);
        }
    }

    $templateId = resolveImportTemplateId($conn, is_array($d['file_headers'] ?? null) ? $d['file_headers'] : []);

    $stmt = $conn->prepare('INSERT INTO import_logs
        (imported_by, school_id, template_id, school_year_id, file_name, file_size_kb, total_rows, status)
        VALUES (:by, :sid, :tid, :sy, :fn, :sz, :tot, "Processing")');
    $stmt->bindValue(':by', $userId, PDO::PARAM_INT);
    bindNullable($stmt, ':sid', $school ? intOrNull($school['school_id']) : null, PDO::PARAM_INT);
    bindNullable($stmt, ':tid', $templateId, PDO::PARAM_INT);
    $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    bindNullable($stmt, ':fn', nullIfEmpty($d['file_name'] ?? null));
    bindNullable($stmt, ':sz', intOrNull($d['file_size_kb'] ?? null), PDO::PARAM_INT);
    $stmt->bindValue(':tot', max(0, (int)($d['total_rows'] ?? 0)), PDO::PARAM_INT);
    $stmt->execute();

    respond(['success' => true, 'import_id' => (int)$conn->lastInsertId(),
             'school_id' => $school ? intOrNull($school['school_id']) : null,
             'template_id' => $templateId,
             'school_year_id' => $schoolYearId]);
}

function getTeacherEmployeeId(PDO $conn, array $session): int {
    $stmt = $conn->prepare('SELECT employee_id FROM employees WHERE user_id = :user_id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':user_id', (int)($session['user_id'] ?? 0), PDO::PARAM_INT);
    $stmt->execute();
    $employeeId = (int)($stmt->fetchColumn() ?: 0);
    if ($employeeId <= 0) {
        respond(['success' => false, 'message' => 'Teacher profile not found'], 403);
    }
    return $employeeId;
}

function teacherCanManageSection(PDO $conn, array $session, int $sectionId, int $schoolYearId): bool {
    if (($session['role_key'] ?? '') !== 'teacher') {
        return true;
    }
    $employeeId = getTeacherEmployeeId($conn, $session);
    $stmt = $conn->prepare(
        'SELECT 1
         FROM sections s
         WHERE s.section_id = :section_id
           AND s.school_year_id = :school_year_id
           AND s.is_deleted = 0
           AND s.adviser_id = :adviser_id
         LIMIT 1'
    );
    $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->bindValue(':adviser_id', $employeeId, PDO::PARAM_INT);
    $stmt->execute();
    return (bool)$stmt->fetchColumn();
}

function teacherCanManageLearnerEnrollment(PDO $conn, array $session, int $learnerId, int $schoolYearId): bool {
    if (($session['role_key'] ?? '') !== 'teacher') {
        return true;
    }

    $stmt = $conn->prepare(
        'SELECT section_id
         FROM enrollments
         WHERE learner_id = :learner_id
           AND school_year_id = :school_year_id
           AND is_deleted = 0
         ORDER BY enrollment_id DESC
         LIMIT 1'
    );
    $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $sectionId = (int)($stmt->fetchColumn() ?: 0);

    return $sectionId > 0 && teacherCanManageSection($conn, $session, $sectionId, $schoolYearId);
}

function importBatchOr404(PDO $conn, int $importId, array $session, ?string $requireStatus = 'Processing'): array {
    $stmt = $conn->prepare('SELECT * FROM import_logs WHERE import_id = :id LIMIT 1');
    $stmt->bindValue(':id', $importId, PDO::PARAM_INT);
    $stmt->execute();
    $b = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$b) respond(['success' => false, 'message' => 'Import batch not found'], 404);
    if (($session['role_key'] ?? '') === 'teacher' && (int)$b['imported_by'] !== (int)$session['user_id']) {
        respond(['success' => false, 'message' => 'Not authorized for this import batch'], 403);
    }
    if ($requireStatus !== null && ($b['status'] ?? '') !== $requireStatus) {
        respond(['success' => false, 'message' => 'Import batch is already ' . $b['status']], 409);
    }
    return $b;
}

function stageLisImportRows(PDO $conn, array $session): void {
    requireImportTables($conn);
    $d = getJsonInput();
    $importId = (int)($d['import_id'] ?? 0);
    $rows = is_array($d['rows'] ?? null) ? $d['rows'] : [];
    if ($importId <= 0 || !$rows) {
        respond(['success' => false, 'message' => 'import_id and rows[] are required'], 422);
    }
    importBatchOr404($conn, $importId, $session);

    $cols = ['lrn','name','sex','birth_date','birth_province','age_by_june','mother_tongue',
             'ip_group','religion','house_street','barangay','municipality','province',
             'father_name','mother_name','guardian_name','guardian_rel','contact_number',
             'remarks','grade_level','section'];
    $colLabels = [
        'lrn' => 'LRN',
        'name' => 'Name',
        'sex' => 'Sex',
        'birth_date' => 'Birth Date',
        'birth_province' => 'Birth Place',
        'age_by_june' => 'Age',
        'mother_tongue' => 'Mother Tongue',
        'ip_group' => 'IP Group',
        'religion' => 'Religion',
        'house_street' => 'House/Street',
        'barangay' => 'Barangay',
        'municipality' => 'Municipality/City',
        'province' => 'Province',
        'father_name' => 'Father Name',
        'mother_name' => 'Mother Name',
        'guardian_name' => 'Guardian Name',
        'guardian_rel' => 'Guardian Relationship',
        'contact_number' => 'Contact Number',
        'remarks' => 'Remarks',
        'grade_level' => 'Grade Level',
        'section' => 'Section',
    ];
    $maxLens = [
        'lrn' => 50,
        'name' => 300,
        'sex' => 20,
        'birth_date' => 50,
        'birth_province' => 150,
        'age_by_june' => 10,
        'mother_tongue' => 100,
        'ip_group' => 150,
        'religion' => 100,
        'house_street' => 200,
        'barangay' => 150,
        'municipality' => 150,
        'province' => 150,
        'father_name' => 300,
        'mother_name' => 300,
        'guardian_name' => 300,
        'guardian_rel' => 50,
        'contact_number' => 50,
        'remarks' => 100,
        'grade_level' => 50,
        'section' => 100,
    ];
    $lengthIssues = [];
    foreach ($rows as $r) {
        if (!is_array($r)) continue;
        $rn = (int)($r['row_number'] ?? 0);
        if ($rn <= 0) continue;
        foreach ($maxLens as $col => $max) {
            $value = $r[$col] ?? null;
            if ($value !== null && !is_scalar($value)) continue;
            $value = nullIfEmpty($value === null ? null : (string)$value);
            if ($value !== null && mbLen($value) > $max) {
                $lengthIssues[] = [
                    'row' => $rn,
                    'column' => $col,
                    'label' => $colLabels[$col] ?? $col,
                    'message' => ($colLabels[$col] ?? $col) . " is too long. Maximum is {$max} characters."
                ];
            }
        }
    }
    if ($lengthIssues) {
        respond([
            'success' => false,
            'message' => 'Some spreadsheet cells are too long. Please shorten the highlighted values and try again.',
            'validation_errors' => $lengthIssues
        ], 422);
    }
    $stmt = $conn->prepare('INSERT INTO sf1_import_staging
        (import_id, `row_number`, raw_lrn, raw_name, raw_sex, raw_birth_date, raw_birth_province,
         raw_age_by_june, raw_mother_tongue, raw_ip_group, raw_religion, raw_house_street,
         raw_barangay, raw_municipality, raw_province, raw_father_name, raw_mother_name,
         raw_guardian_name, raw_guardian_rel, raw_contact_number, raw_remarks,
         raw_grade_level, raw_section)
        VALUES (:iid, :rn, :c0, :c1, :c2, :c3, :c4, :c5, :c6, :c7, :c8, :c9, :c10, :c11,
                :c12, :c13, :c14, :c15, :c16, :c17, :c18, :c19, :c20)
        ON DUPLICATE KEY UPDATE
          raw_lrn=VALUES(raw_lrn), raw_name=VALUES(raw_name), raw_sex=VALUES(raw_sex),
          raw_birth_date=VALUES(raw_birth_date), raw_birth_province=VALUES(raw_birth_province),
          raw_age_by_june=VALUES(raw_age_by_june), raw_mother_tongue=VALUES(raw_mother_tongue),
          raw_ip_group=VALUES(raw_ip_group), raw_religion=VALUES(raw_religion),
          raw_house_street=VALUES(raw_house_street), raw_barangay=VALUES(raw_barangay),
          raw_municipality=VALUES(raw_municipality), raw_province=VALUES(raw_province),
          raw_father_name=VALUES(raw_father_name), raw_mother_name=VALUES(raw_mother_name),
          raw_guardian_name=VALUES(raw_guardian_name), raw_guardian_rel=VALUES(raw_guardian_rel),
          raw_contact_number=VALUES(raw_contact_number), raw_remarks=VALUES(raw_remarks),
          raw_grade_level=VALUES(raw_grade_level), raw_section=VALUES(raw_section),
          validation_status="Pending", planned_action=NULL, messages=NULL');

    $staged = 0;
    $conn->beginTransaction();
    try {
        foreach ($rows as $r) {
            if (!is_array($r)) continue;
            $rn = (int)($r['row_number'] ?? 0);
            if ($rn <= 0) continue;
            $stmt->bindValue(':iid', $importId, PDO::PARAM_INT);
            $stmt->bindValue(':rn', $rn, PDO::PARAM_INT);
            foreach ($cols as $i => $c) {
                $v = $r[$c] ?? null;
                if ($v !== null && !is_scalar($v)) $v = null;
                bindNullable($stmt, ":c{$i}", nullIfEmpty($v === null ? null : (string)$v));
            }
            $stmt->execute();
            $staged++;
        }
        $conn->commit();
    } catch (Exception $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
    respond(['success' => true, 'staged' => $staged]);
}

function validateLisImport(PDO $conn, array $session): void {
    requireImportTables($conn);
    $d = getJsonInput();
    $importId = (int)($d['import_id'] ?? 0);
    if ($importId <= 0) respond(['success' => false, 'message' => 'import_id is required'], 422);
    $batch = importBatchOr404($conn, $importId, $session);

    $schoolYearId = (int)$batch['school_year_id'];
    $defaultGradeId = intOrNull($d['default_grade_level_id'] ?? null);
    $fallbackSectionId = intOrNull($d['fallback_section_id'] ?? null);
    $defaultEnrollmentTypeId = intOrNull($d['enrollment_type_id'] ?? null);
    $defaultEntryClassification = EnrollmentEntryClassificationService::fromEnrollmentTypeId($conn, $defaultEnrollmentTypeId);
    if ($fallbackSectionId !== null && !teacherCanManageSection($conn, $session, $fallbackSectionId, $schoolYearId)) {
        respond(['success' => false, 'message' => 'Section exists, but you are not the adviser assigned to this section. Please make sure you are the adviser before importing learners.'], 403);
    }

    // preload sections for this SY: normalized name + grade → row, plus availability
    $sections = [];
    $allSections = [];
    $sectionAvail = [];
    $teacherFilter = '';
    $teacherId = null;
    if (($session['role_key'] ?? '') === 'teacher') {
        $teacherId = getTeacherEmployeeId($conn, $session);
        $teacherFilter = ' AND s.adviser_id = :adviser_id';
    }

    $sectionSql = "SELECT s.section_id, s.section_name, s.grade_level_id, s.max_capacity, s.adviser_id,
                          gl.grade_name, sy.year_label, COALESCE(ec.cnt, 0) AS enrolled
                   FROM sections s
                   LEFT JOIN grade_levels gl ON gl.grade_level_id = s.grade_level_id
                   LEFT JOIN school_years sy ON sy.school_year_id = s.school_year_id
                   LEFT JOIN (SELECT section_id, COUNT(*) cnt FROM enrollments
                              WHERE is_deleted = 0 AND school_year_id = :sy
                                AND enrollment_status = 'Enrolled'
                              GROUP BY section_id) ec ON ec.section_id = s.section_id
                   WHERE s.is_deleted = 0 AND s.school_year_id = :sy2";
    $allQ = $conn->prepare($sectionSql);
    $allQ->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $allQ->bindValue(':sy2', $schoolYearId, PDO::PARAM_INT);
    $allQ->execute();
    while ($s = $allQ->fetch(PDO::FETCH_ASSOC)) {
        $key = (int)$s['grade_level_id'] . '|' . normalizeImportMatchText((string)$s['section_name']);
        $allSections[$key] = $s;
    }

    $q = $conn->prepare($sectionSql . $teacherFilter);
    $q->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
    $q->bindValue(':sy2', $schoolYearId, PDO::PARAM_INT);
    if ($teacherId !== null) {
        $q->bindValue(':adviser_id', $teacherId, PDO::PARAM_INT);
    }
    $q->execute();
    while ($s = $q->fetch(PDO::FETCH_ASSOC)) {
        $key = (int)$s['grade_level_id'] . '|' . normalizeImportMatchText((string)$s['section_name']);
        $sections[$key] = $s;
        $sectionAvail[(int)$s['section_id']] = max(0, (int)$s['max_capacity'] - (int)$s['enrolled']);
    }
    $sectionById = [];
    foreach ($sections as $s) $sectionById[(int)$s['section_id']] = $s;
    $allSectionById = [];
    foreach ($allSections as $s) $allSectionById[(int)$s['section_id']] = $s;

    $ageReferenceToday = new DateTimeImmutable('now', new DateTimeZone('Asia/Manila'));

    $rows = $conn->prepare('SELECT * FROM sf1_import_staging WHERE import_id = :id ORDER BY `row_number`');
    $rows->bindValue(':id', $importId, PDO::PARAM_INT);
    $rows->execute();
    $all = $rows->fetchAll(PDO::FETCH_ASSOC);

    $upd = $conn->prepare('UPDATE sf1_import_staging SET
        norm_lrn = :nlrn, norm_last_name = :nln, norm_first_name = :nfn,
        norm_middle_name = :nmn, norm_name_extension = :next_, norm_sex = :nsex,
        norm_birth_date = :ndob, norm_contact_number = :ncn,
        resolved_grade_level_id = :rgid, resolved_section_id = :rsid,
        resolved_birth_province_id = :rbpid, resolved_province_id = :rpid,
        resolved_city_municipality_id = :rcid, resolved_barangay_id = :rbid,
        resolved_learner_status = :rls, resolved_enrollment_status = :res,
        resolved_enrollment_type_id = :retid,
        detected_entry_classification = :entry_classification,
        detected_lwd = :detected_lwd,
        matched_learner_id = :mlid, matched_enrollment_id = :meid,
        validation_status = :vs, planned_action = :pa, messages = :msgs
        WHERE staging_id = :sid');

    $seenLrn = [];
    $incomingPerSection = [];   // section_id => [staging rows needing a new slot]
    $summary = ['total' => count($all), 'insert' => 0, 'update' => 0, 'revive' => 0,
                'promote' => 0, 'returnee' => 0, 'transfer_in' => 0,
                'late_enrollment' => 0, 'lwd' => 0,
                'error' => 0, 'warning' => 0, 'valid' => 0, 'skip' => 0];

    // pass 1: per-row normalization + resolution
    $plans = [];
    foreach ($all as $r) {
        $E = []; $W = []; $I = [];
        $msg = function (&$arr, $f, $m) { $arr[] = ['field' => $f, 'message' => $m]; };

        if (($r['planned_action'] ?? null) === 'Skip') {
            $plans[$r['staging_id']] = ['row' => $r, 'action' => 'Skip', 'E' => [], 'W' => [], 'I' => [],
                'vals' => array_fill_keys(['nlrn','nln','nfn','nmn','next_','nsex','ndob','ncn',
                    'rgid','rsid','rbpid','rpid','rcid','rbid','rls','res','retid',
                    'entry_classification','detected_lwd',
                    'mlid','meid'], null)];
            $summary['skip']++;
            continue;
        }

        // LRN
        $lrnNote = null;
        $lrn = repairLrnForImport($r['raw_lrn'], $lrnNote);
        if ($lrnNote) $msg($W, 'lrn', $lrnNote);
        if ($lrn === null) $msg($E, 'lrn', 'Invalid LRN — must be exactly 12 digits');
        elseif (isset($seenLrn[$lrn])) $msg($E, 'lrn', "Duplicate LRN — same LRN appears earlier in the file (row {$seenLrn[$lrn]})");
        else $seenLrn[$lrn] = (int)$r['row_number'];

        // Name
        $nm = parseFullNameForImport($r['raw_name']);
        if ($nm === null) $msg($E, 'name', 'Could not parse name — please use "LAST, FIRST MIDDLE" format');
        else {
            // A two-part given name is normalized automatically by the import
            // contract. It is not an import warning; only real validation
            // failures should interrupt an otherwise successful import.
            $extensionCheck = validateImportNameExtension($conn, $nm['name_extension'] ?? null);
            if (!$extensionCheck['valid']) {
                $msg($E, 'name_extension', $extensionCheck['message']);
            } else {
                $nm['name_extension'] = $extensionCheck['value'];
            }
        }

        // Sex
        $sex = normalizeSexForImport($r['raw_sex']);
        if (nullIfEmpty($r['raw_sex']) !== null && $sex === null) {
            $msg($E, 'sex', 'Sex not recognized — use M (Male) or F (Female)');
        }

        // Birth date + range + age cross-check
        $dobNote = null;
        $dob = normalizeDateForImport($r['raw_birth_date'], $dobNote);
        if ($dobNote) $msg($W, 'birth_date', $dobNote);
        if (nullIfEmpty($r['raw_birth_date']) !== null && $dob === null) {
            $msg($E, 'birth_date', 'Birth date could not be read — check the format');
        }
        if ($dob !== null) {
            if ($dob > date('Y-m-d') || $dob < date('Y-m-d', strtotime('-60 years'))) {
                $msg($E, 'birth_date', 'Birth date is outside a realistic range');
                $dob = null;
            } else {
                $ageWarning = getImportAgeWarning($dob, $r['raw_age_by_june'], $ageReferenceToday);
                if ($ageWarning !== null) $msg($W, 'age', $ageWarning);
            }
        }

        // Contact
        $cnNote = null;
        $contact = normalizeContactForImport($r['raw_contact_number'], $cnNote);
        if ($cnNote) $msg($W, 'contact', $cnNote);

        // Mother tongue (LIS text + DepEd major-language guidance)
        $mt = validateMotherTongueForImport($conn, $r['raw_mother_tongue']);
        if ($mt['warning']) $msg($W, 'mother_tongue', $mt['warning']);

        // Grade
        $fileGradeId = resolveGradeLevelId($conn, $r['raw_grade_level']);
        $gradeId = $fileGradeId ?? $defaultGradeId;
        if ($gradeId === null) $msg($E, 'grade', 'Grade level not recognized and no default was selected');
        elseif ($defaultGradeId !== null && $fileGradeId !== null && $gradeId !== $defaultGradeId) {
            $msg($W, 'grade', 'Grade in the file differs from the selected grade level');
        }

        // Remark → statuses + type
        $remark = mapSf1Remark($conn, $r['raw_remarks']);
        if (($remark['enrollment_type_id'] ?? null) === null && $defaultEnrollmentTypeId !== null) {
            $remark['enrollment_type_id'] = $defaultEnrollmentTypeId;
        }
        if (($remark['entry_classification'] ?? null) === null && $defaultEntryClassification !== null) {
            $remark['entry_classification'] = $defaultEntryClassification;
        }
        if (!$remark['recognized']) $msg($W, 'remarks', 'Remark not recognized — default enrollment settings will be used');
        $enrollmentStatus = $remark['enrollment_status'];
        $learnerStatus = $remark['learner_status'] ?? 'Enrolled';
        $isSourceReturnee = !empty($remark['explicit_returnee']);
        $isSourceTransferIn = ($remark['entry_classification'] ?? null) === 'Transfer-In';
        $isSourceLateEnrollment = EnrollmentEntryClassificationService::isLateEnrollment($remark['entry_classification'] ?? null);
        $isSourceLwd = !empty($remark['is_lwd']);
        $isSourceLifecycleStatus = in_array($enrollmentStatus, ['Transferred Out', 'Dropped'], true);
        $entryClassification = $remark['entry_classification'] ?? null;
        if ($isSourceReturnee) {
            $enrollmentStatus = 'Enrolled';
            $learnerStatus = 'Enrolled';
            $remark['enrollment_type_id'] = ReturneeCaseService::balikAralTypeId($conn) ?? $remark['enrollment_type_id'];
        } elseif ($isSourceTransferIn) {
            $enrollmentStatus = 'Enrolled';
            $learnerStatus = 'Enrolled';
            $remark['enrollment_type_id'] = getDefaultEnrollmentTypeId($conn, 'Transfer-In') ?? $remark['enrollment_type_id'];
        }
        if ($isSourceLateEnrollment) {
            $msg($I, 'late_enrollment', 'Source record identifies this learner as Late Enrollment. The target enrollment remains Enrolled and is stored as Late Enrollment.');
            $enrollmentStatus = 'Enrolled';
            $learnerStatus = 'Enrolled';
        }
        if ($isSourceLwd) {
            $msg($I, 'lwd', 'Source record identifies this learner as LWD. The BoSY identifier will be stored separately from enrollment status.');
        }

        // Section
        $sectionId = null;
        if ($gradeId !== null) {
            $wanted = normalizeImportMatchText((string)($r['raw_section'] ?? ''));
            $sectionIssueAdded = false;
            if ($wanted !== '' && isset($sections[$gradeId . '|' . $wanted])) {
                // Exact match by name + grade
                $sectionId = (int)$sections[$gradeId . '|' . $wanted]['section_id'];
            } elseif ($wanted !== '') {
                if (isset($allSections[$gradeId . '|' . $wanted])) {
                    $existing = $allSections[$gradeId . '|' . $wanted];
                    $msg($E, 'section', 'Section "' . ($existing['section_name'] ?? $r['raw_section']) . '" exists for '
                        . ($existing['grade_name'] ?? 'the selected grade') . ' in '
                        . ($existing['year_label'] ?? 'the selected school year')
                        . ', but you are not the adviser assigned to this section. Please make sure you are the adviser before importing learners.');
                    $sectionIssueAdded = true;
                }
                // Try matching section name across all grades (case: file has section but grade differs)
                $foundAlt = null;
                foreach ($sections as $sKey => $sRow) {
                    if (normalizeImportMatchText((string)$sRow['section_name']) === $wanted) {
                        $foundAlt = $sRow;
                        break;
                    }
                }
                if ($foundAlt !== null) {
                    $sectionId = (int)$foundAlt['section_id'];
                    if ((int)$foundAlt['grade_level_id'] !== $gradeId) {
                        $msg($W, 'section', 'Section found but belongs to a different grade — will use it, please verify');
                    }
                } elseif ($fallbackSectionId !== null && isset($sectionById[$fallbackSectionId])) {
                    $sectionId = $fallbackSectionId;
                    $msg($W, 'section', 'Section in file not found — will use the selected section instead');
                } elseif (!$sectionIssueAdded) {
                    $foundAny = null;
                    foreach ($allSections as $sKey => $sRow) {
                        if (normalizeImportMatchText((string)$sRow['section_name']) === $wanted) {
                            $foundAny = $sRow;
                            break;
                        }
                    }
                    if ($foundAny !== null) {
                        $msg($E, 'section', 'Section "' . ($foundAny['section_name'] ?? $r['raw_section']) . '" exists in '
                            . ($foundAny['year_label'] ?? 'the selected school year')
                            . ' but belongs to ' . ($foundAny['grade_name'] ?? 'a different grade')
                            . ', not ' . getImportGradeName($conn, $gradeId) . '.');
                    } else {
                        $msg($E, 'section', 'Section "' . (string)($r['raw_section'] ?? '') . '" does not exist in the Sections masterfile for the selected school year and grade level.');
                    }
                }
            } elseif ($fallbackSectionId !== null && isset($sectionById[$fallbackSectionId])) {
                // No section in file — use fallback (trust the user's explicit selection)
                $sectionId = $fallbackSectionId;
                if ((int)$sectionById[$fallbackSectionId]['grade_level_id'] !== $gradeId) {
                    $msg($W, 'section', 'Selected section belongs to a different grade — please verify');
                }
            } elseif ($fallbackSectionId !== null && isset($allSectionById[$fallbackSectionId])) {
                $existing = $allSectionById[$fallbackSectionId];
                $msg($E, 'section', 'Selected section "' . ($existing['section_name'] ?? '') . '" exists, but you are not the adviser assigned to this section. Please make sure you are the adviser before importing learners.');
            } else {
                $msg($E, 'section', 'No section specified — please select a section before importing');
            }
        }

        // LIS location values are authoritative text. Legacy resolution IDs remain
        // NULL and are no longer derived from retired geo seed tables.
        $bprov = null;
        $prov = null;
        $mun = null;
        $brgy = null;

        // Learner match (incl. soft-deleted → Revive)
        $mlid = null; $meid = null; $action = 'Insert';
        $matchedEnrollment = null;
        if ($lrn !== null) {
            $f = $conn->prepare('SELECT learner_id, is_deleted FROM learners WHERE lrn = :lrn
                                 ORDER BY is_deleted ASC, learner_id DESC LIMIT 1');
            $f->bindValue(':lrn', $lrn);
            $f->execute();
            if ($m = $f->fetch(PDO::FETCH_ASSOC)) {
                $mlid = (int)$m['learner_id'];
                $action = !empty($m['is_deleted']) ? 'Revive' : 'Update';
                $e = $conn->prepare('SELECT enrollment_id, is_deleted, grade_level_id, section_id,
                                            enrollment_status, enrollment_type_id, entry_classification
                                     FROM enrollments
                                     WHERE learner_id = :lid AND school_year_id = :sy
                                     ORDER BY is_deleted ASC, enrollment_id DESC LIMIT 1');
                $e->bindValue(':lid', $mlid, PDO::PARAM_INT);
                $e->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
                $e->execute();
                if ($er = $e->fetch(PDO::FETCH_ASSOC)) {
                    $matchedEnrollment = $er;
                    $meid = (int)$er['enrollment_id'];
                }
            }
        }

        // Entry classification describes how the learner entered this
        // enrollment. Lifecycle remarks such as T/O and DRP change the
        // enrollment status but must not erase an existing T/I, B/A, or LE
        // classification. Only an unmatched learner receives New here.
        if ($entryClassification === null) {
            $entryClassification = $isSourceReturnee
                ? 'Returnee'
                : ($mlid === null
                    ? 'New'
                    : (in_array($enrollmentStatus, ['Transferred Out', 'Dropped'], true) ? null : 'Update'));
        }

        if ($mlid !== null && $gradeId !== null && $sectionId !== null && empty($E)) {
            if ($matchedEnrollment) {
                $existingGradeId = (int)$matchedEnrollment['grade_level_id'];
                $existingSectionId = (int)$matchedEnrollment['section_id'];
                if ($existingGradeId !== $gradeId) {
                    $msg($E, 'grade', 'Existing learner is already enrolled in this school year under '
                        . getImportGradeName($conn, $existingGradeId) . '. The imported grade is '
                        . getImportGradeName($conn, $gradeId)
                        . '; correct the import school year/grade header values before committing.');
                } elseif ($existingSectionId !== $sectionId) {
                    $fromSection = getImportSectionName($conn, $existingSectionId);
                    $toSection = getImportSectionName($conn, $sectionId);
                    $I[] = [
                        'field' => 'section',
                        'code' => 'section_transfer',
                        'from_section' => $fromSection,
                        'to_section' => $toSection,
                        'message' => "Section transfer: {$fromSection} → {$toSection}. Same school year and grade; the existing enrollment will be updated when import completes.",
                    ];
                } else {
                    $msg($I, 'learner', 'Existing learner found in the same school year, grade, and section. Personal details will be refreshed.');
                }
            } else {
                if ($isSourceReturnee) {
                    $academicEvidence = assessImportAcademicReturnee($conn, $mlid, $schoolYearId, $gradeId);
                    $msg($I, 'returnee', 'Source record identifies this learner as Balik-Aral. A new target-year enrollment will be stored as Enrolled / Returnee.');
                    if ($academicEvidence['candidate']) {
                        $msg($W, 'returnee_academic', 'Academic record validation: the previous same-grade record has '
                            . implode('; ', $academicEvidence['reasons'])
                            . '. Source Returnee status is retained.');
                    } elseif ($academicEvidence['checked'] && $academicEvidence['same_grade']) {
                        $msg($I, 'returnee_academic', 'Academic record validation: the previous same-grade record has no detected missing or failing final grades.');
                    }
                } elseif ($isSourceTransferIn) {
                    $msg($I, 'transfer_in', 'Source record identifies this learner as Transfer-In. The target-year enrollment will be stored as Enrolled / Transfer-In; prior local enrollment history is preserved.');
                } elseif ($isSourceLateEnrollment || $isSourceLifecycleStatus) {
                    $entryClassification = $entryClassification ?? 'New';
                    $msg($I, 'source_status', 'The source status is authoritative. No local promotion or previous-grade completeness check is required for this imported row.');
                } else {
                    $academicEvidence = ['candidate' => false, 'checked' => false, 'prior' => null, 'reasons' => []];
                    if (nullIfEmpty($r['raw_remarks']) === null) {
                        $academicEvidence = assessImportAcademicReturnee($conn, $mlid, $schoolYearId, $gradeId);
                    }
                    if ($academicEvidence['candidate']) {
                        $entryClassification = 'Returnee';
                        $enrollmentStatus = 'Enrolled';
                        $learnerStatus = 'Enrolled';
                        $remark['enrollment_type_id'] = ReturneeCaseService::balikAralTypeId($conn) ?? $remark['enrollment_type_id'];
                        $priorYear = $academicEvidence['prior']['year_label'] ?? 'the previous school year';
                        $msg($I, 'returnee', 'Remarks is blank, but academic record validation identifies a same-grade re-entry from '
                            . $priorYear . ': ' . implode('; ', $academicEvidence['reasons'])
                            . '. The learner will be stored as Enrolled / Returnee.');
                    } else {
                        $entryClassification = 'Promote';
                        if (nullIfEmpty($r['raw_remarks']) === null) {
                            $msg($W, 'remarks', 'Remarks is blank. Academic records did not meet the guarded same-grade Returnee fallback, so promotion validation was applied.');
                        }
                        $promotionCheck = buildPromotionImportMessages($conn, $mlid, $schoolYearId, $gradeId, $sectionId);
                        foreach ($promotionCheck['messages'] as $promotionMessage) {
                            $severity = $promotionMessage['severity'] ?? 'I';
                            if ($severity === 'E') {
                                $msg($E, $promotionMessage['field'] ?? 'promotion', $promotionMessage['message'] ?? 'Promotion validation failed.');
                            } elseif ($severity === 'W') {
                                $msg($W, $promotionMessage['field'] ?? 'promotion', $promotionMessage['message'] ?? 'Promotion validation warning.');
                            } else {
                                $msg($I, $promotionMessage['field'] ?? 'promotion', $promotionMessage['message'] ?? 'Promotion validation note.');
                            }
                        }
                    }
                }
            }
        } elseif ($isSourceReturnee) {
            $msg($I, 'returnee', 'Source record identifies this learner as Balik-Aral. The imported learner will be enrolled as Returnee.');
        }

        // capacity bookkeeping: only Enrolled rows without an existing active enrollment need a slot
        $needsSlot = ($enrollmentStatus === 'Enrolled' && $sectionId !== null && empty($E));
        if ($needsSlot && $meid !== null && $action === 'Update') {
            // has an active enrollment already this SY → no new slot
            $chk = $conn->prepare('SELECT enrollment_status, is_deleted FROM enrollments WHERE enrollment_id = :id');
            $chk->bindValue(':id', $meid, PDO::PARAM_INT);
            $chk->execute();
            $er = $chk->fetch(PDO::FETCH_ASSOC);
            if ($er && empty($er['is_deleted']) && ($er['enrollment_status'] ?? '') === 'Enrolled') {
                $currentSectionId = $matchedEnrollment ? (int)$matchedEnrollment['section_id'] : $sectionId;
                $needsSlot = $currentSectionId !== $sectionId;
            }
        }

        $noChanges = false;
        if ($action === 'Update' && $mlid !== null && $matchedEnrollment !== null && empty($E)) {
            $noChanges = !importExistingRecordHasChanges($conn, $mlid, $r, [
                'nfn' => $nm['first_name'] ?? null,
                'nln' => $nm['last_name'] ?? null,
                'nmn' => nullIfEmpty($nm['middle_name'] ?? null),
                'next_' => nullIfEmpty($nm['name_extension'] ?? null),
                'nsex' => $sex,
                'ndob' => $dob,
                'ncn' => $contact,
                'nlrn' => $lrn,
                'rgid' => $gradeId,
                'rsid' => $sectionId,
                'res' => $enrollmentStatus,
                'retid' => $remark['enrollment_type_id'],
                'entry_classification' => $entryClassification,
                'detected_lwd' => $isSourceLwd ? 1 : 0,
            ], $matchedEnrollment);
            if ($noChanges) {
                $action = 'Skip';
                $I[] = [
                    'field' => 'learner',
                    'code' => 'no_changes',
                    'message' => 'No changes detected. This learner will be skipped.',
                ];
                $needsSlot = false;
            }
        }

        $plans[$r['staging_id']] = [
            'row' => $r, 'action' => $action, 'E' => $E, 'W' => $W, 'I' => $I,
            'noChanges' => $noChanges,
            'needsSlot' => $needsSlot, 'sectionId' => $sectionId,
            'vals' => [
                'nlrn' => $lrn,
                'nln' => $nm['last_name'] ?? null, 'nfn' => $nm['first_name'] ?? null,
                'nmn' => nullIfEmpty($nm['middle_name'] ?? null),
                'next_' => nullIfEmpty($nm['name_extension'] ?? null),
                'nsex' => $sex, 'ndob' => $dob, 'ncn' => $contact,
                'rgid' => $gradeId, 'rsid' => $sectionId, 'rbpid' => $bprov,
                'rpid' => $prov, 'rcid' => $mun, 'rbid' => $brgy,
                'rls' => $learnerStatus, 'res' => $enrollmentStatus,
                'retid' => $remark['enrollment_type_id'],
                'entry_classification' => $entryClassification,
                'detected_lwd' => $isSourceLwd ? 1 : 0,
                'mlid' => $mlid, 'meid' => $meid,
            ],
        ];
    }

    // pass 2: capacity forecast per section (file order; overflow rows → Error)
    $slotUse = [];
    foreach ($plans as $sid => &$p) {
        if (empty($p['needsSlot'])) continue;
        $sec = (int)$p['sectionId'];
        $slotUse[$sec] = ($slotUse[$sec] ?? 0) + 1;
        if ($slotUse[$sec] > ($sectionAvail[$sec] ?? 0)) {
            $name = $sectionById[$sec]['section_name'] ?? "#{$sec}";
            $p['E'][] = ['field' => 'capacity',
                'message' => "Section \"{$name}\" is full — only " . ($sectionAvail[$sec] ?? 0) . " slot(s) available"];
        }
    }
    unset($p);

    // pass 3: persist
    foreach ($plans as $sid => $p) {
        if ($p['action'] === 'Skip') {
            $pa = 'Skip';
            if (!empty($p['noChanges'])) {
                $vs = 'Valid';
                $summary['skip']++;
                $summary['valid']++;
                $messages = json_encode($p['I'] ?: [[
                    'severity' => 'I',
                    'field' => 'learner',
                    'code' => 'no_changes',
                    'message' => 'No changes detected. This learner will be skipped.',
                ]], JSON_UNESCAPED_UNICODE);
            } else {
                $vs = 'Error';
                $messages = json_encode([['severity' => 'I', 'field' => '-', 'message' => 'Excluded by user']], JSON_UNESCAPED_UNICODE);
            }
        } else {
            $vs = $p['E'] ? 'Error' : ($p['W'] ? 'Warning' : 'Valid');
            $pa = $p['E'] ? 'Reject' : $p['action'];
            $msgs = [];
            foreach ($p['E'] as $m) $msgs[] = ['severity' => 'E'] + $m;
            foreach ($p['W'] as $m) $msgs[] = ['severity' => 'W'] + $m;
            foreach (($p['I'] ?? []) as $m) $msgs[] = ['severity' => 'I'] + $m;
            $messages = $msgs ? json_encode($msgs, JSON_UNESCAPED_UNICODE) : null;
            if ($vs === 'Error') $summary['error']++;
            elseif ($vs === 'Warning') $summary['warning']++;
            else $summary['valid']++;
            if ($vs !== 'Error') {
                if ($pa === 'Insert') $summary['insert']++;
                elseif ($pa === 'Update') $summary['update']++;
                elseif ($pa === 'Revive') $summary['revive']++;
            }
        }
        $v = $p['vals'];
        if ($vs !== 'Error') {
            if (($v['entry_classification'] ?? '') === 'Promote') $summary['promote']++;
            if (($v['entry_classification'] ?? '') === 'Returnee') $summary['returnee']++;
            if (($v['entry_classification'] ?? '') === 'Transfer-In') $summary['transfer_in']++;
            if (($v['entry_classification'] ?? '') === 'Late Enrollment') $summary['late_enrollment']++;
            if (!empty($v['detected_lwd'])) $summary['lwd']++;
        }
        foreach (['nlrn','nln','nfn','nmn','next_','nsex','ndob','ncn','rls','res',
                  'entry_classification'] as $k) {
            bindNullable($upd, ':' . $k, $v[$k]);
        }
        foreach (['rgid','rsid','rbpid','rpid','rcid','rbid','retid','mlid','meid'] as $k) {
            bindNullable($upd, ':' . $k, $v[$k], PDO::PARAM_INT);
        }
        $upd->bindValue(':detected_lwd', (int)($v['detected_lwd'] ?? 0), PDO::PARAM_INT);
        $upd->bindValue(':vs', $vs);
        $upd->bindValue(':pa', $pa);
        bindNullable($upd, ':msgs', $messages);
        $upd->bindValue(':sid', (int)$sid, PDO::PARAM_INT);
        $upd->execute();
    }

    respond(['success' => true, 'summary' => $summary]);
}

function getLisImportPreview(PDO $conn, array $session): void {
    requireImportTables($conn);
    $importId = (int)($_GET['import_id'] ?? 0);
    if ($importId <= 0) respond(['success' => false, 'message' => 'import_id is required'], 422);
    importBatchOr404($conn, $importId, $session, null);

    $stmt = $conn->prepare('SELECT st.`row_number`,
                                   st.raw_lrn, st.raw_name, st.raw_sex, st.raw_birth_date,
                                   st.raw_age_by_june, st.raw_birth_province, st.raw_mother_tongue,
                                   st.raw_ip_group, st.raw_religion, st.raw_house_street,
                                   st.raw_barangay, st.raw_municipality, st.raw_province,
                                   st.raw_father_name, st.raw_mother_name,
                                   st.raw_guardian_name, st.raw_guardian_rel,
                                   st.raw_contact_number, st.raw_remarks,
                                   st.raw_grade_level, st.raw_section,
                                   st.norm_lrn, st.norm_last_name, st.norm_first_name, st.norm_middle_name,
                                   st.norm_sex, st.norm_birth_date, st.norm_contact_number,
                                   st.validation_status, st.planned_action, st.messages,
                                   st.detected_entry_classification,
                                   st.detected_lwd,
                                   st.matched_learner_id, st.matched_enrollment_id,
                                   s.section_name AS resolved_section_name,
                                   gl.grade_name AS resolved_grade_name
                            FROM sf1_import_staging st
                            LEFT JOIN sections s ON s.section_id = st.resolved_section_id
                            LEFT JOIN grade_levels gl ON gl.grade_level_id = st.resolved_grade_level_id
                            WHERE st.import_id = :id ORDER BY st.`row_number`');
    $stmt->bindValue(':id', $importId, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$r) {
        $r['messages'] = $r['messages'] ? (json_decode($r['messages'], true) ?: []) : [];
    }
    unset($r);

    // capacity forecast view
    $cap = $conn->prepare("SELECT s.section_id, s.section_name, gl.grade_name, s.max_capacity,
                                  COALESCE(ec.cnt,0) AS enrolled,
                                  COALESCE(inc.cnt,0) AS incoming
                           FROM sections s
                           JOIN grade_levels gl ON gl.grade_level_id = s.grade_level_id
                           LEFT JOIN (SELECT section_id, COUNT(*) cnt FROM enrollments
                                      WHERE is_deleted = 0 AND enrollment_status = 'Enrolled'
                                      GROUP BY section_id) ec ON ec.section_id = s.section_id
                           JOIN (SELECT resolved_section_id sid, COUNT(*) cnt FROM sf1_import_staging
                                 WHERE import_id = :id AND validation_status <> 'Error'
                                   AND resolved_enrollment_status = 'Enrolled'
                                   AND (matched_enrollment_id IS NULL OR planned_action = 'Revive')
                                 GROUP BY resolved_section_id) inc ON inc.sid = s.section_id
                           LEFT JOIN (SELECT 1) dummy ON 1=1
                           WHERE s.is_deleted = 0");
    $cap->bindValue(':id', $importId, PDO::PARAM_INT);
    $cap->execute();

    respond(['success' => true, 'rows' => $rows, 'capacity' => $cap->fetchAll(PDO::FETCH_ASSOC)]);
}

function excludeLisImportRows(PDO $conn, array $session): void {
    requireImportTables($conn);
    $d = getJsonInput();
    $importId = (int)($d['import_id'] ?? 0);
    $rowNumbers = is_array($d['row_numbers'] ?? null) ? array_map('intval', $d['row_numbers']) : [];
    if ($importId <= 0 || !$rowNumbers) {
        respond(['success' => false, 'message' => 'import_id and row_numbers[] are required'], 422);
    }
    importBatchOr404($conn, $importId, $session);
    $ph = implode(',', array_fill(0, count($rowNumbers), '?'));
    $stmt = $conn->prepare("UPDATE sf1_import_staging
                            SET planned_action = 'Skip', validation_status = 'Error',
                                messages = JSON_ARRAY(JSON_OBJECT('severity','I','field','-','message','Excluded by user'))
                            WHERE import_id = ? AND `row_number` IN ($ph)");
    $stmt->execute(array_merge([$importId], $rowNumbers));
    respond(['success' => true, 'excluded' => $stmt->rowCount()]);
}

function commitLisImport(PDO $conn, array $session): void {
    requireImportTables($conn);
    $d = getJsonInput();
    $importId = (int)($d['import_id'] ?? 0);
    if ($importId <= 0) respond(['success' => false, 'message' => 'import_id is required'], 422);
    $batch = importBatchOr404($conn, $importId, $session);
    $schoolYearId = (int)$batch['school_year_id'];

    $chunk = min(200, max(1, (int)($d['chunk_size'] ?? 50)));
    $passwordMode = (string)($d['default_password_mode'] ?? 'lrn');
    $passwordCustom = nullIfEmpty($d['default_password_custom'] ?? null);
    $defaultEtypeId = intOrNull($d['enrollment_type_id'] ?? null);
    $lifecycle = new EnrollmentLifecycleService($conn);
    $movementService = new EnrollmentMovementService($conn);

    // rows not yet committed = still have planned_action Insert/Update/Revive and no log row
    $sel = $conn->prepare("SELECT st.* FROM sf1_import_staging st
                           WHERE st.import_id = :id
                             AND st.planned_action IN ('Insert','Update','Revive')
                             AND NOT EXISTS (SELECT 1 FROM import_log_rows ilr
                                             WHERE ilr.import_id = st.import_id
                                               AND ilr.`row_number` = st.`row_number`)
                           ORDER BY st.`row_number` LIMIT " . $chunk);
    $sel->bindValue(':id', $importId, PDO::PARAM_INT);
    $sel->execute();
    $rows = $sel->fetchAll(PDO::FETCH_ASSOC);

    $results = [];
    foreach ($rows as $r) {
        $rn = (int)$r['row_number'];
        $lrn = (string)$r['norm_lrn'];
        $notes = [];
        $rawJson = json_encode(array_filter($r, fn ($k) => str_starts_with($k, 'raw_'), ARRAY_FILTER_USE_KEY),
                               JSON_UNESCAPED_UNICODE);
        try {
            $conn->beginTransaction();

            $gradeId = (int)$r['resolved_grade_level_id'];
            $sectionId = (int)$r['resolved_section_id'];
            $enrollStatus = $lifecycle->normalizeStatus($r['resolved_enrollment_status'] ?: 'Enrolled');
            $etypeId = intOrNull($r['resolved_enrollment_type_id']) ?? $defaultEtypeId;
            $streetText = nullIfEmpty($r['raw_house_street']);
            $flatAddr = implode(', ', array_filter([
                $streetText, nullIfEmpty($r['raw_barangay']),
                nullIfEmpty($r['raw_municipality']), nullIfEmpty($r['raw_province'])]));

            $mlid = intOrNull($r['matched_learner_id']);
            $action = (string)$r['planned_action'];
            $detectedEntryClassification = EnrollmentEntryClassificationService::normalize(
                $r['detected_entry_classification'] ?? null
            );
            $entryClassification = $detectedEntryClassification
                ?? ($mlid === null ? 'New' : null);
            $sourceRemark = nullIfEmpty($r['raw_remarks']);
            $detectedLwd = !empty($r['detected_lwd']);
            $movementContext = [
                'source_type' => EnrollmentMovementService::SOURCE_LIS_IMPORT,
                'import_id' => $importId,
                'import_row_number' => $rn,
                'raw_lis_remark' => $sourceRemark,
                'user_id' => (int)($session['user_id'] ?? 0),
            ];

            if ($mlid !== null) {
                if ($action === 'Revive') {
                    $rev = $conn->prepare('UPDATE learners SET is_deleted = 0, deleted_at = NULL WHERE learner_id = :id');
                    $rev->bindValue(':id', $mlid, PDO::PARAM_INT);
                    $rev->execute();
                    $notes[] = 'Previously removed learner has been restored';
                }
                // partial update: only non-null normalized values
                $up = []; $pv = [':id' => $mlid];
                $set = function ($col, $val, $key = null) use (&$up, &$pv) {
                    if ($val === null) return;
                    $key = $key ?? $col;
                    $up[] = "$col = :$key"; $pv[":$key"] = $val;
                };
                $set('first_name', nullIfEmpty($r['norm_first_name']), 'fn');
                $set('middle_name', nullIfEmpty($r['norm_middle_name']), 'mn');
                $set('last_name', nullIfEmpty($r['norm_last_name']), 'ln');
                $set('name_extension', nullIfEmpty($r['norm_name_extension']), 'ext');
                $set('full_name_raw', nullIfEmpty($r['raw_name']), 'fnr');
                $set('date_of_birth', nullIfEmpty($r['norm_birth_date']), 'dob');
                $oldLearnerStmt = $conn->prepare('SELECT lrn, date_of_birth, sex, gender, indigenous_group, is_indigenous FROM learners WHERE learner_id = :id LIMIT 1');
                $oldLearnerStmt->execute([':id' => $mlid]);
                $oldLearner = $oldLearnerStmt->fetch(PDO::FETCH_ASSOC) ?: null;
                $preparedLearner = app_integrity_prepare_learner($conn, [
                    'lrn' => $lrn,
                    'date_of_birth' => nullIfEmpty($r['norm_birth_date']),
                    'sex' => nullIfEmpty($r['norm_sex']),
                    'gender' => $oldLearner['gender'] ?? null,
                    'indigenous_group' => nullIfEmpty($r['raw_ip_group']),
                    'is_indigenous' => (int)($oldLearner['is_indigenous'] ?? 0),
                ], $oldLearner, false);
                $set('sex', $preparedLearner['sex'], 'sx');
                $set('gender', $preparedLearner['gender'], 'g');
                $set('mother_tongue', validateMotherTongueForImport($conn, $r['raw_mother_tongue'])['value'], 'mt');
                $set('religion', nullIfEmpty($r['raw_religion']), 'rel');
                $set('indigenous_group', $preparedLearner['indigenous_group'], 'ig');
                $set('is_indigenous', $preparedLearner['is_indigenous'], 'ind');
                if ($detectedLwd) {
                    $set('is_lwd', 1, 'lwd');
                }
                $set('address', nullIfEmpty($flatAddr), 'addr');
                $set('contact_number', nullIfEmpty($r['norm_contact_number']), 'cn');
                if (nullIfEmpty($r['raw_birth_province']) !== null) {
                    $set('birth_province_text', nullIfEmpty($r['raw_birth_province']), 'bpt');
                    // A text-only import must not retain an old location link.
                    $up[] = 'birth_province_id = :bpid';
                    $pv[':bpid'] = null;
                }
                if ($up) {
                    $sql = 'UPDATE learners SET ' . implode(', ', $up) . ' WHERE learner_id = :id';
                    $u = $conn->prepare($sql);
                    foreach ($pv as $k => $v2) {
                        if (in_array($k, [':id', ':bpid', ':ind', ':lwd'], true)) bindNullable($u, $k, $v2, PDO::PARAM_INT);
                        else $u->bindValue($k, $v2);
                    }
                    $u->execute();
                }
                $learnerId = $mlid;
                // account if missing (no password reset for existing accounts)
                $chk = $conn->prepare('SELECT user_id FROM learners WHERE learner_id = :id');
                $chk->bindValue(':id', $learnerId, PDO::PARAM_INT);
                $chk->execute();
                $currentUserId = intOrNull($chk->fetchColumn() ?: null);
                if (!$currentUserId) {
                    $pw = resolvePasswordForImport($passwordMode, $passwordCustom, $lrn, nullIfEmpty($r['norm_birth_date']));
                    $acc = resolveOrCreateLearnerAccount($conn, $lrn, $pw);
                    $lu = $conn->prepare('UPDATE learners SET user_id = :uid WHERE learner_id = :id');
                    $lu->bindValue(':uid', (int)$acc['user_id'], PDO::PARAM_INT);
                    $lu->bindValue(':id', $learnerId, PDO::PARAM_INT);
                    $lu->execute();
                    $sync = $conn->prepare('UPDATE learners SET username = :username, password = :password, role_id = :role_id, is_active = 1, account_created_at = COALESCE(account_created_at, NOW()) WHERE learner_id = :learner_id');
                    $sync->bindValue(':username', $acc['username'] ?? $lrn);
                    $sync->bindValue(':password', $acc['password_hash'] ?? password_hash($pw, PASSWORD_BCRYPT));
                    $sync->bindValue(':role_id', $acc['role_id'] ?? getLearnerRoleId($conn), PDO::PARAM_INT);
                    $sync->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
                    $sync->execute();
                    // The former learners password trigger invalidated active
                    // sessions after this account-linking write.
                    app_integrity_bump_auth_version_for_learner($conn, $learnerId);
                } else {
                    // Existing learner already owns its credential fields; do not reset passwords on import.
                }
            } else {
                // Insert
                $pw = resolvePasswordForImport($passwordMode, $passwordCustom, $lrn, nullIfEmpty($r['norm_birth_date']));
                $acc = resolveOrCreateLearnerAccount($conn, $lrn, $pw);
                $preparedLearner = app_integrity_prepare_learner($conn, [
                    'lrn' => $lrn,
                    'date_of_birth' => nullIfEmpty($r['norm_birth_date']),
                    'sex' => nullIfEmpty($r['norm_sex']),
                    'gender' => null,
                    'indigenous_group' => nullIfEmpty($r['raw_ip_group']),
                    'is_indigenous' => 0,
                ], null, true);
                $ins = $conn->prepare('INSERT INTO learners
                    (user_id, lrn, username, password, role_id, is_active, account_created_at, first_name, middle_name, last_name, name_extension, full_name_raw,
                     date_of_birth, birth_province_text, sex, gender, is_indigenous, is_lwd,
                     mother_tongue, religion, indigenous_group,
                     address, contact_number, completed)
                    VALUES (:uid, :lrn, :username, :password, :role_id, 1, NOW(), :fn, :mn, :ln, :ext, :fnr, :dob, :bpt, :sx, :g, :ind, :lwd,
                            :mt, :rel, :ig, :addr, :cn, 1)');
                $ins->bindValue(':uid', (int)$acc['user_id'], PDO::PARAM_INT);
                $ins->bindValue(':lrn', $lrn);
                $ins->bindValue(':username', $acc['username'] ?? $lrn);
                $ins->bindValue(':password', $acc['password_hash'] ?? password_hash($pw, PASSWORD_BCRYPT));
                $ins->bindValue(':role_id', $acc['role_id'] ?? getLearnerRoleId($conn), PDO::PARAM_INT);
                $ins->bindValue(':fn', (string)$r['norm_first_name']);
                bindNullable($ins, ':mn', nullIfEmpty($r['norm_middle_name']));
                $ins->bindValue(':ln', (string)$r['norm_last_name']);
                bindNullable($ins, ':ext', nullIfEmpty($r['norm_name_extension']));
                bindNullable($ins, ':fnr', nullIfEmpty($r['raw_name']));
                bindNullable($ins, ':dob', $preparedLearner['date_of_birth']);
                bindNullable($ins, ':bpt', nullIfEmpty($r['raw_birth_province']));
                bindNullable($ins, ':sx', $preparedLearner['sex']);
                bindNullable($ins, ':g', $preparedLearner['gender']);
                $ins->bindValue(':ind', $preparedLearner['is_indigenous'], PDO::PARAM_INT);
                $ins->bindValue(':lwd', $detectedLwd ? 1 : 0, PDO::PARAM_INT);
                bindNullable($ins, ':mt', validateMotherTongueForImport($conn, $r['raw_mother_tongue'])['value']);
                bindNullable($ins, ':rel', nullIfEmpty($r['raw_religion']));
                bindNullable($ins, ':ig', nullIfEmpty($r['raw_ip_group']));
                bindNullable($ins, ':addr', nullIfEmpty($flatAddr));
                bindNullable($ins, ':cn', nullIfEmpty($r['norm_contact_number']));
                $ins->execute();
                $learnerId = (int)$conn->lastInsertId();
            }

            // enrollment
            $meid = intOrNull($r['matched_enrollment_id']);
            $enrollmentId = 0;
            if ($meid !== null) {
                $chk = $conn->prepare('SELECT is_deleted, enrollment_status, entry_classification,
                                              grade_level_id, section_id, school_year_id, curriculum_id
                                       FROM enrollments WHERE enrollment_id = :id');
                $chk->bindValue(':id', $meid, PDO::PARAM_INT);
                $chk->execute();
                $er = $chk->fetch(PDO::FETCH_ASSOC);
                if ($er && !empty($er['is_deleted'])) {
                    $lifecycle->restoreFromImport(
                        $meid,
                        $gradeId,
                        $sectionId,
                        $enrollStatus,
                        nullIfEmpty($r['raw_remarks']),
                        $movementContext
                    );
                    $notes[] = 'Enrollment has been restored';
                    $enrollmentId = $meid;
                } elseif ($er) {
                    $previousClassification = nullIfEmpty($er['entry_classification'] ?? null);
                    $effectiveEntryClassification = $entryClassification ?? $previousClassification;
                    if ((int)$er['grade_level_id'] !== $gradeId) {
                        $notes[] = 'Grade in the file differs from the current enrollment — kept as-is, please verify';
                    } elseif ((int)$er['section_id'] !== $sectionId) {
                        $curriculumId = app_integrity_validate_enrollment($conn, [
                            'section_id' => $sectionId,
                            'school_year_id' => (int)$er['school_year_id'],
                            'grade_level_id' => (int)$er['grade_level_id'],
                            'curriculum_id' => $er['curriculum_id'] ?? null,
                            'enrollment_status' => $enrollStatus,
                            'is_deleted' => 0,
                        ], $meid);
                        $ue = $conn->prepare('UPDATE enrollments SET section_id = :section_id, curriculum_id = :curriculum_id,
                                              entry_classification = COALESCE(:classification, entry_classification)
                                              WHERE enrollment_id = :id');
                        $ue->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
                        bindNullable($ue, ':curriculum_id', $curriculumId, PDO::PARAM_INT);
                        bindNullable($ue, ':classification', $effectiveEntryClassification);
                        $ue->bindValue(':id', $meid, PDO::PARAM_INT);
                        $ue->execute();
                        $notes[] = 'Enrollment section updated from ' . getImportSectionName($conn, (int)$er['section_id']) . ' to ' . getImportSectionName($conn, $sectionId);
                    }
                    if (($er['enrollment_status'] ?? '') !== $enrollStatus) {
                        $lifecycle->applyImportedStatus(
                            $meid,
                            $enrollStatus,
                            nullIfEmpty($r['raw_remarks']),
                            $movementContext
                        );
                        $notes[] = "Enrollment status changed to {$enrollStatus} based on the remarks column";
                    }
                    $enrollmentId = $meid;
                    $entryClassification = $effectiveEntryClassification;
                }
                if ($enrollmentId > 0 && $entryClassification !== null) {
                    $uc = $conn->prepare('UPDATE enrollments SET entry_classification = :classification WHERE enrollment_id = :id');
                    $uc->bindValue(':classification', $entryClassification);
                    $uc->bindValue(':id', $enrollmentId, PDO::PARAM_INT);
                    $uc->execute();
                }
                if ($enrollmentId > 0) {
                    $movementService->recordTransferIn(
                        $enrollmentId,
                        $er['entry_classification'] ?? null,
                        $entryClassification,
                        $movementContext
                    );
                }
            }
            if ($enrollmentId === 0) {
                $curriculumId = app_integrity_validate_enrollment($conn, [
                    'section_id' => $sectionId,
                    'school_year_id' => $schoolYearId,
                    'grade_level_id' => $gradeId,
                    'curriculum_id' => null,
                    'enrollment_status' => $enrollStatus,
                    'is_deleted' => 0,
                ]);
                $ie = $conn->prepare('INSERT INTO enrollments
                    (learner_id, school_year_id, grade_level_id, section_id,
                     curriculum_id, enrollment_type_id, entry_classification, enrollment_date, enrollment_status)
                    VALUES (:lid, :sy, :gid, :sid, :cur, :et, :classification, CURDATE(), :es)');
                $ie->bindValue(':lid', $learnerId, PDO::PARAM_INT);
                $ie->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
                $ie->bindValue(':gid', $gradeId, PDO::PARAM_INT);
                $ie->bindValue(':sid', $sectionId, PDO::PARAM_INT);
                bindNullable($ie, ':cur', $curriculumId, PDO::PARAM_INT);
                bindNullable($ie, ':et', $etypeId, PDO::PARAM_INT);
                bindNullable($ie, ':classification', $entryClassification);
                $ie->bindValue(':es', $enrollStatus);
                $ie->execute();   // curriculum, section consistency, and capacity were validated above
                $enrollmentId = (int)$conn->lastInsertId();

                $movementService->recordStatusChange(
                    $enrollmentId,
                    null,
                    $enrollStatus,
                    $movementContext
                );
                $movementService->recordTransferIn(
                    $enrollmentId,
                    null,
                    $entryClassification,
                    $movementContext
                );
            }

            // family + guardian
            $guardianName = nullIfEmpty($r['raw_guardian_name']);
            $contact = nullIfEmpty($r['norm_contact_number']);

            $fatherName = nullIfEmpty($r['raw_father_name']);
            $motherName = nullIfEmpty($r['raw_mother_name']);
            $guardianRel = normalizeGuardianRelationshipCategory($r['raw_guardian_rel'], $guardianName, $fatherName, $motherName);

            $guardianContact = $guardianName ? $contact : null;
            $fatherContact = ($guardianName || !$fatherName) ? null : $contact;
            $motherContact = ($guardianName || !$motherName || $fatherName) ? null : $contact;

            upsertFamilyMember($conn, $learnerId, 'Father', $fatherName, $fatherContact, false, $fatherName);
            upsertFamilyMember($conn, $learnerId, 'Mother', $motherName, $motherContact, false, $motherName);
            upsertFamilyMember($conn, $learnerId, $guardianRel, $guardianName, $guardianContact, true, $guardianName);

            // structured address
            upsertCurrentAddress($conn, $learnerId, $streetText,
                nullIfEmpty($r['raw_province']),
                nullIfEmpty($r['raw_municipality']),
                nullIfEmpty($r['raw_barangay']));

            $conn->commit();

            $rowAction = $action === 'Insert' ? 'Inserted' : 'Updated';
            foreach (json_decode((string)$r['messages'], true) ?: [] as $message) {
                if (($message['code'] ?? '') === 'section_transfer') {
                    $notes[] = 'Section moved: ' . ($message['from_section'] ?? '') . ' → ' . ($message['to_section'] ?? '') . '.';
                }
            }
            $noteStr = array_merge($notes,
                array_map(fn ($m) => $m['message'], array_filter(
                    json_decode((string)$r['messages'], true) ?: [],
                    fn ($m) => ($m['severity'] ?? '') === 'W')));
            $noteStr = $noteStr ? implode(' | ', $noteStr) : null;

            $log = $conn->prepare('INSERT INTO import_log_rows
                (import_id, `row_number`, lrn, row_action, error_message, raw_data)
                VALUES (:iid, :rn, :lrn, :act, :msg, :raw)');
            $log->bindValue(':iid', $importId, PDO::PARAM_INT);
            $log->bindValue(':rn', $rn, PDO::PARAM_INT);
            $log->bindValue(':lrn', $lrn);
            $log->bindValue(':act', $rowAction);
            bindNullable($log, ':msg', $noteStr);
            bindNullable($log, ':raw', $rawJson);
            $log->execute();
            $col = $rowAction === 'Inserted' ? 'inserted' : 'updated';
            $conn->prepare("UPDATE import_logs SET {$col} = {$col} + 1 WHERE import_id = " . $importId)->execute();

            $results[] = ['row' => $rn, 'lrn' => $lrn, 'status' => $rowAction, 'message' => $noteStr ?? ''];
        } catch (Exception $e) {
            if ($conn->inTransaction()) $conn->rollBack();
            if (is_name_extension_fk_violation($e)) {
                $extension = nullIfEmpty($r['norm_name_extension'] ?? null);
                $msg = $extension === null
                    ? 'The imported name extension is not approved. Select a value from the Name Extensions masterfile or leave it blank.'
                    : 'Name extension "' . $extension . '" is no longer approved. Select an approved suffix from the Name Extensions masterfile or leave it blank.';
            } else {
                $msg = $e instanceof PDOException && (string)$e->getCode() === '45000'
                     ? $e->getMessage()
                     : ($e instanceof PDOException ? 'Database error: ' : '') . $e->getMessage();
            }
            $log = $conn->prepare('INSERT INTO import_log_rows
                (import_id, `row_number`, lrn, row_action, error_message, raw_data)
                VALUES (:iid, :rn, :lrn, "Error", :msg, :raw)');
            $log->bindValue(':iid', $importId, PDO::PARAM_INT);
            $log->bindValue(':rn', $rn, PDO::PARAM_INT);
            bindNullable($log, ':lrn', $lrn ?: null);
            $log->bindValue(':msg', mb_substr($msg, 0, 490));
            bindNullable($log, ':raw', $rawJson);
            $log->execute();
            $results[] = ['row' => $rn, 'lrn' => $lrn, 'status' => 'Error', 'message' => $msg];
        }
    }

    // remaining?
    $rem = $conn->prepare("SELECT COUNT(*) FROM sf1_import_staging st
                           WHERE st.import_id = :id
                             AND st.planned_action IN ('Insert','Update','Revive')
                             AND NOT EXISTS (SELECT 1 FROM import_log_rows ilr
                                             WHERE ilr.import_id = st.import_id
                                               AND ilr.`row_number` = st.`row_number`)");
    $rem->bindValue(':id', $importId, PDO::PARAM_INT);
    $rem->execute();
    $remaining = (int)$rem->fetchColumn();

    if ($remaining === 0) {
        finalizeImportInternal($conn, $importId);
    }
    respond(['success' => true, 'processed' => count($results), 'remaining' => $remaining,
             'done' => $remaining === 0, 'results' => $results]);
}

function finalizeImportInternal(PDO $conn, int $importId): array {
    // rejected staging rows become Error log rows (audit completeness)
    $rej = $conn->prepare("SELECT st.`row_number`, st.norm_lrn, st.raw_lrn, st.planned_action, st.messages
                           FROM sf1_import_staging st
                           WHERE st.import_id = :id AND st.planned_action IN ('Reject','Skip')
                             AND NOT EXISTS (SELECT 1 FROM import_log_rows ilr
                                             WHERE ilr.import_id = st.import_id
                                               AND ilr.`row_number` = st.`row_number`)");
    $rej->bindValue(':id', $importId, PDO::PARAM_INT);
    $rej->execute();
    foreach ($rej->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $msgs = json_decode((string)$r['messages'], true) ?: [];
        $txt = implode(' | ', array_map(fn ($m) => $m['message'] ?? '', $msgs)) ?: 'Rejected by validation';
        // A row explicitly planned as Skip is not a failed import. This
        // includes no-change rows and rows manually excluded from the batch;
        // only validation Reject rows should contribute to the error count.
        $act = (string)($r['planned_action'] ?? '') === 'Skip' ? 'Skipped' : 'Error';
        $log = $conn->prepare('INSERT INTO import_log_rows
            (import_id, `row_number`, lrn, row_action, error_message)
            VALUES (:iid, :rn, :lrn, :act, :msg)');
        $log->bindValue(':iid', $importId, PDO::PARAM_INT);
        $log->bindValue(':rn', (int)$r['row_number'], PDO::PARAM_INT);
        bindNullable($log, ':lrn', nullIfEmpty($r['norm_lrn']) ?? nullIfEmpty($r['raw_lrn']));
        $log->bindValue(':act', $act);
        $log->bindValue(':msg', mb_substr($txt, 0, 490));
        $log->execute();
        if ($act === 'Skipped') {
            $conn->prepare('UPDATE import_logs SET skipped = skipped + 1 WHERE import_id = ' . $importId)->execute();
        }
    }

    $cnt = $conn->prepare("SELECT COUNT(*) FROM import_log_rows WHERE import_id = :id AND row_action = 'Error'");
    $cnt->bindValue(':id', $importId, PDO::PARAM_INT);
    $cnt->execute();
    $errCount = (int)$cnt->fetchColumn();

    $errs = null;
    if ($errCount > 0) {
        $e = $conn->prepare("SELECT `row_number`, lrn, error_message FROM import_log_rows
                             WHERE import_id = :id AND row_action = 'Error'
                             ORDER BY `row_number` LIMIT 50");
        $e->bindValue(':id', $importId, PDO::PARAM_INT);
        $e->execute();
        $errs = json_encode(array_map(fn ($r) => ['row' => (int)$r['row_number'], 'lrn' => $r['lrn'],
                                                  'message' => $r['error_message']],
                            $e->fetchAll(PDO::FETCH_ASSOC)), JSON_UNESCAPED_UNICODE);
    }
    $status = $errCount > 0 ? 'Completed with Errors' : 'Completed';
    $u = $conn->prepare('UPDATE import_logs SET status = :s, errors = :e, completed_at = NOW()
                         WHERE import_id = :id');
    $u->bindValue(':s', $status);
    bindNullable($u, ':e', $errs);
    $u->bindValue(':id', $importId, PDO::PARAM_INT);
    $u->execute();
    return ['status' => $status, 'error_count' => $errCount];
}

function finalizeLisImport(PDO $conn, array $session): void {
    requireImportTables($conn);
    $d = getJsonInput();
    $importId = (int)($d['import_id'] ?? 0);
    if ($importId <= 0) respond(['success' => false, 'message' => 'import_id is required'], 422);
    importBatchOr404($conn, $importId, $session, null);
    $r = finalizeImportInternal($conn, $importId);
    respond(['success' => true] + $r);
}

/* ======================================================================== */
/* CRUD (kept, repaired: S-12 keyed upserts, S-13 real school columns)      */
/* ======================================================================== */

function registrationSelectSql(PDO $conn): string {
    $hasRawAddressText = columnExists($conn, 'learner_addresses', 'barangay_text')
        && columnExists($conn, 'learner_addresses', 'city_municipality_text')
        && columnExists($conn, 'learner_addresses', 'province_text');
    $hasLwd = columnExists($conn, 'learners', 'is_lwd');
    $addrBarangay = $hasRawAddressText ? "NULLIF(TRIM(la.barangay_text), '')" : 'NULL';
    $addrMunicipality = $hasRawAddressText ? "NULLIF(TRIM(la.city_municipality_text), '')" : 'NULL';
    $addrProvince = $hasRawAddressText ? "NULLIF(TRIM(la.province_text), '')" : 'NULL';
    $lwdSelect = $hasLwd ? 'l.is_lwd' : '0';
    $learnerStatusSelect = columnExists($conn, 'learners', 'learner_status')
        ? 'l.learner_status'
        : 'NULL';

    $schoolIdSelect = "(SELECT deped_school_id FROM schools WHERE is_active = 1 ORDER BY school_id LIMIT 1)";
    $schoolNameSelect = "(SELECT school_name FROM schools WHERE is_active = 1 ORDER BY school_id LIMIT 1)";
    if (tableExists($conn, 'school_settings')) {
        $schoolIdSelect = "COALESCE(
            (SELECT NULLIF(TRIM(setting_value), '') FROM school_settings
             WHERE setting_key = 'school_id' AND is_deleted = 0 LIMIT 1),
            {$schoolIdSelect}
        )";
        $schoolNameSelect = "COALESCE(
            (SELECT NULLIF(TRIM(setting_value), '') FROM school_settings
             WHERE setting_key = 'school_name' AND is_deleted = 0 LIMIT 1),
            {$schoolNameSelect}
        )";
    }

    $enrollmentTypeSelect = tableExists($conn, 'enrollment_types')
        ? 'e.enrollment_type_id, et.type_name AS enrollment_type_name,'
        : 'NULL AS enrollment_type_id, NULL AS enrollment_type_name,';
    $previousSchoolSelect = tableExists($conn, 'learner_previous_schools')
        ? "
                   (SELECT last_grade_level_completed FROM learner_previous_schools
                    WHERE learner_id = l.learner_id AND is_deleted = 0
                    ORDER BY previous_school_id DESC LIMIT 1) AS last_grade_level_completed,
                   (SELECT last_school_year_completed FROM learner_previous_schools
                    WHERE learner_id = l.learner_id AND is_deleted = 0
                    ORDER BY previous_school_id DESC LIMIT 1) AS last_school_year_completed,
                   (SELECT last_school_attended FROM learner_previous_schools
                    WHERE learner_id = l.learner_id AND is_deleted = 0
                    ORDER BY previous_school_id DESC LIMIT 1) AS last_school_attended,
                   (SELECT last_school_id FROM learner_previous_schools
                    WHERE learner_id = l.learner_id AND is_deleted = 0
                    ORDER BY previous_school_id DESC LIMIT 1) AS last_school_id,"
        : 'NULL AS last_grade_level_completed, NULL AS last_school_year_completed, NULL AS last_school_attended, NULL AS last_school_id,';

    return "SELECT l.learner_id, l.lrn, l.first_name, l.middle_name, l.last_name, l.name_extension,
                   l.full_name_raw, l.date_of_birth, l.sex, l.gender,
                   l.religion, l.mother_tongue, l.indigenous_group, l.is_indigenous,
                   {$learnerStatusSelect} AS learner_status, {$lwdSelect} AS is_lwd,
                   l.completed, l.address, l.birth_province_id,
                   l.birth_province_text, NULLIF(TRIM(l.birth_province_text), '') AS birth_province_name,
                   e.enrollment_id, e.enrollment_status, e.enrollment_date, e.entry_classification,
                   {$enrollmentTypeSelect}
                   e.curriculum_id, cur.curriculum_name, cur.curriculum_code,
                   e.grade_level_id, gl.grade_name,
                   e.section_id, sec.section_name,
                   e.school_year_id, sy.year_label,
                   {$schoolIdSelect} AS school_id,
                   {$schoolNameSelect} AS school_name,
                   {$previousSchoolSelect}
                   COALESCE(addr.house_street, NULLIF(TRIM(SUBSTRING_INDEX(l.address, ',', 1)), '')) AS house_street,
                   COALESCE(addr.barangay, CASE
                     WHEN (LENGTH(l.address) - LENGTH(REPLACE(l.address, ',', ''))) >= 3
                     THEN NULLIF(TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(l.address, ',', -3), ',', 1)), '')
                   END) AS barangay,
                   COALESCE(addr.municipality, CASE
                     WHEN (LENGTH(l.address) - LENGTH(REPLACE(l.address, ',', ''))) >= 3
                     THEN NULLIF(TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(l.address, ',', -2), ',', 1)), '')
                   END) AS municipality,
                   COALESCE(addr.province, CASE
                     WHEN (LENGTH(l.address) - LENGTH(REPLACE(l.address, ',', ''))) >= 3
                     THEN NULLIF(TRIM(SUBSTRING_INDEX(l.address, ',', -1)), '')
                   END) AS province,
                   (SELECT full_name FROM family_members WHERE learner_id = l.learner_id
                     AND relationship = 'Father' AND is_deleted = 0 LIMIT 1) AS father_name,
                   (SELECT full_name FROM family_members WHERE learner_id = l.learner_id
                     AND relationship = 'Mother' AND is_deleted = 0 LIMIT 1) AS mother_name,
                   (SELECT full_name FROM family_members WHERE learner_id = l.learner_id
                     AND is_guardian = 1 AND is_deleted = 0 LIMIT 1) AS guardian_name,
                   (SELECT relationship FROM family_members WHERE learner_id = l.learner_id
                     AND is_guardian = 1 AND is_deleted = 0 LIMIT 1) AS guardian_relationship,
                   COALESCE(
                     (SELECT contact_number FROM family_members WHERE learner_id = l.learner_id
                       AND is_guardian = 1 AND is_deleted = 0 AND contact_number IS NOT NULL LIMIT 1),
                     (SELECT contact_number FROM family_members WHERE learner_id = l.learner_id
                       AND relationship = 'Father' AND is_deleted = 0 AND contact_number IS NOT NULL LIMIT 1),
                     (SELECT contact_number FROM family_members WHERE learner_id = l.learner_id
                       AND relationship = 'Mother' AND is_deleted = 0 AND contact_number IS NOT NULL LIMIT 1),
                     l.contact_number
                   ) AS guardian_contact
            FROM learners l
            LEFT JOIN enrollments e ON e.enrollment_id = (
                SELECT e2.enrollment_id FROM enrollments e2
                WHERE e2.learner_id = l.learner_id AND e2.is_deleted = 0
                ORDER BY
                    (e2.school_year_id = (SELECT school_year_id FROM school_years WHERE is_active = 1 AND is_deleted = 0 ORDER BY year_start DESC LIMIT 1)) DESC,
                    e2.enrollment_date DESC,
                    e2.enrollment_id DESC
                LIMIT 1)
            LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
            LEFT JOIN sections sec ON sec.section_id = e.section_id
            LEFT JOIN school_years sy ON sy.school_year_id = e.school_year_id
            LEFT JOIN curricula cur ON cur.curriculum_id = e.curriculum_id
            LEFT JOIN enrollment_types et ON et.enrollment_type_id = e.enrollment_type_id
            LEFT JOIN (
                SELECT la.learner_id,
                       TRIM(CONCAT_WS(' ', la.house_no, la.street_name)) AS house_street,
                       {$addrBarangay} AS barangay,
                       {$addrMunicipality} AS municipality,
                       {$addrProvince} AS province
                FROM learner_addresses la
                WHERE la.address_type = 'CURRENT' AND la.is_deleted = 0
            ) addr ON addr.learner_id = l.learner_id
            WHERE l.is_deleted = 0";
}

function getAllRegistrations(PDO $conn): void {
    $stmt = $conn->query(registrationSelectSql($conn) . ' ORDER BY l.last_name, l.first_name');
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function getRegistrationList(PDO $conn): void {
    getAllRegistrations($conn);
}

function getRegistrationById(PDO $conn, array $session): void {
    $learnerId = (int)($_GET['learner_id'] ?? 0);
    $requestedUserId = (int)($_GET['user_id'] ?? 0);

    if ($learnerId <= 0 && $requestedUserId > 0) {
        $userStmt = $conn->prepare('SELECT learner_id FROM learners WHERE user_id = :uid AND is_deleted = 0 LIMIT 1');
        $userStmt->bindValue(':uid', $requestedUserId, PDO::PARAM_INT);
        $userStmt->execute();
        $learnerId = (int)($userStmt->fetchColumn() ?: 0);
    }

    if ($learnerId <= 0) respond(['success' => false, 'message' => 'learner_id is required'], 422);

    // Learners may only view their own registration record.
    if (($session['role_key'] ?? '') === 'learners') {
        $ownStmt = $conn->prepare('SELECT learner_id FROM learners WHERE user_id = :uid AND is_deleted = 0 LIMIT 1');
        $ownStmt->bindValue(':uid', (int)($session['user_id'] ?? 0), PDO::PARAM_INT);
        $ownStmt->execute();
        $ownLearnerId = (int)($ownStmt->fetchColumn() ?: 0);
        if ($ownLearnerId <= 0 || $ownLearnerId !== $learnerId) {
            respond(['success' => false, 'message' => 'Not authorized'], 403);
        }
    }

    $stmt = $conn->prepare(registrationSelectSql($conn) . ' AND l.learner_id = :id LIMIT 1');
    $stmt->bindValue(':id', $learnerId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) respond(['success' => false, 'message' => 'Learner not found'], 404);

    $presenceStmt = $conn->prepare(
        'SELECT last_login,
                last_seen_at,
                TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) AS last_seen_seconds_ago,
                TIMESTAMPDIFF(SECOND, last_login, NOW()) AS last_login_seconds_ago,
                CASE WHEN last_seen_at IS NOT NULL
                           AND last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
                     THEN 1 ELSE 0 END AS is_online
         FROM learners
         WHERE learner_id = :learner_id
         LIMIT 1'
    );
    $presenceStmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $presenceStmt->execute();
    $presence = $presenceStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $row['last_login'] = $presence['last_login'] ?? null;
    $row['last_seen_at'] = $presence['last_seen_at'] ?? null;
    $row['last_seen_seconds_ago'] = $presence['last_seen_seconds_ago'] ?? null;
    $row['last_login_seconds_ago'] = $presence['last_login_seconds_ago'] ?? null;
    $row['is_online'] = (int)($presence['is_online'] ?? 0);
    respond($row);
}

function getEnrollmentStatus(PDO $conn, array $session = []): void {
    $learnerId = intOrNull($_GET['learner_id'] ?? null);
    $schoolYearId = intOrNull($_GET['school_year_id'] ?? null);
    if ($learnerId === null || $schoolYearId === null) {
        respond(['success' => false, 'message' => 'Learner ID and school year are required'], 422);
    }

    $stmt = $conn->prepare(
        'SELECT e.enrollment_id, e.learner_id, e.school_year_id, e.enrollment_status,
                e.status_updated_at, e.grade_level_id, e.section_id,
                gl.grade_name, sec.section_name, sy.year_label
         FROM enrollments e
         LEFT JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
         LEFT JOIN sections sec ON sec.section_id = e.section_id
         LEFT JOIN school_years sy ON sy.school_year_id = e.school_year_id
         WHERE e.learner_id = :learner_id
           AND e.school_year_id = :school_year_id
           AND e.is_deleted = 0
         ORDER BY e.enrollment_id DESC
         LIMIT 1'
    );
    $stmt->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;

    if ($row) {
        $isPrivilegedRole = in_array((string)($session['role_key'] ?? ''), ['admin', 'registrar'], true);
        $isAdviser = $isPrivilegedRole || teacherCanManageSection(
            $conn,
            $session,
            (int)($row['section_id'] ?? 0),
            $schoolYearId
        );
        $row['can_manage_status'] = $isAdviser;
        $row['status_permission_message'] = $isAdviser
            ? ''
            : 'Enrollment status is locked. Only the class adviser assigned to this learner’s section can update it.';
    }

    respond(['success' => true, 'data' => $row]);
}

function updateEnrollmentStatus(PDO $conn, array $session = []): void {
    $data = getJsonInput();
    $learnerId = intOrNull($data['learner_id'] ?? null);
    $schoolYearId = intOrNull($data['school_year_id'] ?? null);
    if ($learnerId === null || $schoolYearId === null) {
        respond(['success' => false, 'message' => 'Learner ID and school year are required'], 422);
    }

    try {
        $status = (new EnrollmentLifecycleService($conn))->normalizeStatus($data['enrollment_status'] ?? null);
    } catch (InvalidArgumentException $e) {
        respond(['success' => false, 'message' => $e->getMessage()], 422);
    }

    $find = $conn->prepare(
        'SELECT enrollment_id, enrollment_status, section_id
         FROM enrollments
         WHERE learner_id = :learner_id
           AND school_year_id = :school_year_id
           AND is_deleted = 0
         ORDER BY enrollment_id DESC
         LIMIT 1'
    );
    $find->bindValue(':learner_id', $learnerId, PDO::PARAM_INT);
    $find->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
    $find->execute();
    $row = $find->fetch(PDO::FETCH_ASSOC);
    if (!$row) respond(['success' => false, 'message' => 'No enrollment exists for the selected school year.'], 404);

    if (($session['role_key'] ?? '') === 'teacher'
        && !teacherCanManageSection($conn, $session, (int)($row['section_id'] ?? 0), $schoolYearId)) {
        respond(['success' => false, 'message' => 'Enrollment status is locked. Only the class adviser assigned to this learner’s section can update it.'], 403);
    }

    $enrollmentId = (int)$row['enrollment_id'];
    $previousStatus = (string)($row['enrollment_status'] ?? '');
    if ($previousStatus === $status) {
        respond([
            'success' => true,
            'message' => "Enrollment status is already {$status}.",
            'enrollment_id' => $enrollmentId,
            'enrollment_status' => $status,
        ]);
    }

    try {
        $conn->beginTransaction();
        $changed = (new EnrollmentLifecycleService($conn))->setStatus(
            $enrollmentId,
            $status,
            'learnerDetailsStatusControl',
            "Status changed from {$previousStatus} to {$status} in Learner Details.",
            [
                'source_type' => EnrollmentMovementService::SOURCE_MANUAL_PROFILE,
                'user_id' => (int)($session['user_id'] ?? 0),
            ]
        );
        if (!$changed) {
            throw new RuntimeException('The enrollment status could not be updated.');
        }
        $conn->commit();
        respond([
            'success' => true,
            'message' => 'Enrollment status updated.',
            'enrollment_id' => $enrollmentId,
            'enrollment_status' => $status,
        ]);
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        if ($e instanceof RuntimeException) {
            respond(['success' => false, 'message' => $e->getMessage()], 422);
        }
        throw $e;
    }
}

function validateSectionConsistency(PDO $conn, int $sectionId, int $schoolYearId, int $gradeLevelId): void {
    $stmt = $conn->prepare('SELECT school_year_id, grade_level_id FROM sections
                            WHERE section_id = :id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':id', $sectionId, PDO::PARAM_INT);
    $stmt->execute();
    $s = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$s) throw new Exception('Selected section not found');
    if ((int)$s['school_year_id'] !== $schoolYearId) throw new Exception('Section does not belong to the selected school year');
    if ((int)$s['grade_level_id'] !== $gradeLevelId) throw new Exception('Section does not match the selected grade level');
}

function checkLrnAvailability(PDO $conn): void {
    $d = getJsonInput();
    $lrn = repairLrnForImport($d['lrn'] ?? null);
    if ($lrn === null) {
        respond(['success' => false, 'available' => false, 'message' => 'LRN must be exactly 12 digits'], 422);
    }
    $stmt = $conn->prepare('SELECT learner_id, is_deleted FROM learners WHERE lrn = :lrn LIMIT 1');
    $stmt->bindValue(':lrn', $lrn);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row) {
        respond(['success' => true,
                 'available' => false,
                 'message' => empty($row['is_deleted'])
                    ? 'LRN already exists.'
                    : 'A deleted learner with this LRN exists. Re-import the learner instead of creating a new record.']);
    }
    respond(['success' => true, 'available' => true]);
}

function getPrimaryCurriculumId(PDO $conn, int $schoolYearId): ?int {
    $stmt = $conn->prepare('SELECT m.curriculum_id
                            FROM curriculum_school_year_map m
                            JOIN curricula c ON c.curriculum_id = m.curriculum_id
                            WHERE m.school_year_id = :sid
                              AND m.is_deleted = 0
                              AND m.is_primary = 1
                              AND c.is_deleted = 0
                            ORDER BY c.is_active DESC, c.effective_from DESC, c.curriculum_id DESC
                            LIMIT 1');
    $stmt->bindValue(':sid', $schoolYearId, PDO::PARAM_INT);
    $stmt->execute();
    $id = $stmt->fetchColumn();
    return $id === false ? null : (int)$id;
}

function getDefaultEnrollmentTypeId(PDO $conn, string $typeName = 'New Enrollee'): ?int {
    $stmt = $conn->prepare('SELECT enrollment_type_id FROM enrollment_types WHERE type_name = :tn AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':tn', $typeName);
    $stmt->execute();
    $id = $stmt->fetchColumn();
    return $id === false ? null : (int)$id;
}

function createRegistration(PDO $conn): void {
    $d = getJsonInput();
    $lrn = repairLrnForImport($d['lrn'] ?? null);
    if ($lrn === null) respond(['success' => false, 'message' => 'LRN must be exactly 12 digits'], 422);
    if (empty($d['first_name']) || empty($d['last_name'])) {
        respond(['success' => false, 'message' => 'First name and last name are required'], 422);
    }
    $gradeLevelId = intOrNull($d['grade_level_id'] ?? null);
    $sectionId = intOrNull($d['section_id'] ?? null);
    if ($gradeLevelId === null || $sectionId === null) {
        respond(['success' => false, 'message' => 'Grade level and section are required'], 422);
    }
    $schoolYearId = intOrNull($d['school_year_id'] ?? null) ?? getActiveSchoolYearId($conn);
    if (!$schoolYearId) respond(['success' => false, 'message' => 'No active school year found'], 409);

    // duplicate incl. soft-deleted → tell the user to use the import revive flow / restore
    $stmt = $conn->prepare('SELECT learner_id, is_deleted FROM learners WHERE lrn = :lrn LIMIT 1');
    $stmt->bindValue(':lrn', $lrn);
    $stmt->execute();
    if ($ex = $stmt->fetch(PDO::FETCH_ASSOC)) {
        respond(['success' => false,
                 'message' => empty($ex['is_deleted'])
                    ? 'LRN already exists.'
                    : 'A deleted learner with this LRN exists. Re-import the learner (revive) instead of creating a new record.'], 409);
    }

    try {
        $conn->beginTransaction();
        validateSectionConsistency($conn, $sectionId, $schoolYearId, $gradeLevelId);

        $acc = resolveOrCreateLearnerAccount($conn, $lrn, $lrn, intOrNull($d['user_id'] ?? null));
        $dobNote = null;
        $dob = normalizeDateForImport($d['date_of_birth'] ?? null, $dobNote);
        $sex = normalizeSexForImport($d['sex'] ?? ($d['gender'] ?? null));
        $gender = nullIfEmpty($d['gender'] ?? null);
        if (!in_array($gender, ['Male', 'Female', 'Other'], true)) {
            $gender = ($sex === 'M') ? 'Male' : (($sex === 'F') ? 'Female' : null);
        }
        $preparedLearner = app_integrity_prepare_learner($conn, [
            'lrn' => $lrn,
            'date_of_birth' => $dob,
            'sex' => $sex,
            'gender' => $gender,
            'indigenous_group' => $d['indigenous_group'] ?? ($d['indigenous_group_id'] ?? null),
            'is_indigenous' => (int)($d['is_indigenous'] ?? 0),
        ], null, true);
        $sex = $preparedLearner['sex'];
        $gender = $preparedLearner['gender'];

        $mappedRemark = mapSf1Remark($conn, $d['remarks'] ?? null);
        $fullNameRaw = nullIfEmpty($d['full_name_raw'] ?? null)
            ?? buildFullNameRaw($d['last_name'] ?? null, $d['first_name'] ?? null, $d['middle_name'] ?? null);
        $birthProvinceText = nullIfEmpty($d['birth_province_text'] ?? $d['birth_place_text'] ?? $d['place_of_birth'] ?? null);

        $ins = $conn->prepare('INSERT INTO learners
            (user_id, lrn, username, password, role_id, is_active, account_created_at, first_name, middle_name, last_name, name_extension, full_name_raw,
             date_of_birth, sex, gender, is_lwd, religion, mother_tongue,
             indigenous_group, is_indigenous, address, contact_number, completed, birth_province_text)
            VALUES (:uid, :lrn, :username, :password, :role_id, 1, NOW(), :fn, :mn, :ln, :ext, :fnr, :dob, :sx, :g, :lwd, :rel, :mt,
                    :ig, :ind, :addr, :cn, :done, :bpt)');
        $ins->bindValue(':uid', (int)$acc['user_id'], PDO::PARAM_INT);
        $ins->bindValue(':lrn', $lrn);
        $ins->bindValue(':username', $acc['username'] ?? $lrn);
        $ins->bindValue(':password', $acc['password_hash'] ?? password_hash($lrn, PASSWORD_BCRYPT));
        $ins->bindValue(':role_id', $acc['role_id'] ?? getLearnerRoleId($conn), PDO::PARAM_INT);
        $ins->bindValue(':fn', (string)$d['first_name']);
        bindNullable($ins, ':mn', nullIfEmpty($d['middle_name'] ?? null));
        $ins->bindValue(':ln', (string)$d['last_name']);
        bindNullable($ins, ':ext', nullIfEmpty($d['name_extension'] ?? ($d['name_extension_id'] ?? null)));
        bindNullable($ins, ':fnr', $fullNameRaw);
        bindNullable($ins, ':dob', $dob);
        bindNullable($ins, ':sx', $sex);
        bindNullable($ins, ':g', $gender);
        $ins->bindValue(':lwd', !empty($mappedRemark['is_lwd']) ? 1 : 0, PDO::PARAM_INT);
        bindNullable($ins, ':rel', nullIfEmpty($d['religion'] ?? ($d['religion_id'] ?? null)));
        bindNullable($ins, ':mt', nullIfEmpty($d['mother_tongue'] ?? ($d['mother_tongue_id'] ?? null)));
        bindNullable($ins, ':ig', nullIfEmpty($d['indigenous_group'] ?? ($d['indigenous_group_id'] ?? null)));
        $ins->bindValue(':ind', $preparedLearner['is_indigenous'], PDO::PARAM_INT);
        bindNullable($ins, ':addr', nullIfEmpty($d['address'] ?? null));
        bindNullable($ins, ':cn', nullIfEmpty($d['guardian_contact'] ?? ($d['contact_number'] ?? null)));
        $ins->bindValue(':done', (int)($d['completed'] ?? 0), PDO::PARAM_INT);
        bindNullable($ins, ':bpt', $birthProvinceText);
        $ins->execute();
        $learnerId = (int)$conn->lastInsertId();

        $enrollmentTypeId = intOrNull($d['enrollment_type_id'] ?? null);
        if ($enrollmentTypeId === null && ($mappedRemark['enrollment_type_id'] ?? null) !== null) {
            $enrollmentTypeId = $mappedRemark['enrollment_type_id'];
        }
        $enrollmentTypeId = $enrollmentTypeId ?: getDefaultEnrollmentTypeId($conn, 'New Enrollee');
        $enrollmentStatus = $mappedRemark['enrollment_status'] ?? 'Enrolled';
        $entryClassification = EnrollmentEntryClassificationService::normalize($d['entry_classification'] ?? null)
            ?? EnrollmentEntryClassificationService::fromEnrollmentTypeId($conn, $enrollmentTypeId)
            ?? ($mappedRemark['entry_classification'] ?? null);
        if (in_array($entryClassification, ['Returnee', 'Transfer-In'], true)) $enrollmentStatus = 'Enrolled';
        $curriculumId = app_integrity_validate_enrollment($conn, [
            'section_id' => $sectionId,
            'school_year_id' => $schoolYearId,
            'grade_level_id' => $gradeLevelId,
            'curriculum_id' => intOrNull($d['curriculum_id'] ?? null),
            'enrollment_status' => $enrollmentStatus,
            'is_deleted' => 0,
        ]);

        $ie = $conn->prepare('INSERT INTO enrollments
            (learner_id, school_year_id, grade_level_id, section_id,
             curriculum_id, enrollment_type_id, entry_classification, enrollment_status, enrollment_date)
            VALUES (:lid, :sy, :gid, :sid, :cur, :et, :classification, :es, CURDATE())');
        $ie->bindValue(':lid', $learnerId, PDO::PARAM_INT);
        $ie->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $ie->bindValue(':gid', $gradeLevelId, PDO::PARAM_INT);
        $ie->bindValue(':sid', $sectionId, PDO::PARAM_INT);
        bindNullable($ie, ':cur', $curriculumId, PDO::PARAM_INT);
        bindNullable($ie, ':et', $enrollmentTypeId, PDO::PARAM_INT);
        bindNullable($ie, ':classification', $entryClassification);
        $ie->bindValue(':es', $enrollmentStatus);
        $ie->execute();
        $enrollmentId = (int)$conn->lastInsertId();

        $guardianRel = normalizeGuardianRelationshipCategory(
            $d['guardian_relationship'] ?? null,
            $d['guardian_name'] ?? null,
            $d['father_name'] ?? null,
            $d['mother_name'] ?? null
        );
        upsertFamilyMember($conn, $learnerId, 'Father', $d['father_name'] ?? null, $d['father_contact'] ?? null);
        upsertFamilyMember($conn, $learnerId, 'Mother', $d['mother_name'] ?? null, $d['mother_contact'] ?? null);
        upsertFamilyMember($conn, $learnerId, $guardianRel, $d['guardian_name'] ?? null,
                           $d['guardian_contact'] ?? ($d['contact_number'] ?? null), true);

        $currentStreet = nullIfEmpty($d['current_house_no'] ?? null) !== null || nullIfEmpty($d['current_street_name'] ?? null) !== null
            ? trim(((string)($d['current_house_no'] ?? '')) . ' ' . ((string)($d['current_street_name'] ?? ''))) ?: null
            : null;
        upsertCurrentAddress($conn, $learnerId, $currentStreet,
                             $d['province'] ?? null, $d['municipality'] ?? null, $d['barangay'] ?? null);

        $formattedAddress = formatAddressFromParts($currentStreet,
            nullIfEmpty($d['barangay'] ?? null),
            nullIfEmpty($d['municipality'] ?? null),
            nullIfEmpty($d['province'] ?? null));
        if ($formattedAddress !== null) {
            $updAddr = $conn->prepare('UPDATE learners SET address = :addr WHERE learner_id = :lid');
            $updAddr->bindValue(':addr', $formattedAddress);
            $updAddr->bindValue(':lid', $learnerId, PDO::PARAM_INT);
            $updAddr->execute();
        }

        upsertPreviousSchool($conn, $learnerId, $enrollmentId, $d);

        $conn->commit();
        respond(['success' => true, 'message' => 'Registration saved.',
                 'learner_id' => $learnerId, 'enrollment_id' => $enrollmentId,
                 'account_created' => (bool)$acc['created'],
                 'dob_note' => $dobNote]);
    } catch (PDOException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        if (is_name_extension_fk_violation($e)) respond(name_extension_fk_error_payload(), 422);
        if ((string)$e->getCode() === '45000') respond(['success' => false, 'message' => $e->getMessage()], 409);
        respond(['success' => false, 'message' => 'Database error: ' . $e->getMessage()], 500);
    } catch (Exception $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => $e->getMessage()], 422);
    }
}

function updateRegistration(PDO $conn, array $session = []): void {
    $d = getJsonInput();
    $learnerId = intOrNull($d['learner_id'] ?? null);
    if ($learnerId === null) respond(['success' => false, 'message' => 'Learner ID is required'], 422);

    $cur = $conn->prepare('SELECT * FROM learners WHERE learner_id = :id AND is_deleted = 0 LIMIT 1');
    $cur->bindValue(':id', $learnerId, PDO::PARAM_INT);
    $cur->execute();
    $currentLearner = $cur->fetch(PDO::FETCH_ASSOC);
    if (!$currentLearner) respond(['success' => false, 'message' => 'Learner not found'], 404);
    $currentLrn = (string)$currentLearner['lrn'];

    $roleKey = (string)($session['role_key'] ?? '');
    $canManageEnrollmentStatus = in_array($roleKey, ['admin', 'registrar'], true);
    $requestedEnrollmentStatus = null;
    if (array_key_exists('enrollment_status', $d) && trim((string)($d['enrollment_status'] ?? '')) !== '') {
        try {
            $requestedEnrollmentStatus = (new EnrollmentLifecycleService($conn))->normalizeStatus($d['enrollment_status']);
        } catch (InvalidArgumentException $e) {
            respond(['success' => false, 'message' => $e->getMessage()], 422);
        }

        if (!$canManageEnrollmentStatus) {
            $statusSchoolYearId = intOrNull($d['school_year_id'] ?? null) ?? getActiveSchoolYearId($conn);
            $isAssignedAdviser = $roleKey === 'teacher'
                && $statusSchoolYearId > 0
                && teacherCanManageLearnerEnrollment($conn, $session, $learnerId, $statusSchoolYearId);
            if (!$isAssignedAdviser) {
                respond(['success' => false, 'message' => 'Enrollment status is locked. Only the class adviser assigned to this learner’s section can update it.'], 403);
            }
            $canManageEnrollmentStatus = true;
        }
    }

    $lrn = trim((string)($d['lrn'] ?? ''));
    if ($lrn !== '' && $lrn !== (string)$currentLrn) {
        if (!preg_match('/^\d{12}$/', $lrn)) respond(['success' => false, 'message' => 'LRN must be exactly 12 digits'], 422);
        $chk = $conn->prepare('SELECT 1 FROM learners WHERE lrn = :lrn AND learner_id <> :id LIMIT 1');
        $chk->bindValue(':lrn', $lrn);
        $chk->bindValue(':id', $learnerId, PDO::PARAM_INT);
        $chk->execute();
        if ($chk->fetchColumn()) respond(['success' => false, 'message' => 'LRN already exists.'], 409);
    }

    try {
        $conn->beginTransaction();

        // partial update — only provided keys are touched (S-12 fix: nothing is wiped)
        $up = []; $pv = [':id' => $learnerId];
        $set = function (string $col, $val, string $key) use (&$up, &$pv) {
            $up[] = "$col = :$key"; $pv[":$key"] = $val;
        };
        $preparedLearner = app_integrity_prepare_learner($conn, [
            'lrn' => $lrn !== '' ? $lrn : $currentLrn,
            'date_of_birth' => array_key_exists('date_of_birth', $d) ? normalizeDateForImport($d['date_of_birth']) : ($currentLearner['date_of_birth'] ?? null),
            'sex' => $d['sex'] ?? ($d['gender'] ?? ($currentLearner['sex'] ?? null)),
            'gender' => $d['gender'] ?? ($currentLearner['gender'] ?? null),
            'indigenous_group' => array_key_exists('indigenous_group', $d) || array_key_exists('indigenous_group_id', $d)
                ? ($d['indigenous_group'] ?? $d['indigenous_group_id'] ?? null)
                : ($currentLearner['indigenous_group'] ?? null),
            'is_indigenous' => array_key_exists('is_indigenous', $d) ? (int)$d['is_indigenous'] : (int)($currentLearner['is_indigenous'] ?? 0),
        ], $currentLearner, false);
        if ($lrn !== '' && $lrn !== (string)$currentLrn) $set('lrn', $lrn, 'lrn');
        foreach ([['first_name','fn'], ['middle_name','mn'], ['last_name','ln'],
                  ['address','addr']] as [$col, $key]) {
            if (array_key_exists($col, $d)) $set($col, nullIfEmpty($d[$col]), $key);
        }
        if (array_key_exists('name_extension', $d) || array_key_exists('name_extension_id', $d)) {
            $set('name_extension', nullIfEmpty($d['name_extension'] ?? $d['name_extension_id']), 'ext');
        }
        if (array_key_exists('date_of_birth', $d)) {
            $set('date_of_birth', $preparedLearner['date_of_birth'], 'dob');
        }
        if (array_key_exists('gender', $d) || array_key_exists('sex', $d)) {
            if ($preparedLearner['sex'] !== null) $set('sex', $preparedLearner['sex'], 'sx');
            if ($preparedLearner['gender'] !== null) $set('gender', $preparedLearner['gender'], 'g');
        }
        foreach ([['indigenous_group','indigenous_group_id','ig']] as [$col, $alt, $key]) {
            if (array_key_exists($col, $d) || array_key_exists($alt, $d)) {
                $set($col, $preparedLearner['indigenous_group'], $key);
                $set('is_indigenous', $preparedLearner['is_indigenous'], 'ind');
            }
        }
        if (array_key_exists('religion', $d) || array_key_exists('religion_id', $d)) {
            $set('religion', nullIfEmpty($d['religion'] ?? $d['religion_id'] ?? null), 'rel');
        }
        if (array_key_exists('mother_tongue', $d) || array_key_exists('mother_tongue_id', $d)) {
            $set('mother_tongue', nullIfEmpty($d['mother_tongue'] ?? $d['mother_tongue_id'] ?? null), 'mt');
        }
        if (array_key_exists('guardian_contact', $d) || array_key_exists('contact_number', $d)) {
            $set('contact_number', nullIfEmpty($d['guardian_contact'] ?? $d['contact_number']), 'cn');
        }
        if (array_key_exists('birth_province_text', $d) || array_key_exists('birth_place_text', $d) || array_key_exists('place_of_birth', $d)) {
            $birthProvinceText = nullIfEmpty($d['birth_province_text'] ?? $d['birth_place_text'] ?? $d['place_of_birth'] ?? null);
            $set('birth_province_text', $birthProvinceText, 'bpt');
            $set('birth_province_id', null, 'bpid');
        } elseif (array_key_exists('birth_province_id', $d)) {
            // Legacy ID payloads are intentionally cleared; LIS text is authoritative.
            $set('birth_province_id', null, 'bpid');
            $set('birth_province_text', null, 'bpt');
        }
        if (array_key_exists('completed', $d)) $set('completed', (int)$d['completed'], 'done');
        if ($up) {
            $sql = 'UPDATE learners SET ' . implode(', ', $up) . ' WHERE learner_id = :id';
            $u = $conn->prepare($sql);
            foreach ($pv as $k => $v) {
                if (in_array($k, [':id', ':done', ':bpid'], true)) bindNullable($u, $k, $v, PDO::PARAM_INT);
                else bindNullable($u, $k, $v);
            }
            $u->execute();
        }

        // enrollment (only when grade+section provided)
        $enrollmentId = 0;
        $schoolYearId = intOrNull($d['school_year_id'] ?? null) ?? getActiveSchoolYearId($conn);
        $gradeLevelId = intOrNull($d['grade_level_id'] ?? null);
        $sectionId = intOrNull($d['section_id'] ?? null);
        if ($schoolYearId && $gradeLevelId && $sectionId) {
            validateSectionConsistency($conn, $sectionId, $schoolYearId, $gradeLevelId);
            $e = $conn->prepare('SELECT enrollment_id FROM enrollments
                                 WHERE learner_id = :lid AND school_year_id = :sy AND is_deleted = 0
                                 ORDER BY enrollment_id DESC LIMIT 1');
            $e->bindValue(':lid', $learnerId, PDO::PARAM_INT);
            $e->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
            $e->execute();
            $eid = intOrNull($e->fetchColumn() ?: null);
            if ($eid) {
                $existingEnrollment = $conn->prepare('SELECT school_year_id, grade_level_id, section_id, curriculum_id, enrollment_status, entry_classification, is_deleted FROM enrollments WHERE enrollment_id = :id LIMIT 1');
                $existingEnrollment->execute([':id' => $eid]);
                $existingRow = $existingEnrollment->fetch(PDO::FETCH_ASSOC) ?: null;
                if (!$existingRow) app_integrity_fail('Enrollment record was not found.');
                $classificationWasProvided = array_key_exists('entry_classification', $d)
                    || array_key_exists('enrollment_type_id', $d);
                $entryClassification = $classificationWasProvided
                    ? (EnrollmentEntryClassificationService::normalize($d['entry_classification'] ?? null)
                        ?? EnrollmentEntryClassificationService::fromEnrollmentTypeId($conn, intOrNull($d['enrollment_type_id'] ?? null)))
                    : ($existingRow['entry_classification'] ?? null);
                $curriculumId = app_integrity_validate_enrollment($conn, [
                    'section_id' => $sectionId,
                    'school_year_id' => $schoolYearId,
                    'grade_level_id' => $gradeLevelId,
                    'curriculum_id' => intOrNull($d['curriculum_id'] ?? null) ?? intOrNull($existingRow['curriculum_id'] ?? null),
                    'enrollment_status' => $requestedEnrollmentStatus ?? ($existingRow['enrollment_status'] ?? 'Enrolled'),
                    'is_deleted' => (int)($existingRow['is_deleted'] ?? 0),
                ], $eid);
                $ue = $conn->prepare('UPDATE enrollments SET grade_level_id = :g, section_id = :s,
                                      curriculum_id = :c,
                                      enrollment_type_id = COALESCE(:t, enrollment_type_id),
                                      entry_classification = ' . ($classificationWasProvided ? ':classification' : 'entry_classification') . '
                                      WHERE enrollment_id = :id');
                $ue->bindValue(':g', $gradeLevelId, PDO::PARAM_INT);
                $ue->bindValue(':s', $sectionId, PDO::PARAM_INT);
                bindNullable($ue, ':c', $curriculumId, PDO::PARAM_INT);
                bindNullable($ue, ':t', intOrNull($d['enrollment_type_id'] ?? null), PDO::PARAM_INT);
                if ($classificationWasProvided) bindNullable($ue, ':classification', $entryClassification);
                $ue->bindValue(':id', $eid, PDO::PARAM_INT);
                $ue->execute();
                $enrollmentId = $eid;

                (new EnrollmentMovementService($conn))->recordTransferIn(
                    $eid,
                    $existingRow['entry_classification'] ?? null,
                    $entryClassification,
                    [
                        'source_type' => EnrollmentMovementService::SOURCE_MANUAL_PROFILE,
                        'user_id' => (int)($session['user_id'] ?? 0),
                    ]
                );

                if ($requestedEnrollmentStatus !== null
                    && $requestedEnrollmentStatus !== ($existingRow['enrollment_status'] ?? null)) {
                    (new EnrollmentLifecycleService($conn))->setStatus(
                        $eid,
                        $requestedEnrollmentStatus,
                        'learnerDetailsCombinedSave',
                        'Status changed together with learner details in Learner Details.',
                        [
                            'source_type' => EnrollmentMovementService::SOURCE_MANUAL_PROFILE,
                            'user_id' => (int)($session['user_id'] ?? 0),
                        ]
                    );
                }
            } else {
                if ($requestedEnrollmentStatus !== null && $requestedEnrollmentStatus !== 'Enrolled') {
                    throw new InvalidArgumentException('No enrollment exists for the selected school year. Save the learner record as Enrolled first.');
                }
                $curriculumId = app_integrity_validate_enrollment($conn, [
                    'section_id' => $sectionId,
                    'school_year_id' => $schoolYearId,
                    'grade_level_id' => $gradeLevelId,
                    'curriculum_id' => intOrNull($d['curriculum_id'] ?? null),
                    'enrollment_status' => 'Enrolled',
                    'is_deleted' => 0,
                ]);
                $newEntryClassification = EnrollmentEntryClassificationService::normalize($d['entry_classification'] ?? null)
                    ?? EnrollmentEntryClassificationService::fromEnrollmentTypeId($conn, intOrNull($d['enrollment_type_id'] ?? null));
                $ie = $conn->prepare('INSERT INTO enrollments
                    (learner_id, school_year_id, grade_level_id, section_id, curriculum_id,
                     enrollment_type_id, entry_classification, enrollment_status, enrollment_date)
                    VALUES (:lid, :sy, :g, :s, :c, :t, :classification, "Enrolled", CURDATE())');
                $ie->bindValue(':lid', $learnerId, PDO::PARAM_INT);
                $ie->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
                $ie->bindValue(':g', $gradeLevelId, PDO::PARAM_INT);
                $ie->bindValue(':s', $sectionId, PDO::PARAM_INT);
                bindNullable($ie, ':c', $curriculumId, PDO::PARAM_INT);
                bindNullable($ie, ':t', intOrNull($d['enrollment_type_id'] ?? null), PDO::PARAM_INT);
                bindNullable($ie, ':classification', $newEntryClassification);
                $ie->execute();
                $enrollmentId = (int)$conn->lastInsertId();

                (new EnrollmentMovementService($conn))->recordTransferIn(
                    $enrollmentId,
                    null,
                    $newEntryClassification,
                    [
                        'source_type' => EnrollmentMovementService::SOURCE_MANUAL_PROFILE,
                        'user_id' => (int)($session['user_id'] ?? 0),
                    ]
                );
            }
        }

        // address (structured fields from the learner control form)
        $houseStreet = nullIfEmpty($d['house_street'] ?? null);
        $barangay = nullIfEmpty($d['barangay'] ?? null);
        $municipality = nullIfEmpty($d['municipality'] ?? null);
        $province = nullIfEmpty($d['province'] ?? null);
        if ($houseStreet !== null || $barangay !== null || $municipality !== null || $province !== null) {
            $address = formatAddressFromParts($houseStreet, $barangay, $municipality, $province);
            if ($address !== null) {
                $ua = $conn->prepare('UPDATE learners SET address = :addr WHERE learner_id = :id');
                $ua->bindValue(':addr', $address);
                $ua->bindValue(':id', $learnerId, PDO::PARAM_INT);
                $ua->execute();
            }

            upsertCurrentAddress($conn, $learnerId, $houseStreet,
                                 $province, $municipality, $barangay);
        }

        // family — keyed upserts, nothing wiped
        if (array_key_exists('father_name', $d)) {
            upsertFamilyMember($conn, $learnerId, 'Father', $d['father_name'], $d['father_contact'] ?? null);
        }
        if (array_key_exists('mother_name', $d)) {
            upsertFamilyMember($conn, $learnerId, 'Mother', $d['mother_name'], $d['mother_contact'] ?? null);
        }
        if (array_key_exists('guardian_name', $d)) {
            $rel = normalizeGuardianRelationshipCategory(
                $d['guardian_relationship'] ?? null,
                $d['guardian_name'] ?? null,
                $d['father_name'] ?? null,
                $d['mother_name'] ?? null
            );
            upsertFamilyMember($conn, $learnerId, $rel, $d['guardian_name'],
                               $d['guardian_contact'] ?? null, true);
        }

        upsertPreviousSchool($conn, $learnerId, $enrollmentId, $d);

        $conn->commit();
        respond(['success' => true, 'message' => 'Registration updated.',
                 'learner_id' => $learnerId, 'enrollment_id' => $enrollmentId]);
    } catch (PDOException $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        if (is_name_extension_fk_violation($e)) respond(name_extension_fk_error_payload(), 422);
        if ((string)$e->getCode() === '45000') respond(['success' => false, 'message' => $e->getMessage()], 409);
        respond(['success' => false, 'message' => 'Database error: ' . $e->getMessage()], 500);
    } catch (Exception $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => $e->getMessage()], 422);
    }
}

function deleteRegistration(PDO $conn): void {
    $d = getJsonInput();
    $learnerId = intOrNull($d['learner_id'] ?? null);
    if ($learnerId === null) respond(['success' => false, 'message' => 'Learner ID is required'], 422);
    try {
        $conn->beginTransaction();
        foreach (['enrollments', 'family_members',
                  'learner_previous_schools', 'learner_addresses'] as $t) {
            $stmt = $conn->prepare("UPDATE {$t} SET is_deleted = 1, deleted_at = NOW()
                                    WHERE learner_id = :id AND is_deleted = 0");
            $stmt->bindValue(':id', $learnerId, PDO::PARAM_INT);
            $stmt->execute();
        }
        $stmt = $conn->prepare('UPDATE learners SET is_deleted = 1, deleted_at = NOW() WHERE learner_id = :id');
        $stmt->bindValue(':id', $learnerId, PDO::PARAM_INT);
        $stmt->execute();
        $conn->commit();
        respond(['success' => true, 'message' => 'Registration deleted.']);
    } catch (Exception $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        respond(['success' => false, 'message' => 'Error: ' . $e->getMessage()], 500);
    }
}
