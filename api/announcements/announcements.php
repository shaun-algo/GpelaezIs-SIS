<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';
require_once __DIR__ . '/../utils/notifications.php';
require_once __DIR__ . '/../utils/audit.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function requireAnnouncementOwner(PDO $conn, int $announcementId, int $userId, array $session): void {
    // Admins can manage any announcement.
    if (auth_is_admin($session)) {
        return;
    }

    $stmt = $conn->prepare('SELECT posted_by FROM announcements WHERE announcement_id = :announcement_id AND is_deleted = 0');
    $stmt->bindValue(':announcement_id', $announcementId, PDO::PARAM_INT);
    $stmt->execute();
    $postedBy = $stmt->fetchColumn();

    if (!$postedBy) {
        respond(['success' => false, 'message' => 'Announcement not found'], 404);
    }

    if ((int)$postedBy !== $userId) {
        respond(['success' => false, 'message' => 'Not authorized to modify this announcement'], 403);
    }
}

function getJsonInput(): array {
    $raw = file_get_contents('php://input');
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

function normalize_nullable_datetime($value): ?string {
    if ($value === null) {
        return null;
    }
    $raw = trim((string)$value);
    if ($raw === '') {
        return null;
    }

    // HTML datetime-local: YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS
    if (preg_match('/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/', $raw, $m)) {
        $seconds = isset($m[3]) && $m[3] !== '' ? $m[3] : '00';
        return $m[1] . ' ' . $m[2] . ':' . $seconds;
    }

    // SQL datetime without seconds: YYYY-MM-DD HH:MM
    if (preg_match('/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/', $raw, $m)) {
        return $m[1] . ' ' . $m[2] . ':00';
    }

    return $raw;
}

function normalize_announcement_background($value): ?string {
    $raw = trim((string)($value ?? ''));
    if ($raw === '') return null;

    $presets = [
        '#ffffff',
        'linear-gradient(135deg, #3e5870 0%, #7e9bb8 100%)',
        'linear-gradient(135deg, #294d3b 0%, #6e9b7a 100%)',
        'linear-gradient(135deg, #6f4d2d 0%, #b68a54 100%)',
        'linear-gradient(135deg, #6e3545 0%, #b87887 100%)',
        'linear-gradient(135deg, #4b3b72 0%, #8974bd 100%)',
    ];
    foreach ($presets as $preset) {
        if (strcasecmp($raw, $preset) === 0) return $preset;
    }

    // Preserve legacy saved gradients while keeping CSS values constrained.
    if (preg_match('/^linear-gradient\(\s*(\d{1,3})deg,\s*(#[0-9a-f]{6})\s+0%,\s*(#[0-9a-f]{6})\s+100%\s*\)$/i', $raw, $match)) {
        $angle = min(360, max(0, (int)$match[1]));
        return sprintf(
            'linear-gradient(%ddeg, %s 0%%, %s 100%%)',
            $angle,
            strtolower($match[2]),
            strtolower($match[3])
        );
    }

    return null;
}

$operation = $_GET['operation'] ?? '';
$session = in_array($operation, ['hideAnnouncement', 'reportAnnouncement'], true)
    ? auth_require_roles(['admin', 'teacher', 'registrar', 'learners'])
    : auth_enforce_roles($operation, ['admin', 'teacher', 'registrar', 'learners'], ['admin', 'teacher', 'registrar']);

if (in_array($operation, ['getAnnouncementReports', 'resolveAnnouncementReports'], true)) {
    $session = auth_require_roles(['admin']);
}
try {
    switch ($operation) {
        case 'getAllAnnouncements': getAllAnnouncements($conn); break;
        case 'getAnnouncement': getAnnouncement($conn); break;
        case 'createAnnouncement': createAnnouncement($conn); break;
        case 'updateAnnouncement': updateAnnouncement($conn); break;
        case 'deleteAnnouncement': deleteAnnouncement($conn); break;
        case 'pinAnnouncement': pinAnnouncement($conn); break;
        case 'hideAnnouncement': hideAnnouncement($conn); break;
        case 'reportAnnouncement': reportAnnouncement($conn); break;
        case 'getAnnouncementReports': getAnnouncementReports($conn, $session); break;
        case 'resolveAnnouncementReports': resolveAnnouncementReports($conn, $session); break;
        default: respond(['success' => false, 'message' => 'Invalid operation'], 400);
    }
} catch (Exception $e) {
    respond(['success' => false, 'message' => 'Server error: ' . $e->getMessage()], 500);
}

function getAllAnnouncements(PDO $conn): void {
    $viewerRoleId = isset($_SESSION['role_id']) ? (int)$_SESSION['role_id'] : 0;
    $viewerRoleName = (string)($_SESSION['role_name'] ?? '');
    $isAdmin = auth_normalize_role($viewerRoleName) === 'admin';
    $viewerUserId = isset($_SESSION['user_id']) ? (int)$_SESSION['user_id'] : 0;

        $sql = "SELECT a.announcement_id, a.title, a.body, a.posted_by, a.target_role_id,
                 a.published_at, a.expires_at, a.is_pinned, a.message_background,
             u.username AS posted_by_name,
             u.last_login,
             u.last_seen_at,
             TIMESTAMPDIFF(SECOND, u.last_seen_at, NOW()) AS last_seen_seconds_ago,
             TIMESTAMPDIFF(SECOND, u.last_login, NOW()) AS last_login_seconds_ago,
             CASE WHEN u.last_seen_at IS NOT NULL
                        AND u.last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
                  THEN 1 ELSE 0 END AS is_online,
             e.first_name, e.last_name, e.gender,
             profile_position.position_name,
                 r.role_name AS target_role_name,
                 CASE WHEN :viewer_user_id > 0 AND a.posted_by = :viewer_user_id_owner THEN 1 ELSE 0 END AS is_owner,
                 TIMESTAMPDIFF(SECOND, a.published_at, NOW()) as seconds_ago
            FROM announcements a
            LEFT JOIN (" . user_identity_derived_sql() . ") u ON a.posted_by = u.user_id
         LEFT JOIN employees e ON e.user_id = u.user_id AND e.is_deleted = 0
         LEFT JOIN positions profile_position
                ON profile_position.position_id = e.position_id
               AND profile_position.is_deleted = 0
            LEFT JOIN roles r ON a.target_role_id = r.role_id
            LEFT JOIN announcement_user_actions hidden_action
                   ON hidden_action.announcement_id = a.announcement_id
                  AND hidden_action.user_id = :viewer_user_id_hidden
                  AND hidden_action.action_type = 'hidden'
            WHERE a.is_deleted = 0";

    // Visibility filter:
    // - Not logged in: only show announcements for all roles (NULL/0).
    // - Admin: show everything.
    // - Otherwise: show announcements for all roles (NULL/0) + targeted to viewer role_id.
    // Note: PDO (with emulation disabled) does not allow reusing the same named placeholder twice.
    $params = [
        ':viewer_user_id' => $viewerUserId,
        ':viewer_user_id_owner' => $viewerUserId,
        ':viewer_user_id_hidden' => $viewerUserId
    ];
    if (empty($_SESSION['user_id'])) {
        $sql .= " AND (a.target_role_id IS NULL OR a.target_role_id = 0)";
    } elseif (!$isAdmin) {
        $sql .= " AND (a.target_role_id IS NULL OR a.target_role_id = 0 OR a.target_role_id = :viewer_role_id)";
        $params[':viewer_role_id'] = $viewerRoleId;
    }

    $sql .= " AND hidden_action.announcement_user_action_id IS NULL";

    $sql .= "
            ORDER BY a.is_pinned DESC, a.announcement_id DESC";
    $stmt = $conn->prepare($sql);
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, PDO::PARAM_INT);
    }
    $stmt->execute();
    respond($stmt->fetchAll(PDO::FETCH_ASSOC));
}

function getAnnouncement(PDO $conn): void {
    $id = $_GET['id'] ?? null;
    if (!$id) {
        respond(['success' => false, 'message' => 'Announcement ID required'], 422);
    }

    $viewerRoleId = isset($_SESSION['role_id']) ? (int)$_SESSION['role_id'] : 0;
    $viewerRoleName = (string)($_SESSION['role_name'] ?? '');
    $isAdmin = auth_normalize_role($viewerRoleName) === 'admin';
    $viewerUserId = isset($_SESSION['user_id']) ? (int)$_SESSION['user_id'] : 0;

		$sql = "SELECT a.*, u.username AS posted_by_name, u.last_login, u.last_seen_at,
		               TIMESTAMPDIFF(SECOND, u.last_seen_at, NOW()) AS last_seen_seconds_ago,
		               TIMESTAMPDIFF(SECOND, u.last_login, NOW()) AS last_login_seconds_ago,
		               CASE WHEN u.last_seen_at IS NOT NULL
		                          AND u.last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
		                    THEN 1 ELSE 0 END AS is_online,
		               e.first_name, e.last_name, e.gender,
                       profile_position.position_name,
                   r.role_name AS target_role_name,
                                     CASE WHEN :viewer_user_id > 0 AND a.posted_by = :viewer_user_id_owner THEN 1 ELSE 0 END AS is_owner
            FROM announcements a
            LEFT JOIN (" . user_identity_derived_sql() . ") u ON a.posted_by = u.user_id
            LEFT JOIN employees e ON e.user_id = u.user_id AND e.is_deleted = 0
            LEFT JOIN positions profile_position
                   ON profile_position.position_id = e.position_id
                  AND profile_position.is_deleted = 0
            LEFT JOIN roles r ON a.target_role_id = r.role_id
            LEFT JOIN announcement_user_actions hidden_action
                   ON hidden_action.announcement_id = a.announcement_id
                  AND hidden_action.user_id = :viewer_user_id_hidden
                  AND hidden_action.action_type = 'hidden'
            WHERE a.announcement_id = :id AND a.is_deleted = 0";

        $params = [
                ':id' => (int)$id,
                ':viewer_user_id' => $viewerUserId,
                ':viewer_user_id_owner' => $viewerUserId,
                ':viewer_user_id_hidden' => $viewerUserId
        ];
    if (empty($_SESSION['user_id'])) {
        $sql .= " AND (a.target_role_id IS NULL OR a.target_role_id = 0)";
    } elseif (!$isAdmin) {
        $sql .= " AND (a.target_role_id IS NULL OR a.target_role_id = 0 OR a.target_role_id = :viewer_role_id)";
        $params[':viewer_role_id'] = $viewerRoleId;
    }
    $sql .= " AND hidden_action.announcement_user_action_id IS NULL";
    $stmt = $conn->prepare($sql);
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, PDO::PARAM_INT);
    }
    $stmt->execute();
    $result = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($result) {
        respond(['success' => true, 'data' => $result]);
    } else {
        respond(['success' => false, 'message' => 'Announcement not found'], 404);
    }
}

function createAnnouncement(PDO $conn): void {
    $data = getJsonInput();
    $userId = (int)($_SESSION['user_id'] ?? 0);
    if (empty($data['title']) || empty($data['body'])) {
        respond(['success' => false, 'message' => 'Title and body are required'], 422);
    }

    $rawBackground = $data['message_background'] ?? null;
    $messageBackground = normalize_announcement_background($rawBackground);
    if ($rawBackground !== null && trim((string)$rawBackground) !== '' && $messageBackground === null) {
        respond(['success' => false, 'message' => 'Invalid announcement background'], 422);
    }
    $messageBackground = $messageBackground ?? '#ffffff';

    $targetRoleId = null;
    if (array_key_exists('target_role_id', $data)) {
        $rawTargetRoleId = $data['target_role_id'];
        if ($rawTargetRoleId === '' || $rawTargetRoleId === 0 || $rawTargetRoleId === '0') {
            $targetRoleId = null;
        } elseif ($rawTargetRoleId === null) {
            $targetRoleId = null;
        } else {
            $targetRoleId = (int)$rawTargetRoleId;
        }
    }

        $sql = 'INSERT INTO announcements (title, body, posted_by, target_role_id, published_at, expires_at, is_pinned, message_background)
            VALUES (:title, :body, :posted_by, :target_role_id, COALESCE(:published_at, NOW()), :expires_at, :is_pinned, :message_background)';
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':title', $data['title']);
    $stmt->bindValue(':body', $data['body']);
    $stmt->bindValue(':posted_by', $userId, PDO::PARAM_INT);
    if ($targetRoleId === null) {
        $stmt->bindValue(':target_role_id', null, PDO::PARAM_NULL);
    } else {
        $stmt->bindValue(':target_role_id', $targetRoleId, PDO::PARAM_INT);
    }
    $publishedAt = normalize_nullable_datetime($data['published_at'] ?? null);
    if ($publishedAt === null) {
        $stmt->bindValue(':published_at', null, PDO::PARAM_NULL);
    } else {
        $stmt->bindValue(':published_at', $publishedAt);
    }

    $expiresAt = normalize_nullable_datetime($data['expires_at'] ?? null);
    if ($expiresAt === null) {
        $stmt->bindValue(':expires_at', null, PDO::PARAM_NULL);
    } else {
        $stmt->bindValue(':expires_at', $expiresAt);
    }
    $stmt->bindValue(':is_pinned', $data['is_pinned'] ?? 0, PDO::PARAM_INT);
    $stmt->bindValue(':message_background', $messageBackground, PDO::PARAM_STR);
    $stmt->execute();

    $announcementId = $conn->lastInsertId();

    // Audit log
    audit_log($conn, 'announcements', (int)$announcementId, 'INSERT', null, [
        'announcement_id' => (int)$announcementId,
        'title' => $data['title'],
        'target_role_id' => $targetRoleId,
        'is_pinned' => $data['is_pinned'] ?? 0,
        'message_background' => $messageBackground,
    ]);

    // Create in-app notifications for recipients.
    try {
        $title = (string)$data['title'];
        $message = (string)$data['body'];
        if ($targetRoleId === null) {
            // Do not create an announcement notification for the user who posted it.
            notifications_create_broadcast($conn, 'Announcement', $title, $message, 'announcements', (int)$announcementId, $userId, null, $userId);
        } else {
            notifications_create_for_role($conn, (int)$targetRoleId, 'Announcement', $title, $message, 'announcements', (int)$announcementId, $userId, null, $userId);
        }
    } catch (Exception $e) {
        // Never block announcement creation if notifications fail.
    }

    // Fetch the newly created announcement with seconds_ago for accurate timestamp
    $fetchSql = "SELECT a.*, u.username AS posted_by_name, u.last_login, u.last_seen_at,
                        TIMESTAMPDIFF(SECOND, u.last_seen_at, NOW()) AS last_seen_seconds_ago,
                        TIMESTAMPDIFF(SECOND, u.last_login, NOW()) AS last_login_seconds_ago,
                        CASE WHEN u.last_seen_at IS NOT NULL
                                   AND u.last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
                             THEN 1 ELSE 0 END AS is_online,
                        e.first_name, e.last_name, e.gender,
                        r.role_name AS target_role_name,
                        TIMESTAMPDIFF(SECOND, a.published_at, NOW()) as seconds_ago
                 FROM announcements a
                 LEFT JOIN (" . user_identity_derived_sql() . ") u ON a.posted_by = u.user_id
                 LEFT JOIN employees e ON e.user_id = u.user_id AND e.is_deleted = 0
                 LEFT JOIN roles r ON a.target_role_id = r.role_id
                 WHERE a.announcement_id = :id";
    $fetchStmt = $conn->prepare($fetchSql);
    $fetchStmt->bindValue(':id', $announcementId, PDO::PARAM_INT);
    $fetchStmt->execute();
    $newAnnouncement = $fetchStmt->fetch(PDO::FETCH_ASSOC);

    respond(['success' => true, 'message' => 'Announcement created.', 'announcement' => $newAnnouncement]);
}

function updateAnnouncement(PDO $conn): void {
    $userId = (int)($_SESSION['user_id'] ?? 0);
    $data = getJsonInput();
    if (empty($data['announcement_id']) || empty($data['title']) || empty($data['body'])) {
        respond(['success' => false, 'message' => 'Announcement ID, title, and body are required'], 422);
    }

    $targetRoleId = null;
    if (array_key_exists('target_role_id', $data)) {
        $rawTargetRoleId = $data['target_role_id'];
        if ($rawTargetRoleId === '' || $rawTargetRoleId === 0 || $rawTargetRoleId === '0') {
            $targetRoleId = null;
        } elseif ($rawTargetRoleId === null) {
            $targetRoleId = null;
        } else {
            $targetRoleId = (int)$rawTargetRoleId;
        }
    }

    requireAnnouncementOwner($conn, (int)$data['announcement_id'], $userId, auth_require());

    $setClauses = [
        'title = :title',
        'body = :body',
        'target_role_id = :target_role_id',
        'expires_at = :expires_at',
    ];

    $messageBackground = null;
    if (array_key_exists('message_background', $data)) {
        $rawBackground = $data['message_background'];
        $messageBackground = normalize_announcement_background($rawBackground);
        if ($rawBackground !== null && trim((string)$rawBackground) !== '' && $messageBackground === null) {
            respond(['success' => false, 'message' => 'Invalid announcement background'], 422);
        }
        $messageBackground = $messageBackground ?? '#ffffff';
        $setClauses[] = 'message_background = :message_background';
    }

    // Only update attachment_url if the client explicitly sends it.
    if (array_key_exists('attachment_url', $data)) {
        $setClauses[] = 'attachment_url = :attachment_url';
    }

    // Allow editing pinned state from the same edit flow.
    if (array_key_exists('is_pinned', $data)) {
        $setClauses[] = 'is_pinned = :is_pinned';
    }

    $sql = 'UPDATE announcements SET ' . implode(', ', $setClauses) . ' WHERE announcement_id = :announcement_id';
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':title', $data['title']);
    $stmt->bindValue(':body', $data['body']);
    if ($targetRoleId === null) {
        $stmt->bindValue(':target_role_id', null, PDO::PARAM_NULL);
    } else {
        $stmt->bindValue(':target_role_id', $targetRoleId, PDO::PARAM_INT);
    }
    $expiresAt = normalize_nullable_datetime($data['expires_at'] ?? null);
    if ($expiresAt === null) {
        $stmt->bindValue(':expires_at', null, PDO::PARAM_NULL);
    } else {
        $stmt->bindValue(':expires_at', $expiresAt);
    }

    if (array_key_exists('attachment_url', $data)) {
        $attachmentUrl = $data['attachment_url'];
        if ($attachmentUrl === '') {
            $attachmentUrl = null;
        }
        $stmt->bindValue(':attachment_url', $attachmentUrl);
    }

    if (array_key_exists('is_pinned', $data)) {
        $stmt->bindValue(':is_pinned', (int)$data['is_pinned'], PDO::PARAM_INT);
    }

    if (array_key_exists('message_background', $data)) {
        $stmt->bindValue(':message_background', $messageBackground, PDO::PARAM_STR);
    }

    $stmt->bindValue(':announcement_id', $data['announcement_id'], PDO::PARAM_INT);
    $stmt->execute();

    // Audit log
    $oldRow = audit_fetch_old($conn, 'announcements', 'announcement_id', (int)$data['announcement_id']);
    audit_log($conn, 'announcements', (int)$data['announcement_id'], 'UPDATE', $oldRow, [
        'title' => $data['title'],
        'target_role_id' => $targetRoleId,
        'is_pinned' => $data['is_pinned'] ?? 0,
        'message_background' => $messageBackground,
    ]);

    respond(['success' => true, 'message' => 'Announcement updated.']);
}

function deleteAnnouncement(PDO $conn): void {
    $userId = (int)($_SESSION['user_id'] ?? 0);
    $data = getJsonInput();
    $announcementId = (int)($data['announcement_id'] ?? 0);
    if ($announcementId <= 0) {
        respond(['success' => false, 'message' => 'Announcement ID is required'], 422);
    }

    $session = auth_require();
    requireAnnouncementOwner($conn, $announcementId, $userId, $session);
    // Read before the soft delete. audit_fetch_old() intentionally ignores
    // deleted rows, and the owner/title are also needed for the notification.
    $oldRow = audit_fetch_old($conn, 'announcements', 'announcement_id', $announcementId);
    if (!$oldRow) {
        respond(['success' => false, 'message' => 'Announcement not found'], 404);
    }

    $stmt = $conn->prepare('UPDATE announcements SET is_deleted = 1, deleted_at = NOW() WHERE announcement_id = :announcement_id');
    $stmt->bindValue(':announcement_id', $announcementId, PDO::PARAM_INT);
    $stmt->execute();

    $ownerId = (int)($oldRow['posted_by'] ?? 0);
    $isAdminRemoval = auth_is_admin($session) && $ownerId !== $userId;
    audit_log_event($conn, 'DELETE', 'SUCCESS', [
        'event_type' => 'CONTENT_MODERATION',
        'table_name' => 'announcements',
        'record_id' => $announcementId,
        'target_type' => 'post',
        'reason_code' => $isAdminRemoval ? 'POST_REMOVED_AFTER_REPORT' : 'POST_REMOVED_BY_OWNER',
        'actor_user_id' => $userId,
        'old_values' => $oldRow,
        'metadata' => [
            'removed_from_feed' => true,
            'post_title' => trim((string)($oldRow['title'] ?? '')),
        ],
    ]);

    if ($isAdminRemoval && $ownerId > 0) {
        try {
            $title = trim((string)($oldRow['title'] ?? 'Untitled post')) ?: 'Untitled post';
            notifications_create_for_user(
                $conn,
                $ownerId,
                'Announcement',
                'Your post was removed',
                'Your post “' . $title . '” was removed from the school feed after a community report.',
                'announcements',
                $announcementId,
                0,
                $userId
            );
        } catch (Throwable $e) {
            // The removal and audit record must remain successful if a notice
            // cannot be created.
        }
    }

    respond(['success' => true, 'message' => 'Announcement deleted.']);
}

function pinAnnouncement(PDO $conn): void {
    $userId = (int)($_SESSION['user_id'] ?? 0);
    $data = getJsonInput();
    if (empty($data['announcement_id'])) {
        respond(['success' => false, 'message' => 'Announcement ID is required'], 422);
    }

    requireAnnouncementOwner($conn, (int)$data['announcement_id'], $userId, auth_require());

    $isPinned = $data['is_pinned'] ?? 1;
    $stmt = $conn->prepare('UPDATE announcements SET is_pinned = :is_pinned WHERE announcement_id = :announcement_id');
    $stmt->bindValue(':is_pinned', $isPinned, PDO::PARAM_INT);
    $stmt->bindValue(':announcement_id', $data['announcement_id'], PDO::PARAM_INT);
    $stmt->execute();

    $message = $isPinned ? 'Announcement pinned.' : 'Announcement unpinned.';
    respond(['success' => true, 'message' => $message]);
}

function getAnnouncementFeedbackOptions(string $actionType): array {
    if ($actionType === 'hidden') {
        return [
            'not_relevant' => 'This post is not relevant to me',
            'already_seen' => 'I have already seen this',
            'too_frequent' => 'I am seeing too many similar posts',
            'other' => 'Other'
        ];
    }

    return [
        'inappropriate' => 'Inappropriate or unsafe content',
        'harassment' => 'Harassment or a personal attack',
        'spam' => 'Spam or misleading information',
        'privacy' => 'Personal or private information',
        'other' => 'Other'
    ];
}

function recordAnnouncementUserAction(PDO $conn, string $actionType): void {
    $userId = (int)($_SESSION['user_id'] ?? 0);
    $data = getJsonInput();
    $announcementId = (int)($data['announcement_id'] ?? 0);
    if ($userId <= 0 || $announcementId <= 0) {
        respond(['success' => false, 'message' => 'Announcement ID is required'], 422);
    }

    $check = $conn->prepare('SELECT announcement_id, posted_by, title FROM announcements WHERE announcement_id = :announcement_id AND is_deleted = 0 LIMIT 1');
    $check->bindValue(':announcement_id', $announcementId, PDO::PARAM_INT);
    $check->execute();
    $announcement = $check->fetch(PDO::FETCH_ASSOC);
    if (!$announcement) {
        respond(['success' => false, 'message' => 'Announcement not found'], 404);
    }
    $postedBy = (int)($announcement['posted_by'] ?? 0);
    if ((int)$postedBy === $userId) {
        respond(['success' => false, 'message' => 'You cannot apply this action to your own announcement'], 403);
    }

    $options = getAnnouncementFeedbackOptions($actionType);
    $reasonCode = trim((string)($data['reason_code'] ?? ''));
    if (!array_key_exists($reasonCode, $options)) {
        respond(['success' => false, 'message' => 'Please select a reason'], 422);
    }

    $reasonDetails = trim((string)($data['reason_details'] ?? ''));
    if ($reasonCode === 'other' && $reasonDetails === '') {
        respond(['success' => false, 'message' => 'Please specify the reason'], 422);
    }
    if (strlen($reasonDetails) > 420) {
        $reasonDetails = substr($reasonDetails, 0, 420);
    }

    $reason = $options[$reasonCode];
    if ($reasonDetails !== '') {
        $reason .= ': ' . $reasonDetails;
    }
    if (strlen($reason) > 500) {
        $reason = substr($reason, 0, 500);
    }

    $existingActionStmt = $conn->prepare(
        'SELECT report_reason
         FROM announcement_user_actions
         WHERE announcement_id = :announcement_id
           AND user_id = :user_id
           AND action_type = :action_type
         LIMIT 1'
    );
    $existingActionStmt->bindValue(':announcement_id', $announcementId, PDO::PARAM_INT);
    $existingActionStmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $existingActionStmt->bindValue(':action_type', $actionType);
    $existingActionStmt->execute();
    $existingReason = $existingActionStmt->fetchColumn();
    $isNewOrChangedAction = $existingReason === false || (string)$existingReason !== $reason;

    $stmt = $conn->prepare(
        'INSERT INTO announcement_user_actions (announcement_id, user_id, action_type, report_reason)
         VALUES (:announcement_id, :user_id, :action_type, :report_reason)
         ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP, report_reason = VALUES(report_reason)'
    );
    $stmt->bindValue(':announcement_id', $announcementId, PDO::PARAM_INT);
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $stmt->bindValue(':action_type', $actionType);
    $stmt->bindValue(':report_reason', $reason !== '' ? $reason : null, $reason !== '' ? PDO::PARAM_STR : PDO::PARAM_NULL);
    $stmt->execute();

    if ($isNewOrChangedAction) {
        audit_log_event($conn, $actionType === 'reported' ? 'REPORT' : 'HIDE', 'SUCCESS', [
            'event_type' => 'CONTENT_MODERATION',
            'table_name' => 'announcements',
            'record_id' => $announcementId,
            'target_type' => 'post',
            'reason_code' => $actionType === 'reported' ? 'POST_REPORTED' : 'POST_HIDDEN',
            'actor_user_id' => $userId,
            'old_values' => [
                'title' => trim((string)($announcement['title'] ?? '')),
                'posted_by' => $postedBy,
            ],
            'metadata' => [
                'feedback_type' => $actionType,
                'reason_code' => $reasonCode,
                'reason_label' => $options[$reasonCode],
            ],
        ]);
    }

    if ($actionType === 'reported' && $isNewOrChangedAction) {
        $reopenReviewStmt = $conn->prepare(
            'DELETE FROM announcement_report_reviews WHERE announcement_id = :announcement_id'
        );
        $reopenReviewStmt->bindValue(':announcement_id', $announcementId, PDO::PARAM_INT);
        $reopenReviewStmt->execute();
    }

    if ($actionType === 'reported' && $isNewOrChangedAction) {
        try {
            $announcementTitleStmt = $conn->prepare('SELECT title FROM announcements WHERE announcement_id = :announcement_id LIMIT 1');
            $announcementTitleStmt->bindValue(':announcement_id', $announcementId, PDO::PARAM_INT);
            $announcementTitleStmt->execute();
            $announcementTitle = trim((string)($announcementTitleStmt->fetchColumn() ?: 'Untitled post'));
            $adminRoleId = notifications_get_role_id($conn, 'admin');
            $ownerRoleId = null;
            if ($postedBy > 0) {
                $ownerRoleStmt = $conn->prepare(
                    'SELECT role_id
                     FROM (' . user_identity_derived_sql() . ') notification_owner
                     WHERE user_id = :user_id
                     LIMIT 1'
                );
                $ownerRoleStmt->bindValue(':user_id', $postedBy, PDO::PARAM_INT);
                $ownerRoleStmt->execute();
                $ownerRoleId = (int)($ownerRoleStmt->fetchColumn() ?: 0);
            }
            if ($adminRoleId !== null) {
                notifications_create_for_role(
                    $conn,
                    $adminRoleId,
                    'Announcement',
                    'Post report needs review',
                    'A user reported the post.',
                    'announcements',
                    $announcementId,
                    $ownerRoleId === $adminRoleId && $postedBy > 0 ? $postedBy : $userId,
                    null,
                    $userId
                );
            }
            if ($postedBy > 0) {
                notifications_create_for_user(
                    $conn,
                    $postedBy,
                    'Announcement',
                    'Your post needs review',
                    'A user reported your post.',
                    'announcements',
                    $announcementId,
                    0,
                    $userId
                );
            }
        } catch (Exception $e) {
            // Feedback is already saved. A notification failure must not block it.
        }
    }

    respond([
        'success' => true,
        'message' => $actionType === 'hidden' ? 'Announcement hidden.' : 'Announcement reported.',
        'reason_label' => $options[$reasonCode]
    ]);
}

function hideAnnouncement(PDO $conn): void {
    recordAnnouncementUserAction($conn, 'hidden');
}

function reportAnnouncement(PDO $conn): void {
    recordAnnouncementUserAction($conn, 'reported');
}

function resolveAnnouncementReports(PDO $conn, array $session): void {
    if (!auth_is_admin($session)) {
        respond(['success' => false, 'message' => 'Not authorized'], 403);
    }

    $data = getJsonInput();
    $announcementId = (int)($data['announcement_id'] ?? 0);
    $resolution = trim((string)($data['resolution'] ?? ''));
    if ($announcementId <= 0 || $resolution !== 'no_issue') {
        respond(['success' => false, 'message' => 'A valid post and resolution are required'], 422);
    }

    $reportCheck = $conn->prepare(
        "SELECT a.announcement_id
         FROM announcements a
         INNER JOIN announcement_user_actions aua
                 ON aua.announcement_id = a.announcement_id
                AND aua.action_type = 'reported'
         WHERE a.announcement_id = :announcement_id
           AND a.is_deleted = 0
         LIMIT 1"
    );
    $reportCheck->bindValue(':announcement_id', $announcementId, PDO::PARAM_INT);
    $reportCheck->execute();
    if ($reportCheck->fetchColumn() === false) {
        respond(['success' => false, 'message' => 'Active reported post not found'], 404);
    }

    $reviewStmt = $conn->prepare(
        "INSERT INTO announcement_report_reviews (announcement_id, resolution, reviewed_by, reviewed_at)
         VALUES (:announcement_id, :resolution, :reviewed_by, NOW())
         ON DUPLICATE KEY UPDATE
             resolution = VALUES(resolution),
             reviewed_by = VALUES(reviewed_by),
             reviewed_at = NOW()"
    );
    $reviewStmt->bindValue(':announcement_id', $announcementId, PDO::PARAM_INT);
    $reviewStmt->bindValue(':resolution', $resolution, PDO::PARAM_STR);
    $reviewStmt->bindValue(':reviewed_by', (int)($session['user_id'] ?? 0), PDO::PARAM_INT);
    $reviewStmt->execute();

    audit_log_event($conn, 'REPORT_REVIEW', 'SUCCESS', [
        'event_type' => 'CONTENT_MODERATION',
        'table_name' => 'announcements',
        'record_id' => $announcementId,
        'target_type' => 'post',
        'reason_code' => 'REPORT_RESOLVED_NO_ISSUE',
        'actor_user_id' => (int)($session['user_id'] ?? 0),
        'metadata' => ['resolution' => $resolution],
    ]);

    respond([
        'success' => true,
        'message' => 'Report resolved. No issue was found.',
        'resolution' => $resolution
    ]);
}

function getAnnouncementReports(PDO $conn, array $session): void {
    if (!auth_is_admin($session)) {
        respond(['success' => false, 'message' => 'Not authorized'], 403);
    }

    $limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 100;
    $limit = max(1, min($limit, 250));
    $requestedView = (string)($_GET['view'] ?? 'active');
    $view = in_array($requestedView, ['removed', 'resolved'], true) ? $requestedView : 'active';
    $deletedState = $view === 'removed' ? 1 : 0;
    $reviewFilter = $view === 'active'
        ? 'AND report_review.announcement_id IS NULL'
        : ($view === 'resolved' ? 'AND report_review.announcement_id IS NOT NULL' : '');
    $limitClause = $view === 'active' ? " LIMIT {$limit}" : '';

    $sql = "SELECT
                aua.announcement_user_action_id AS report_id,
                aua.announcement_id,
                aua.user_id AS reporter_user_id,
                aua.action_type,
                aua.report_reason,
                aua.created_at AS reported_at,
                a.title,
                a.body,
                a.posted_by,
                a.published_at,
                a.expires_at,
                a.attachment_url,
                a.is_pinned,
                a.message_background,
                a.is_deleted,
                report_review.resolution AS review_resolution,
                report_review.reviewed_at,
                COALESCE(
                    NULLIF(TRIM(CONCAT_WS(' ', reporter_employee.first_name, reporter_employee.last_name)), ''),
                    NULLIF(TRIM(CONCAT_WS(' ', reporter_learner.first_name, reporter_learner.last_name)), ''),
                    reporter_identity.username,
                    CONCAT('User #', aua.user_id)
                ) AS reporter_name,
                COALESCE(reporter_employee.gender, reporter_learner.gender) AS reporter_gender,
                reporter_identity.last_login AS reporter_last_login,
                reporter_identity.last_seen_at AS reporter_last_seen_at,
                TIMESTAMPDIFF(SECOND, reporter_identity.last_seen_at, NOW()) AS reporter_last_seen_seconds_ago,
                TIMESTAMPDIFF(SECOND, reporter_identity.last_login, NOW()) AS reporter_last_login_seconds_ago,
                CASE WHEN reporter_identity.last_seen_at IS NOT NULL
                           AND reporter_identity.last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
                     THEN 1 ELSE 0 END AS reporter_is_online,
                COALESCE(
                    NULLIF(TRIM(CONCAT_WS(' ', poster_employee.first_name, poster_employee.last_name)), ''),
                    NULLIF(TRIM(CONCAT_WS(' ', poster_learner.first_name, poster_learner.last_name)), ''),
                    poster_identity.username,
                    CONCAT('User #', a.posted_by)
                ) AS poster_name,
                COALESCE(poster_employee.gender, poster_learner.gender) AS poster_gender,
                poster_identity.last_login AS poster_last_login,
                poster_identity.last_seen_at AS poster_last_seen_at,
                TIMESTAMPDIFF(SECOND, poster_identity.last_seen_at, NOW()) AS poster_last_seen_seconds_ago,
                TIMESTAMPDIFF(SECOND, poster_identity.last_login, NOW()) AS poster_last_login_seconds_ago,
                CASE WHEN poster_identity.last_seen_at IS NOT NULL
                           AND poster_identity.last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
                     THEN 1 ELSE 0 END AS poster_is_online,
                poster_target_role.role_name AS target_role_name
            FROM announcement_user_actions aua
            INNER JOIN announcements a ON a.announcement_id = aua.announcement_id
            LEFT JOIN announcement_report_reviews report_review
                   ON report_review.announcement_id = a.announcement_id
            LEFT JOIN (" . user_identity_derived_sql() . ") reporter_identity ON reporter_identity.user_id = aua.user_id
            LEFT JOIN employees reporter_employee
                   ON reporter_employee.user_id = aua.user_id
                  AND reporter_employee.is_deleted = 0
            LEFT JOIN learners reporter_learner
                   ON reporter_learner.user_id = aua.user_id
                  AND reporter_learner.is_deleted = 0
            LEFT JOIN (" . user_identity_derived_sql() . ") poster_identity ON poster_identity.user_id = a.posted_by
            LEFT JOIN employees poster_employee
                   ON poster_employee.user_id = a.posted_by
                  AND poster_employee.is_deleted = 0
            LEFT JOIN learners poster_learner
                   ON poster_learner.user_id = a.posted_by
                  AND poster_learner.is_deleted = 0
            LEFT JOIN roles poster_target_role
                   ON poster_target_role.role_id = a.target_role_id
            WHERE aua.action_type = 'reported'
              AND a.is_deleted = :is_deleted
              {$reviewFilter}
            ORDER BY aua.created_at DESC
            {$limitClause}";

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':is_deleted', $deletedState, PDO::PARAM_INT);
    $stmt->execute();
    $reports = $stmt->fetchAll(PDO::FETCH_ASSOC);

    respond([
        'success' => true,
        'data' => [
            'reports' => $reports,
            'count' => count($reports)
        ]
    ]);
}
?>
