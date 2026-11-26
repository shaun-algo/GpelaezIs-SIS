<?php

/**
 * Family-member names remain backward-compatible with the legacy full_name
 * field while exposing safe structured name parts for new and edited records.
 */
function family_member_clean_name_part($value): ?string {
    if ($value === null) return null;
    $value = trim((string)$value);
    return $value === '' ? null : $value;
}

function family_member_parse_name(?string $raw): array {
    $raw = family_member_clean_name_part($raw);
    if ($raw === null || !str_contains($raw, ',')) {
        return [
            'first_name' => null,
            'middle_name' => null,
            'last_name' => null,
            'name_extension' => null,
        ];
    }

    $extensionMap = [
        'JR' => 'Jr.', 'SR' => 'Sr.', 'II' => 'II', 'III' => 'III', 'IV' => 'IV',
        'V' => 'V', 'VI' => 'VI', 'VII' => 'VII', 'VIII' => 'VIII', 'IX' => 'IX', 'X' => 'X',
    ];
    $parts = array_values(array_filter(array_map('trim', explode(',', $raw)), static fn ($part) => $part !== ''));
    if (count($parts) < 2) {
        return ['first_name' => null, 'middle_name' => null, 'last_name' => null, 'name_extension' => null];
    }

    $lastName = array_shift($parts);
    $tokens = preg_split('/\s+/', trim(implode(' ', $parts))) ?: [];
    $tokens = array_values(array_filter($tokens, static fn ($token) => $token !== ''));
    $extension = null;
    if ($tokens) {
        $candidate = strtoupper(trim(str_replace('.', '', (string)end($tokens))));
        if (isset($extensionMap[$candidate])) {
            array_pop($tokens);
            $extension = $extensionMap[$candidate];
        }
    }

    $firstName = array_shift($tokens) ?: null;
    $middleName = $tokens ? implode(' ', $tokens) : null;
    return [
        'first_name' => family_member_clean_name_part($firstName),
        'middle_name' => family_member_clean_name_part($middleName),
        'last_name' => family_member_clean_name_part($lastName),
        'name_extension' => $extension,
    ];
}

function family_member_build_name(?string $lastName, ?string $firstName,
                                  ?string $middleName = null, ?string $nameExtension = null): ?string {
    $lastName = family_member_clean_name_part($lastName);
    $firstName = family_member_clean_name_part($firstName);
    $middleName = family_member_clean_name_part($middleName);
    $nameExtension = family_member_clean_name_part($nameExtension);
    if ($lastName === null || $firstName === null) return null;

    $given = implode(' ', array_filter([$firstName, $middleName, $nameExtension], static fn ($part) => $part !== null));
    return $lastName . ', ' . $given;
}

function family_member_lookup_extension(PDO $conn, ?string $value): array {
    $value = family_member_clean_name_part($value);
    if ($value === null) return ['valid' => true, 'value' => null, 'message' => null];

    static $cache = [];
    $cacheKey = strtolower($value);
    if (array_key_exists($cacheKey, $cache)) return $cache[$cacheKey];

    $stmt = $conn->prepare('SELECT extension_name
                            FROM name_extensions
                            WHERE extension_name = :extension_name
                              AND is_deleted = 0
                            LIMIT 1');
    $stmt->bindValue(':extension_name', $value);
    $stmt->execute();
    $approved = $stmt->fetchColumn();
    if ($approved !== false) {
        return $cache[$cacheKey] = ['valid' => true, 'value' => (string)$approved, 'message' => null];
    }

    return $cache[$cacheKey] = [
        'valid' => false,
        'value' => $value,
        'message' => 'Name extension "' . $value . '" is not available in the Name Extensions masterfile. Select an approved suffix or leave it blank.',
    ];
}

function family_member_prepare_name(PDO $conn, ?string $fullName, ?string $firstName = null,
                                    ?string $middleName = null, ?string $lastName = null,
                                    ?string $nameExtension = null): array {
    $raw = family_member_clean_name_part($fullName);
    $parsed = family_member_parse_name($raw);

    $firstName = family_member_clean_name_part($firstName) ?? $parsed['first_name'];
    $middleName = family_member_clean_name_part($middleName) ?? $parsed['middle_name'];
    $lastName = family_member_clean_name_part($lastName) ?? $parsed['last_name'];
    $nameExtension = family_member_clean_name_part($nameExtension) ?? $parsed['name_extension'];

    $extension = family_member_lookup_extension($conn, $nameExtension);
    if (!$extension['valid']) return ['valid' => false, 'message' => $extension['message']];
    $nameExtension = $extension['value'];

    $canonical = family_member_build_name($lastName, $firstName, $middleName, $nameExtension);
    if ($canonical === null) $canonical = $raw;
    if ($canonical === null) {
        return ['valid' => false, 'message' => 'Provide a family member name or complete the first and last name fields.'];
    }

    return [
        'valid' => true,
        'full_name' => $canonical,
        'full_name_raw' => $raw ?? $canonical,
        'first_name' => $firstName,
        'middle_name' => $middleName,
        'last_name' => $lastName,
        'name_extension' => $nameExtension,
    ];
}

