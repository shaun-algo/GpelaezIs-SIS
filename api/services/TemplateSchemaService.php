<?php

/**
 * Normalizes the safe, data-only schema used by the dynamic report-card
 * template builder. Templates never execute HTML, JavaScript, SQL, or user
 * supplied formulas; they describe rows, columns, and approved cell types.
 */
final class TemplateSchemaService
{
    public static function defaultSchema(string $templateCode = 'SF9-G4-10-DYNAMIC', string $mode = 'Numeric'): array
    {
        $normalizedCode = strtoupper(trim($templateCode));
        $isDescriptive = strtolower(trim($mode)) === 'descriptive' || str_contains($normalizedCode, 'G1');
        $periodColumn = [
            'key' => 'periods',
            'label' => 'Term',
            'type' => 'period',
            'source' => 'grading_periods',
        ];

        if ($isDescriptive) {
            return [
                'schema_version' => 1,
                'mode' => 'Descriptive',
                'indicator' => [
                    'key' => 'descriptor',
                    'label' => 'Grade Indicator',
                    'type' => 'enum',
                    'values' => ['A', 'B', 'C', 'D', 'E'],
                ],
                'columns' => [$periodColumn],
                'rows' => [
                    ['key' => 'reading', 'label' => 'Reading and Literacy', 'binding' => 'reading', 'type' => 'learning_area'],
                    ['key' => 'language', 'label' => 'Language', 'binding' => 'language', 'type' => 'learning_area'],
                    ['key' => 'mathematics', 'label' => 'Mathematics', 'binding' => 'mathematics', 'type' => 'learning_area'],
                    ['key' => 'gmrc', 'label' => 'Good Manners and Right Conduct', 'binding' => 'gmrc', 'type' => 'learning_area'],
                    ['key' => 'makabansa', 'label' => 'Makabansa', 'binding' => 'makabansa', 'type' => 'learning_area'],
                ],
                'options' => ['show_general_average' => false],
            ];
        }

        return [
            'schema_version' => 1,
            'mode' => 'Numeric',
            'indicator' => [
                'key' => 'numeric',
                'label' => 'Numeric Grade',
                'type' => 'numeric',
                'min' => 60,
                'max' => 100,
            ],
            'columns' => [
                $periodColumn,
                ['key' => 'final_grade', 'label' => 'Final Grade', 'type' => 'computed', 'source' => 'final_grade'],
                ['key' => 'remarks', 'label' => 'Remarks', 'type' => 'computed', 'source' => 'remarks'],
            ],
            'rows' => [
                ['key' => 'filipino', 'label' => 'Filipino', 'binding' => 'filipino', 'type' => 'learning_area'],
                ['key' => 'english', 'label' => 'English', 'binding' => 'english', 'type' => 'learning_area'],
                ['key' => 'mathematics', 'label' => 'Mathematics', 'binding' => 'mathematics', 'type' => 'learning_area'],
                ['key' => 'science', 'label' => 'Science', 'binding' => 'science', 'type' => 'learning_area'],
                ['key' => 'araling_panlipunan', 'label' => 'Araling Panlipunan', 'binding' => 'araling panlipunan', 'type' => 'learning_area'],
                ['key' => 'gmrc', 'label' => 'GMRC / Values Education', 'binding' => 'gmrc', 'type' => 'learning_area'],
                ['key' => 'epp_tle', 'label' => 'EPP / TLE', 'binding' => 'epp', 'type' => 'learning_area'],
                ['key' => 'mapeh', 'label' => 'MAPEH', 'binding' => 'mapeh', 'type' => 'group'],
                ['key' => 'music_arts', 'label' => 'Music and Arts', 'binding' => 'music and arts', 'type' => 'learning_area'],
                ['key' => 'pe_health', 'label' => 'Physical Education and Health', 'binding' => 'physical education and health', 'type' => 'learning_area'],
            ],
            'options' => ['show_general_average' => true],
        ];
    }

    public static function normalize(array $schema, string $mode = 'Numeric'): array
    {
        $normalizedMode = strtolower(trim($mode)) === 'descriptive' ? 'Descriptive' : 'Numeric';
        $defaults = self::defaultSchema('', $normalizedMode);
        $indicator = is_array($schema['indicator'] ?? null) ? $schema['indicator'] : $defaults['indicator'];
        $indicatorType = strtolower(trim((string)($indicator['type'] ?? '')));
        if (!in_array($indicatorType, ['numeric', 'enum', 'text'], true)) {
            $indicatorType = $normalizedMode === 'Descriptive' ? 'enum' : 'numeric';
        }

        $normalizedIndicator = [
            'key' => self::safeKey($indicator['key'] ?? 'indicator', 'indicator'),
            'label' => self::label($indicator['label'] ?? 'Grade Indicator', 'Grade Indicator'),
            'type' => $indicatorType,
        ];
        if ($indicatorType === 'enum') {
            $values = is_array($indicator['values'] ?? null) ? $indicator['values'] : [];
            $normalizedValues = [];
            foreach ($values as $value) {
                $value = trim((string)$value);
                if ($value === '' || mb_strlen($value) > 80) continue;
                if (!in_array($value, $normalizedValues, true)) $normalizedValues[] = $value;
                if (count($normalizedValues) >= 50) break;
            }
            if (!$normalizedValues) $normalizedValues = $normalizedMode === 'Descriptive' ? ['A', 'B', 'C', 'D', 'E'] : ['1', '2', '3'];
            $normalizedIndicator['values'] = $normalizedValues;
        }
        if ($indicatorType === 'numeric') {
            $min = is_numeric($indicator['min'] ?? null) ? (float)$indicator['min'] : 0;
            $max = is_numeric($indicator['max'] ?? null) ? (float)$indicator['max'] : 100;
            $normalizedIndicator['min'] = max(-999999, min(999999, $min));
            $normalizedIndicator['max'] = max($normalizedIndicator['min'], min(999999, $max));
        }

        $columns = self::normalizeCollection($schema['columns'] ?? null, $defaults['columns'], 'column');
        $rows = self::normalizeCollection($schema['rows'] ?? null, $defaults['rows'], 'row');
        $options = is_array($schema['options'] ?? null) ? $schema['options'] : [];

        return [
            'schema_version' => 1,
            'mode' => $normalizedMode,
            'indicator' => $normalizedIndicator,
            'columns' => $columns,
            'rows' => $rows,
            'options' => [
                'show_general_average' => (bool)($options['show_general_average'] ?? ($normalizedMode === 'Numeric')),
            ],
        ];
    }

    public static function decode(?string $json, string $mode = 'Numeric'): array
    {
        $decoded = $json ? json_decode($json, true) : null;
        return self::normalize(is_array($decoded) ? $decoded : [], $mode);
    }

    public static function fallbackCode(string $variant, int $gradeLevelId = 0): string
    {
        $variant = strtoupper(trim($variant));
        if ($variant === 'G1' || $gradeLevelId === 1) return 'SF9-G1-DYNAMIC';
        if ($variant === 'G2' || $gradeLevelId === 2) return 'SF9-G2-DYNAMIC';
        return 'SF9-G4-10-DYNAMIC';
    }

    private static function normalizeCollection($incoming, array $fallback, string $kind): array
    {
        $items = is_array($incoming) && $incoming ? $incoming : $fallback;
        $result = [];
        $usedKeys = [];
        foreach ($items as $index => $item) {
            if (!is_array($item)) continue;
            $default = $fallback[$index] ?? [];
            $key = self::safeKey($item['key'] ?? ($default['key'] ?? "{$kind}_" . ($index + 1)), "{$kind}_" . ($index + 1));
            $baseKey = $key;
            $suffix = 2;
            while (isset($usedKeys[$key])) $key = $baseKey . '_' . $suffix++;
            $usedKeys[$key] = true;

            $type = strtolower(trim((string)($item['type'] ?? ($default['type'] ?? ($kind === 'row' ? 'learning_area' : 'text')))));
            $allowedTypes = $kind === 'row'
                ? ['learning_area', 'group', 'text']
                : ['period', 'numeric', 'rating', 'computed', 'text'];
            if (!in_array($type, $allowedTypes, true)) $type = $allowedTypes[0];

            $row = [
                'key' => $key,
                'label' => self::label($item['label'] ?? ($default['label'] ?? ucfirst(str_replace('_', ' ', $key))), ucfirst(str_replace('_', ' ', $key))),
                'type' => $type,
            ];
            if ($kind === 'row') {
                $row['binding'] = self::label($item['binding'] ?? ($default['binding'] ?? $key), $key);
            } else {
                $source = trim((string)($item['source'] ?? ($default['source'] ?? '')));
                if ($source !== '') $row['source'] = mb_substr($source, 0, 80);
            }
            $result[] = $row;
            if (count($result) >= 100) break;
        }
        return $result ?: $fallback;
    }

    private static function safeKey($value, string $fallback): string
    {
        $key = strtolower(trim((string)$value));
        $key = preg_replace('/[^a-z0-9_\-]+/', '_', $key) ?: '';
        $key = trim($key, '_-');
        return mb_substr($key !== '' ? $key : $fallback, 0, 80);
    }

    private static function label($value, string $fallback): string
    {
        $label = trim((string)$value);
        return mb_substr($label !== '' ? $label : $fallback, 0, 180);
    }
}
