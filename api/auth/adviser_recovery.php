<?php
require __DIR__ . '/../database/connection.php';
require __DIR__ . '/../utils/password_recovery.php';
require_once __DIR__ . '/../utils/auth.php';

function adviser_recovery_input(): array {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        header('Allow: POST');
        recovery_json(['success' => false, 'message' => 'POST is required.'], 405);
    }

    $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($origin !== '' && !hash_equals(recovery_origin(), $origin)) {
        recovery_json(['success' => false, 'message' => 'Request origin is not allowed.'], 403);
    }

    $contentType = strtolower(trim(explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? ''))[0]));
    if ($contentType !== 'application/json') {
        recovery_json(['success' => false, 'message' => 'Send JSON.'], 415);
    }

    $raw = file_get_contents('php://input', false, null, 0, 4097);
    $data = is_string($raw) && strlen($raw) <= 4096 ? json_decode($raw, true) : null;
    if (!is_array($data)) {
        recovery_json(['success' => false, 'message' => 'Invalid request.'], 400);
    }
    foreach ($data as $value) {
        if (!is_string($value)) {
            recovery_json(['success' => false, 'message' => 'Invalid request.'], 400);
        }
    }
    return $data;
}

try {
    $data = adviser_recovery_input();
    $session = auth_require();
    if (!in_array($session['role_key'], ['admin', 'teacher', 'registrar'], true)) {
        recovery_json(['success' => false, 'message' => 'Admin, adviser, or registrar access required.'], 403);
    }

    if (!isset($_SESSION['recovery_csrf'])) {
        $_SESSION['recovery_csrf'] = bin2hex(random_bytes(32));
    }

    if (($data['action'] ?? '') === 'list') {
        recovery_json([
            'success' => true,
            'requests' => learner_recovery_list($conn, $session),
            'csrf' => $_SESSION['recovery_csrf'],
            'role' => $session['role_key']
        ]);
    }

    if (!hash_equals((string)$_SESSION['recovery_csrf'], (string)($data['csrf'] ?? ''))) {
        recovery_json(['success' => false, 'message' => 'Refresh the page and try again.'], 403);
    }

    $result = learner_recovery_decide($conn, $session, $data);
    recovery_json([
        'success' => $result['code'] === 200,
        'message' => $result['message'],
        'reset_url' => $result['reset_url'] ?? null
    ], $result['code']);
} catch (Throwable $e) {
    if (isset($conn) && $conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('Adviser recovery failed: ' . get_class($e));
    recovery_json(['success' => false, 'message' => 'Recovery is temporarily unavailable.'], 503);
}
