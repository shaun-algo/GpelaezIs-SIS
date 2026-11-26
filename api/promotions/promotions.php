<?php
header('Content-Type: application/json');

require_once __DIR__ . '/../utils/cors.php';

http_response_code(410);
echo json_encode([
    'success' => false,
    'message' => 'Promotion & Rollover has been disabled. Use the Enrollments import workflow; school year, grade, and section are identified from the file headers during promotion import.'
]);
exit;
