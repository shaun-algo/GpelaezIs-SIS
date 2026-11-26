<?php

require_once __DIR__ . '/TemplateSchemaService.php';

/** Resolves the published template assigned to a school-year/grade pair. */
final class ReportCardTemplateService
{
    /**
     * Rehydrates a report-card template from the immutable snapshot stored on
     * report_cards. This deliberately does not query the live template row, so
     * later template versions cannot change an already-generated card.
     */
    public static function fromSnapshot(array $row): ?array
    {
        $schemaJson = trim((string)($row['template_schema_json'] ?? ''));
        $templateCode = trim((string)($row['template_code'] ?? ''));
        if ($schemaJson === '' && $templateCode === '') {
            return null;
        }

        $mode = strtolower(trim((string)($row['template_grading_mode'] ?? '')))
            === 'descriptive' ? 'Descriptive' : 'Numeric';
        $schema = TemplateSchemaService::decode($schemaJson, $mode);
        $schemaMode = strtolower(trim((string)($schema['mode'] ?? '')))
            === 'descriptive' ? 'Descriptive' : $mode;

        return [
            'template_id' => (int)($row['template_id'] ?? 0),
            'template_code' => $templateCode !== '' ? $templateCode : 'HISTORICAL-SF9',
            'template_name' => $templateCode !== '' ? $templateCode : 'Historical SF9 Template',
            'grade_scope' => 'historical',
            'grading_mode' => $schemaMode,
            'version_no' => max(1, (int)($row['template_version'] ?? 1)),
            // Keep this as Published so existing renderers continue to use the
            // captured schema, while exposing the source for diagnostics.
            'status' => 'Published',
            'is_historical_snapshot' => true,
            'schema' => TemplateSchemaService::normalize($schema, $schemaMode),
        ];
    }

    public static function resolve(PDO $conn, int $schoolYearId, int $gradeLevelId, string $variant, string $mode): ?array
    {
        if (!self::tableExists($conn)) {
            return null;
        }

        $normalizedMode = strtolower(trim($mode)) === 'descriptive' ? 'Descriptive' : 'Numeric';
        $fallbackCode = TemplateSchemaService::fallbackCode($variant, $gradeLevelId);
        $stmt = $conn->prepare(
            'SELECT t.template_id, t.template_code, t.template_name, t.grade_scope,
                    t.grading_mode, t.version_no, t.status, t.schema_json
             FROM report_card_template_assignments a
             JOIN report_card_templates t ON t.template_id = a.template_id
                                           AND t.is_deleted = 0
                                           AND t.status = "Published"
             WHERE a.school_year_id = :school_year_id
               AND a.grade_level_id = :grade_level_id
               AND a.is_deleted = 0
               AND LOWER(t.grading_mode) = LOWER(:grading_mode)
             LIMIT 1'
        );
        $stmt->execute([
            ':school_year_id' => $schoolYearId,
            ':grade_level_id' => $gradeLevelId,
            ':grading_mode' => $normalizedMode,
        ]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$row) {
            $fallback = $conn->prepare(
                'SELECT template_id, template_code, template_name, grade_scope,
                        grading_mode, version_no, status, schema_json
                 FROM report_card_templates
                 WHERE template_code = :template_code
                   AND status = "Published"
                   AND is_deleted = 0
                   AND LOWER(grading_mode) = LOWER(:grading_mode)
                 ORDER BY version_no DESC, template_id DESC
                 LIMIT 1'
            );
            $fallback->execute([
                ':template_code' => $fallbackCode,
                ':grading_mode' => $normalizedMode,
            ]);
            $row = $fallback->fetch(PDO::FETCH_ASSOC);
        }

        if (!$row) {
            return [
                'template_id' => 0,
                'template_code' => $fallbackCode,
                'template_name' => $fallbackCode,
                'grade_scope' => (string)$gradeLevelId,
                'grading_mode' => $normalizedMode,
                'version_no' => 1,
                'status' => 'Fallback',
                'schema' => TemplateSchemaService::defaultSchema($fallbackCode, $normalizedMode),
            ];
        }

        // A published template is only eligible after matching the resolved
        // school-year policy. Keep the returned contract canonical as well so
        // future renderers cannot accidentally switch modes from template
        // metadata alone.
        $templateMode = $normalizedMode;
        return [
            'template_id' => (int)$row['template_id'],
            'template_code' => (string)$row['template_code'],
            'template_name' => (string)$row['template_name'],
            'grade_scope' => (string)$row['grade_scope'],
            'grading_mode' => $templateMode,
            'version_no' => (int)$row['version_no'],
            'status' => (string)$row['status'],
            'schema' => TemplateSchemaService::decode($row['schema_json'] ?? '', $templateMode),
        ];
    }

    private static function tableExists(PDO $conn): bool
    {
        static $exists;
        if ($exists !== null) return $exists;
        try {
            $stmt = $conn->query("SHOW TABLES LIKE 'report_card_templates'");
            $exists = (bool)$stmt->fetch(PDO::FETCH_NUM);
        } catch (Throwable $_) {
            $exists = false;
        }
        return $exists;
    }
}
