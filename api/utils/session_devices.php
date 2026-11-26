<?php
// Per-browser device controls used by Account security. The database stores
// hashes for the PHP session and device cookie; raw identifiers never leave
// the browser/server boundary.

function auth_session_device_cookie_name(): string {
    return 'DEPED_DEVICE_ID';
}

function auth_session_device_cookie_value(): string {
    $name = auth_session_device_cookie_name();
    $existing = strtolower(trim((string)($_COOKIE[$name] ?? '')));
    if (preg_match('/^[a-f0-9]{64}$/', $existing)) return $existing;

    try {
        $value = bin2hex(random_bytes(32));
    } catch (Throwable $e) {
        $value = hash('sha256', uniqid('', true) . microtime(true));
    }

    $_COOKIE[$name] = $value;
    if (!headers_sent()) {
        $isHttps = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
        setcookie($name, $value, [
            'expires' => time() + 31536000,
            'path' => '/',
            'secure' => $isHttps,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }
    return $value;
}

function auth_session_device_fingerprint(): string {
    return hash('sha256', auth_session_device_cookie_value());
}

function auth_session_hash(): string {
    return hash('sha256', (string)session_id());
}

function auth_session_devices_available(PDO $conn): bool {
    static $available = null;
    if ($available !== null) return $available;

    try {
        $stmt = $conn->prepare(
            'SELECT 1
             FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = \'auth_session_devices\'
             LIMIT 1'
        );
        $stmt->execute();
        $available = (bool)$stmt->fetchColumn();
    } catch (Throwable $e) {
        $available = false;
    }
    return $available;
}

function auth_session_devices_modern_available(PDO $conn): bool {
    static $available = null;
    if ($available !== null) return $available;
    if (!auth_session_devices_available($conn)) return $available = false;

    try {
        $stmt = $conn->prepare(
            "SELECT COUNT(*)
             FROM information_schema.columns
             WHERE table_schema = DATABASE()
               AND table_name = 'auth_session_devices'
               AND column_name IN ('is_main_device', 'trusted_at', 'new_device_pending')"
        );
        $stmt->execute();
        $available = (int)$stmt->fetchColumn() === 3;
    } catch (Throwable $e) {
        $available = false;
    }
    return $available;
}

function auth_session_device_location_available(PDO $conn): bool {
    static $availability = [];
    $cacheKey = spl_object_hash($conn);
    if (array_key_exists($cacheKey, $availability)) return $availability[$cacheKey];
    if (!auth_session_devices_available($conn)) return $availability[$cacheKey] = false;

    try {
        $stmt = $conn->prepare(
            "SELECT COUNT(*)
             FROM information_schema.columns
             WHERE table_schema = DATABASE()
               AND table_name = 'auth_session_devices'
               AND column_name = 'location_label'"
        );
        $stmt->execute();
        $availability[$cacheKey] = (int)$stmt->fetchColumn() === 1;
    } catch (Throwable $e) {
        $availability[$cacheKey] = false;
    }
    return $availability[$cacheKey];
}

function auth_session_device_user_agent(): string {
    return substr(trim((string)($_SERVER['HTTP_USER_AGENT'] ?? '')), 0, 512);
}

function auth_session_device_ip_matches_cidr(string $ip, string $cidr): bool {
    $parts = explode('/', trim($cidr), 2);
    $network = trim((string)($parts[0] ?? ''));
    if (!filter_var($ip, FILTER_VALIDATE_IP) || !filter_var($network, FILTER_VALIDATE_IP)) return false;
    if (count($parts) === 1) return hash_equals($network, $ip);

    $ipBinary = inet_pton($ip);
    $networkBinary = inet_pton($network);
    $prefixLength = (int)$parts[1];
    $binaryLength = strlen((string)$ipBinary);
    if ($ipBinary === false || $networkBinary === false
        || strlen((string)$networkBinary) !== $binaryLength
        || $prefixLength < 0 || $prefixLength > $binaryLength * 8) {
        return false;
    }

    $fullBytes = intdiv($prefixLength, 8);
    $remainingBits = $prefixLength % 8;
    for ($index = 0; $index < $fullBytes; $index++) {
        if (ord($ipBinary[$index]) !== ord($networkBinary[$index])) return false;
    }
    if ($remainingBits > 0) {
        $mask = (0xFF << (8 - $remainingBits)) & 0xFF;
        if ((ord($ipBinary[$fullBytes]) & $mask) !== (ord($networkBinary[$fullBytes]) & $mask)) return false;
    }
    return true;
}

function auth_session_device_is_trusted_proxy(string $ip): bool {
    $configured = trim((string)(getenv('AUTH_TRUSTED_PROXY_IPS') ?: ''));
    if ($configured === '') return false;
    foreach (preg_split('/[\s,]+/', $configured, -1, PREG_SPLIT_NO_EMPTY) as $entry) {
        if (auth_session_device_ip_matches_cidr($ip, (string)$entry)) return true;
    }
    return false;
}

function auth_session_device_client_ip(): ?string {
    $remote = trim((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    if (!filter_var($remote, FILTER_VALIDATE_IP)) return null;

    // Forwarded headers are attacker-controlled unless the direct peer is a
    // proxy explicitly listed by the deployment administrator.
    if (auth_session_device_is_trusted_proxy($remote)) {
        $forwarded = (string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
        foreach (explode(',', $forwarded) as $candidate) {
            $candidate = trim($candidate);
            if (filter_var($candidate, FILTER_VALIDATE_IP)) return $candidate;
        }
    }
    return $remote;
}

function auth_session_device_geoip_endpoint(): string {
    $configured = trim((string)(getenv('AUTH_SESSION_GEOIP_ENDPOINT') ?: ''));
    if ($configured !== '') return $configured;

    // Keep the endpoint configurable for deployments that use a local
    // MaxMind reader or an organization-approved provider. The default is a
    // bounded, HTTPS lookup suitable for this small school application.
    return 'https://ipwho.is/{ip}';
}

function auth_session_device_clean_location_part($value): string {
    $value = trim((string)$value);
    if ($value === '') return '';
    $value = preg_replace('/\s+/u', ' ', $value) ?: '';
    $value = preg_replace('/[^\p{L}\p{N}\s.,()\'\-]/u', '', $value) ?: '';
    return substr(trim($value), 0, 80);
}

function auth_session_device_geoip_location_label(?string $ip): ?string {
    static $cache = [];
    $ip = trim((string)$ip);
    if ($ip === '' || !filter_var($ip, FILTER_VALIDATE_IP)) return null;
    if (array_key_exists($ip, $cache)) return $cache[$ip];
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
        return $cache[$ip] = null;
    }
    if (!function_exists('curl_init')) return $cache[$ip] = null;

    $endpoint = auth_session_device_geoip_endpoint();
    $parts = parse_url($endpoint);
    if (!is_array($parts) || strtolower((string)($parts['scheme'] ?? '')) !== 'https') {
        return $cache[$ip] = null;
    }
    $encodedIp = rawurlencode($ip);
    $url = str_contains($endpoint, '{ip}')
        ? str_replace('{ip}', $encodedIp, $endpoint)
        : rtrim($endpoint, '/') . '/' . $encodedIp;

    $handle = curl_init($url);
    if ($handle === false) return $cache[$ip] = null;
    curl_setopt_array($handle, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 1,
        CURLOPT_TIMEOUT => 2,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
        CURLOPT_USERAGENT => 'DepEd-Capstone-Account-Security/1.0',
    ]);
    $body = curl_exec($handle);
    $status = (int)curl_getinfo($handle, CURLINFO_HTTP_CODE);
    curl_close($handle);
    if (!is_string($body) || $status < 200 || $status >= 300) return $cache[$ip] = null;

    $payload = json_decode($body, true);
    if (!is_array($payload) || (array_key_exists('success', $payload) && $payload['success'] === false) || !empty($payload['error'])) {
        return $cache[$ip] = null;
    }

    $values = [
        auth_session_device_clean_location_part($payload['city'] ?? ''),
        auth_session_device_clean_location_part($payload['region'] ?? ($payload['region_name'] ?? '')),
        auth_session_device_clean_location_part($payload['country_name'] ?? ($payload['country'] ?? '')),
    ];
    $values = array_values(array_unique(array_filter($values, static fn(string $value): bool => $value !== '')));
    return $cache[$ip] = ($values ? implode(', ', $values) : null);
}

function auth_session_device_reverse_geocoder_endpoint(): string {
    $configured = trim((string)(getenv('AUTH_SESSION_REVERSE_GEOCODER_ENDPOINT') ?: ''));
    return $configured !== '' ? $configured : 'https://nominatim.openstreetmap.org/reverse';
}

function auth_session_device_coordinate($value, float $minimum, float $maximum): ?float {
    if (is_bool($value) || !is_numeric($value)) return null;
    $number = (float)$value;
    if (!is_finite($number) || $number < $minimum || $number > $maximum) return null;
    return $number;
}

function auth_session_device_reverse_geocode_location_label(?array $clientLocation): ?string {
    static $cache = [];
    if (!is_array($clientLocation)) return null;

    $latitude = auth_session_device_coordinate($clientLocation['latitude'] ?? null, -90.0, 90.0);
    $longitude = auth_session_device_coordinate($clientLocation['longitude'] ?? null, -180.0, 180.0);
    if ($latitude === null || $longitude === null) return null;

    // Round only the cache key. Coordinates are never persisted or returned
    // to the browser; the reverse geocoder receives the original values.
    $cacheKey = number_format($latitude, 4, '.', '') . ',' . number_format($longitude, 4, '.', '');
    if (array_key_exists($cacheKey, $cache)) return $cache[$cacheKey];
    if (!function_exists('curl_init')) return $cache[$cacheKey] = null;

    $endpoint = auth_session_device_reverse_geocoder_endpoint();
    $parts = parse_url($endpoint);
    if (!is_array($parts) || strtolower((string)($parts['scheme'] ?? '')) !== 'https') {
        return $cache[$cacheKey] = null;
    }

    $query = http_build_query([
        'format' => 'jsonv2',
        'lat' => number_format($latitude, 6, '.', ''),
        'lon' => number_format($longitude, 6, '.', ''),
        'zoom' => 10,
        'addressdetails' => 1,
        'accept-language' => 'en',
    ], '', '&', PHP_QUERY_RFC3986);
    if (str_contains($endpoint, '{lat}') || str_contains($endpoint, '{lon}')) {
        $url = str_replace(
            ['{lat}', '{lon}'],
            [rawurlencode(number_format($latitude, 6, '.', '')), rawurlencode(number_format($longitude, 6, '.', ''))],
            $endpoint
        );
    } else {
        $url = $endpoint . (str_contains($endpoint, '?') ? '&' : '?') . $query;
    }

    $handle = curl_init($url);
    if ($handle === false) return $cache[$cacheKey] = null;
    curl_setopt_array($handle, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 1,
        CURLOPT_TIMEOUT => 3,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
        CURLOPT_USERAGENT => 'DepEd-Capstone-Account-Security/1.0',
    ]);
    $body = curl_exec($handle);
    $status = (int)curl_getinfo($handle, CURLINFO_HTTP_CODE);
    curl_close($handle);
    if (!is_string($body) || $status < 200 || $status >= 300) return $cache[$cacheKey] = null;

    $payload = json_decode($body, true);
    $address = is_array($payload) && is_array($payload['address'] ?? null) ? $payload['address'] : [];
    if (!$address) return $cache[$cacheKey] = null;

    $firstAddressPart = static function (array $keys) use ($address): string {
        foreach ($keys as $key) {
            $value = auth_session_device_clean_location_part($address[$key] ?? '');
            if ($value !== '') return $value;
        }
        return '';
    };
    $place = $firstAddressPart(['city', 'town', 'municipality', 'village', 'county']);
    $region = $firstAddressPart(['province', 'state', 'region', 'state_district']);
    $country = $firstAddressPart(['country']);
    $values = array_values(array_unique(array_filter([$place, $region, $country], static function (string $value): bool {
        return $value !== '';
    })));

    return $cache[$cacheKey] = ($values ? implode(', ', $values) : null);
}

function auth_session_device_location_label(?string $clientTimezone = null, ?array $clientLocation = null): ?string {
    $geoipLocation = auth_session_device_geoip_location_label(auth_session_device_client_ip());
    if ($geoipLocation !== null) return $geoipLocation;

    // Use precise coordinates only after the browser has explicitly granted
    // location permission. Store only the reverse-geocoded place label.
    $preciseLocation = auth_session_device_reverse_geocode_location_label($clientLocation);
    if ($preciseLocation !== null) return $preciseLocation;

    $candidate = trim((string)$clientTimezone);
    if ($candidate !== '' && strlen($candidate) <= 120) {
        try {
            // Browsers provide an IANA timezone such as Asia/Manila. Resolve
            // it server-side so arbitrary text is never persisted as a label.
            return (new DateTimeZone($candidate))->getName();
        } catch (Throwable $ignored) {
            // Fall through to a deliberately non-identifying server fallback.
        }
    }

    $ip = trim((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    if ($ip !== '' && filter_var($ip, FILTER_VALIDATE_IP)) {
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
            return 'Local network';
        }
    }
    return null;
}

function auth_session_device_label(string $userAgent): string {
    $value = trim($userAgent);
    $browser = 'Unknown browser';
    if (preg_match('/EdgA?\//i', $value) || preg_match('/EdgiOS\//i', $value)) $browser = 'Edge';
    elseif (preg_match('/OPR\//i', $value)) $browser = 'Opera';
    elseif (preg_match('/SamsungBrowser\//i', $value)) $browser = 'Samsung Internet';
    elseif (preg_match('/CriOS\//i', $value) || preg_match('/Chrome\//i', $value)) $browser = 'Chrome';
    elseif (preg_match('/FxiOS\//i', $value) || preg_match('/Firefox\//i', $value)) $browser = 'Firefox';
    elseif (preg_match('/Safari\//i', $value)) $browser = 'Safari';

    $device = 'Unknown device';
    if (preg_match('/iPhone/i', $value)) $device = 'iPhone';
    elseif (preg_match('/iPad/i', $value)) $device = 'iPad';
    elseif (preg_match('/Android/i', $value)) $device = 'Android';
    elseif (preg_match('/Windows/i', $value)) $device = 'Windows';
    elseif (preg_match('/Mac OS X|Macintosh/i', $value)) $device = 'Mac';
    elseif (preg_match('/Linux/i', $value)) $device = 'Linux';

    return $browser . ' on ' . $device;
}

function auth_session_device_row(PDO $conn, string $where, array $params, bool $forUpdate = false): ?array {
    $locationSelect = auth_session_device_location_available($conn) ? 'location_label' : 'NULL AS location_label';
    $stmt = $conn->prepare(
        'SELECT session_device_id, user_id, session_hash, device_fingerprint,
                user_agent, ' . $locationSelect . ', is_main_device, trusted_at, new_device_pending,
                created_at, last_seen_at, revoked_at, blocked_at,
                TIMESTAMPDIFF(SECOND, created_at, NOW()) AS created_age_seconds,
                TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) AS last_seen_age_seconds
         FROM auth_session_devices
         WHERE ' . $where . '
         LIMIT 1' . ($forUpdate ? ' FOR UPDATE' : '')
    );
    $stmt->execute($params);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function auth_session_device_register_legacy(PDO $conn, int $userId, ?string $clientTimezone = null, ?array $clientLocation = null): ?array {
    $sessionHash = auth_session_hash();
    $deviceFingerprint = auth_session_device_fingerprint();
    $userAgent = auth_session_device_user_agent();
    $location = auth_session_device_location_label($clientTimezone, $clientLocation);
    $locationAvailable = auth_session_device_location_available($conn);
    $columns = 'user_id, session_hash, device_fingerprint, user_agent, last_seen_at';
    $values = ':user_id, :session_hash, :device_fingerprint, :user_agent, NOW()';
    $updates = 'user_agent = VALUES(user_agent),
            last_seen_at = IF(revoked_at IS NULL AND blocked_at IS NULL, NOW(), last_seen_at)';
    if ($locationAvailable) {
        $columns .= ', location_label';
        $values .= ', :location_label';
        $updates .= ', location_label = COALESCE(VALUES(location_label), location_label)';
    }
    $stmt = $conn->prepare(
        'INSERT INTO auth_session_devices (' . $columns . ')
         VALUES (' . $values . ')
         ON DUPLICATE KEY UPDATE ' . $updates
    );
    $bindings = [
        ':user_id' => $userId,
        ':session_hash' => $sessionHash,
        ':device_fingerprint' => $deviceFingerprint,
        ':user_agent' => $userAgent !== '' ? $userAgent : null,
    ];
    if ($locationAvailable) $bindings[':location_label'] = $location;
    $stmt->execute($bindings);

    $locationSelect = $locationAvailable ? 'location_label' : 'NULL AS location_label';
    $row = $conn->prepare(
        'SELECT session_device_id, user_id, session_hash, device_fingerprint,
                user_agent, ' . $locationSelect . ', created_at, last_seen_at, revoked_at, blocked_at
         FROM auth_session_devices
         WHERE session_hash = :session_hash AND user_id = :user_id
         LIMIT 1'
    );
    $row->execute([':session_hash' => $sessionHash, ':user_id' => $userId]);
    $result = $row->fetch(PDO::FETCH_ASSOC);
    return $result ?: null;
}

function auth_session_device_register(PDO $conn, int $userId, ?string $clientTimezone = null, ?array $clientLocation = null): ?array {
    if ($userId <= 0 || !auth_session_devices_available($conn) || session_id() === '') return null;

    if (!auth_session_devices_modern_available($conn)) {
        $row = auth_session_device_register_legacy($conn, $userId, $clientTimezone, $clientLocation);
        if ($row) {
            $row['is_new_device'] = false;
            $row['is_main_device'] = false;
            $row['new_device_pending'] = false;
        }
        return $row;
    }

    $sessionHash = auth_session_hash();
    $deviceFingerprint = auth_session_device_fingerprint();
    $userAgent = auth_session_device_user_agent();
    $location = auth_session_device_location_label($clientTimezone, $clientLocation);
    $locationAvailable = auth_session_device_location_available($conn);
    $startedTransaction = false;

    try {
        if (!$conn->inTransaction()) {
            $conn->beginTransaction();
            $startedTransaction = true;
        }

        $row = auth_session_device_row($conn,
            'user_id = :user_id AND device_fingerprint = :device_fingerprint',
            [':user_id' => $userId, ':device_fingerprint' => $deviceFingerprint],
            true
        );
        $isNewDevice = !$row;

        if ($row) {
            if ($row['blocked_at'] !== null) {
                if ($startedTransaction) $conn->commit();
                $row['is_new_device'] = false;
                return $row;
            }

            $set = 'session_hash = :session_hash,
                     user_agent = :user_agent,
                     last_seen_at = NOW(),
                     revoked_at = NULL';
            if ($locationAvailable) $set .= ', location_label = COALESCE(:location_label, location_label)';
            $update = $conn->prepare(
                'UPDATE auth_session_devices
                 SET ' . $set . '
                 WHERE session_device_id = :session_device_id'
            );
            $bindings = [
                ':session_hash' => $sessionHash,
                ':user_agent' => $userAgent !== '' ? $userAgent : null,
                ':session_device_id' => (int)$row['session_device_id'],
            ];
            if ($locationAvailable) $bindings[':location_label'] = $location;
            $update->execute($bindings);
        } else {
            $count = $conn->prepare('SELECT COUNT(*) FROM auth_session_devices WHERE user_id = :user_id');
            $count->execute([':user_id' => $userId]);
            $isMainDevice = (int)$count->fetchColumn() === 0;
            $columns = 'user_id, session_hash, device_fingerprint, user_agent,
                     is_main_device, trusted_at, new_device_pending, last_seen_at';
            $values = ':user_id, :session_hash, :device_fingerprint, :user_agent,
                         :is_main_device, :trusted_at, :new_device_pending, NOW()';
            if ($locationAvailable) {
                $columns .= ', location_label';
                $values .= ', :location_label';
            }
            $insert = $conn->prepare(
                'INSERT INTO auth_session_devices (' . $columns . ')
                 VALUES (' . $values . ')'
            );
            $bindings = [
                ':user_id' => $userId,
                ':session_hash' => $sessionHash,
                ':device_fingerprint' => $deviceFingerprint,
                ':user_agent' => $userAgent !== '' ? $userAgent : null,
                ':is_main_device' => $isMainDevice ? 1 : 0,
                ':trusted_at' => $isMainDevice ? date('Y-m-d H:i:s') : null,
                ':new_device_pending' => $isMainDevice ? 0 : 1,
            ];
            if ($locationAvailable) $bindings[':location_label'] = $location;
            $insert->execute($bindings);
            $row = auth_session_device_row($conn,
                'session_device_id = :session_device_id',
                [':session_device_id' => (int)$conn->lastInsertId()]
            );
        }

        if ($startedTransaction) $conn->commit();
        if (!$row) return null;
        if (!$isNewDevice) {
            $row = auth_session_device_row($conn,
                'user_id = :user_id AND session_hash = :session_hash',
                [':user_id' => $userId, ':session_hash' => $sessionHash]
            );
        }
        $row['is_new_device'] = $isNewDevice;
        return $row;
    } catch (Throwable $e) {
        if ($startedTransaction && $conn->inTransaction()) $conn->rollBack();
        return null;
    }
}

function auth_session_device_is_blocked(PDO $conn, int $userId): bool {
    if ($userId <= 0 || !auth_session_devices_available($conn)) return false;
    $stmt = $conn->prepare(
        'SELECT 1
         FROM auth_session_devices
         WHERE user_id = :user_id
           AND device_fingerprint = :device_fingerprint
           AND blocked_at IS NOT NULL
         LIMIT 1'
    );
    $stmt->execute([
        ':user_id' => $userId,
        ':device_fingerprint' => auth_session_device_fingerprint(),
    ]);
    return (bool)$stmt->fetchColumn();
}

function auth_session_device_guard(PDO $conn, int $userId): ?array {
    if ($userId <= 0 || !auth_session_devices_available($conn) || session_id() === '') return null;
    if (!auth_session_devices_modern_available($conn)) return auth_session_device_register($conn, $userId);

    $sessionHash = auth_session_hash();
    $row = auth_session_device_row($conn,
        'user_id = :user_id AND session_hash = :session_hash',
        [':user_id' => $userId, ':session_hash' => $sessionHash]
    );
    if ($row) return $row;

    // A second login from the same browser replaces the current session hash
    // on the single device row. The older PHP session must not remain valid.
    $row = auth_session_device_row($conn,
        'user_id = :user_id AND device_fingerprint = :device_fingerprint',
        [':user_id' => $userId, ':device_fingerprint' => auth_session_device_fingerprint()]
    );
    if ($row) $row['session_replaced'] = true;
    return $row;
}

function auth_session_device_touch(PDO $conn, int $userId): void {
    if ($userId <= 0 || !auth_session_devices_available($conn) || session_id() === '') return;
    $stmt = $conn->prepare(
        'UPDATE auth_session_devices
         SET last_seen_at = NOW(), user_agent = :user_agent
         WHERE user_id = :user_id AND session_hash = :session_hash
           AND blocked_at IS NULL AND revoked_at IS NULL'
    );
    $stmt->execute([
        ':user_id' => $userId,
        ':session_hash' => auth_session_hash(),
        ':user_agent' => auth_session_device_user_agent(),
    ]);
}
?>
