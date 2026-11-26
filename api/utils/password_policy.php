<?php
function password_policy_user_columns(PDO $conn, string $table = 'users'): array {
    static $cache = [];
    $table = preg_replace('/[^A-Za-z0-9_]/', '', $table) ?: 'users';
    if (isset($cache[$table])) {
        return $cache[$table];
    }

    $cache[$table] = [];
    try {
        $stmt = $conn->query('SHOW COLUMNS FROM `' . $table . '`');
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $field = strtolower((string)($row['Field'] ?? ''));
            if ($field !== '') {
                $cache[$table][$field] = true;
            }
        }
    } catch (Throwable $e) {
        $cache[$table] = [];
    }
    return $cache[$table];
}

function password_policy_has_column(PDO $conn, string $column, string $table = 'users'): bool {
    $columns = password_policy_user_columns($conn, $table);
    return !empty($columns[strtolower($column)]);
}

function password_policy_select_fields(PDO $conn, string $alias = 'u', string $table = 'users'): string {
    $fields = '';
    if (password_policy_has_column($conn, 'must_change_password', $table)) {
        $fields .= ', ' . $alias . '.must_change_password';
    }
    if (password_policy_has_column($conn, 'password_updated_at', $table)) {
        $fields .= ', ' . $alias . '.password_updated_at';
    }
    return $fields;
}

function password_policy_default_insert_sql(PDO $conn, string $table = 'users'): array {
    $columns = '';
    $values = '';
    if (password_policy_has_column($conn, 'must_change_password', $table)) {
        $columns .= ', must_change_password';
        $values .= ', 1';
    }
    if (password_policy_has_column($conn, 'password_updated_at', $table)) {
        $columns .= ', password_updated_at';
        $values .= ', NULL';
    }
    return [$columns, $values];
}

function password_policy_default_update_sql(PDO $conn, string $table = 'users'): string {
    $sql = '';
    if (password_policy_has_column($conn, 'must_change_password', $table)) {
        $sql .= ', must_change_password = 1';
    }
    if (password_policy_has_column($conn, 'password_updated_at', $table)) {
        $sql .= ', password_updated_at = NULL';
    }
    return $sql;
}

function password_policy_changed_update_sql(PDO $conn, string $table = 'users'): string {
    $sql = '';
    if (password_policy_has_column($conn, 'must_change_password', $table)) {
        $sql .= ', must_change_password = 0';
    }
    if (password_policy_has_column($conn, 'password_updated_at', $table)) {
        $sql .= ', password_updated_at = NOW()';
    }
    return $sql;
}

function password_policy_validate_new_password(string $newPassword, string $username, ?string $currentPassword = null): array {
    $errors = [];
    if (mb_strlen($newPassword, 'UTF-8') < 8) {
        $errors[] = 'Use at least 8 characters.';
    }
    if (!preg_match('/[A-Z]/', $newPassword)) $errors[] = 'Include a capital letter.';
    if (!preg_match('/[0-9]/', $newPassword)) $errors[] = 'Include a number.';
    if (strlen($newPassword) > 72) $errors[] = 'Use at most 72 bytes (72 plain English characters).';
    if (strpos($newPassword, chr(0)) !== false) $errors[] = 'Unsupported password character.';
    if ($username !== '' && strtolower($newPassword) === strtolower($username)) {
        $errors[] = 'Do not use your username as your password.';
    }
    if ($currentPassword !== null && $newPassword === $currentPassword) {
        $errors[] = 'Choose a password different from your current password.';
    }
    return $errors;
}
?>
