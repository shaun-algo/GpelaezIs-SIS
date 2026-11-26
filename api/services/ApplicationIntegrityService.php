<?php
declare(strict_types=1);

require_once __DIR__ . '/DescriptiveProgressionService.php';

/**
 * Application-side replacements for the former database trigger rules.
 *
 * Every function in this file is deliberately side-effect free unless its
 * name says otherwise. Callers should execute validation and the associated
 * write inside the same PDO transaction. These checks are therefore usable
 * by the HTTP APIs, imports, background workers, and future CLI jobs without
 * reintroducing database triggers.
 */

if (!class_exists('ApplicationIntegrityException')) {
    class ApplicationIntegrityException extends RuntimeException
    {
        public function __construct(string $message, int $code = 422, ?Throwable $previous = null)
        {
            parent::__construct($message, $code, $previous);
        }
    }
}

function app_integrity_fail(string $message, int $code = 422): void
{
    throw new ApplicationIntegrityException($message, $code);
}

function app_integrity_nullable_string($value): ?string
{
    if ($value === null) return null;
    $value = trim((string)$value);
    return $value === '' ? null : $value;
}

function app_integrity_validate_education_level_name(string $name): string
{
    $name = trim($name);
    if ($name === '') app_integrity_fail('Level name is required.');
    if (str_contains(strtolower($name), 'senior')) {
        app_integrity_fail('Senior High School is out of scope for this system.');
    }
    return $name;
}

function app_integrity_validate_grade_level_name(string $name): string
{
    $name = trim($name);
    if ($name === '') app_integrity_fail('Grade name is required.');
    if (preg_match('/11|12/', $name)) {
        app_integrity_fail('Grades 11-12 (SHS) are out of scope for this system.');
    }
    return $name;
}

function app_integrity_validate_lrn(?string $lrn): string
{
    $lrn = trim((string)$lrn);
    if (!preg_match('/^\d{12}$/D', $lrn)) {
        app_integrity_fail('LRN must be exactly 12 digits.');
    }
    return $lrn;
}

function app_integrity_validate_date_of_birth(?string $date): ?string
{
    $date = app_integrity_nullable_string($date);
    if ($date === null) return null;

    $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
    $errors = DateTimeImmutable::getLastErrors();
    if (!$parsed || ($errors !== false && ($errors['warning_count'] > 0 || $errors['error_count'] > 0)) || $parsed->format('Y-m-d') !== $date) {
        app_integrity_fail('date_of_birth must be a valid date in YYYY-MM-DD format.');
    }

    $today = new DateTimeImmutable('today');
    $oldest = $today->modify('-60 years');
    if ($parsed > $today || $parsed < $oldest) {
        app_integrity_fail('date_of_birth out of plausible range (future or more than 60 years ago).');
    }
    return $date;
}

/**
 * Reproduces the learner insert/update trigger behavior while making the
 * normalization explicit to every PHP learner write path.
 */
function app_integrity_prepare_learner(PDO $conn, array $data, ?array $old = null, bool $insert = false): array
{
    $out = $data;
    $lrn = trim((string)($data['lrn'] ?? ($old['lrn'] ?? '')));
    $oldLrn = $old !== null ? trim((string)($old['lrn'] ?? '')) : null;
    if ($insert || $old === null || $lrn !== $oldLrn) {
        $out['lrn'] = app_integrity_validate_lrn($lrn);
    } else {
        // Existing legacy LRNs remain readable until an operator changes them.
        $out['lrn'] = $lrn;
    }

    $dob = app_integrity_nullable_string($data['date_of_birth'] ?? ($old['date_of_birth'] ?? null));
    $oldDob = $old !== null ? app_integrity_nullable_string($old['date_of_birth'] ?? null) : null;
    if ($insert || $old === null || $dob !== $oldDob) {
        $out['date_of_birth'] = app_integrity_validate_date_of_birth($dob);
    } else {
        $out['date_of_birth'] = $dob;
    }

    $sex = app_integrity_nullable_string($data['sex'] ?? ($old['sex'] ?? null));
    $gender = app_integrity_nullable_string($data['gender'] ?? ($old['gender'] ?? null));
    if ($sex === null && in_array($gender, ['Male', 'Female'], true)) {
        $sex = $gender === 'Male' ? 'M' : 'F';
    }
    if ($gender === null && $sex !== null) {
        $gender = $sex === 'M' ? 'Male' : ($sex === 'F' ? 'Female' : $gender);
    }
    $out['sex'] = $sex;
    $out['gender'] = $gender;

    $indigenousGroup = app_integrity_nullable_string($data['indigenous_group'] ?? ($old['indigenous_group'] ?? null));
    $isIndigenous = (int)($data['is_indigenous'] ?? ($old['is_indigenous'] ?? 0));
    if ($indigenousGroup !== null) {
        $isIndigenous = 1;
    } elseif ($isIndigenous === 1) {
        $isIndigenous = 0;
    }
    $out['indigenous_group'] = $indigenousGroup;
    $out['is_indigenous'] = $isIndigenous;
    return $out;
}

/**
 * Return the curriculum configured as primary for a school year.
 *
 * A school-year curriculum map is the authoritative boundary for subjects,
 * grades, reports, and progression. Callers that need to write an academic
 * record should use app_integrity_resolve_curriculum_for_school_year(),
 * which fails instead of silently falling back to another year's curriculum.
 */
function app_integrity_primary_curriculum_id(PDO $conn, int $schoolYearId): ?int
{
    if ($schoolYearId <= 0) return null;
    $stmt = $conn->prepare(
        'SELECT m.curriculum_id
         FROM curriculum_school_year_map m
         JOIN curricula c
           ON c.curriculum_id = m.curriculum_id
          AND c.is_deleted = 0
         JOIN school_years sy
           ON sy.school_year_id = m.school_year_id
          AND sy.is_deleted = 0
         WHERE m.school_year_id = :school_year_id
           AND m.is_primary = 1
           AND m.is_deleted = 0
         ORDER BY m.map_id ASC
         LIMIT 1'
    );
    $stmt->execute([':school_year_id' => $schoolYearId]);
    $value = $stmt->fetchColumn();
    return $value === false || $value === null ? null : (int)$value;
}

function app_integrity_get_curriculum_id_for_school_year(PDO $conn, int $schoolYearId): ?int
{
    return app_integrity_primary_curriculum_id($conn, $schoolYearId);
}

/**
 * Resolve and validate a curriculum in the context of one school year.
 *
 * $requestedCurriculumId may be supplied only when that curriculum is mapped
 * to the same school year. Without it, the primary map is required. When a
 * curriculum has explicit grade-level coverage, the selected grade must also
 * be covered by that curriculum.
 */
function app_integrity_resolve_curriculum_for_school_year(
    PDO $conn,
    int $schoolYearId,
    ?int $requestedCurriculumId = null,
    int $gradeLevelId = 0
): int {
    if ($schoolYearId <= 0) {
        app_integrity_fail('A valid school year is required.');
    }

    $curriculumId = $requestedCurriculumId !== null && $requestedCurriculumId > 0
        ? $requestedCurriculumId
        : app_integrity_primary_curriculum_id($conn, $schoolYearId);

    if (!$curriculumId) {
        app_integrity_fail('No curriculum is mapped to the selected school year. Configure the school-year curriculum before continuing.');
    }

    if ($requestedCurriculumId !== null && $requestedCurriculumId > 0) {
        $mapped = $conn->prepare(
            'SELECT 1
             FROM curriculum_school_year_map m
             JOIN curricula c
               ON c.curriculum_id = m.curriculum_id
              AND c.is_deleted = 0
             WHERE m.curriculum_id = :curriculum_id
               AND m.school_year_id = :school_year_id
               AND m.is_deleted = 0
             LIMIT 1'
        );
        $mapped->execute([
            ':curriculum_id' => $curriculumId,
            ':school_year_id' => $schoolYearId,
        ]);
        if (!$mapped->fetchColumn()) {
            app_integrity_fail('The selected curriculum is not mapped to the selected school year.');
        }
    }

    if ($gradeLevelId > 0) {
        $coverage = $conn->prepare(
            'SELECT EXISTS(
                SELECT 1
                FROM curriculum_grade_levels cgl
                WHERE cgl.curriculum_id = :coverage_curriculum_id
                  AND cgl.is_deleted = 0
            ) AS has_explicit_levels,
            EXISTS(
                SELECT 1
                FROM curriculum_grade_levels cgl
                WHERE cgl.curriculum_id = :covered_curriculum_id
                  AND cgl.grade_level_id = :grade_level_id
                  AND cgl.is_deleted = 0
            ) AS covers_grade'
        );
        $coverage->execute([
            ':coverage_curriculum_id' => $curriculumId,
            ':covered_curriculum_id' => $curriculumId,
            ':grade_level_id' => $gradeLevelId,
        ]);
        $coverageRow = $coverage->fetch(PDO::FETCH_ASSOC) ?: [];
        if ((int)($coverageRow['has_explicit_levels'] ?? 0) === 1 && (int)($coverageRow['covers_grade'] ?? 0) !== 1) {
            app_integrity_fail('The selected curriculum does not define the selected grade level.');
        }
    }

    return (int)$curriculumId;
}

/**
 * Validates section consistency and capacity and returns the effective
 * curriculum_id. The caller must keep this inside its write transaction.
 */
function app_integrity_validate_enrollment(PDO $conn, array $values, ?int $currentEnrollmentId = null): ?int
{
    $sectionId = (int)($values['section_id'] ?? 0);
    $schoolYearId = (int)($values['school_year_id'] ?? 0);
    $gradeLevelId = (int)($values['grade_level_id'] ?? 0);
    $isDeleted = (int)($values['is_deleted'] ?? 0);
    $status = array_key_exists('enrollment_status', $values) ? $values['enrollment_status'] : null;

    $requestedCurriculumId = !empty($values['curriculum_id']) ? (int)$values['curriculum_id'] : null;
    if ($isDeleted !== 0 || !($status === null || $status === '' || $status === 'Enrolled')) {
        if ($requestedCurriculumId !== null && $schoolYearId > 0) {
            return app_integrity_resolve_curriculum_for_school_year($conn, $schoolYearId, $requestedCurriculumId, $gradeLevelId);
        }
        return $schoolYearId > 0 ? app_integrity_primary_curriculum_id($conn, $schoolYearId) : null;
    }
    if ($sectionId <= 0 || $schoolYearId <= 0 || $gradeLevelId <= 0) {
        app_integrity_fail('Enrollment section, school year, and grade level are required.');
    }

    $sectionStmt = $conn->prepare(
        'SELECT section_id, school_year_id, grade_level_id, max_capacity
         FROM sections
         WHERE section_id = :section_id AND is_deleted = 0
         LIMIT 1
         FOR UPDATE'
    );
    $sectionStmt->execute([':section_id' => $sectionId]);
    $section = $sectionStmt->fetch(PDO::FETCH_ASSOC);
    if (!$section) app_integrity_fail('Invalid section_id.');
    if ((int)$section['school_year_id'] !== $schoolYearId) {
        app_integrity_fail('Enrollment school_year_id does not match section school_year_id.');
    }
    if ((int)$section['grade_level_id'] !== $gradeLevelId) {
        app_integrity_fail('Enrollment grade_level_id does not match section grade_level_id.');
    }
    if ($section['max_capacity'] === null) app_integrity_fail('Section capacity is not configured.');

    // Inserts count every active row. Updates exclude the row being moved so
    // an unchanged full section can still be edited safely.
    $countSql =
        'SELECT COUNT(*)
         FROM enrollments
         WHERE section_id = :section_id
           AND school_year_id = :school_year_id
           AND is_deleted = 0
           AND (enrollment_status = "Enrolled" OR enrollment_status IS NULL)';
    if ($currentEnrollmentId !== null) $countSql .= ' AND enrollment_id <> :enrollment_id';
    $countStmt = $conn->prepare($countSql);
    $countParams = [
        ':section_id' => $sectionId,
        ':school_year_id' => $schoolYearId,
    ];
    if ($currentEnrollmentId !== null) $countParams[':enrollment_id'] = $currentEnrollmentId;
    $countStmt->execute($countParams);
    if ((int)$countStmt->fetchColumn() >= (int)$section['max_capacity']) {
        app_integrity_fail('Section is already at max capacity.');
    }

    return app_integrity_resolve_curriculum_for_school_year(
        $conn,
        $schoolYearId,
        $requestedCurriculumId,
        $gradeLevelId
    );
}

/**
 * Resolve teacher_id and enforce the former class-schedule guard rules.
 */
function app_integrity_prepare_schedule(PDO $conn, array $values, ?int $currentScheduleId = null): array
{
    $out = $values;
    $classId = !empty($values['class_id']) ? (int)$values['class_id'] : null;
    $teacherId = !empty($values['teacher_id']) ? (int)$values['teacher_id'] : null;
    if ($classId !== null) {
        // The active class offering is the source of truth. The schedule row
        // keeps teacher_id for fast conflict checks, but it must not override
        // a current teacher reassignment on the offering.
        $teacherStmt = $conn->prepare(
            'SELECT teacher_id
             FROM class_offerings
             WHERE class_id = :class_id AND is_deleted = 0
             LIMIT 1'
        );
        $teacherStmt->execute([':class_id' => $classId]);
        $teacher = $teacherStmt->fetchColumn();
        if ($teacher === false) {
            app_integrity_fail('Class offering not found or is inactive.');
        }
        $teacherId = $teacher === null ? null : (int)$teacher;
    }

    $start = (string)($values['start_time'] ?? '');
    $end = (string)($values['end_time'] ?? '');
    if ($start === '' || $end === '') app_integrity_fail('start_time and end_time are required.');
    if ($end <= $start) app_integrity_fail('Schedule end_time must be after start_time.');

    $schoolYearId = (int)($values['school_year_id'] ?? 0);
    $day = (string)($values['day_of_week'] ?? '');
    if ($teacherId !== null) {
        // Lock the teacher's existing schedule rows while checking. This does
        // not replace a database constraint, but prevents two API requests in
        // the same application from passing the check simultaneously.
        $lock = $conn->prepare(
            'SELECT schedule_id
             FROM class_schedules
             LEFT JOIN class_offerings co
               ON co.class_id = class_schedules.class_id
              AND co.is_deleted = 0
             WHERE class_schedules.is_deleted = 0
               AND COALESCE(co.teacher_id, class_schedules.teacher_id) = :teacher_id
               AND class_schedules.school_year_id = :school_year_id
               AND class_schedules.day_of_week = :day_of_week
             FOR UPDATE'
        );
        $lock->execute([
            ':teacher_id' => $teacherId,
            ':school_year_id' => $schoolYearId,
            ':day_of_week' => $day,
        ]);

        $sql =
            'SELECT COUNT(*)
             FROM class_schedules cs
             LEFT JOIN class_offerings co
               ON co.class_id = cs.class_id
              AND co.is_deleted = 0
             WHERE cs.is_deleted = 0
               AND COALESCE(co.teacher_id, cs.teacher_id) = :teacher_id
               AND cs.school_year_id = :school_year_id
               AND cs.day_of_week = :day_of_week
               AND :start_time < cs.end_time
               AND :end_time > cs.start_time';
        if ($currentScheduleId !== null) $sql .= ' AND cs.schedule_id <> :schedule_id';
        $stmt = $conn->prepare($sql);
        $stmt->bindValue(':teacher_id', $teacherId, PDO::PARAM_INT);
        $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT);
        $stmt->bindValue(':day_of_week', $day);
        $stmt->bindValue(':start_time', $start);
        $stmt->bindValue(':end_time', $end);
        if ($currentScheduleId !== null) $stmt->bindValue(':schedule_id', $currentScheduleId, PDO::PARAM_INT);
        $stmt->execute();
        if ((int)$stmt->fetchColumn() > 0) {
            app_integrity_fail('Teacher already has a class in this time slot.');
        }
    }

    $out['teacher_id'] = $teacherId;
    return $out;
}

function app_integrity_sync_schedule_teacher(PDO $conn, int $classId, ?int $teacherId): void
{
    $startedTransaction = false;
    if (!$conn->inTransaction()) {
        $conn->beginTransaction();
        $startedTransaction = true;
    }

    try {
        $rows = $conn->prepare(
            'SELECT schedule_id, school_year_id, day_of_week, start_time, end_time
             FROM class_schedules
             WHERE class_id = :class_id AND is_deleted = 0
             FOR UPDATE'
        );
        $rows->execute([':class_id' => $classId]);
        foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if ($teacherId !== null) {
                app_integrity_prepare_schedule($conn, [
                    'class_id' => $classId,
                    'teacher_id' => $teacherId,
                    'school_year_id' => (int)$row['school_year_id'],
                    'day_of_week' => (string)$row['day_of_week'],
                    'start_time' => (string)$row['start_time'],
                    'end_time' => (string)$row['end_time'],
                ], (int)$row['schedule_id']);
            }
        }

        $stmt = $conn->prepare(
            'UPDATE class_schedules
             SET teacher_id = :teacher_id
             WHERE class_id = :class_id AND is_deleted = 0'
        );
        $stmt->bindValue(':teacher_id', $teacherId, $teacherId === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $stmt->bindValue(':class_id', $classId, PDO::PARAM_INT);
        $stmt->execute();

        if ($startedTransaction) $conn->commit();
    } catch (Throwable $e) {
        if ($startedTransaction && $conn->inTransaction()) $conn->rollBack();
        throw $e;
    }
}

function app_integrity_validate_single_guardian(PDO $conn, int $learnerId, bool $isGuardian, ?int $currentFamilyMemberId = null): void
{
    if (!$isGuardian || $learnerId <= 0) return;
    $sql = 'SELECT family_member_id
            FROM family_members
            WHERE learner_id = :learner_id
              AND is_guardian = 1
              AND is_deleted = 0';
    if ($currentFamilyMemberId !== null) $sql .= ' AND family_member_id <> :family_member_id';
    $sql .= ' LIMIT 1 FOR UPDATE';
    $stmt = $conn->prepare($sql);
    $params = [':learner_id' => $learnerId];
    if ($currentFamilyMemberId !== null) $params[':family_member_id'] = $currentFamilyMemberId;
    $stmt->execute($params);
    if ($stmt->fetchColumn() !== false) {
        app_integrity_fail('Learner already has a guardian-of-record; unset it first.');
    }
}

function app_integrity_validate_quarterly_grade($value, string $field = 'quarterly_grade'): ?float
{
    if ($value === null || $value === '') return null;
    if (!is_numeric($value)) app_integrity_fail("{$field} must be a number between 60 and 100.");
    $value = (float)$value;
    if ($value < 60.0 || $value > 100.0) {
        app_integrity_fail("{$field} must be between 60 and 100.");
    }
    return $value;
}

function app_integrity_validate_final_grade_value($value): ?float
{
    if ($value === null || $value === '') return null;
    if (!is_numeric($value)) app_integrity_fail('final_grade must be a number.');
    $value = (float)$value;
    if ($value < 60.0 || $value > 100.0) app_integrity_fail('final_grade must be between 60 and 100.');
    return $value;
}

/**
 * Reproduces both final_grades DepEd-rule triggers and returns the values the
 * write must use. is_deleted != 0 intentionally bypasses the update rules,
 * matching the soft-delete exception in the original update trigger.
 */
function app_integrity_prepare_final_grade(PDO $conn, int $enrollmentId, int $classId, $finalGrade, int $isDeleted = 0): array
{
    $final = app_integrity_validate_final_grade_value($finalGrade);
    if ($isDeleted !== 0) return ['final_grade' => $final, 'remark' => $final !== null && $final >= 75 ? 'Passed' : 'Failed'];

    $meta = $conn->prepare(
        'SELECT e.school_year_id, e.section_id, co.subject_id, sy.grading_system_type
         FROM enrollments e
         JOIN school_years sy ON sy.school_year_id = e.school_year_id
         JOIN class_offerings co ON co.class_id = :class_id
                                AND co.section_id = e.section_id
                                AND co.school_year_id = e.school_year_id
                                AND co.is_deleted = 0
         WHERE e.enrollment_id = :enrollment_id
           AND e.is_deleted = 0
         LIMIT 1'
    );
    $meta->execute([
        ':class_id' => $classId,
        ':enrollment_id' => $enrollmentId,
    ]);
    $row = $meta->fetch(PDO::FETCH_ASSOC);
    if (!$row) app_integrity_fail('Cannot compute final grade: enrollment context was not found.');

    // A class offering can be replaced during the school year when the
    // assigned teacher or offering setup changes. Period grades remain tied
    // to the original offering, while the final grade is written to the
    // current active offering. Validate against that same offering history as
    // GradeComputationService so a normal period-grade save is not rejected.
    $classHistory = $conn->prepare(
        'SELECT class_id
         FROM class_offerings
         WHERE section_id = :section_id
           AND school_year_id = :school_year_id
           AND subject_id = :subject_id'
    );
    $classHistory->execute([
        ':section_id' => (int)$row['section_id'],
        ':school_year_id' => (int)$row['school_year_id'],
        ':subject_id' => (int)$row['subject_id'],
    ]);
    $classIds = array_values(array_unique(array_map(
        'intval',
        $classHistory->fetchAll(PDO::FETCH_COLUMN)
    )));
    if (!in_array($classId, $classIds, true)) $classIds[] = $classId;
    $classPlaceholders = implode(',', array_fill(0, count($classIds), '?'));

    $expected = match ((string)($row['grading_system_type'] ?? '')) {
        'Semester' => 2,
        'Three-Term', 'Trimester' => 3,
        default => 4,
    };
    $grades = $conn->prepare(
        "SELECT COUNT(DISTINCT gp.period_no) AS actual_periods,
                ROUND(AVG(g.quarterly_grade), 2) AS average_grade
         FROM grades g
         JOIN grading_periods gp ON gp.grading_period_id = g.grading_period_id
         WHERE g.enrollment_id = ?
           AND g.class_id IN ({$classPlaceholders})
           AND g.is_deleted = 0
           AND gp.is_deleted = 0
           AND gp.school_year_id = ?
           AND g.quarterly_grade IS NOT NULL"
    );
    $grades->execute(array_merge(
        [$enrollmentId],
        $classIds,
        [(int)$row['school_year_id']]
    ));
    $computed = $grades->fetch(PDO::FETCH_ASSOC) ?: ['actual_periods' => 0, 'average_grade' => null];
    if ((int)$computed['actual_periods'] < $expected) {
        app_integrity_fail("Cannot compute final grade: {$expected} period grade(s) required.");
    }

    $average = $computed['average_grade'] === null ? null : (float)$computed['average_grade'];
    if ($final === null) {
        $final = $average;
    } elseif ($average !== null && abs($final - $average) > 0.01) {
        app_integrity_fail('final_grade must equal the average of the period grades.');
    }
    return [
        'final_grade' => $final,
        'remark' => $final !== null && $final >= 75.0 ? 'Passed' : 'Failed',
    ];
}

function app_integrity_prepare_general_average(PDO $conn, int $enrollmentId, $generalAverage, ?int $schoolYearId = null): ?float
{
    // The computed value must use the same current, active final-grade set as
    // GradeComputationService. Final grades on replaced offerings are history,
    // not additional learning areas to include in this year's average.
    $provided = $generalAverage === null || $generalAverage === '' ? null : (float)$generalAverage;
    $enrollmentMeta = $conn->prepare(
        'SELECT school_year_id
         FROM enrollments
         WHERE enrollment_id = :enrollment_id
           AND is_deleted = 0
         LIMIT 1'
    );
    $enrollmentMeta->execute([':enrollment_id' => $enrollmentId]);
    $resolvedSchoolYearId = $enrollmentMeta->fetchColumn();
    if ($resolvedSchoolYearId === false) {
        app_integrity_fail('Cannot compute general average: enrollment context was not found.');
    }
    $enrollmentSchoolYearId = (int)$resolvedSchoolYearId;
    if ($schoolYearId === null) {
        $schoolYearId = $enrollmentSchoolYearId;
    } elseif ($schoolYearId !== $enrollmentSchoolYearId) {
        app_integrity_fail('General average school year does not match the enrollment.');
    }

    $stmt = $conn->prepare(
        'SELECT ROUND(AVG(fg.final_grade), 2)
         FROM final_grades fg
         JOIN class_offerings co
           ON co.class_id = fg.class_id
          AND co.is_deleted = 0
          AND co.school_year_id = :school_year_id
         WHERE fg.enrollment_id = :enrollment_id
           AND fg.is_deleted = 0
           AND fg.final_grade IS NOT NULL'
    );
    $stmt->execute([
        ':enrollment_id' => $enrollmentId,
        ':school_year_id' => $schoolYearId,
    ]);
    $expected = $stmt->fetchColumn();
    $expected = $expected === false || $expected === null ? null : (float)$expected;
    if ($provided === null) $provided = $expected;
    if ($expected !== null && ($provided === null || abs($provided - $expected) > 0.01)) {
        app_integrity_fail('general_averages.general_average must equal AVG(final_grades.final_grade).');
    }
    return $provided;
}

function app_integrity_prepare_progression(PDO $conn, array $values): array
{
    $enrollmentId = (int)($values['enrollment_id'] ?? 0);
    $gradeLevelId = (int)($values['current_grade_level_id'] ?? 0);
    if ($enrollmentId <= 0 || $gradeLevelId <= 0) app_integrity_fail('Progression enrollment and grade level are required.');

    $meta = $conn->prepare(
        'SELECT gl.grade_level_id, glp.is_terminal, glp.next_grade_level_id
         FROM grade_levels gl
         LEFT JOIN grade_level_progression glp ON glp.grade_level_id = gl.grade_level_id
         WHERE gl.grade_level_id = :grade_level_id
         LIMIT 1'
    );
    $meta->execute([':grade_level_id' => $gradeLevelId]);
    $row = $meta->fetch(PDO::FETCH_ASSOC);
    if (!$row) app_integrity_fail('Progression grade level was not found.');

    $out = $values;

    // Grade 1 descriptive SF9 has no numeric final grades or general average.
    // Require complete persisted PACE evidence before allowing a promotion
    // record to be written, and retain the basis for audit/reporting.
    $enrollmentMeta = $conn->prepare(
        'SELECT school_year_id
         FROM enrollments
         WHERE enrollment_id = :enrollment_id
           AND is_deleted = 0
         LIMIT 1'
    );
    $enrollmentMeta->execute([':enrollment_id' => $enrollmentId]);
    $schoolYearId = (int)$enrollmentMeta->fetchColumn();
    if (DescriptiveProgressionService::isGradeOneDescriptive($conn, $schoolYearId, $gradeLevelId)) {
        $evidence = DescriptiveProgressionService::evidenceForEnrollment($conn, $enrollmentId);
        if (empty($evidence['complete'])) {
            app_integrity_fail('Grade 1 descriptive progression requires complete PACE A-E ratings for Terms 1-3.');
        }

        $out['progression_basis'] = DescriptiveProgressionService::BASIS;
        $out['general_average'] = null;
        $out['next_grade_level_id'] = $row['next_grade_level_id'] === null ? null : (int)$row['next_grade_level_id'];
        $out['final_status'] = (int)$row['is_terminal'] === 1 ? 'Completed' : 'Promoted';
        $out['remarks'] = 'Promoted from complete Grade 1 descriptive PACE ratings for Terms 1-3.';
        return $out;
    }

    $out['progression_basis'] = 'numerical_grades';
    $failedStmt = $conn->prepare(
        'SELECT COUNT(*)
         FROM final_grades
         WHERE enrollment_id = :enrollment_id
           AND is_deleted = 0
           AND final_grade IS NOT NULL
           AND final_grade < 75.00'
    );
    $failedStmt->execute([':enrollment_id' => $enrollmentId]);
    $failed = (int)$failedStmt->fetchColumn();
    $out['progression_basis'] = 'numerical_grades';
    $out['next_grade_level_id'] = $row['next_grade_level_id'] === null ? null : (int)$row['next_grade_level_id'];
    if ((int)$row['is_terminal'] === 1) {
        $out['final_status'] = 'Completed';
        $out['next_grade_level_id'] = null;
        $out['remarks'] = 'Completed terminal grade level.';
    } elseif ($failed === 0) {
        $out['final_status'] = 'Promoted';
        $out['remarks'] = 'Promoted with no failed learning areas.';
    } elseif ($failed <= 2) {
        $out['final_status'] = 'Conditionally Promoted';
        $out['remarks'] = "Conditionally promoted with {$failed} failed learning area(s).";
    } else {
        $out['final_status'] = 'Retained';
        $out['next_grade_level_id'] = $gradeLevelId;
        $out['remarks'] = "Retained with {$failed} failed learning areas.";
    }
    return $out;
}

function app_integrity_prepare_remedial_result($snapshot, $remedialGrade): string
{
    if ($remedialGrade === null || $remedialGrade === '') return 'Pending';
    return (((float)$snapshot + (float)$remedialGrade) / 2) >= 75.0 ? 'Passed' : 'Failed';
}

function app_integrity_bump_auth_version(PDO $conn, int $userId): void
{
    if ($userId <= 0) return;
    try {
        if (function_exists('password_policy_has_column') && !password_policy_has_column($conn, 'auth_version')) return;
        $stmt = $conn->prepare('UPDATE users SET auth_version = COALESCE(auth_version, 0) + 1 WHERE user_id = :user_id');
        $stmt->execute([':user_id' => $userId]);
    } catch (Throwable $e) {
        // Older installations may not yet have auth_version. The password
        // change itself must remain usable on those schemas.
        if ($e instanceof PDOException && (string)$e->getCode() === '42S22') return;
        throw $e;
    }
}

function app_integrity_bump_auth_version_for_learner(PDO $conn, int $learnerId): void
{
    if ($learnerId <= 0) return;
    $stmt = $conn->prepare('SELECT user_id FROM learners WHERE learner_id = :learner_id LIMIT 1');
    $stmt->execute([':learner_id' => $learnerId]);
    $userId = $stmt->fetchColumn();
    if ($userId !== false && $userId !== null) app_integrity_bump_auth_version($conn, (int)$userId);
}
