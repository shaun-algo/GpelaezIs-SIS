<?php
require_once __DIR__ . '/../database/connection.php';
require_once __DIR__ . '/../utils/recovery_mail.php';
header('Content-Type: application/json');
header('Cache-Control: no-store');
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET');
    http_response_code(405);
    echo json_encode(['message'=>'GET is required.']);
    exit;
}
try {
    $config = recovery_config();
    $message = '';
    if (empty($config['enabled'])) {
        $message = 'Email recovery is currently unavailable. Please contact the school office.';
    } elseif (($config['transport'] ?? '') === 'smtp') {
        // Report service health only, never recipients, account details, or SMTP errors.
        $latest = $conn->query("SELECT status FROM recovery_mail_queue WHERE status IN ('sent','failed') ORDER BY finished_at DESC, id DESC LIMIT 1")->fetchColumn();
        if ($latest === 'failed') {
            $message = 'Recent recovery emails could not be sent. Your reset email may not arrive. Please contact the school office or try again later.';
        } elseif ($conn->query("SELECT 1 FROM recovery_mail_queue WHERE status IN ('pending','sending') AND created_at < NOW() - INTERVAL 2 MINUTE LIMIT 1")->fetchColumn()) {
            $message = 'Recovery email delivery is delayed. If your reset email does not arrive, please contact the school office or try again later.';
        }
    }
    echo json_encode(['warning'=>$message !== '', 'message'=>$message]);
} catch (Throwable $e) {
    http_response_code(503);
    echo json_encode(['warning'=>true,'message'=>'Email delivery status is unavailable. If your reset email does not arrive, please contact the school office.']);
}
