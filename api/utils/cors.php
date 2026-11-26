<?php
// CORS helper for local development and same-network device access.
// Allows credentialed requests from localhost and private IPv4 origins only.

function isAllowedLocalOrigin(string $origin): bool {
    $parts = parse_url($origin);
    if (!is_array($parts) || !in_array(strtolower((string)($parts['scheme'] ?? '')), ['http', 'https'], true)) {
        return false;
    }

    $host = strtolower((string)($parts['host'] ?? ''));
    if (in_array($host, ['localhost', '127.0.0.1', '::1'], true)) {
        return true;
    }

    $ip = filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4);
    if ($ip === false) {
        return false;
    }

    $octets = array_map('intval', explode('.', $ip));
    if (count($octets) !== 4) {
        return false;
    }

    return $octets[0] === 10
        || ($octets[0] === 192 && $octets[1] === 168)
        || ($octets[0] === 172 && $octets[1] >= 16 && $octets[1] <= 31);
}

if (PHP_SAPI !== 'cli') {
    // APIs should always return valid JSON; avoid emitting PHP notices/warnings into responses.
    ini_set('display_errors', '0');
    ini_set('display_startup_errors', '0');
    error_reporting(E_ALL);

    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';

    if ($origin) {
        if (isAllowedLocalOrigin($origin)) {
            header('Access-Control-Allow-Origin: ' . $origin);
            header('Access-Control-Allow-Credentials: true');
            header('Vary: Origin');
        } else {
            // Deliberately do not reflect unknown origins.
            header('Access-Control-Allow-Origin: null');
        }
    } else {
        // No Origin header: typically same-origin navigation or CLI tools.
        header('Access-Control-Allow-Origin: *');
    }

    header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
    header('Access-Control-Max-Age: 600');

    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}
