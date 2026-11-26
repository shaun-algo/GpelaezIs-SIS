<?php

require_once __DIR__ . '/../connection.php';

try {
    $stmt = $conn->prepare(
        "UPDATE grading_periods gp
         JOIN school_years sy ON sy.school_year_id = gp.school_year_id
         SET gp.period_name = CASE gp.period_no
             WHEN 1 THEN 'Term 1'
             WHEN 2 THEN 'Term 2'
             WHEN 3 THEN 'Term 3'
         END
         WHERE sy.grading_system_type IN ('Three-Term', 'Trimester')
           AND gp.period_no BETWEEN 1 AND 3
           AND gp.is_deleted = 0"
    );
    $stmt->execute();
    echo "Renamed {$stmt->rowCount()} three-term period(s) to Term 1–3.\n";
} catch (Exception $e) {
    fwrite(STDERR, "Term rename failed: {$e->getMessage()}\n");
    exit(1);
}
