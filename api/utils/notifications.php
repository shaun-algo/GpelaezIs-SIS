<?php
require_once __DIR__ . '/account_identity_queries.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';

// Matches the baseline schema in api/database/thepelaezdraftrev.sql
function notifications_ensure_tables(PDO $conn): void {
    $conn->exec(
        "CREATE TABLE IF NOT EXISTS notifications (
            notification_id INT(11) NOT NULL AUTO_INCREMENT,
            user_id INT(11) NOT NULL,
            actor_user_id INT(11) DEFAULT NULL,
            notification_type ENUM('Grade Alert','Risk Flag','Intervention Due','Announcement','Grading Period') NOT NULL,
            title VARCHAR(200) NOT NULL,
            message TEXT NOT NULL,
            is_read TINYINT(1) DEFAULT 0,
            read_at DATETIME DEFAULT NULL,
            reference_table VARCHAR(50) DEFAULT NULL,
            reference_id INT(11) DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_deleted TINYINT(1) DEFAULT 0,
            deleted_at DATETIME DEFAULT NULL,
            PRIMARY KEY (notification_id),
            KEY idx_notif_user (user_id),
            KEY idx_notif_actor (actor_user_id),
            KEY idx_notif_read (is_read)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci"
    );

    notifications_ensure_actor_column($conn);
}

/**
 * Add actor storage to installations created from an older notifications schema.
 * Notifications must remain best-effort, so an unavailable ALTER must not stop
 * the endpoint that created the notification.
 */
function notifications_ensure_actor_column(PDO $conn): bool {
    static $ready = null;
    if ($ready !== null) return $ready;

    try {
        $check = $conn->query("SHOW COLUMNS FROM notifications LIKE 'actor_user_id'");
        if (!$check->fetch(PDO::FETCH_ASSOC)) {
            $conn->exec("ALTER TABLE notifications ADD COLUMN actor_user_id INT(11) DEFAULT NULL AFTER user_id, ADD KEY idx_notif_actor (actor_user_id)");
        }
        $ready = true;
    } catch (Throwable $e) {
        $ready = false;
    }

    return $ready;
}

function notifications_get_role_id(PDO $conn, string $roleKey): ?int {
    static $cache = null;
    if ($cache === null) {
        $cache = [];
        try {
            $stmt = $conn->query("SELECT role_id, role_name FROM roles WHERE is_deleted = 0");
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            foreach ($rows as $r) {
                $key = auth_normalize_role((string)($r['role_name'] ?? ''));
                if ($key === '') continue;
                $cache[$key] = (int)$r['role_id'];
            }
        } catch (Exception $e) {
            $cache = [];
        }
    }

    $normalized = auth_normalize_role($roleKey);
    if ($normalized === '') return null;
    return $cache[$normalized] ?? null;
}

function notifications_normalize_type(string $type): string {
    $type = trim($type);
    $allowed = ['Grade Alert','Risk Flag','Intervention Due','Announcement','Grading Period'];
    return in_array($type, $allowed, true) ? $type : 'Announcement';
}

function notifications_create_for_user(PDO $conn, int $userId, string $type, string $title, string $message, ?string $referenceTable = null, ?int $referenceId = null, int $isRead = 0, ?int $actorUserId = null): void {
    notifications_ensure_tables($conn);
    if ($userId <= 0) return;

    $type = notifications_normalize_type($type);
    $title = trim($title);
    $message = trim($message);
    if ($title === '' || $message === '') return;

    $isRead = ((int)$isRead) === 1 ? 1 : 0;
    $readAt = $isRead ? date('Y-m-d H:i:s') : null;

    $hasActorColumn = notifications_ensure_actor_column($conn);
    $stmt = $conn->prepare($hasActorColumn
        ? "INSERT INTO notifications (user_id, actor_user_id, notification_type, title, message, is_read, read_at, reference_table, reference_id)
           VALUES (:uid, :actor_uid, :type, :title, :msg, :is_read, :read_at, :rt, :rid)"
        : "INSERT INTO notifications (user_id, notification_type, title, message, is_read, read_at, reference_table, reference_id)
           VALUES (:uid, :type, :title, :msg, :is_read, :read_at, :rt, :rid)"
    );

    $stmt->bindValue(':uid', $userId, PDO::PARAM_INT);
    if ($hasActorColumn) {
        if ($actorUserId === null || $actorUserId <= 0) {
            $stmt->bindValue(':actor_uid', null, PDO::PARAM_NULL);
        } else {
            $stmt->bindValue(':actor_uid', $actorUserId, PDO::PARAM_INT);
        }
    }
    $stmt->bindValue(':type', $type);
    $stmt->bindValue(':title', $title);
    $stmt->bindValue(':msg', $message);
    $stmt->bindValue(':is_read', $isRead, PDO::PARAM_INT);
    if ($readAt === null) {
        $stmt->bindValue(':read_at', null, PDO::PARAM_NULL);
    } else {
        $stmt->bindValue(':read_at', $readAt);
    }

    if ($referenceTable === null || trim($referenceTable) === '') {
        $stmt->bindValue(':rt', null, PDO::PARAM_NULL);
    } else {
        $stmt->bindValue(':rt', $referenceTable);
    }
    if ($referenceId === null || $referenceId <= 0) {
        $stmt->bindValue(':rid', null, PDO::PARAM_NULL);
    } else {
        $stmt->bindValue(':rid', $referenceId, PDO::PARAM_INT);
    }

    try {
        $stmt->execute();
    } catch (Exception $e) {
        // Don't break calling endpoints.
    }
}

function notifications_exists_today_for_user(PDO $conn, int $userId, string $type, string $title, string $message): bool {
    try {
        $stmt = $conn->prepare(
            "SELECT 1
             FROM notifications
             WHERE user_id = :uid
               AND notification_type = :type
               AND title = :title
               AND message = :msg
               AND is_deleted = 0
               AND created_at >= CURDATE()
             LIMIT 1"
        );
        $stmt->bindValue(':uid', $userId, PDO::PARAM_INT);
        $stmt->bindValue(':type', notifications_normalize_type($type));
        $stmt->bindValue(':title', trim($title));
        $stmt->bindValue(':msg', trim($message));
        $stmt->execute();
        return (bool)$stmt->fetchColumn();
    } catch (Exception $e) {
        return false;
    }
}

function notifications_exists_recent_for_reference(PDO $conn, int $userId, string $type, string $title, string $referenceTable, int $referenceId, int $cooldownDays = 2): bool {
    if ($userId <= 0 || $referenceId <= 0) return false;
    $cooldownDays = max(1, $cooldownDays);

    try {
        $stmt = $conn->prepare(
            "SELECT 1
             FROM notifications
             WHERE user_id = :uid
               AND notification_type = :type
               AND title = :title
               AND reference_table = :reference_table
               AND reference_id = :reference_id
               AND is_deleted = 0
               AND created_at >= DATE_SUB(NOW(), INTERVAL {$cooldownDays} DAY)
             LIMIT 1"
        );
        $stmt->execute([
            ':uid' => $userId,
            ':type' => notifications_normalize_type($type),
            ':title' => trim($title),
            ':reference_table' => $referenceTable,
            ':reference_id' => $referenceId,
        ]);
        return (bool)$stmt->fetchColumn();
    } catch (Exception $e) {
        return false;
    }
}

/**
 * Keep learner risk notifications short, clear, and separate from the
 * operational wording used by staff risk-assessment notifications.
 */
function notifications_learner_risk_copy(string $riskName, string $periodName = ''): array {
    $normalized = strtolower(trim($riskName));
    $displayRisk = str_contains($normalized, 'high') || str_contains($normalized, 'critical')
        ? 'High'
        : (str_contains($normalized, 'medium') || str_contains($normalized, 'moderate') ? 'Medium' : 'At risk');
    $periodSuffix = trim($periodName) !== '' ? ' for ' . trim($periodName) : '';

    return [
        'title' => 'Your Failing Risk is ' . $displayRisk,
        'message' => 'Your Failing Risk is ' . $displayRisk . $periodSuffix . '. Open My Academic Status to review your status.',
    ];
}

function notifications_migrate_legacy_learner_risk_copy(PDO $conn, int $userId, int $riskAssessmentId, string $riskName, array $copy): void {
    if ($userId <= 0 || $riskAssessmentId <= 0) return;

    try {
        $stmt = $conn->prepare(
            'UPDATE notifications
             SET title = :title,
                 message = :message
             WHERE user_id = :user_id
               AND notification_type = "Risk Flag"
               AND reference_table = "risk_assessments"
               AND reference_id = :reference_id
               AND title = :legacy_title
               AND is_deleted = 0'
        );
        $stmt->execute([
            ':title' => (string)($copy['title'] ?? ''),
            ':message' => (string)($copy['message'] ?? ''),
            ':user_id' => $userId,
            ':reference_id' => $riskAssessmentId,
            ':legacy_title' => 'Academic status: ' . trim($riskName),
        ]);
    } catch (Throwable $e) {
        // Copy migration is best-effort; it must not block notification delivery.
    }
}

/**
 * Backfill learner-facing risk alerts when the learner opens the notification
 * feed. Risk assessments may be created by an automated job or an older admin
 * workflow, so delivery must not depend on the risk page being open at the
 * exact moment the assessment is saved.
 */
function notifications_sync_learner_risk_alerts(PDO $conn, int $userId): void {
    if ($userId <= 0) return;

    try {
        $stmt = $conn->prepare(
            'SELECT ra.risk_assessment_id,
                    rl.risk_name,
                    gp.period_name
             FROM risk_assessments ra
             JOIN risk_levels rl ON rl.risk_level_id = ra.risk_level_id
                                AND rl.is_deleted = 0
             JOIN grading_periods gp ON gp.grading_period_id = ra.grading_period_id
                                    AND gp.is_deleted = 0
                                    AND gp.status = "Locked"
             JOIN enrollments e ON e.enrollment_id = ra.enrollment_id
                               AND e.is_deleted = 0
             JOIN learners l ON l.learner_id = e.learner_id
                            AND l.user_id = :user_id
                            AND l.is_deleted = 0
                            AND l.is_active = 1
             WHERE ra.is_deleted = 0
               AND LOWER(TRIM(rl.risk_name)) IN ("medium", "moderate", "high", "critical")
             ORDER BY COALESCE(gp.date_start, "9999-12-31") DESC,
                      gp.grading_period_id DESC,
                      ra.risk_assessment_id DESC'
        );
        $stmt->execute([':user_id' => $userId]);

        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $riskAssessmentId = (int)($row['risk_assessment_id'] ?? 0);
            $riskName = trim((string)($row['risk_name'] ?? 'At risk')) ?: 'At risk';
            $periodName = trim((string)($row['period_name'] ?? ''));
            if ($riskAssessmentId <= 0) continue;

            $copy = notifications_learner_risk_copy($riskName, $periodName);
            $title = $copy['title'];
            $message = $copy['message'];

            notifications_migrate_legacy_learner_risk_copy(
                $conn,
                $userId,
                $riskAssessmentId,
                $riskName,
                $copy
            );

            if (notifications_exists_recent_for_reference(
                $conn,
                $userId,
                'Risk Flag',
                $title,
                'risk_assessments',
                $riskAssessmentId,
                365
            )) {
                continue;
            }

            notifications_create_for_user(
                $conn,
                $userId,
                'Risk Flag',
                $title,
                $message,
                'risk_assessments',
                $riskAssessmentId
            );
        }
    } catch (Throwable $e) {
        // Notification delivery is best-effort and must not block the feed.
        error_log('Learner risk notification sync failed: ' . $e->getMessage());
    }
}

/**
 * Keep one staff-facing risk summary per closed grading period.
 *
 * Learner notifications remain assessment-specific, but employees do not need
 * one notification card for every learner. When a new assessment changes an
 * existing summary, refresh the same card and make it unread again so the
 * employee sees the updated total without creating another duplicate card.
 */
function notifications_upsert_closed_staff_risk_summary(
    PDO $conn,
    int $userId,
    int $periodId,
    string $periodName,
    int $periodNo,
    int $learnerCount
): bool {
    if ($userId <= 0 || $periodId <= 0 || $learnerCount <= 0) return false;

    $periodName = trim($periodName);
    $periodLabel = $periodName !== '' ? $periodName : ('Period ' . max(1, $periodNo));
    if ($periodNo > 0 && stripos($periodLabel, 'period') === false) {
        $periodLabel .= ' (Period ' . $periodNo . ')';
    }

    $title = 'At-Risk Learners — ' . $periodLabel;
    $message = $periodLabel . ': ' . $learnerCount
        . ' learner' . ($learnerCount === 1 ? '' : 's')
        . ($learnerCount === 1 ? ' was' : ' were')
        . ' identified at risk after the grading period closed. '
        . 'Open Risk Assessment to review the official statuses.';

    try {
        $find = $conn->prepare(
            'SELECT notification_id, message, is_deleted
             FROM notifications
             WHERE user_id = :user_id
               AND notification_type = "Risk Flag"
               AND reference_table = "risk_period_summary"
               AND reference_id = :period_id
             ORDER BY notification_id DESC
             LIMIT 1'
        );
        $find->execute([
            ':user_id' => $userId,
            ':period_id' => $periodId,
        ]);
        $existing = $find->fetch(PDO::FETCH_ASSOC);

        if ($existing && (int)($existing['is_deleted'] ?? 0) === 1) {
            // Respect an employee explicitly removing this period summary.
            return true;
        }

        if ($existing) {
            if ((string)($existing['message'] ?? '') !== $message) {
                $update = $conn->prepare(
                    'UPDATE notifications
                     SET title = :title,
                         message = :message,
                         is_read = 0,
                         read_at = NULL,
                         created_at = NOW()
                     WHERE notification_id = :notification_id
                       AND user_id = :user_id
                       AND is_deleted = 0'
                );
                $update->execute([
                    ':title' => $title,
                    ':message' => $message,
                    ':notification_id' => (int)$existing['notification_id'],
                    ':user_id' => $userId,
                ]);
            }
            return true;
        }

        notifications_create_for_user(
            $conn,
            $userId,
            'Risk Flag',
            $title,
            $message,
            'risk_period_summary',
            $periodId
        );

        $verify = $conn->prepare(
            'SELECT 1
             FROM notifications
             WHERE user_id = :user_id
               AND notification_type = "Risk Flag"
               AND reference_table = "risk_period_summary"
               AND reference_id = :period_id
               AND is_deleted = 0
             LIMIT 1'
        );
        $verify->execute([
            ':user_id' => $userId,
            ':period_id' => $periodId,
        ]);
        return (bool)$verify->fetchColumn();
    } catch (Throwable $e) {
        // Notification delivery is best-effort and must not block the feed.
        return false;
    }
}

function notifications_hide_staff_risk_detail_cards(PDO $conn, int $userId, int $periodId): void {
    if ($userId <= 0 || $periodId <= 0) return;

    try {
        $stmt = $conn->prepare(
            'UPDATE notifications n
             JOIN risk_assessments ra
               ON ra.risk_assessment_id = n.reference_id
              AND ra.grading_period_id = :period_id
              AND ra.is_deleted = 0
             SET n.is_deleted = 1,
                 n.deleted_at = NOW()
             WHERE n.user_id = :user_id
               AND n.notification_type = "Risk Flag"
               AND n.title = "At-Risk Learner"
               AND n.reference_table IN ("risk_assessment", "risk_assessments")
               AND n.is_deleted = 0'
        );
        $stmt->execute([
            ':period_id' => $periodId,
            ':user_id' => $userId,
        ]);
    } catch (Throwable $e) {
        // Cleanup is best-effort; the summary itself remains authoritative.
    }
}

/**
 * Deliver official risk summaries lazily the first time the notification feed
 * is requested after a period closes. Staff receive one card per period,
 * while learners continue to receive their own assessment-specific alert.
 */
function notifications_sync_closed_risk_alerts(PDO $conn): void {
    try {
        $globalUsers = [];
        $roleStmt = $conn->query(
            "SELECT DISTINCT u.user_id
             FROM users u
             JOIN roles r ON r.role_id = u.role_id
             WHERE u.is_deleted = 0
               AND u.is_active = 1
               AND LOWER(TRIM(r.role_name)) IN ('admin', 'registrar', 'principal')"
        );
        if ($roleStmt) {
            $globalUsers = array_map('intval', $roleStmt->fetchAll(PDO::FETCH_COLUMN));
        }

        $stmt = $conn->query(
            'SELECT ra.risk_assessment_id,
                    ra.assessed_by AS assessed_by_user_id,
                    e.enrollment_id,
                    gp.grading_period_id,
                    gp.period_name,
                    gp.period_no,
                    l.user_id AS learner_user_id,
                    rl.risk_name,
                    sec.adviser_id,
                    adv.user_id AS adviser_user_id
             FROM risk_assessments ra
             JOIN grading_periods gp ON gp.grading_period_id = ra.grading_period_id
                                    AND gp.is_deleted = 0
                                    AND gp.status = "Locked"
             JOIN risk_levels rl ON rl.risk_level_id = ra.risk_level_id
                                AND rl.is_deleted = 0
             JOIN enrollments e ON e.enrollment_id = ra.enrollment_id
                               AND e.is_deleted = 0
             JOIN learners l ON l.learner_id = e.learner_id
                            AND l.user_id IS NOT NULL
                            AND l.is_deleted = 0
                            AND l.is_active = 1
             LEFT JOIN sections sec ON sec.section_id = e.section_id
                                   AND sec.is_deleted = 0
             LEFT JOIN employees adv_emp ON adv_emp.employee_id = sec.adviser_id
                                        AND adv_emp.is_deleted = 0
             LEFT JOIN users adv ON adv.user_id = adv_emp.user_id
                               AND adv.is_deleted = 0
                               AND adv.is_active = 1
             WHERE ra.is_deleted = 0
               AND LOWER(TRIM(rl.risk_name)) IN ("medium", "moderate", "high", "critical")'
        );

        $periodRecipients = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $riskAssessmentId = (int)($row['risk_assessment_id'] ?? 0);
            if ($riskAssessmentId <= 0) continue;

            $periodId = (int)($row['grading_period_id'] ?? 0);
            if ($periodId <= 0) continue;

            $learnerUserId = (int)($row['learner_user_id'] ?? 0);
            $recipientUserIds = array_values(array_unique(array_filter([
                (int)($row['assessed_by_user_id'] ?? 0),
                (int)($row['adviser_user_id'] ?? 0),
                ...$globalUsers
            ], static fn($id) => $id > 0)));

            foreach ($recipientUserIds as $recipientUserId) {
                $key = $recipientUserId . ':' . $periodId;
                if (!isset($periodRecipients[$key])) {
                    $periodRecipients[$key] = [
                        'user_id' => $recipientUserId,
                        'period_id' => $periodId,
                        'period_name' => trim((string)($row['period_name'] ?? '')),
                        'period_no' => (int)($row['period_no'] ?? 0),
                        'learner_ids' => [],
                    ];
                }

                // Count distinct learners, not assessment rows, in the summary.
                $learnerKey = $learnerUserId > 0
                    ? (string)$learnerUserId
                    : ('enrollment:' . (int)($row['enrollment_id'] ?? 0));
                $periodRecipients[$key]['learner_ids'][$learnerKey] = true;
            }
        }

        foreach ($periodRecipients as $summary) {
            $userId = (int)$summary['user_id'];
            $periodId = (int)$summary['period_id'];
            $learnerCount = count($summary['learner_ids']);
            $summaryReady = notifications_upsert_closed_staff_risk_summary(
                $conn,
                $userId,
                $periodId,
                (string)$summary['period_name'],
                (int)$summary['period_no'],
                $learnerCount
            );
            if ($summaryReady) {
                notifications_hide_staff_risk_detail_cards($conn, $userId, $periodId);
            }
        }
    } catch (Throwable $e) {
        error_log('Closed risk notification sync failed: ' . $e->getMessage());
    }
}

function notifications_sync_grade_monitoring_alerts(PDO $conn, int $userId, array $session = []): void {
    if ($userId <= 0) return;

    $roleKey = auth_normalize_role((string)($session['role_key'] ?? $session['role_name'] ?? ''));
    if (!in_array($roleKey, ['admin', 'registrar'], true)) return;

    try {
        $schoolYearStmt = $conn->query(
            'SELECT school_year_id
             FROM school_years
             WHERE is_deleted = 0 AND is_active = 1
             ORDER BY year_end DESC, school_year_id DESC
             LIMIT 1'
        );
        $schoolYearId = (int)($schoolYearStmt->fetchColumn() ?: 0);
        if ($schoolYearId <= 0) return;

        $curriculumId = (int)(app_integrity_get_curriculum_id_for_school_year($conn, $schoolYearId) ?? 0);
        if ($curriculumId <= 0) return;

        $subjectFilter = "(
            EXISTS (
                SELECT 1
                FROM curriculum_subjects cs_allowed
                WHERE cs_allowed.curriculum_id = :curriculum_id_allowed
                  AND cs_allowed.grade_level_id = sec.grade_level_id
                  AND cs_allowed.subject_id = co.subject_id
                  AND cs_allowed.is_deleted = 0
            )
            OR (
                EXISTS (
                    SELECT 1
                    FROM curriculum_subjects cs_mapeh
                    JOIN subjects s_mapeh
                      ON s_mapeh.subject_id = cs_mapeh.subject_id
                     AND s_mapeh.is_deleted = 0
                    WHERE cs_mapeh.curriculum_id = :curriculum_id_mapeh
                      AND cs_mapeh.grade_level_id = sec.grade_level_id
                      AND cs_mapeh.is_deleted = 0
                      AND s_mapeh.subject_name LIKE '%MAPEH%'
                )
                AND (
                    sub.subject_name LIKE '%MAPEH Component%'
                    OR (
                        sub.subject_name NOT LIKE '%MAPEH%'
                        AND sub.subject_name REGEXP '(^|[^A-Za-z])(Music|Arts|Physical Education|Health)([^A-Za-z]|$)'
                    )
                )
            )
        )";

        $stmt = $conn->prepare(
            "SELECT monitoring.teacher_id,
                    monitoring.teacher_name,
                    monitoring.section_id,
                    monitoring.section_name,
                    monitoring.grading_period_id,
                    monitoring.period_name,
                    COUNT(DISTINCT monitoring.enrollment_id) AS expected_count,
                    COUNT(DISTINCT CASE
                        WHEN monitoring.required_subject_count > 0
                         AND monitoring.encoded_subject_count >= monitoring.required_subject_count
                        THEN monitoring.enrollment_id
                    END) AS complete_count
             FROM (
                 SELECT co.teacher_id,
                        TRIM(CONCAT_WS(' ', NULLIF(TRIM(emp.first_name), ''), NULLIF(TRIM(emp.last_name), ''))) AS teacher_name,
                        sec.section_id,
                        sec.section_name,
                        gp.grading_period_id,
                        gp.period_name,
                        en.enrollment_id,
                        COUNT(DISTINCT co.class_id) AS required_subject_count,
                        COUNT(DISTINCT CASE
                            WHEN g.grade_id IS NOT NULL AND g.quarterly_grade IS NOT NULL
                            THEN co.class_id
                        END) AS encoded_subject_count
                 FROM class_offerings co
                 JOIN employees emp
                   ON emp.employee_id = co.teacher_id
                  AND emp.is_deleted = 0
                 JOIN subjects sub
                   ON sub.subject_id = co.subject_id
                  AND sub.is_deleted = 0
                 JOIN sections sec
                   ON sec.section_id = co.section_id
                  AND sec.is_deleted = 0
                 JOIN grading_periods gp
                   ON gp.school_year_id = co.school_year_id
                  AND gp.is_deleted = 0
                  AND gp.status = 'Open'
                 LEFT JOIN enrollments en
                   ON en.section_id = co.section_id
                  AND en.school_year_id = co.school_year_id
                  AND en.is_deleted = 0
                  AND en.enrollment_status = 'Enrolled'
                 LEFT JOIN learners l
                   ON l.learner_id = en.learner_id
                  AND l.is_deleted = 0
                 LEFT JOIN grades g
                   ON g.enrollment_id = en.enrollment_id
                  AND g.class_id = co.class_id
                  AND g.grading_period_id = gp.grading_period_id
                  AND g.is_deleted = 0
                 WHERE co.is_deleted = 0
                   AND co.school_year_id = :school_year_id
                   AND {$subjectFilter}
                 GROUP BY co.teacher_id, teacher_name, sec.section_id, sec.section_name,
                          gp.grading_period_id, gp.period_name, en.enrollment_id
             ) monitoring
             GROUP BY monitoring.teacher_id, monitoring.teacher_name,
                      monitoring.section_id, monitoring.section_name,
                      monitoring.grading_period_id, monitoring.period_name
             HAVING expected_count > 0 AND complete_count < expected_count
             ORDER BY monitoring.grading_period_id ASC, monitoring.teacher_name ASC,
                      monitoring.section_name ASC"
        );
        $stmt->execute([
            ':school_year_id' => $schoolYearId,
            ':curriculum_id_allowed' => $curriculumId,
            ':curriculum_id_mapeh' => $curriculumId,
        ]);

        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $expected = (int)($row['expected_count'] ?? 0);
            $complete = (int)($row['complete_count'] ?? 0);
            $missing = max(0, $expected - $complete);
            $periodId = (int)($row['grading_period_id'] ?? 0);
            if ($expected <= 0 || $missing <= 0 || $periodId <= 0) continue;

            $title = 'Incomplete grade entries';
            $message = 'Some teachers have incomplete grade entries in the active grading periods. Review Grade Monitoring to see which sections still need grades.';

            if (!notifications_exists_recent_for_reference($conn, $userId, 'Grade Alert', $title, 'grade_monitoring', $periodId, 1)) {
                notifications_create_for_user($conn, $userId, 'Grade Alert', $title, $message, 'grade_monitoring', $periodId);
            }
        }
    } catch (Exception $e) {
        // Grade monitoring alerts must never prevent the notification feed from loading.
    }
}

function notifications_create_for_role(PDO $conn, int $roleId, string $type, string $title, string $message, ?string $referenceTable = null, ?int $referenceId = null, ?int $excludeUserId = null, ?int $markReadUserId = null, ?int $actorUserId = null): void {
    if ($roleId <= 0) return;
    notifications_ensure_tables($conn);

    $exclude = $excludeUserId !== null ? (int)$excludeUserId : null;
    $markRead = $markReadUserId !== null ? (int)$markReadUserId : null;

    try {
        $stmt = $conn->prepare("SELECT user_id FROM (" . user_identity_derived_sql() . ") ui WHERE ui.role_id = :rid AND ui.is_active = 1 AND ui.is_deleted = 0");
        $stmt->bindValue(':rid', $roleId, PDO::PARAM_INT);
        $stmt->execute();
        $userIds = $stmt->fetchAll(PDO::FETCH_COLUMN);
        foreach ($userIds as $uid) {
            $id = (int)$uid;
            if ($exclude !== null && $id === $exclude) continue;
            $isRead = ($markRead !== null && $id === $markRead) ? 1 : 0;
            notifications_create_for_user($conn, $id, $type, $title, $message, $referenceTable, $referenceId, $isRead, $actorUserId);
        }
    } catch (Exception $e) {
        // ignore
    }
}

function notifications_create_broadcast(PDO $conn, string $type, string $title, string $message, ?string $referenceTable = null, ?int $referenceId = null, ?int $excludeUserId = null, ?int $markReadUserId = null, ?int $actorUserId = null): void {
    notifications_ensure_tables($conn);

    $exclude = $excludeUserId !== null ? (int)$excludeUserId : null;
    $markRead = $markReadUserId !== null ? (int)$markReadUserId : null;

    try {
        $stmt = $conn->query("SELECT user_id FROM (" . user_identity_derived_sql() . ") ui WHERE ui.is_active = 1 AND ui.is_deleted = 0");
        $userIds = $stmt->fetchAll(PDO::FETCH_COLUMN);
        foreach ($userIds as $uid) {
            $id = (int)$uid;
            if ($exclude !== null && $id === $exclude) continue;
            $isRead = ($markRead !== null && $id === $markRead) ? 1 : 0;
            notifications_create_for_user($conn, $id, $type, $title, $message, $referenceTable, $referenceId, $isRead, $actorUserId);
        }
    } catch (Exception $e) {
        // ignore
    }
}
?>
