<?php
header('Content-Type: application/json');

require_once __DIR__ . '/../utils/cors.php';
require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';
require_once __DIR__ . '/../utils/notifications.php';
require_once __DIR__ . '/../utils/grading_period_lifecycle.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function notifications_official_risk_visibility_clause(): string {
    return " AND NOT (
        (
            n.notification_type = 'Risk Flag'
            AND n.reference_table IN ('risk_assessment', 'risk_assessments')
            AND EXISTS (
                SELECT 1
                FROM risk_assessments risk_notice
                JOIN grading_periods risk_period
                  ON risk_period.grading_period_id = risk_notice.grading_period_id
                 AND risk_period.is_deleted = 0
                WHERE risk_notice.risk_assessment_id = n.reference_id
                  AND risk_notice.is_deleted = 0
                  AND risk_period.status <> 'Locked'
            )
        )
        OR (
            n.notification_type = 'Risk Flag'
            AND n.reference_table = 'risk_period_summary'
            AND EXISTS (
                SELECT 1
                FROM grading_periods risk_summary_period
                WHERE risk_summary_period.grading_period_id = n.reference_id
                  AND risk_summary_period.is_deleted = 0
                  AND risk_summary_period.status <> 'Locked'
            )
        )
    )";
}

$operation = $_GET['operation'] ?? '';
if ($operation === '') {
    $operation = 'getNotifications';
}

$session = auth_require();
$userId = (int)($session['user_id'] ?? 0);
try {
    sync_automatic_grading_period_statuses($conn);
} catch (Throwable $e) {
    error_log('Notification lifecycle sync failed: ' . $e->getMessage());
}
notifications_ensure_tables($conn);
notifications_sync_closed_risk_alerts($conn);
if (($session['role_key'] ?? '') === 'learners') {
    notifications_sync_learner_risk_alerts($conn, $userId);
}

try {
    switch ($operation) {
        case 'getNotifications':
            getNotifications($conn, $userId);
            break;
        case 'getUnreadCount':
            getUnreadCount($conn, $userId);
            break;
        case 'markRead':
            markRead($conn, $userId);
            break;
        case 'markAllRead':
            markAllRead($conn, $userId);
            break;
        case 'removeNotification':
            removeNotification($conn, $userId);
            break;
        default:
            respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error'], 500);
}

function getNotifications(PDO $conn, int $userId): void {
    global $session;
    if ((int)($_GET['sync_grade_monitoring'] ?? 0) === 1) {
        notifications_sync_grade_monitoring_alerts($conn, $userId, $session);
    }

    $limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 12;
    if ($limit <= 0) $limit = 12;
    if ($limit > 50) $limit = 50;

    $storedActorUserExpression = notifications_ensure_actor_column($conn) ? 'n.actor_user_id' : 'NULL';
    $actorUserExpression = "COALESCE(
        {$storedActorUserExpression},
        a.posted_by,
        CASE
            WHEN n.reference_table = 'account_deactivation_requests'
             AND n.title = 'Account deactivation requested'
            THEN security_request.user_id
            WHEN n.reference_table = 'account_deactivation_requests'
            THEN security_request.reviewed_by
            ELSE NULL
        END
    )";
    $securityVisibilityClause = !empty($session['is_main_device'])
        ? ''
        : " AND (n.reference_table IS NULL OR n.reference_table <> 'auth_session_devices')";
    $officialRiskVisibilityClause = notifications_official_risk_visibility_clause();

    $stmt = $conn->prepare(
        "SELECT n.notification_id, n.notification_type, n.title, n.message, n.is_read, n.read_at, n.reference_table, n.reference_id, n.created_at,
                COALESCE(announcement_reports.report_count, 0) AS report_count,
                {$actorUserExpression} AS actor_user_id,
                actor_identity.username AS actor_username,
                COALESCE(actor_employee.first_name, actor_learner.first_name) AS actor_first_name,
                COALESCE(actor_employee.last_name, actor_learner.last_name) AS actor_last_name,
                COALESCE(actor_employee.gender, actor_learner.gender) AS actor_gender
         FROM notifications n
         LEFT JOIN announcements a
           ON (n.reference_table = 'announcements' AND n.reference_id = a.announcement_id)
         LEFT JOIN account_deactivation_requests security_request
           ON (n.reference_table = 'account_deactivation_requests' AND n.reference_id = security_request.request_id)
         LEFT JOIN (
             SELECT announcement_id, COUNT(DISTINCT user_id) AS report_count
             FROM announcement_user_actions
             WHERE action_type = 'reported'
             GROUP BY announcement_id
         ) announcement_reports
           ON (n.reference_table = 'announcements' AND n.reference_id = announcement_reports.announcement_id)
         LEFT JOIN (" . user_identity_derived_sql() . ") actor_identity
           ON actor_identity.user_id = {$actorUserExpression}
         LEFT JOIN employees actor_employee
           ON actor_employee.user_id = actor_identity.user_id AND actor_employee.is_deleted = 0
         LEFT JOIN learners actor_learner
           ON actor_learner.user_id = actor_identity.user_id AND actor_learner.is_deleted = 0
         WHERE n.user_id = :uid AND n.is_deleted = 0
           {$securityVisibilityClause}
           {$officialRiskVisibilityClause}
           AND NOT EXISTS (
               SELECT 1
               FROM announcements own_a
               WHERE n.notification_type = 'Announcement'
                 AND n.reference_table = 'announcements'
                 AND own_a.announcement_id = n.reference_id
                 AND own_a.posted_by = n.user_id
                 AND own_a.title = n.title
                 AND own_a.body = n.message
           )
         ORDER BY n.created_at DESC, n.notification_id DESC
         LIMIT :lim"
    );
    $stmt->bindValue(':uid', $userId, PDO::PARAM_INT);
    $stmt->bindValue(':lim', $limit, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $c = $conn->prepare(
        "SELECT COUNT(*)
         FROM notifications n
         WHERE n.user_id = :uid AND n.is_read = 0 AND n.is_deleted = 0
           {$securityVisibilityClause}
           {$officialRiskVisibilityClause}
           AND NOT EXISTS (
               SELECT 1
               FROM announcements own_a
               WHERE n.notification_type = 'Announcement'
                 AND n.reference_table = 'announcements'
                 AND own_a.announcement_id = n.reference_id
                 AND own_a.posted_by = n.user_id
                 AND own_a.title = n.title
                 AND own_a.body = n.message
           )"
    );
    $c->bindValue(':uid', $userId, PDO::PARAM_INT);
    $c->execute();
    $unread = (int)$c->fetchColumn();

    respond([
        'success' => true,
        'data' => [
            'unread_count' => $unread,
            'notifications' => $rows
        ]
    ]);
}

function getUnreadCount(PDO $conn, int $userId): void {
    global $session;
    if ((int)($_GET['sync_grade_monitoring'] ?? 0) === 1) {
        notifications_sync_grade_monitoring_alerts($conn, $userId, $session);
    }

    $securityVisibilityClause = !empty($session['is_main_device'])
        ? ''
        : " AND (n.reference_table IS NULL OR n.reference_table <> 'auth_session_devices')";
    $officialRiskVisibilityClause = notifications_official_risk_visibility_clause();
    $stmt = $conn->prepare(
        "SELECT COUNT(*)
         FROM notifications n
         WHERE n.user_id = :uid AND n.is_read = 0 AND n.is_deleted = 0
           {$securityVisibilityClause}
           {$officialRiskVisibilityClause}
           AND NOT EXISTS (
               SELECT 1
               FROM announcements own_a
               WHERE n.notification_type = 'Announcement'
                 AND n.reference_table = 'announcements'
                 AND own_a.announcement_id = n.reference_id
                 AND own_a.posted_by = n.user_id
                 AND own_a.title = n.title
                 AND own_a.body = n.message
           )"
    );
    $stmt->bindValue(':uid', $userId, PDO::PARAM_INT);
    $stmt->execute();
    respond(['success' => true, 'data' => ['count' => (int)$stmt->fetchColumn()]]);
}

function markRead(PDO $conn, int $userId): void {
    global $session;
    $data = getJsonInput();
    $notificationId = (int)($data['notification_id'] ?? 0);
    if ($notificationId <= 0) {
        respond(['success' => false, 'message' => 'notification_id required'], 422);
    }

    $stmt = $conn->prepare(
        'UPDATE notifications
         SET is_read = 1, read_at = NOW()
         WHERE notification_id = :id AND user_id = :uid AND is_deleted = 0
           AND (reference_table IS NULL OR reference_table <> \'auth_session_devices\' OR :is_main_device = 1)'
    );
    $stmt->bindValue(':id', $notificationId, PDO::PARAM_INT);
    $stmt->bindValue(':uid', $userId, PDO::PARAM_INT);
    $stmt->bindValue(':is_main_device', !empty($session['is_main_device']) ? 1 : 0, PDO::PARAM_INT);
    $stmt->execute();

    respond(['success' => true]);
}

function markAllRead(PDO $conn, int $userId): void {
    global $session;
    $stmt = $conn->prepare(
        'UPDATE notifications
         SET is_read = 1, read_at = NOW()
         WHERE user_id = :uid AND is_read = 0 AND is_deleted = 0
           AND (reference_table IS NULL OR reference_table <> \'auth_session_devices\' OR :is_main_device = 1)'
    );
    $stmt->bindValue(':uid', $userId, PDO::PARAM_INT);
    $stmt->bindValue(':is_main_device', !empty($session['is_main_device']) ? 1 : 0, PDO::PARAM_INT);
    $stmt->execute();
    respond(['success' => true]);
}

function removeNotification(PDO $conn, int $userId): void {
    global $session;
    $data = getJsonInput();
    $notificationId = (int)($data['notification_id'] ?? 0);
    if ($notificationId <= 0) {
        respond(['success' => false, 'message' => 'notification_id required'], 422);
    }

    // Soft-delete only this user's notification. The original record remains
    // available for auditing while disappearing from future notification feeds.
    $stmt = $conn->prepare(
        'UPDATE notifications
         SET is_deleted = 1, deleted_at = NOW()
         WHERE notification_id = :id AND user_id = :uid AND is_deleted = 0
           AND (reference_table IS NULL OR reference_table <> \'auth_session_devices\' OR :is_main_device = 1)'
    );
    $stmt->bindValue(':id', $notificationId, PDO::PARAM_INT);
    $stmt->bindValue(':uid', $userId, PDO::PARAM_INT);
    $stmt->bindValue(':is_main_device', !empty($session['is_main_device']) ? 1 : 0, PDO::PARAM_INT);
    $stmt->execute();

    respond(['success' => true]);
}
?>
