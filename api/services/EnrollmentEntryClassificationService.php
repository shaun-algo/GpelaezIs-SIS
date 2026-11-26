<?php

/**
 * Keeps enrollment entry classifications consistent across manual enrollment
 * and the SF1/LIS import pipeline.
 *
 * This is intentionally a small data-layer helper. It does not create an
 * approval workflow; it only translates the enrollment type or source remark
 * into the value stored on enrollments.entry_classification.
 */
class EnrollmentEntryClassificationService
{
    public const CLASSIFICATION_NEW = 'New';
    public const CLASSIFICATION_PROMOTE = 'Promote';
    public const CLASSIFICATION_UPDATE = 'Update';
    public const CLASSIFICATION_RETURNEE = 'Returnee';
    public const CLASSIFICATION_TRANSFER_IN = 'Transfer-In';
    public const CLASSIFICATION_LATE_ENROLLMENT = 'Late Enrollment';

    public static function normalize(?string $value): ?string
    {
        $key = strtolower(trim((string)($value ?? '')));
        $key = preg_replace('/[‐‑‒–—―]/u', '-', $key);
        $key = preg_replace('/\s+/', ' ', (string)$key);
        $key = trim((string)$key);

        if ($key === '') return null;
        if (in_array($key, ['returnee', 'balik-aral', 'balik aral', 'ba', 'b/a'], true)) return self::CLASSIFICATION_RETURNEE;
        if (in_array($key, ['transfer-in', 'transfer in', 'transferred in', 'transferred-in', 't/i', 'ti'], true)) return self::CLASSIFICATION_TRANSFER_IN;
        if (in_array($key, ['late enrollment', 'late-enrollment', 'late enrollee', 'late enrolled', 'le'], true)) return self::CLASSIFICATION_LATE_ENROLLMENT;
        if (in_array($key, ['promote', 'promoted', 'promotion'], true)) return self::CLASSIFICATION_PROMOTE;
        if (in_array($key, ['new', 'new enrollee', 'new enrolee', 'new entrant'], true)) return self::CLASSIFICATION_NEW;
        if (in_array($key, ['update', 'updated'], true)) return self::CLASSIFICATION_UPDATE;
        return null;
    }

    public static function fromEnrollmentTypeName(?string $typeName): ?string
    {
        $key = strtolower(trim((string)($typeName ?? '')));
        $key = preg_replace('/[‐‑‒–—―]/u', '-', $key);
        $key = preg_replace('/\s+/', ' ', (string)$key);
        $key = trim((string)$key);

        if ($key === 'balik-aral' || $key === 'balik aral') return self::CLASSIFICATION_RETURNEE;
        if (in_array($key, ['transfer-in', 'transfer in', 'transferred in', 'transferred-in'], true)) return self::CLASSIFICATION_TRANSFER_IN;
        if (in_array($key, ['late enrollment', 'late-enrollment', 'late enrollee', 'late enrolled'], true)) return self::CLASSIFICATION_LATE_ENROLLMENT;
        return null;
    }

    public static function fromEnrollmentTypeId(PDO $conn, ?int $enrollmentTypeId): ?string
    {
        if (!$enrollmentTypeId || $enrollmentTypeId <= 0) return null;
        $stmt = $conn->prepare('SELECT type_name FROM enrollment_types
                                WHERE enrollment_type_id = :id AND is_deleted = 0 LIMIT 1');
        $stmt->bindValue(':id', $enrollmentTypeId, PDO::PARAM_INT);
        $stmt->execute();
        $name = $stmt->fetchColumn();
        return $name === false ? null : self::fromEnrollmentTypeName((string)$name);
    }

    public static function isTransferIn(?string $classification): bool
    {
        return self::normalize($classification) === self::CLASSIFICATION_TRANSFER_IN;
    }

    public static function isLateEnrollment(?string $classification): bool
    {
        return self::normalize($classification) === self::CLASSIFICATION_LATE_ENROLLMENT;
    }
}
