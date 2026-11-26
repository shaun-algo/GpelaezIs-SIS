<?php
declare(strict_types=1);

/**
 * Shared risk-action rules for the Recommended Actions masterfile and the
 * automated learner risk assessment.
 *
 * Risk bands are properties of the supported indicators, not admin-entered
 * values. The masterfile stores the band for reporting/backward compatibility,
 * while this service is the source of truth whenever a rule is saved or used.
 */
final class RiskActionService
{
    private const FIXED_BANDS = [
        'Chronic Absence' => 'high',
        'Frequent Absence' => 'medium',
        'Attendance Rate Below Threshold' => 'medium',
        'Repeated Tardiness' => 'high',
        'No Encoded Grades' => 'low',
        'Incomplete Grades' => 'low',
        '2 or More Failing Subjects' => 'high',
        '1 Failing Subject' => 'high',
        'Lowest Grade Below Passing' => 'medium',
        'Period Average Below Passing' => 'high',
        'Low General Average' => 'high',
        'Failed Subject Final Grade' => 'high',
        'Sudden Grade Drop' => 'high',
        '__DEFAULT__' => 'high',
    ];

    public static function fixedBandForIndicator(?string $indicatorCode): string
    {
        $key = self::normalizeKey($indicatorCode);
        foreach (self::FIXED_BANDS as $code => $band) {
            if (self::normalizeKey($code) === $key) {
                return $band;
            }
        }
        return 'high';
    }

    public static function loadRules(PDO $conn): array
    {
        if (!self::tableExists($conn, 'risk_indicator_catalog') || !self::tableExists($conn, 'risk_action_rules')) {
            return ['rules' => [], 'default' => null];
        }

        try {
            $stmt = $conn->query(
                'SELECT c.indicator_code, c.indicator_name, c.is_fallback,
                        r.recommended_action
                 FROM risk_indicator_catalog c
                 JOIN risk_action_rules r ON r.indicator_catalog_id = c.indicator_catalog_id
                                          AND r.is_active = 1
                                          AND r.is_deleted = 0
                 WHERE c.is_active = 1
                   AND c.is_deleted = 0'
            );
            $rules = [];
            $fallback = null;
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $action = trim((string)($row['recommended_action'] ?? ''));
                if ($action === '') {
                    continue;
                }

                $rule = [
                    'recommended_action' => $action,
                    'risk_band' => self::fixedBandForIndicator((string)($row['indicator_code'] ?? '')),
                ];
                $codeKey = self::normalizeKey((string)($row['indicator_code'] ?? ''));
                $nameKey = self::normalizeKey((string)($row['indicator_name'] ?? ''));
                if ($codeKey !== '') {
                    $rules[$codeKey] = $rule;
                }
                if ($nameKey !== '') {
                    $rules[$nameKey] = $rule;
                }
                if ((int)($row['is_fallback'] ?? 0) === 1 || $codeKey === 'default') {
                    $fallback = $rule;
                }
            }

            return ['rules' => $rules, 'default' => $fallback];
        } catch (Throwable $e) {
            // Keep older installations functional until the additive migration
            // is applied; the caller will use its normal generic fallback.
            return ['rules' => [], 'default' => null];
        }
    }

    public static function recommendedAction(array $indicators, array $ruleSet): string
    {
        if (!$indicators) {
            return 'Continue routine monitoring and support.';
        }

        $rules = is_array($ruleSet['rules'] ?? null) ? $ruleSet['rules'] : [];
        $fallback = is_array($ruleSet['default'] ?? null) ? $ruleSet['default'] : null;
        $actions = [];

        foreach ($indicators as $indicator) {
            $indicatorType = trim((string)($indicator['indicator_type'] ?? ''));
            if ($indicatorType === '') {
                continue;
            }

            $rule = $rules[self::normalizeKey($indicatorType)] ?? $fallback;
            $action = trim((string)($rule['recommended_action'] ?? ''));
            if ($action === '') {
                $action = 'Monitor learner progress and coordinate appropriate support.';
            }

            $actions[] = [
                'indicator' => $indicatorType,
                'action' => $action
            ];
        }

        if (!$actions) {
            return 'Monitor learner progress and coordinate appropriate support.';
        }

        // Preserve the existing concise value for a single indicator so the
        // risk UI can retain its priority treatment. When several indicators
        // apply, label each action so every configured masterfile value is
        // traceable to the indicator that selected it.
        if (count($actions) === 1) {
            return (string)$actions[0]['action'];
        }

        $labeledActions = array_map(
            static fn(array $item): string => $item['indicator'] . ': ' . $item['action'],
            $actions
        );

        return implode(' / ', array_values(array_unique($labeledActions)));
    }

    private static function normalizeKey(?string $value): string
    {
        $normalized = strtolower(trim((string)($value ?? '')));
        $normalized = preg_replace('/[^a-z0-9]+/', ' ', $normalized);
        return trim((string)$normalized);
    }

    private static function tableExists(PDO $conn, string $table): bool
    {
        static $cache = [];
        if (array_key_exists($table, $cache)) {
            return $cache[$table];
        }

        try {
            $stmt = $conn->prepare(
                'SELECT 1
                 FROM information_schema.tables
                 WHERE table_schema = DATABASE()
                   AND table_name = :table
                 LIMIT 1'
            );
            $stmt->execute([':table' => $table]);
            return $cache[$table] = (bool)$stmt->fetchColumn();
        } catch (Throwable $e) {
            return $cache[$table] = false;
        }
    }
}
