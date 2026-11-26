<?php

require_once __DIR__ . '/../utils/audit.php';
require_once __DIR__ . '/ApplicationIntegrityService.php';
require_once __DIR__ . '/EnrollmentMovementService.php';

/**
 * EnrollmentLifecycleService
 *
 * Owns the meaning and transitions of enrollments.enrollment_status.
 * Promotion decisions stay in learner_progression.final_status.
 */
class EnrollmentLifecycleService
{
    public const STATUS_ENROLLED = 'Enrolled';
    public const STATUS_DROPPED = 'Dropped';
    public const STATUS_TRANSFERRED_OUT = 'Transferred Out';
    public const STATUS_COMPLETED = 'Completed';

    private const VALID_STATUSES = [
        self::STATUS_ENROLLED,
        self::STATUS_DROPPED,
        self::STATUS_TRANSFERRED_OUT,
        self::STATUS_COMPLETED,
    ];

    private PDO $conn;

    public function __construct(PDO $conn)
    {
        $this->conn = $conn;
    }

    public function normalizeStatus(?string $status): string
    {
        $status = trim((string)$status);
        if ($status === '') {
            return self::STATUS_ENROLLED;
        }

        $aliases = [
            'Active' => self::STATUS_ENROLLED,
            'No Longer Participating' => self::STATUS_DROPPED,
            'No Longer Participating in Learning Activities' => self::STATUS_DROPPED,
            'Dropped Out' => self::STATUS_DROPPED,
            'Transfer Out' => self::STATUS_TRANSFERRED_OUT,
            'Transferred' => self::STATUS_TRANSFERRED_OUT,
            'Finished' => self::STATUS_COMPLETED,
        ];
        if (isset($aliases[$status])) {
            return $aliases[$status];
        }

        foreach (self::VALID_STATUSES as $valid) {
            if (strcasecmp($status, $valid) === 0) {
                return $valid;
            }
        }

        throw new InvalidArgumentException("Unsupported enrollment status: {$status}");
    }

    public function completeAfterProgression(int $enrollmentId, string $operation = 'computePromotions'): bool
    {
        $row = $this->fetchEnrollment($enrollmentId);
        if (!$row || (int)$row['is_deleted'] !== 0 || ($row['enrollment_status'] ?? '') !== self::STATUS_ENROLLED) {
            return false;
        }

        return $this->setStatus(
            $enrollmentId,
            self::STATUS_COMPLETED,
            $operation,
            'Learner finished this school-year enrollment; promotion result remains in learner_progression.final_status.'
        );
    }

    /**
     * Close the current school-year enrollment once all required academic
     * completion evidence is present. Numeric grades use passing final grades
     * and general average; descriptive Grade 1 uses complete PACE ratings.
     * Promotion/next-year placement remains a separate workflow.
     */
    public function completeAfterPassingGrades(int $enrollmentId, string $operation = 'autoCompleteAfterPassingGrades'): bool
    {
        $row = $this->fetchEnrollment($enrollmentId);
        if (!$row || (int)$row['is_deleted'] !== 0 || ($row['enrollment_status'] ?? '') !== self::STATUS_ENROLLED) {
            return false;
        }

        return $this->setStatus(
            $enrollmentId,
            self::STATUS_COMPLETED,
            $operation,
            'All required academic completion evidence is present; learner completed this school-year enrollment and is ready for promotion placement.'
        );
    }

    public function applyImportedStatus(
        int $enrollmentId,
        string $status,
        ?string $remark = null,
        array $movementContext = []
    ): bool
    {
        $status = $this->normalizeStatus($status);
        $row = $this->fetchEnrollment($enrollmentId);
        if (!$row || (int)$row['is_deleted'] !== 0 || ($row['enrollment_status'] ?? '') === $status) {
            return false;
        }

        return $this->setStatus(
            $enrollmentId,
            $status,
            'commitLisImport',
            $remark ? "Status mapped from SF1/LIS remarks: {$remark}" : 'Status mapped from SF1/LIS import.',
            array_merge([
                'source_type' => EnrollmentMovementService::SOURCE_LIS_IMPORT,
                'raw_lis_remark' => $remark,
            ], $movementContext)
        );
    }

    public function restoreFromImport(
        int $enrollmentId,
        int $gradeLevelId,
        int $sectionId,
        string $status,
        ?string $remark = null,
        array $movementContext = []
    ): bool
    {
        $status = $this->normalizeStatus($status);
        $oldRow = $this->fetchEnrollment($enrollmentId);
        if (!$oldRow) {
            return false;
        }

        $curriculumId = app_integrity_validate_enrollment($this->conn, [
            'section_id' => $sectionId,
            'school_year_id' => (int)$oldRow['school_year_id'],
            'grade_level_id' => $gradeLevelId,
            'curriculum_id' => $oldRow['curriculum_id'] ?? null,
            'enrollment_status' => $status,
            'is_deleted' => 0,
        ], $enrollmentId);

        $stmt = $this->conn->prepare(
            'UPDATE enrollments
             SET is_deleted = 0,
                 deleted_at = NULL,
                 grade_level_id = :grade_level_id,
                 section_id = :section_id,
                 curriculum_id = :curriculum_id,
                 enrollment_status = :status,
                 status_updated_at = CURRENT_TIMESTAMP
             WHERE enrollment_id = :enrollment_id'
        );
        $stmt->bindValue(':grade_level_id', $gradeLevelId, PDO::PARAM_INT);
        $stmt->bindValue(':section_id', $sectionId, PDO::PARAM_INT);
        if ($curriculumId === null) $stmt->bindValue(':curriculum_id', null, PDO::PARAM_NULL);
        else $stmt->bindValue(':curriculum_id', $curriculumId, PDO::PARAM_INT);
        $stmt->bindValue(':status', $status);
        $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
        $stmt->execute();

        if ($stmt->rowCount() <= 0) {
            return false;
        }

        (new EnrollmentMovementService($this->conn))->recordStatusChange(
            $enrollmentId,
            $oldRow['enrollment_status'] ?? null,
            $status,
            array_merge([
                'source_type' => EnrollmentMovementService::SOURCE_LIS_IMPORT,
                'raw_lis_remark' => $remark,
            ], $movementContext)
        );

        audit_log($this->conn, 'enrollments', $enrollmentId, 'UPDATE', $oldRow, [
            'enrollment_id' => $enrollmentId,
            'grade_level_id' => $gradeLevelId,
            'section_id' => $sectionId,
            'enrollment_status' => $status,
            'is_deleted' => 0,
            'status_updated_by_operation' => 'commitLisImport',
            'status_reason' => $remark ? "Restored from SF1/LIS import remarks: {$remark}" : 'Restored from SF1/LIS import.',
        ]);

        return true;
    }

    public function setStatus(
        int $enrollmentId,
        string $status,
        string $operation,
        ?string $reason = null,
        array $movementContext = []
    ): bool
    {
        $status = $this->normalizeStatus($status);
        $oldRow = $this->fetchEnrollment($enrollmentId);
        if (!$oldRow || (int)$oldRow['is_deleted'] !== 0 || ($oldRow['enrollment_status'] ?? '') === $status) {
            return false;
        }

        $ownsTransaction = !$this->conn->inTransaction();
        if ($ownsTransaction) {
            $this->conn->beginTransaction();
        }

        try {
            $stmt = $this->conn->prepare(
                'UPDATE enrollments
                 SET enrollment_status = :status,
                     status_updated_at = CURRENT_TIMESTAMP
                 WHERE enrollment_id = :enrollment_id
                   AND is_deleted = 0'
            );
            $stmt->bindValue(':status', $status);
            $stmt->bindValue(':enrollment_id', $enrollmentId, PDO::PARAM_INT);
            $stmt->execute();

            if ($stmt->rowCount() <= 0) {
                if ($ownsTransaction && $this->conn->inTransaction()) $this->conn->rollBack();
                return false;
            }

            audit_log($this->conn, 'enrollments', $enrollmentId, 'UPDATE', $oldRow, [
                'enrollment_id' => $enrollmentId,
                'enrollment_status' => $status,
                'status_updated_by_operation' => $operation,
                'status_reason' => $reason,
            ]);

            (new EnrollmentMovementService($this->conn))->recordStatusChange(
                $enrollmentId,
                $oldRow['enrollment_status'] ?? null,
                $status,
                array_merge([
                    'source_type' => $this->sourceTypeForOperation($operation),
                    'user_id' => $_SESSION['user_id'] ?? null,
                ], $movementContext)
            );

            if ($ownsTransaction) {
                $this->conn->commit();
            }
            return true;
        } catch (Throwable $e) {
            if ($ownsTransaction && $this->conn->inTransaction()) {
                $this->conn->rollBack();
            }
            throw $e;
        }
    }

    private function sourceTypeForOperation(string $operation): string
    {
        return $operation === 'commitLisImport'
            ? EnrollmentMovementService::SOURCE_LIS_IMPORT
            : ($operation === 'learnerDetailsStatusControl' || $operation === 'learnerDetailsCombinedSave'
                ? EnrollmentMovementService::SOURCE_MANUAL_PROFILE
                : EnrollmentMovementService::SOURCE_SYSTEM);
    }

    private function fetchEnrollment(int $enrollmentId): ?array
    {
        $stmt = $this->conn->prepare('SELECT * FROM enrollments WHERE enrollment_id = :id LIMIT 1');
        $stmt->bindValue(':id', $enrollmentId, PDO::PARAM_INT);
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }
}
