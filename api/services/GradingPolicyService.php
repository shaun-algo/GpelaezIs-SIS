<?php

/**
 * Resolves the grading mode and SF9 variant for a school-year/grade pair.
 *
 * The table is optional at runtime so an older installation continues to use
 * the built-in grade-level defaults until the additive migration is applied.
 */
final class GradingPolicyService
{
    public static function defaultElementaryModes(): array
    {
        return [
            1 => 'Descriptive',
            2 => 'Numeric',
            3 => 'Numeric',
        ];
    }

    public static function requestedElementaryModes(array $data): array
    {
        $modes = [];
        foreach ([1, 2, 3] as $gradeNo) {
            $key = "grade_{$gradeNo}_grading_mode";
            if (!array_key_exists($key, $data)) {
                continue;
            }
            $mode = ucfirst(strtolower(trim((string)$data[$key])));
            if (!in_array($mode, ['Numeric', 'Descriptive'], true)) {
                throw new InvalidArgumentException("Grade {$gradeNo} grading mode must be Numeric or Descriptive");
            }
            $modes[$gradeNo] = $mode;
        }
        return $modes;
    }

    public static function saveElementaryModes(PDO $conn, int $schoolYearId, array $modes): void
    {
        if (!$modes) {
            return;
        }
        if (!self::tableExists($conn)) {
            throw new InvalidArgumentException('Apply the grading-policy migration before configuring Grade 1-3 modes');
        }

        $gradeLevelIds = self::gradeLevelIdsByNumber($conn);
        $stmt = $conn->prepare(
            'INSERT INTO school_year_grade_policies
                (school_year_id, grade_level_id, grading_mode, sf9_template_variant, is_deleted, deleted_at)
             VALUES (:school_year_id, :grade_level_id, :grading_mode, :sf9_template_variant, 0, NULL)
             ON DUPLICATE KEY UPDATE
                grading_mode = VALUES(grading_mode),
                sf9_template_variant = VALUES(sf9_template_variant),
                is_deleted = 0,
                deleted_at = NULL'
        );

        foreach ($modes as $gradeNo => $mode) {
            $gradeNo = (int)$gradeNo;
            $stmt->execute([
                ':school_year_id' => $schoolYearId,
                // The current seed uses IDs 1-3, but the policy is about the
                // named grade level. Resolve the real ID first so a future
                // installation with different IDs cannot split modal and SF9
                // behavior across two policy rows.
                ':grade_level_id' => $gradeLevelIds[$gradeNo] ?? $gradeNo,
                ':grading_mode' => $mode,
                ':sf9_template_variant' => "G{$gradeNo}",
            ]);
        }
    }

    public static function elementaryModeFields(PDO $conn, int $schoolYearId): array
    {
        $modes = self::defaultElementaryModes();
        if ($schoolYearId <= 0 || !self::tableExists($conn)) {
            return $modes;
        }

        $stmt = $conn->prepare(
            'SELECT p.grade_level_id, p.grading_mode, gl.grade_name
             FROM school_year_grade_policies p
             LEFT JOIN grade_levels gl ON gl.grade_level_id = p.grade_level_id
             WHERE p.school_year_id = :school_year_id
               AND p.is_deleted = 0'
        );
        $stmt->execute([':school_year_id' => $schoolYearId]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $gradeNo = self::gradeNumber((int)($row['grade_level_id'] ?? 0), $row['grade_name'] ?? null);
            $mode = ucfirst(strtolower(trim((string)($row['grading_mode'] ?? ''))));
            if (isset($modes[$gradeNo]) && in_array($mode, ['Numeric', 'Descriptive'], true)) {
                $modes[$gradeNo] = $mode;
            }
        }
        return $modes;
    }

    public static function resolve(PDO $conn, int $schoolYearId, int $gradeLevelId, ?string $gradeName = null): array
    {
        $fallback = self::fallback($gradeLevelId, $gradeName);
        if ($schoolYearId <= 0 || $gradeLevelId <= 0 || !self::tableExists($conn)) {
            return $fallback;
        }

        $stmt = $conn->prepare(
            'SELECT grading_mode, sf9_template_variant
             FROM school_year_grade_policies
             WHERE school_year_id = :school_year_id
               AND grade_level_id = :grade_level_id
               AND is_deleted = 0
             LIMIT 1'
        );
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':grade_level_id', $gradeLevelId, PDO::PARAM_INT);
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return $fallback;
        }

        $mode = self::normalizeMode($row['grading_mode'] ?? $fallback['grading_mode']);
        $variant = self::normalizeVariant($row['sf9_template_variant'] ?? $fallback['sf9_template_variant'], $fallback['sf9_template_variant']);
        return [
            'grading_mode' => $mode,
            'sf9_template_variant' => $variant,
            'supports_term_comments' => $mode === 'Numeric' && in_array($variant, ['G2', 'G3', 'G4_10'], true),
            'is_explicit' => true,
        ];
    }

    public static function fallback(int $gradeLevelId, ?string $gradeName = null): array
    {
        $gradeNo = self::gradeNumber($gradeLevelId, $gradeName);
        if ($gradeNo <= 0 && preg_match('/(\d+)/', (string)$gradeName, $match)) {
            $gradeNo = (int)$match[1];
        }
        $variant = match (true) {
            $gradeNo === 1 => 'G1',
            $gradeNo === 2 => 'G2',
            $gradeNo === 3 => 'G3',
            $gradeNo >= 4 && $gradeNo <= 10 => 'G4_10',
            default => 'LEGACY',
        };

        return [
            // Grade 1 uses the handwritten descriptive SF9 flow even when an
            // older installation has not yet applied the policy migration.
            'grading_mode' => $variant === 'G1' ? 'Descriptive' : 'Numeric',
            'sf9_template_variant' => $variant,
            'supports_term_comments' => $variant !== 'G1' && in_array($variant, ['G2', 'G3', 'G4_10'], true),
            'is_explicit' => false,
        ];
    }

    private static function normalizeMode($value): string
    {
        return strtolower(trim((string)$value)) === 'descriptive' ? 'Descriptive' : 'Numeric';
    }

    private static function normalizeVariant($value, string $fallback): string
    {
        $variant = strtoupper(trim((string)$value));
        return in_array($variant, ['G1', 'G2', 'G3', 'G4_10', 'LEGACY'], true) ? $variant : $fallback;
    }

    private static function gradeNumber(int $gradeLevelId, ?string $gradeName = null): int
    {
        $name = trim((string)($gradeName ?? ''));
        if (preg_match('/\b(?:grade|g)\s*0*(\d+)\b/i', $name, $match)) {
            return (int)$match[1];
        }

        // Preserve compatibility with the seeded schema, where Grade 1-10
        // currently use matching IDs.
        return $gradeLevelId >= 1 && $gradeLevelId <= 10 ? $gradeLevelId : 0;
    }

    private static function gradeLevelIdsByNumber(PDO $conn): array
    {
        try {
            $stmt = $conn->query(
                'SELECT grade_level_id, grade_name
                 FROM grade_levels
                 WHERE is_deleted = 0'
            );
            $ids = [];
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $gradeNo = self::gradeNumber((int)($row['grade_level_id'] ?? 0), $row['grade_name'] ?? null);
                if ($gradeNo >= 1 && $gradeNo <= 3 && !isset($ids[$gradeNo])) {
                    $ids[$gradeNo] = (int)$row['grade_level_id'];
                }
            }
            return $ids;
        } catch (Throwable $_) {
            return [];
        }
    }

    private static function tableExists(PDO $conn): bool
    {
        static $exists;
        if ($exists !== null) {
            return $exists;
        }
        try {
            $stmt = $conn->query("SHOW TABLES LIKE 'school_year_grade_policies'");
            $exists = (bool)$stmt->fetch(PDO::FETCH_NUM);
        } catch (Throwable $_) {
            $exists = false;
        }
        return $exists;
    }
}
