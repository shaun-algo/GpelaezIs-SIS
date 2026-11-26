<?php
declare(strict_types=1);

/**
 * Grade 1 descriptive progression evidence.
 *
 * Grade 1 descriptive SF9 records do not produce numeric final_grades or a
 * general average.  Promotion readiness is therefore based on the PACE form
 * having a valid rating for every editable competency cell in Terms 1–3.
 */
final class DescriptiveProgressionService
{
    public const BASIS = 'descriptive_pace';

    /**
     * Return whether a school-year/grade pair uses the Grade 1 descriptive SF9.
     */
    public static function isGradeOneDescriptive(PDO $conn, int $schoolYearId, int $gradeLevelId): bool
    {
        if ($schoolYearId <= 0 || $gradeLevelId <= 0) {
            return false;
        }

        $stmt = $conn->prepare(
            'SELECT gl.grade_name,
                    p.grading_mode,
                    p.sf9_template_variant
             FROM grade_levels gl
             LEFT JOIN school_year_grade_policies p
               ON p.grade_level_id = gl.grade_level_id
              AND p.school_year_id = :school_year_id
              AND p.is_deleted = 0
             WHERE gl.grade_level_id = :grade_level_id
               AND gl.is_deleted = 0
             LIMIT 1'
        );
        try {
            $stmt->execute([
                ':school_year_id' => $schoolYearId,
                ':grade_level_id' => $gradeLevelId,
            ]);
        } catch (PDOException $e) {
            // Older installations may not have the optional policy table yet.
            $fallback = $conn->prepare(
                'SELECT grade_name
                 FROM grade_levels
                 WHERE grade_level_id = :grade_level_id
                   AND is_deleted = 0
                 LIMIT 1'
            );
            $fallback->execute([':grade_level_id' => $gradeLevelId]);
            $gradeName = (string)($fallback->fetchColumn() ?: '');
            return preg_match('/^grade\s*1$/i', trim($gradeName)) === 1;
        }

        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row || !preg_match('/^grade\s*1$/i', trim((string)($row['grade_name'] ?? '')))) {
            return false;
        }

        $mode = strtolower(trim((string)($row['grading_mode'] ?? '')));
        $variant = strtoupper(trim((string)($row['sf9_template_variant'] ?? '')));

        // The policy row is authoritative when present.  If it is absent,
        // retain the application's Grade 1 default of descriptive mode.
        return ($mode === '' || $mode === 'descriptive')
            && ($variant === '' || $variant === 'G1');
    }

    /**
     * Inspect PACE completion for one Grade 1 enrollment.
     *
     * The expected counts are derived from the same printable SF9/PACE source
     * used by the browser.  If that source is unavailable on an older host,
     * the safe fallback still requires at least one valid rating in every term.
     */
    public static function evidenceForEnrollment(PDO $conn, int $enrollmentId): array
    {
        $empty = [
            'is_descriptive' => false,
            'complete' => false,
            'school_year_id' => null,
            'grade_level_id' => null,
            'expected_by_term' => [1 => 0, 2 => 0, 3 => 0],
            'actual_by_term' => [1 => 0, 2 => 0, 3 => 0],
            'missing_terms' => [1, 2, 3],
            'expected_total' => 0,
            'actual_total' => 0,
        ];

        if ($enrollmentId <= 0) {
            return $empty;
        }

        $metaStmt = $conn->prepare(
            'SELECT e.school_year_id, e.grade_level_id, gl.grade_name
             FROM enrollments e
             JOIN grade_levels gl ON gl.grade_level_id = e.grade_level_id
             WHERE e.enrollment_id = :enrollment_id
               AND e.is_deleted = 0
             LIMIT 1'
        );
        $metaStmt->execute([':enrollment_id' => $enrollmentId]);
        $meta = $metaStmt->fetch(PDO::FETCH_ASSOC);
        if (!$meta) {
            return $empty;
        }

        $schoolYearId = (int)$meta['school_year_id'];
        $gradeLevelId = (int)$meta['grade_level_id'];
        if (!self::isGradeOneDescriptive($conn, $schoolYearId, $gradeLevelId)) {
            return $empty;
        }

        $expected = self::expectedRatingCountsByTerm();
        if (!self::tableExists($conn, 'sf9_pace_ratings')) {
            foreach ($expected as $periodNo => $count) {
                if ($count <= 0) $expected[$periodNo] = 1;
            }
            return [
                'is_descriptive' => true,
                'complete' => false,
                'school_year_id' => $schoolYearId,
                'grade_level_id' => $gradeLevelId,
                'grade_name' => (string)$meta['grade_name'],
                'expected_by_term' => $expected,
                'actual_by_term' => [1 => 0, 2 => 0, 3 => 0],
                'missing_terms' => [1, 2, 3],
                'expected_total' => array_sum($expected),
                'actual_total' => 0,
            ];
        }

        $actual = [1 => 0, 2 => 0, 3 => 0];
        $countStmt = $conn->prepare(
            'SELECT gp.period_no, COUNT(DISTINCT pr.catalog_key) AS rating_count
             FROM sf9_pace_ratings pr
             JOIN grading_periods gp
               ON gp.grading_period_id = pr.grading_period_id
              AND gp.school_year_id = pr.school_year_id
              AND gp.is_deleted = 0
             WHERE pr.enrollment_id = :enrollment_id
               AND pr.school_year_id = :school_year_id
               AND pr.grade_level_id = :grade_level_id
               AND pr.is_deleted = 0
               AND gp.period_no BETWEEN 1 AND 3
               AND pr.rating_code IN (\'A\', \'B\', \'C\', \'D\', \'E\')
             GROUP BY gp.period_no'
        );
        $countStmt->execute([
            ':enrollment_id' => $enrollmentId,
            ':school_year_id' => $schoolYearId,
            ':grade_level_id' => $gradeLevelId,
        ]);
        while ($row = $countStmt->fetch(PDO::FETCH_ASSOC)) {
            $periodNo = (int)$row['period_no'];
            if (isset($actual[$periodNo])) {
                $actual[$periodNo] = (int)$row['rating_count'];
            }
        }

        // A zero expected count means the template could not be inspected.
        // Requiring one valid rating per term remains safer than accepting an
        // entirely empty PACE record.
        foreach ($expected as $periodNo => $count) {
            if ($count <= 0) $expected[$periodNo] = 1;
        }

        $missing = [];
        foreach ([1, 2, 3] as $periodNo) {
            if ($actual[$periodNo] < $expected[$periodNo]) {
                $missing[] = $periodNo;
            }
        }

        return [
            'is_descriptive' => true,
            'complete' => $missing === [],
            'school_year_id' => $schoolYearId,
            'grade_level_id' => $gradeLevelId,
            'grade_name' => (string)$meta['grade_name'],
            'expected_by_term' => $expected,
            'actual_by_term' => $actual,
            'missing_terms' => $missing,
            'expected_total' => array_sum($expected),
            'actual_total' => array_sum($actual),
        ];
    }

    /**
     * Count editable PACE fields in the official local template.
     *
     * These counts are intentionally kept out of the database: the browser
     * and server both use the same source template, so a changed template
     * automatically changes the completion requirement.
     */
    private static function expectedRatingCountsByTerm(): array
    {
        static $counts;
        if ($counts !== null) return $counts;

        $counts = [1 => 0, 2 => 0, 3 => 0];
        $template = dirname(__DIR__, 2) . '/sample_pages/sf9/SF9_descriptive-SY2026-2027.html';
        if (!is_file($template) || !class_exists('DOMDocument')) return $counts;

        $document = new DOMDocument();
        $previous = libxml_use_internal_errors(true);
        $loaded = $document->loadHTMLFile($template);
        libxml_clear_errors();
        libxml_use_internal_errors($previous);
        if (!$loaded) return $counts;

        $xpath = new DOMXPath($document);
        $sections = $xpath->query(
            '//section[contains(concat(" ", normalize-space(@class), " "), " pace-page ")]'
        );
        if (!$sections) return $counts;

        foreach ($sections as $section) {
            $tables = $xpath->query('.//table', $section);
            foreach ($tables as $table) {
                $class = ' ' . preg_replace('/\s+/', ' ', trim((string)$table->getAttribute('class'))) . ' ';
                if (str_contains($class, ' pace ')) {
                    $headers = [];
                    foreach ($xpath->query('.//thead//th', $table) as $header) {
                        $headerClass = ' ' . preg_replace('/\s+/', ' ', trim((string)$header->getAttribute('class'))) . ' ';
                        if (!str_contains($headerClass, ' t ')) continue;
                        $text = trim((string)$header->textContent);
                        $headers[] = preg_match('/([1-3])/', $text, $m) ? (int)$m[1] : count($headers) + 1;
                    }
                    foreach ($xpath->query('.//tbody//tr', $table) as $row) {
                        $cells = $xpath->query('./td[contains(concat(" ", normalize-space(@class), " "), " c ")]', $row);
                        foreach ($cells as $index => $cell) {
                            $cellClass = ' ' . preg_replace('/\s+/', ' ', trim((string)$cell->getAttribute('class'))) . ' ';
                            if (!$cell->hasAttribute('contenteditable')
                                || !preg_match('/\b[LSRW]\b/', $cellClass)) continue;
                            $term = $headers[$index] ?? ($index + 1);
                            if (isset($counts[$term])) $counts[$term]++;
                        }
                    }
                } elseif (str_contains($class, ' lc ')) {
                    $term = 0;
                    foreach ($xpath->query('.//tbody//tr', $table) as $row) {
                        $rowClass = ' ' . preg_replace('/\s+/', ' ', trim((string)$row->getAttribute('class'))) . ' ';
                        if (str_contains($rowClass, ' termrow ')) {
                            $term = preg_match('/Term\s*([1-3])/i', (string)$row->textContent, $m)
                                ? (int)$m[1]
                                : 0;
                            continue;
                        }
                        if (!isset($counts[$term])) continue;
                        foreach ($xpath->query('./td[contains(concat(" ", normalize-space(@class), " "), " rt ")]', $row) as $cell) {
                            $cellClass = ' ' . preg_replace('/\s+/', ' ', trim((string)$cell->getAttribute('class'))) . ' ';
                            if ($cell->hasAttribute('contenteditable') && !str_contains($cellClass, ' blank ')) {
                                $counts[$term]++;
                            }
                        }
                    }
                }
            }
        }

        return $counts;
    }

    private static function tableExists(PDO $conn, string $table): bool
    {
        static $cache = [];
        if (array_key_exists($table, $cache)) return $cache[$table];
        $stmt = $conn->query('SHOW TABLES LIKE ' . $conn->quote($table));
        return $cache[$table] = (bool)$stmt->fetch(PDO::FETCH_NUM);
    }
}
