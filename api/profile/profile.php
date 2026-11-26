<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../utils/cors.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/auth.php';
require_once __DIR__ . '/../utils/account_identity_queries.php';

function respond($payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function profile_presence_payload(array $row): array {
    $lastSeenAt = trim((string)($row['last_seen_at'] ?? ''));
    $lastLogin = trim((string)($row['last_login'] ?? ''));
    $lastSeenTime = $lastSeenAt !== '' ? strtotime($lastSeenAt) : false;

    return [
        'is_online' => array_key_exists('is_online', $row)
            ? (int)$row['is_online'] === 1
            : ($lastSeenTime !== false && $lastSeenTime >= (time() - 300)),
        'last_seen_at' => $lastSeenAt !== '' ? $lastSeenAt : null,
        'last_login' => $lastLogin !== '' ? $lastLogin : null,
        'last_seen_seconds_ago' => isset($row['last_seen_seconds_ago']) && is_numeric($row['last_seen_seconds_ago'])
            ? max(0, (int)$row['last_seen_seconds_ago'])
            : null,
        'last_login_seconds_ago' => isset($row['last_login_seconds_ago']) && is_numeric($row['last_login_seconds_ago'])
            ? max(0, (int)$row['last_login_seconds_ago'])
            : null,
    ];
}

$operation = $_GET['operation'] ?? '';
$session = auth_require();
$viewerIsLearner = ($session['role_key'] ?? '') === 'learners'
    || (int)($session['role_id'] ?? 0) === 10;

if ($operation === 'searchProfiles') {
    $query = trim((string)($_GET['q'] ?? ''));
    $limit = max(1, min(30, (int)($_GET['limit'] ?? 20)));

    if (mb_strlen($query) < 2) {
        respond(['success' => true, 'data' => []]);
    }

    try {
        // Keep directory search intentionally small and safe for authenticated
        // users. Do not return contact details, addresses, LRNs, usernames, or
        // credentials from this endpoint.
        $sql =
            'SELECT u.user_id,
                    u.role_id,
                    u.role_name,
                    COALESCE(e.first_name, l.first_name, \'\') AS first_name,
                    COALESCE(e.middle_name, l.middle_name, \'\') AS middle_name,
                    COALESCE(e.last_name, l.last_name, \'\') AS last_name,
                    COALESCE(e.gender, l.gender, \'\') AS gender,
                    u.last_login,
                    u.last_seen_at,
                    TIMESTAMPDIFF(SECOND, u.last_seen_at, NOW()) AS last_seen_seconds_ago,
                    TIMESTAMPDIFF(SECOND, u.last_login, NOW()) AS last_login_seconds_ago,
                    CASE WHEN u.last_seen_at IS NOT NULL
                               AND u.last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
                         THEN 1 ELSE 0 END AS is_online,
                    p.position_name
             FROM (' . user_identity_derived_sql() . ') u
             LEFT JOIN employees e
                    ON e.user_id = u.user_id
                   AND e.is_deleted = 0
             LEFT JOIN learners l
                    ON l.user_id = u.user_id
                   AND l.is_deleted = 0
             LEFT JOIN positions p
                    ON p.position_id = e.position_id
                   AND p.is_deleted = 0
             WHERE u.is_active = 1
               AND u.is_deleted = 0
               ' . ($viewerIsLearner ? 'AND u.role_id <> 10' : '') . '
               AND (
                    CONCAT_WS(\' \', e.first_name, e.middle_name, e.last_name) LIKE :name_term
                    OR CONCAT_WS(\' \', l.first_name, l.middle_name, l.last_name) LIKE :learner_name_term
                    OR u.role_name LIKE :role_term
                    OR p.position_name LIKE :position_term
               )
             ORDER BY COALESCE(e.last_name, l.last_name, \'\'),
                      COALESCE(e.first_name, l.first_name, \'\')
             LIMIT ' . $limit;

        $stmt = $conn->prepare($sql);
        $term = '%' . $query . '%';
        $stmt->bindValue(':name_term', $term, PDO::PARAM_STR);
        $stmt->bindValue(':learner_name_term', $term, PDO::PARAM_STR);
        $stmt->bindValue(':role_term', $term, PDO::PARAM_STR);
        $stmt->bindValue(':position_term', $term, PDO::PARAM_STR);
        $stmt->execute();

        $profiles = array_map(static function (array $row): array {
            $firstName = trim((string)($row['first_name'] ?? ''));
            $middleName = trim((string)($row['middle_name'] ?? ''));
            $lastName = trim((string)($row['last_name'] ?? ''));
            $fullName = trim(implode(' ', array_filter([$firstName, $middleName, $lastName])));

            return [
                'user_id' => (int)$row['user_id'],
                'role_id' => (int)($row['role_id'] ?? 0),
                'role_name' => (string)($row['role_name'] ?? 'User'),
                'first_name' => $firstName,
                'last_name' => $lastName,
                'gender' => (string)($row['gender'] ?? ''),
                'position_name' => (string)($row['position_name'] ?? ''),
                'full_name' => $fullName !== '' ? $fullName : 'User',
                'presence' => profile_presence_payload($row)
            ];
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));

        respond(['success' => true, 'data' => $profiles]);
    } catch (Throwable $e) {
        error_log('Profile directory search failed: ' . $e->getMessage());
        respond(['success' => false, 'message' => 'Unable to search profiles right now.'], 500);
    }
}

if ($operation !== 'getPublicProfile') {
    respond(['success' => false, 'message' => 'Invalid operation'], 400);
}

$profileUserId = filter_input(INPUT_GET, 'user_id', FILTER_VALIDATE_INT);
if (!$profileUserId || $profileUserId < 1) {
    respond(['success' => false, 'message' => 'A valid profile user is required.'], 422);
}

try {
    // Keep this projection intentionally small. A public profile must not expose
    // contact details, address, birth date, employee number, LRN, or credentials.
    $stmt = $conn->prepare(
        'SELECT u.user_id,
                u.role_id,
                u.role_name,
                COALESCE(e.first_name, l.first_name, \'\') AS first_name,
                COALESCE(e.last_name, l.last_name, \'\') AS last_name,
                COALESCE(e.gender, l.gender, \'\') AS gender,
                u.last_login,
                u.last_seen_at,
                TIMESTAMPDIFF(SECOND, u.last_seen_at, NOW()) AS last_seen_seconds_ago,
                TIMESTAMPDIFF(SECOND, u.last_login, NOW()) AS last_login_seconds_ago,
                COALESCE(account_user.account_created_at, account_user.created_at) AS account_created_at,
                CASE WHEN u.last_seen_at IS NOT NULL
                           AND u.last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
                     THEN 1 ELSE 0 END AS is_online,
                p.position_name
         FROM (' . user_identity_derived_sql() . ') u
         LEFT JOIN employees e
                ON e.user_id = u.user_id
               AND e.is_deleted = 0
         LEFT JOIN learners l
                ON l.user_id = u.user_id
               AND l.is_deleted = 0
         LEFT JOIN users account_user
                ON account_user.user_id = u.user_id
         LEFT JOIN positions p
                ON p.position_id = e.position_id
               AND p.is_deleted = 0
         WHERE u.user_id = :user_id
           AND u.is_active = 1
           AND u.is_deleted = 0
         LIMIT 1'
    );
    $stmt->bindValue(':user_id', (int)$profileUserId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        respond(['success' => false, 'message' => 'Profile not found.'], 404);
    }

    if ($viewerIsLearner && (int)($row['role_id'] ?? 0) === 10) {
        respond(['success' => false, 'message' => 'Learner accounts may view employee profiles only.'], 403);
    }

    $firstName = trim((string)($row['first_name'] ?? ''));
    $lastName = trim((string)($row['last_name'] ?? ''));
    $fullName = trim($firstName . ' ' . $lastName);

    respond([
        'success' => true,
        'data' => [
            'user_id' => (int)$row['user_id'],
            'role_id' => (int)($row['role_id'] ?? 0),
            'role_name' => (string)($row['role_name'] ?? 'User'),
            'first_name' => $firstName,
            'last_name' => $lastName,
            'gender' => (string)($row['gender'] ?? ''),
            'position_name' => (string)($row['position_name'] ?? ''),
            'full_name' => $fullName !== '' ? $fullName : 'User',
            'account_created_at' => $row['account_created_at'] ?? null,
            'presence' => profile_presence_payload($row)
        ]
    ]);
} catch (Throwable $e) {
    error_log('Public profile lookup failed: ' . $e->getMessage());
    respond(['success' => false, 'message' => 'Unable to load this profile right now.'], 500);
}
