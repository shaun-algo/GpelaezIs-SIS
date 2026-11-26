<?php
/**
 * Migration: Seed missing grading periods for existing school years.
 *
 * Run from project root or directly:
 *   php api/database/migrations/seed_missing_grading_periods.php
 *
 * For each school year that has no grading periods, this script inserts the
 * correct number of periods based on school_years.grading_system_type.
 */

require_once __DIR__ . '/../connection.php';

function periodConfig(string $gradingSystemType): array
{
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

try {
    $syStmt = $conn->query(
        'SELECT school_year_id, year_label, grading_system_type
         FROM school_years
         WHERE is_deleted = 0'
    );
    $schoolYears = $syStmt->fetchAll(PDO::FETCH_ASSOC);

    $check = $conn->prepare(
        'SELECT 1 FROM grading_periods WHERE school_year_id = :sy AND is_deleted = 0 LIMIT 1'
    );
    $insert = $conn->prepare(
        'INSERT INTO grading_periods (school_year_id, period_no, period_name, status, date_start, date_end)
         VALUES (:school_year_id, :period_no, :period_name, "Open", NULL, NULL)'
    );

    $totalCreated = 0;
    foreach ($schoolYears as $sy) {
        $check->bindValue(':sy', (int)$sy['school_year_id'], PDO::PARAM_INT);
        $check->execute();
        if ($check->fetchColumn()) {
            continue;
        }

        $periods = periodConfig($sy['grading_system_type']);
        foreach ($periods as $p) {
            $insert->bindValue(':school_year_id', (int)$sy['school_year_id'], PDO::PARAM_INT);
            $insert->bindValue(':period_no', (int)$p['period_no'], PDO::PARAM_INT);
            $insert->bindValue(':period_name', $p['period_name']);
            $insert->execute();
            $totalCreated++;
        }
        echo "Created " . count($periods) . " period(s) for SY {$sy['year_label']} ({$sy['grading_system_type']}).\n";
    }

    echo "\nDone. Total periods created: {$totalCreated}\n";
} catch (Exception $e) {
    fwrite(STDERR, "Error: " . $e->getMessage() . "\n");
    exit(1);
}
