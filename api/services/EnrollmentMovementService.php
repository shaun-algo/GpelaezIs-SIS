<?php

/**
 * Records reportable enrollment movements without replacing the current state
 * stored on enrollments. The service is intentionally source-aware so LIS
 * imports are idempotent while authorized profile edits remain auditable.
 */
class EnrollmentMovementService
{
    public const SOURCE_LIS_IMPORT = 'LIS_IMPORT';
    public const SOURCE_MANUAL_PROFILE = 'MANUAL_PROFILE';
    public const SOURCE_MANUAL_ENROLLMENT = 'MANUAL_ENROLLMENT';
    public const SOURCE_SYSTEM = 'SYSTEM';

    public const TYPE_TRANSFER_IN = 'Transfer-In';
    public const TYPE_DROPPED = 'Dropped';
    public const TYPE_TRANSFERRED_OUT = 'Transferred Out';

    private PDO $conn;
    private ?bool $available = null;

    public function __construct(PDO $conn)
    {
        $this->conn = $conn;
    }

    public function isAvailable(): bool
    {
        if ($this->available !== null) return $this->available;

        try {
            $stmt = $this->conn->query("SHOW TABLES LIKE 'enrollment_movement_events'");
            $this->available = (bool)$stmt->fetchColumn();
        } catch (Throwable $e) {
            $this->available = false;
        }
        return $this->available;
    }

    public function requireAvailable(): void
    {
        if (!$this->isAvailable()) {
            throw new RuntimeException(
                'Enrollment movement history is not installed. Apply add_enrollment_movement_events.sql first.'
            );
        }
    }

    public function recordStatusChange(
        int $enrollmentId,
        ?string $previousStatus,
        string $newStatus,
        array $context = []
    ): ?int {
        $newStatus = trim($newStatus);
        $previousStatus = $previousStatus !== null ? trim($previousStatus) : null;
        if ($newStatus === '' || $previousStatus === $newStatus) return null;

        $movementType = $this->movementTypeForStatus($newStatus);
        if ($movementType === null) return null;

        $this->requireAvailable();
        $snapshot = $this->fetchEnrollmentSnapshot($enrollmentId);
        if (!$snapshot) {
            throw new RuntimeException('Enrollment movement could not be recorded because the enrollment was not found.');
        }

        return $this->insertEvent([
            'source_key' => $this->sourceKey($movementType, $enrollmentId, $context),
            'source_type' => $this->sourceType($context),
            'import_id' => $context['import_id'] ?? null,
            'import_row_number' => $context['import_row_number'] ?? null,
            'enrollment_id' => $enrollmentId,
            'learner_id' => (int)$snapshot['learner_id'],
            'school_year_id' => (int)$snapshot['school_year_id'],
            'section_id' => $snapshot['section_id'] !== null ? (int)$snapshot['section_id'] : null,
            'grade_level_id' => $snapshot['grade_level_id'] !== null ? (int)$snapshot['grade_level_id'] : null,
            'gender_snapshot' => $snapshot['gender'] ?? null,
            'movement_type' => $movementType,
            'previous_status' => $previousStatus,
            'new_status' => $newStatus,
            'previous_classification' => $context['previous_classification'] ?? null,
            'new_classification' => $context['new_classification'] ?? null,
            'raw_lis_remark' => $context['raw_lis_remark'] ?? null,
            'source_effective_date' => $context['source_effective_date'] ?? null,
            'created_by' => $this->createdBy($context),
        ]);
    }

    public function recordTransferIn(
        int $enrollmentId,
        ?string $previousClassification,
        ?string $newClassification,
        array $context = []
    ): ?int {
        if (strcasecmp(trim((string)$newClassification), self::TYPE_TRANSFER_IN) !== 0) {
            return null;
        }
        if (strcasecmp(trim((string)$previousClassification), self::TYPE_TRANSFER_IN) === 0) {
            return null;
        }

        $this->requireAvailable();
        $snapshot = $this->fetchEnrollmentSnapshot($enrollmentId);
        if (!$snapshot) {
            throw new RuntimeException('Transfer-in movement could not be recorded because the enrollment was not found.');
        }

        return $this->insertEvent([
            'source_key' => $this->sourceKey(self::TYPE_TRANSFER_IN, $enrollmentId, $context),
            'source_type' => $this->sourceType($context),
            'import_id' => $context['import_id'] ?? null,
            'import_row_number' => $context['import_row_number'] ?? null,
            'enrollment_id' => $enrollmentId,
            'learner_id' => (int)$snapshot['learner_id'],
            'school_year_id' => (int)$snapshot['school_year_id'],
            'section_id' => $snapshot['section_id'] !== null ? (int)$snapshot['section_id'] : null,
            'grade_level_id' => $snapshot['grade_level_id'] !== null ? (int)$snapshot['grade_level_id'] : null,
            'gender_snapshot' => $snapshot['gender'] ?? null,
            'movement_type' => self::TYPE_TRANSFER_IN,
            'previous_status' => $snapshot['enrollment_status'] ?? null,
            'new_status' => $snapshot['enrollment_status'] ?? null,
            'previous_classification' => $previousClassification,
            'new_classification' => $newClassification,
            'raw_lis_remark' => $context['raw_lis_remark'] ?? null,
            'source_effective_date' => $context['source_effective_date'] ?? null,
            'created_by' => $this->createdBy($context),
        ]);
    }

    private function movementTypeForStatus(string $status): ?string
    {
        return match (strcasecmp($status, 'Dropped')) {
            0 => self::TYPE_DROPPED,
            default => strcasecmp($status, 'Transferred Out') === 0
                ? self::TYPE_TRANSFERRED_OUT
                : null,
        };
    }

    private function fetchEnrollmentSnapshot(int $enrollmentId): ?array
    {
        $stmt = $this->conn->prepare(
            'SELECT e.enrollment_id, e.learner_id, e.school_year_id, e.section_id,
                    e.grade_level_id, e.enrollment_status, e.entry_classification,
                    l.gender
             FROM enrollments e
             LEFT JOIN learners l ON l.learner_id = e.learner_id
             WHERE e.enrollment_id = :id
             LIMIT 1'
        );
        $stmt->bindValue(':id', $enrollmentId, PDO::PARAM_INT);
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    private function insertEvent(array $event): ?int
    {
        $stmt = $this->conn->prepare(
            'INSERT INTO enrollment_movement_events
                (source_key, source_type, import_id, import_row_number,
                 enrollment_id, learner_id, school_year_id, section_id,
                 grade_level_id, gender_snapshot, movement_type,
                 previous_status, new_status, previous_classification,
                 new_classification, raw_lis_remark, source_effective_date,
                 created_by)
             VALUES
                (:source_key, :source_type, :import_id, :import_row_number,
                 :enrollment_id, :learner_id, :school_year_id, :section_id,
                 :grade_level_id, :gender_snapshot, :movement_type,
                 :previous_status, :new_status, :previous_classification,
                 :new_classification, :raw_lis_remark, :source_effective_date,
                 :created_by)
             ON DUPLICATE KEY UPDATE movement_event_id = LAST_INSERT_ID(movement_event_id)'
        );

        $intFields = ['import_id', 'import_row_number', 'enrollment_id', 'learner_id', 'school_year_id', 'section_id', 'grade_level_id', 'created_by'];
        foreach ($intFields as $field) {
            $value = $event[$field] ?? null;
            $stmt->bindValue(':' . $field, $value, $value === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        }
        foreach (['source_key', 'source_type', 'gender_snapshot', 'movement_type', 'previous_status', 'new_status', 'previous_classification', 'new_classification', 'raw_lis_remark', 'source_effective_date'] as $field) {
            $value = $event[$field] ?? null;
            $stmt->bindValue(':' . $field, $value, $value === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        }
        $stmt->execute();
        return (int)$this->conn->lastInsertId();
    }

    private function sourceType(array $context): string
    {
        $source = strtoupper(trim((string)($context['source_type'] ?? self::SOURCE_SYSTEM)));
        return $source !== '' ? $source : self::SOURCE_SYSTEM;
    }

    private function createdBy(array $context): ?int
    {
        $userId = (int)($context['user_id'] ?? ($_SESSION['user_id'] ?? 0));
        return $userId > 0 ? $userId : null;
    }

    private function sourceKey(string $movementType, int $enrollmentId, array $context): string
    {
        $importId = (int)($context['import_id'] ?? 0);
        $rowNumber = (int)($context['import_row_number'] ?? 0);
        if ($importId > 0 && $rowNumber > 0) {
            return 'lis:' . $importId . ':' . $rowNumber . ':' . $movementType;
        }

        try {
            return 'manual:' . $enrollmentId . ':' . $movementType . ':' . bin2hex(random_bytes(16));
        } catch (Throwable $e) {
            return 'manual:' . $enrollmentId . ':' . $movementType . ':' . uniqid('', true);
        }
    }
}
