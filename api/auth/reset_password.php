<?php
require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/password_recovery.php';
try {
    /* Adviser-issued learner links are delivered in person, so they must work
     * even when the optional employee mail queue is not configured. */
    recovery_reset($conn, recovery_input($conn, true));
} catch (Throwable $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    error_log('Recovery reset failed: ' . get_class($e));
    recovery_json(['success' => false, 'message' => 'Recovery is temporarily unavailable. Try again later.'], 503);
}
