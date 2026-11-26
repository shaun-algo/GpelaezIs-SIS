<?php

/**
 * Source-of-truth helpers for imported Balik-Aral / returnee statuses.
 *
 * The import file is authoritative. This service intentionally does not infer
 * a returnee from a school-year gap and does not create a pending case.
 */
class ReturneeCaseService
{
    private static array $tableCache = [];

    public static function tableExists(PDO $conn, string $table): bool
    {
        if (array_key_exists($table, self::$tableCache)) return self::$tableCache[$table];
        $stmt = $conn->prepare('SELECT 1 FROM information_schema.tables
                                WHERE table_schema = DATABASE() AND table_name = :table LIMIT 1');
        $stmt->bindValue(':table', $table);
        $stmt->execute();
        return self::$tableCache[$table] = (bool)$stmt->fetchColumn();
    }

    public static function normalizeRemark(?string $remark): string
    {
        $value = function_exists('mb_strtolower')
            ? mb_strtolower(trim((string)($remark ?? '')))
            : strtolower(trim((string)($remark ?? '')));
        $value = preg_replace('/[‐‑‒–—―]/u', '-', $value);
        $value = preg_replace('/\s+/', ' ', (string)$value);
        return trim((string)$value);
    }

    public static function isExplicitReturneeRemark(?string $remark): bool
    {
        return in_array(self::normalizeRemark($remark), [
            'balik-aral', 'balik aral', 'balik-aral learner', 'balik aral learner',
            'ba', 'b/a', 'returnee', 'returnee learner'
        ], true);
    }

    public static function balikAralTypeId(PDO $conn): ?int
    {
        if (!self::tableExists($conn, 'enrollment_types')) return null;
        $stmt = $conn->prepare("SELECT enrollment_type_id FROM enrollment_types
                                WHERE is_deleted = 0 AND LOWER(type_name) = 'balik-aral'
                                ORDER BY enrollment_type_id LIMIT 1");
        $stmt->execute();
        $id = $stmt->fetchColumn();
        return $id === false ? null : (int)$id;
    }

    public static function assess(PDO $conn, ?string $sourceRemark = null): array
    {
        $isReturnee = self::isExplicitReturneeRemark($sourceRemark);
        return [
            'classification' => $isReturnee ? 'Returnee' : 'Promote',
            'is_returnee' => $isReturnee,
            'source' => 'Import Source',
            'evidence' => null,
            'messages' => $isReturnee ? [[
                'severity' => 'I',
                'field' => 'returnee',
                'code' => 'returnee_source_status',
                'message' => 'Source record identifies this learner as Balik-Aral. The target-year enrollment will be stored as Enrolled / Returnee.'
            ]] : [],
            'enrollment_type_id' => $isReturnee ? self::balikAralTypeId($conn) : null,
        ];
    }
}
