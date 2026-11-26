<?php
/**
 * Align the active curriculum's Grade 7-10 subject catalog with the
 * MATATAG Grade 7-9 and Old K to 12 Grade 10 transition list.
 *
 * Run from the project root or directly:
 *   php api/database/migrations/align_junior_high_subject_catalog.php
 *
 * The migration refuses to edit a curriculum that is mapped to a previous
 * school year. It preserves existing passing-mark settings and weekly minutes
 * when a Grade 7-9 EsP row is replaced by Values Education.
 */

require_once __DIR__ . '/../connection.php';

function juniorHighSubject(PDO $conn, int $subjectId): array
{
    $stmt = $conn->prepare(
        'SELECT subject_id, subject_name
         FROM subjects
         WHERE subject_id = :subject_id AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->execute([':subject_id' => $subjectId]);
    $subject = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$subject) {
        throw new RuntimeException("Required subject master {$subjectId} was not found.");
    }
    return $subject;
}

function juniorHighArea(PDO $conn, int $curriculumId, string $areaCode): int
{
    $stmt = $conn->prepare(
        'SELECT area_id
         FROM curriculum_learning_areas
         WHERE curriculum_id = :curriculum_id
           AND area_code = :area_code
           AND is_deleted = 0
         LIMIT 1'
    );
    $stmt->execute([
        ':curriculum_id' => $curriculumId,
        ':area_code' => $areaCode,
    ]);
    $areaId = (int)$stmt->fetchColumn();
    if ($areaId <= 0) {
        throw new RuntimeException("Required learning area {$areaCode} was not found for curriculum {$curriculumId}.");
    }
    return $areaId;
}

try {
    $active = $conn->query(
        'SELECT curriculum_id, curriculum_code, curriculum_name
         FROM curricula
         WHERE is_deleted = 0 AND is_active = 1
         ORDER BY effective_from DESC, curriculum_id DESC
         LIMIT 1'
    )->fetch(PDO::FETCH_ASSOC);
    if (!$active) {
        throw new RuntimeException('No active curriculum is available.');
    }

    $curriculumId = (int)$active['curriculum_id'];
    $activeYearEnd = $conn->query(
        'SELECT year_end
         FROM school_years
         WHERE is_deleted = 0 AND is_active = 1
         ORDER BY year_start DESC, school_year_id DESC
         LIMIT 1'
    )->fetchColumn();
    if ($activeYearEnd === false || $activeYearEnd === null || $activeYearEnd === '') {
        throw new RuntimeException('No active school year is available.');
    }

    $historicalStmt = $conn->prepare(
        'SELECT COUNT(*)
         FROM curriculum_school_year_map csm
         JOIN school_years sy ON sy.school_year_id = csm.school_year_id
         WHERE csm.curriculum_id = :curriculum_id
           AND csm.is_deleted = 0
           AND sy.is_deleted = 0
           AND sy.year_end < :active_year_end'
    );
    $historicalStmt->execute([
        ':curriculum_id' => $curriculumId,
        ':active_year_end' => (int)$activeYearEnd,
    ]);
    if ((int)$historicalStmt->fetchColumn() > 0) {
        throw new RuntimeException(
            "Active curriculum {$curriculumId} is mapped to a previous school year; refusing an in-place edit."
        );
    }

    $expectedSubjects = [
        2 => 'Filipino',
        3 => 'English',
        4 => 'Mathematics',
        5 => 'Araling Panlipunan (AP)',
        6 => 'Edukasyon sa Pagpapakatao (EsP)',
        7 => 'MAPEH',
        10 => 'Science',
        12 => 'TLE (Technology & Livelihood Education)',
    ];
    foreach ($expectedSubjects as $subjectId => $expectedName) {
        $subject = juniorHighSubject($conn, $subjectId);
        if ($subject['subject_name'] !== $expectedName) {
            throw new RuntimeException(
                "Subject {$subjectId} has unexpected name '{$subject['subject_name']}'; refusing to overwrite it."
            );
        }
    }

    $valuesEducation = $conn->prepare(
        'SELECT subject_id, subject_name
         FROM subjects
         WHERE subject_name = :subject_name AND is_deleted = 0
         ORDER BY subject_id'
    );
    $valuesEducation->execute([':subject_name' => 'Values Education']);
    $valuesRows = $valuesEducation->fetchAll(PDO::FETCH_ASSOC);
    if (count($valuesRows) > 1) {
        throw new RuntimeException('More than one active Values Education subject master exists; refusing to choose one.');
    }

    $areaIds = [];
    foreach (['LANG', 'MATH', 'SCI', 'SOAPSS', 'VALUES', 'MAPEH', 'TECHVOC'] as $areaCode) {
        $areaIds[$areaCode] = juniorHighArea($conn, $curriculumId, $areaCode);
    }

    $existingSubjectsStmt = $conn->prepare(
        'SELECT grade_level_id, subject_id, is_required, weekly_minutes, notes
         FROM curriculum_subjects
         WHERE curriculum_id = :curriculum_id
           AND grade_level_id BETWEEN 7 AND 10
           AND is_deleted = 0'
    );
    $existingSubjectsStmt->execute([':curriculum_id' => $curriculumId]);
    $existingSubjects = [];
    while ($row = $existingSubjectsStmt->fetch(PDO::FETCH_ASSOC)) {
        $existingSubjects[(int)$row['grade_level_id'] . '-' . (int)$row['subject_id']] = $row;
    }

    $existingMarksStmt = $conn->prepare(
        'SELECT grade_level_id, subject_id, passing_mark, notes, floor_grade, report_card_passing_grade
         FROM curriculum_passing_marks
         WHERE curriculum_id = :curriculum_id
           AND grade_level_id BETWEEN 7 AND 10
           AND is_deleted = 0'
    );
    $existingMarksStmt->execute([':curriculum_id' => $curriculumId]);
    $existingMarks = [];
    while ($row = $existingMarksStmt->fetch(PDO::FETCH_ASSOC)) {
        $existingMarks[(int)$row['grade_level_id'] . '-' . (int)$row['subject_id']] = $row;
    }

    $target = [
        7 => [
            [3, 'LANG', 1, 'English'],
            [2, 'LANG', 2, 'Filipino'],
            [4, 'MATH', 3, 'Mathematics'],
            [10, 'SCI', 4, 'Science'],
            [5, 'SOAPSS', 5, 'Araling Panlipunan (AP)'],
            ['VALUES_EDUCATION', 'VALUES', 6, 'Values Education'],
            [7, 'MAPEH', 7, 'MAPEH'],
            [12, 'TECHVOC', 8, 'TLE (Technology & Livelihood Education)'],
        ],
        8 => [
            [3, 'LANG', 1, 'English'],
            [2, 'LANG', 2, 'Filipino'],
            [4, 'MATH', 3, 'Mathematics'],
            [10, 'SCI', 4, 'Science'],
            [5, 'SOAPSS', 5, 'Araling Panlipunan (AP)'],
            ['VALUES_EDUCATION', 'VALUES', 6, 'Values Education'],
            [7, 'MAPEH', 7, 'MAPEH'],
            [12, 'TECHVOC', 8, 'TLE (Technology & Livelihood Education)'],
        ],
        9 => [
            [3, 'LANG', 1, 'English'],
            [2, 'LANG', 2, 'Filipino'],
            [4, 'MATH', 3, 'Mathematics'],
            [10, 'SCI', 4, 'Science'],
            [5, 'SOAPSS', 5, 'Araling Panlipunan (AP)'],
            ['VALUES_EDUCATION', 'VALUES', 6, 'Values Education'],
            [7, 'MAPEH', 7, 'MAPEH'],
            [12, 'TECHVOC', 8, 'TLE (Technology & Livelihood Education)'],
        ],
        10 => [
            [3, 'LANG', 1, 'English'],
            [2, 'LANG', 2, 'Filipino'],
            [4, 'MATH', 3, 'Mathematics'],
            [10, 'SCI', 4, 'Science'],
            [5, 'SOAPSS', 5, 'Araling Panlipunan (AP)'],
            [6, 'VALUES', 6, 'Edukasyon sa Pagpapakatao (EsP)'],
            [7, 'MAPEH', 7, 'MAPEH'],
            [12, 'TECHVOC', 8, 'TLE (Technology & Livelihood Education)'],
        ],
    ];

    $conn->beginTransaction();

    if (!$valuesRows) {
        $createValuesEducation = $conn->prepare(
            'INSERT INTO subjects (subject_name, description, is_deleted, deleted_at)
             VALUES (:subject_name, :description, 0, NULL)'
        );
        $createValuesEducation->execute([
            ':subject_name' => 'Values Education',
            ':description' => 'Values Education — MATATAG Grades 7-9',
        ]);
        $valuesEducationId = (int)$conn->lastInsertId();
    } else {
        $valuesEducationId = (int)$valuesRows[0]['subject_id'];
        $updateValuesEducation = $conn->prepare(
            'UPDATE subjects
             SET description = :description
             WHERE subject_id = :subject_id'
        );
        $updateValuesEducation->execute([
            ':subject_id' => $valuesEducationId,
            ':description' => 'Values Education — MATATAG Grades 7-9',
        ]);
    }

    foreach ($target as &$rows) {
        foreach ($rows as &$row) {
            if ($row[0] === 'VALUES_EDUCATION') $row[0] = $valuesEducationId;
        }
        unset($row);
    }
    unset($rows);

    $archiveSubjects = $conn->prepare(
        'UPDATE curriculum_subjects
         SET is_deleted = 1, deleted_at = NOW()
         WHERE curriculum_id = :curriculum_id
           AND grade_level_id BETWEEN 7 AND 10
           AND is_deleted = 0'
    );
    $archiveSubjects->execute([':curriculum_id' => $curriculumId]);

    $archiveMarks = $conn->prepare(
        'UPDATE curriculum_passing_marks
         SET is_deleted = 1, deleted_at = NOW()
         WHERE curriculum_id = :curriculum_id
           AND grade_level_id BETWEEN 7 AND 10
           AND is_deleted = 0'
    );
    $archiveMarks->execute([':curriculum_id' => $curriculumId]);

    $insertSubject = $conn->prepare(
        'INSERT INTO curriculum_subjects
            (curriculum_id, grade_level_id, subject_id, is_required, weekly_minutes, sort_order, learning_area_id, notes, is_deleted, deleted_at)
         VALUES (:curriculum_id, :grade_level_id, :subject_id, :is_required, :weekly_minutes, :sort_order, :learning_area_id, :notes, 0, NULL)
         ON DUPLICATE KEY UPDATE
            is_required = VALUES(is_required),
            weekly_minutes = VALUES(weekly_minutes),
            sort_order = VALUES(sort_order),
            learning_area_id = VALUES(learning_area_id),
            notes = VALUES(notes),
            is_deleted = 0,
            deleted_at = NULL'
    );

    $insertMark = $conn->prepare(
        'INSERT INTO curriculum_passing_marks
            (curriculum_id, grade_level_id, subject_id, passing_mark, notes, is_deleted, deleted_at, floor_grade, report_card_passing_grade)
         VALUES (:curriculum_id, :grade_level_id, :subject_id, :passing_mark, :notes, 0, NULL, :floor_grade, :report_card_passing_grade)
         ON DUPLICATE KEY UPDATE
            passing_mark = VALUES(passing_mark),
            notes = VALUES(notes),
            floor_grade = VALUES(floor_grade),
            report_card_passing_grade = VALUES(report_card_passing_grade),
            is_deleted = 0,
            deleted_at = NULL'
    );

    foreach ($target as $gradeLevelId => $rows) {
        foreach ($rows as [$subjectId, $areaCode, $sortOrder, $note]) {
            $previousSubjectId = ($gradeLevelId >= 7 && $gradeLevelId <= 9 && $subjectId === $valuesEducationId)
                ? 6
                : $subjectId;
            $existingSubject = $existingSubjects[$gradeLevelId . '-' . $previousSubjectId]
                ?? $existingSubjects[$gradeLevelId . '-' . $subjectId]
                ?? null;
            $existingMark = $existingMarks[$gradeLevelId . '-' . $previousSubjectId]
                ?? $existingMarks[$gradeLevelId . '-' . $subjectId]
                ?? null;

            $insertSubject->execute([
                ':curriculum_id' => $curriculumId,
                ':grade_level_id' => $gradeLevelId,
                ':subject_id' => $subjectId,
                ':is_required' => $existingSubject ? (int)$existingSubject['is_required'] : 1,
                ':weekly_minutes' => $existingSubject['weekly_minutes'] ?? null,
                ':sort_order' => $sortOrder,
                ':learning_area_id' => $areaIds[$areaCode],
                ':notes' => $note,
            ]);

            $insertMark->execute([
                ':curriculum_id' => $curriculumId,
                ':grade_level_id' => $gradeLevelId,
                ':subject_id' => $subjectId,
                ':passing_mark' => $existingMark['passing_mark'] ?? 75,
                ':notes' => $existingMark['notes'] ?? null,
                ':floor_grade' => $existingMark['floor_grade'] ?? 60,
                ':report_card_passing_grade' => $existingMark['report_card_passing_grade'] ?? 75,
            ]);
        }
    }

    $verify = $conn->prepare(
        'SELECT COUNT(*)
         FROM curriculum_subjects
         WHERE curriculum_id = :curriculum_id
           AND grade_level_id BETWEEN 7 AND 10
           AND is_deleted = 0'
    );
    $verify->execute([':curriculum_id' => $curriculumId]);
    if ((int)$verify->fetchColumn() !== 32) {
        throw new RuntimeException('Verification failed: expected exactly 32 active Grade 7-10 subject assignments.');
    }

    $verifyOrder = $conn->prepare(
        'SELECT grade_level_id, subject_id, sort_order
         FROM curriculum_subjects
         WHERE curriculum_id = :curriculum_id
           AND grade_level_id BETWEEN 7 AND 10
           AND is_deleted = 0
         ORDER BY grade_level_id, sort_order, curriculum_subject_id'
    );
    $verifyOrder->execute([':curriculum_id' => $curriculumId]);
    $actualOrder = [];
    while ($row = $verifyOrder->fetch(PDO::FETCH_ASSOC)) {
        $actualOrder[(int)$row['grade_level_id']][] = [
            (int)$row['subject_id'],
            (int)$row['sort_order'],
        ];
    }
    foreach ($target as $gradeLevelId => $rows) {
        $expectedOrder = array_map(
            static fn(array $row): array => [(int)$row[0], (int)$row[2]],
            $rows
        );
        if (($actualOrder[$gradeLevelId] ?? []) !== $expectedOrder) {
            throw new RuntimeException("Verification failed: Grade {$gradeLevelId} subject order does not match the configured reference.");
        }
    }

    $conn->commit();
    echo "Aligned {$active['curriculum_code']} (curriculum {$curriculumId}) Grade 7-10 subject catalog.\n";
    echo "Values Education master: {$valuesEducationId}; active assignments: 32; passing marks preserved/defaulted.\n";
} catch (Throwable $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    fwrite(STDERR, "Migration failed: {$e->getMessage()}\n");
    exit(1);
}
