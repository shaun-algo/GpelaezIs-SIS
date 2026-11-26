<?php

require_once __DIR__ . '/ApplicationIntegrityService.php';
require_once __DIR__ . '/DescriptiveProgressionService.php';
require_once __DIR__ . '/EnrollmentLifecycleService.php';

/**
 * GradeComputationService
 *
 * Centralizes final-grade and general-average computation for the class records
 * module. ApplicationIntegrityService is the shared validation boundary for
 * every computed-grade write.
 */
class GradeComputationService
{
    private PDO $conn;

    public function __construct(PDO $conn)
    {
        $this->conn = $conn;
    }

    /**
     * Expected number of period grades based on the school year's grading system.
     */
    public function getExpectedPeriodCount(int $schoolYearId): int
    {
        $stmt = $this->conn->prepare(
            'SELECT grading_system_type FROM school_years WHERE school_year_id = :sy AND is_deleted = 0 LIMIT 1'
        );
        $stmt->bindValue(':sy', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        $type = $stmt->fetchColumn();

        return match ((string)$type) {
            'Semester' => 2,
            'Three-Term', 'Trimester' => 3,
            default => 4,
        };
    }

    /**
     * Find all class_ids that represent the same section + school year + subject
     * offering over time (e.g. teacher reassignment history).
     */
    public function getEquivalentClassIds(int $classId): array
    {
        $metaStmt = $this->conn->prepare(
            'SELECT section_id, school_year_id, subject_id
             FROM class_offerings
             WHERE class_id = :class_id AND is_deleted = 0
             LIMIT 1'
        );
        $metaStmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
        $metaStmt->execute();
        $meta = $metaStmt->fetch(PDO::FETCH_ASSOC);
        if (!$meta) {
            return [];
        }

        $stmt = $this->conn->prepare(
            'SELECT class_id
             FROM class_offerings
             WHERE section_id = :section_id
               AND school_year_id = :school_year_id
               AND subject_id = :subject_id'
        );
        $stmt->bindValue(':section_id', (int)$meta['section_id'], PDO::PARAM_INT);
        $stmt->bindValue(':school_year_id', (int)$meta['school_year_id'], PDO::PARAM_INT);
        $stmt->bindValue(':subject_id', (int)$meta['subject_id'], PDO::PARAM_INT);
        $stmt->execute();
        $ids = array_values(array_unique(array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN))));
        if (!in_array($classId, $ids, true)) {
            $ids[] = $classId;
        }
        return array_values(array_filter($ids, fn($id) => $id > 0));
    }

    /**
     * Aggregate period grades for a learner/class and return the simple average
     * if the expected number of periods is satisfied.
     */
    public function computeFinalGradeForEnrollment(int $enrollmentId, int $classId): ?float
    {
        $metaStmt = $this->conn->prepare(
            'SELECT co.school_year_id, sy.grading_system_type
             FROM class_offerings co
             JOIN school_years sy ON sy.school_year_id = co.school_year_id
             WHERE co.class_id = :class_id AND co.is_deleted = 0 AND sy.is_deleted = 0
             LIMIT 1'
        );
        $metaStmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
        $metaStmt->execute();
        $meta = $metaStmt->fetch(PDO::FETCH_ASSOC);
        if (!$meta) {
            return null;
        }
        $schoolYearId = (int)$meta['school_year_id'];
        $expected = $this->getExpectedPeriodCount($schoolYearId);

        $classIds = $this->getEquivalentClassIds($classId);
        if (!$classIds) {
            return null;
        }
        $inPlaceholders = implode(',', array_fill(0, count($classIds), '?'));

        $stmt = $this->conn->prepare(
            "SELECT ROUND(AVG(g.quarterly_grade), 2) AS avg_grade, COUNT(DISTINCT gp.period_no) AS cnt
             FROM grades g
             JOIN grading_periods gp ON gp.grading_period_id = g.grading_period_id AND gp.is_deleted = 0
             WHERE g.enrollment_id = ?
               AND g.class_id IN ({$inPlaceholders})
               AND g.is_deleted = 0
               AND gp.school_year_id = ?
               AND g.quarterly_grade IS NOT NULL"
        );
        $pos = 1;
        $stmt->bindValue($pos++, $enrollmentId, PDO::PARAM_INT);
        foreach ($classIds as $cid) {
            $stmt->bindValue($pos++, (int)$cid, PDO::PARAM_INT);
        }
        $stmt->bindValue($pos++, $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        $count = (int)($row['cnt'] ?? 0);
        if ($count < $expected) {
            return null;
        }
        return $row['avg_grade'] !== null ? (float)$row['avg_grade'] : null;
    }

    /**
     * Upsert a final_grade row, setting remark automatically.
     */
    public function upsertFinalGrade(int $enrollmentId, int $classId, ?float $finalGrade, int $computedBy): void
    {
        if ($finalGrade === null) {
            return;
        }
        $prepared = app_integrity_prepare_final_grade($this->conn, $enrollmentId, $classId, $finalGrade);
        $finalGrade = $prepared['final_grade'];
        $remark = $prepared['remark'];

        $check = $this->conn->prepare(
            'SELECT final_grade_id FROM final_grades
             WHERE enrollment_id = :enrollment_id AND class_id = :class_id AND is_deleted = 0
             LIMIT 1'
        );
        $check->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
        $check->bindValue(':class_id', $classId, PDO::PARAM_INT);
        $check->execute();
        $existing = $check->fetchColumn();

        if ($existing) {
            $stmt = $this->conn->prepare(
                'UPDATE final_grades
                 SET final_grade = :final_grade,
                     remark = :remark,
                     computed_by = :computed_by,
                     computed_at = NOW()
                 WHERE final_grade_id = :final_grade_id'
            );
            $stmt->bindValue(':final_grade_id', (int)$existing, PDO::PARAM_INT);
        } else {
            $stmt = $this->conn->prepare(
                'INSERT INTO final_grades (enrollment_id, class_id, final_grade, remark, computed_by, computed_at)
                 VALUES (:enrollment_id, :class_id, :final_grade, :remark, :computed_by, NOW())'
            );
            $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
            $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
        }
        $stmt->bindValue(':final_grade', $finalGrade, PDO::PARAM_STR);
        $stmt->bindValue(':remark', $remark);
        $stmt->bindValue(':computed_by', $computedBy ?: null);
        $stmt->execute();
    }

    /**
     * Compute the general average from non-deleted final grades attached to
     * active offerings in the enrollment's school year. Replaced offerings
     * remain available for period-grade history but are not counted twice in
     * the current general average. Returns null if no final grades exist yet.
     */
    public function computeGeneralAverageForEnrollment(int $enrollmentId, int $schoolYearId): ?float
    {
        $stmt = $this->conn->prepare(
            'SELECT ROUND(AVG(final_grade), 2) AS avg_grade, COUNT(*) AS cnt
             FROM final_grades fg
             JOIN class_offerings co ON co.class_id = fg.class_id AND co.is_deleted = 0
             WHERE fg.enrollment_id = :enrollment_id
               AND fg.is_deleted = 0
               AND fg.final_grade IS NOT NULL
               AND co.school_year_id = :school_year_id'
        );
        $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if ((int)($row['cnt'] ?? 0) === 0) {
            return null;
        }
        return $row['avg_grade'] !== null ? (float)$row['avg_grade'] : null;
    }

    /**
     * Upsert a general_averages row for the enrollment + school year.
     */
    public function upsertGeneralAverage(int $enrollmentId, int $schoolYearId, ?float $generalAverage): void
    {
        $generalAverage = app_integrity_prepare_general_average(
            $this->conn,
            $enrollmentId,
            $generalAverage,
            $schoolYearId
        );
        $check = $this->conn->prepare(
            'SELECT general_average_id FROM general_averages
             WHERE enrollment_id = :enrollment_id AND school_year_id = :school_year_id AND is_deleted = 0
             LIMIT 1'
        );
        $check->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
        $check->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $check->execute();
        $existing = $check->fetchColumn();

        if ($existing) {
            $stmt = $this->conn->prepare(
                'UPDATE general_averages
                 SET general_average = :general_average
                 WHERE general_average_id = :general_average_id'
            );
            $stmt->bindValue(':general_average_id', (int)$existing, PDO::PARAM_INT);
        } else {
            $stmt = $this->conn->prepare(
                'INSERT INTO general_averages (enrollment_id, school_year_id, general_average)
                 VALUES (:enrollment_id, :school_year_id, :general_average)'
            );
            $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
            $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        }
        $stmt->bindValue(':general_average', $generalAverage);
        $stmt->execute();
    }

    /**
     * Auto-compute final grade + general average for a single enrollment if all
     * expected period grades are present. Returns whether a final grade was saved.
     */
    public function autoComputeForEnrollment(int $enrollmentId, int $classId, int $computedBy): bool
    {
        $finalGrade = $this->computeFinalGradeForEnrollment($enrollmentId, $classId);
        if ($finalGrade === null) {
            return false;
        }

        $this->upsertFinalGrade($enrollmentId, $classId, $finalGrade, $computedBy);

        $metaStmt = $this->conn->prepare(
            'SELECT school_year_id FROM class_offerings WHERE class_id = :class_id AND is_deleted = 0 LIMIT 1'
        );
        $metaStmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
        $metaStmt->execute();
        $schoolYearId = (int)$metaStmt->fetchColumn();
        if ($schoolYearId) {
            $ga = $this->computeGeneralAverageForEnrollment($enrollmentId, $schoolYearId);
            if ($ga !== null) {
                $this->upsertGeneralAverage($enrollmentId, $schoolYearId, $ga);
                $this->autoCompleteIfEligible($enrollmentId);
            }
        }

        return true;
    }

    /**
     * Mark an enrolled learner Completed when the applicable evidence is
     * complete. Grades 2-10 use passing numeric final grades and general
     * average; Grade 1 descriptive mode uses complete PACE A-E ratings for
     * Terms 1-3. This only closes the current enrollment; it never creates a
     * next-school-year enrollment.
     */
    public function autoCompleteIfEligible(int $enrollmentId, string $operation = 'autoCompleteAfterPassingGrades'): bool
    {
        $metaStmt = $this->conn->prepare(
            'SELECT school_year_id, grade_level_id, section_id, enrollment_status
             FROM enrollments
             WHERE enrollment_id = :enrollment_id
               AND is_deleted = 0
             LIMIT 1'
        );
        $metaStmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
        $metaStmt->execute();
        $enrollment = $metaStmt->fetch(PDO::FETCH_ASSOC);
        if (!$enrollment || ($enrollment['enrollment_status'] ?? '') !== EnrollmentLifecycleService::STATUS_ENROLLED) {
            return false;
        }

        if (DescriptiveProgressionService::isGradeOneDescriptive(
            $this->conn,
            (int)$enrollment['school_year_id'],
            (int)$enrollment['grade_level_id']
        )) {
            $evidence = DescriptiveProgressionService::evidenceForEnrollment($this->conn, $enrollmentId);
            if (empty($evidence['complete'])) {
                return false;
            }

            return (new EnrollmentLifecycleService($this->conn))->completeAfterPassingGrades(
                $enrollmentId,
                $operation
            );
        }

        $subjectStmt = $this->conn->prepare(
            'SELECT co.subject_id,
                    COUNT(fg.final_grade_id) AS final_grade_count,
                    MIN(fg.final_grade) AS lowest_final_grade
             FROM class_offerings co
             LEFT JOIN final_grades fg
               ON fg.class_id = co.class_id
              AND fg.enrollment_id = :enrollment_id
              AND fg.is_deleted = 0
              AND fg.final_grade IS NOT NULL
             WHERE co.section_id = :section_id
               AND co.school_year_id = :school_year_id
               AND co.is_deleted = 0
             GROUP BY co.subject_id'
        );
        $subjectStmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
        $subjectStmt->bindValue(':section_id', (int)$enrollment['section_id'], PDO::PARAM_INT);
        $subjectStmt->bindValue(':school_year_id', (int)$enrollment['school_year_id'], PDO::PARAM_INT);
        $subjectStmt->execute();
        $subjects = $subjectStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        if (!$subjects) {
            return false;
        }

        foreach ($subjects as $subject) {
            if ((int)($subject['final_grade_count'] ?? 0) <= 0
                || $subject['lowest_final_grade'] === null
                || (float)$subject['lowest_final_grade'] < 75.00) {
                return false;
            }
        }

        $generalAverage = $this->computeGeneralAverageForEnrollment(
            $enrollmentId,
            (int)$enrollment['school_year_id']
        );
        if ($generalAverage === null || $generalAverage < 75.00) {
            return false;
        }

        // Keep the stored computed value synchronized before closing the
        // enrollment. The write remains inside the caller's transaction.
        $this->upsertGeneralAverage(
            $enrollmentId,
            (int)$enrollment['school_year_id'],
            $generalAverage
        );

        return (new EnrollmentLifecycleService($this->conn))->completeAfterPassingGrades(
            $enrollmentId,
            $operation
        );
    }

    /**
     * Finalize grades for every enrolled learner in a class.
     * Computes final grades + general averages and upserts them in one transaction.
     *
     * @return array{finalized: int, general_averages: int, skipped: int, enrollments_completed: int}
     */
    public function finalizeClass(int $classId, int $computedBy): array
    {
        $metaStmt = $this->conn->prepare(
            'SELECT co.school_year_id, co.section_id
             FROM class_offerings co
             WHERE co.class_id = :class_id AND co.is_deleted = 0
             LIMIT 1'
        );
        $metaStmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
        $metaStmt->execute();
        $meta = $metaStmt->fetch(PDO::FETCH_ASSOC);
        if (!$meta) {
            throw new InvalidArgumentException('Class offering not found');
        }
        $schoolYearId = (int)$meta['school_year_id'];
        $sectionId = (int)$meta['section_id'];

        $expected = $this->getExpectedPeriodCount($schoolYearId);
        $classIds = $this->getEquivalentClassIds($classId);
        $inPlaceholders = implode(',', array_fill(0, count($classIds), '?'));

        // Find learners in the section with enough period grades for this class.
        $stmt = $this->conn->prepare(
            "SELECT e.enrollment_id,
                    ROUND(AVG(g.quarterly_grade), 2) AS avg_grade,
                    COUNT(DISTINCT gp.period_no) AS cnt
             FROM enrollments e
             LEFT JOIN grades g ON g.enrollment_id = e.enrollment_id
                                AND g.class_id IN ({$inPlaceholders})
                                AND g.is_deleted = 0
                                AND g.quarterly_grade IS NOT NULL
             LEFT JOIN grading_periods gp ON gp.grading_period_id = g.grading_period_id
                                          AND gp.school_year_id = ?
                                          AND gp.is_deleted = 0
             WHERE e.section_id = ?
               AND e.school_year_id = ?
               AND e.enrollment_status = 'Enrolled'
               AND e.is_deleted = 0
             GROUP BY e.enrollment_id"
        );
        $params = array_map('intval', $classIds);
        $params[] = $schoolYearId;
        $params[] = $sectionId;
        $params[] = $schoolYearId;
        $stmt->execute($params);
        $learners = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $finalized = 0;
        $skipped = 0;
        foreach ($learners as $learner) {
            $enrollmentId = (int)$learner['enrollment_id'];
            $count = (int)($learner['cnt'] ?? 0);
            $avg = $learner['avg_grade'] !== null ? (float)$learner['avg_grade'] : null;

            if ($count < $expected || $avg === null) {
                $skipped++;
                continue;
            }

            $this->upsertFinalGrade($enrollmentId, $classId, $avg, $computedBy);
            $finalized++;
        }

        // General averages are computed from final grades that now exist.
        $gaFinalized = 0;
        $enrollmentsCompleted = 0;
        $gaStmt = $this->conn->prepare(
            'SELECT enrollment_id FROM enrollments
             WHERE section_id = :section_id
               AND school_year_id = :school_year_id
               AND enrollment_status = "Enrolled"
               AND is_deleted = 0'
        );
        $gaStmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
        $gaStmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $gaStmt->execute();
        $enrollments = $gaStmt->fetchAll(PDO::FETCH_COLUMN);

        foreach ($enrollments as $eid) {
            $ga = $this->computeGeneralAverageForEnrollment((int)$eid, $schoolYearId);
            if ($ga !== null) {
                $this->upsertGeneralAverage((int)$eid, $schoolYearId, $ga);
                $gaFinalized++;
                if ($this->autoCompleteIfEligible((int)$eid)) {
                    $enrollmentsCompleted++;
                }
            }
        }

        return [
            'finalized' => $finalized,
            'skipped' => $skipped,
            'general_averages' => $gaFinalized,
            'enrollments_completed' => $enrollmentsCompleted,
        ];
    }
}
