<?php

require_once __DIR__ . '/../connection.php';
require_once __DIR__ . '/../../services/GradeComputationService.php';

try {
    $conn->beginTransaction();

    $affectedStmt = $conn->prepare(
        'SELECT g.grade_id, g.enrollment_id, g.class_id, target.grading_period_id AS target_period_id
         FROM grades g
         JOIN class_offerings co ON co.class_id = g.class_id AND co.is_deleted = 0
         JOIN grading_periods source ON source.grading_period_id = g.grading_period_id AND source.is_deleted = 0
         JOIN grading_periods target ON target.school_year_id = co.school_year_id
                                     AND target.period_no = source.period_no
                                     AND target.is_deleted = 0
         WHERE g.is_deleted = 0
           AND source.school_year_id <> co.school_year_id'
    );
    $affectedStmt->execute();
    $affected = $affectedStmt->fetchAll(PDO::FETCH_ASSOC);

    if (!$affected) {
        $conn->commit();
        echo "No cross-year grade periods found.\n";
        exit(0);
    }

    $conflictStmt = $conn->prepare(
        'SELECT 1
         FROM grades g
         JOIN class_offerings co ON co.class_id = g.class_id AND co.is_deleted = 0
         JOIN grading_periods source ON source.grading_period_id = g.grading_period_id AND source.is_deleted = 0
         JOIN grading_periods target ON target.school_year_id = co.school_year_id
                                     AND target.period_no = source.period_no
                                     AND target.is_deleted = 0
         JOIN grades existing ON existing.enrollment_id = g.enrollment_id
                             AND existing.class_id = g.class_id
                             AND existing.grading_period_id = target.grading_period_id
         WHERE g.is_deleted = 0
           AND existing.is_deleted = 0
           AND existing.grade_id <> g.grade_id
           AND source.school_year_id <> co.school_year_id
         LIMIT 1'
    );
    $conflictStmt->execute();
    if ($conflictStmt->fetchColumn()) {
        throw new RuntimeException('Cross-year grade repair aborted because a target period grade already exists');
    }

    $affectedEnrollmentIds = array_values(array_unique(array_map('intval', array_column($affected, 'enrollment_id'))));
    $gradeIds = array_map('intval', array_column($affected, 'grade_id'));
    $gradePlaceholders = implode(',', array_fill(0, count($gradeIds), '?'));

    $invalidateFinals = $conn->prepare(
        "UPDATE final_grades fg
         JOIN grades g ON g.enrollment_id = fg.enrollment_id AND g.class_id = fg.class_id
         SET fg.is_deleted = 1, fg.deleted_at = NOW()
         WHERE fg.is_deleted = 0
           AND g.grade_id IN ({$gradePlaceholders})"
    );
    $invalidateFinals->execute($gradeIds);
    $invalidatedFinals = $invalidateFinals->rowCount();

    $repairStmt = $conn->prepare(
        'UPDATE grades g
         JOIN class_offerings co ON co.class_id = g.class_id AND co.is_deleted = 0
         JOIN grading_periods source ON source.grading_period_id = g.grading_period_id AND source.is_deleted = 0
         JOIN grading_periods target ON target.school_year_id = co.school_year_id
                                     AND target.period_no = source.period_no
                                     AND target.is_deleted = 0
         SET g.grading_period_id = target.grading_period_id
         WHERE g.is_deleted = 0
           AND source.school_year_id <> co.school_year_id'
    );
    $repairStmt->execute();
    $repairedGrades = $repairStmt->rowCount();

    $service = new GradeComputationService($conn);
    foreach ($affectedEnrollmentIds as $enrollmentId) {
        $schoolYearStmt = $conn->prepare('SELECT school_year_id FROM enrollments WHERE enrollment_id = :enrollment_id AND is_deleted = 0 LIMIT 1');
        $schoolYearStmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
        $schoolYearStmt->execute();
        $schoolYearId = (int)$schoolYearStmt->fetchColumn();
        if ($schoolYearId <= 0) {
            continue;
        }

        $generalAverage = $service->computeGeneralAverageForEnrollment($enrollmentId, $schoolYearId);
        if ($generalAverage === null) {
            $clearAverage = $conn->prepare(
                'UPDATE general_averages
                 SET is_deleted = 1, deleted_at = NOW()
                 WHERE enrollment_id = :enrollment_id
                   AND school_year_id = :school_year_id
                   AND is_deleted = 0'
            );
            $clearAverage->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
            $clearAverage->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
            $clearAverage->execute();
            continue;
        }
        $service->upsertGeneralAverage($enrollmentId, $schoolYearId, $generalAverage);
    }

    $conn->commit();
    echo "Repaired {$repairedGrades} grade record(s); invalidated {$invalidatedFinals} stale final grade(s).\n";
} catch (Exception $e) {
    if ($conn->inTransaction()) {
        $conn->rollBack();
    }
    fwrite(STDERR, "Repair failed: {$e->getMessage()}\n");
    exit(1);
}
