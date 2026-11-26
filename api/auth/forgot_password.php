<?php
require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/password_recovery.php';
try {
    $data = recovery_input($conn);
    $username = trim($data['username'] ?? '');
    if (!preg_match('/^(?:[0-9]{12}|[A-Za-z0-9-]{1,9})$/D', $username)) {
        recovery_json(['success'=>false,'message'=>'Enter your 12-digit LRN or employee ID (up to 9 characters).'],422);
    }
    recovery_request($conn, $username);
} catch (Throwable $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    error_log('Recovery request failed: ' . get_class($e));
    recovery_json(['success' => false, 'message' => 'Recovery is temporarily unavailable. Try again later.'], 503);
}
