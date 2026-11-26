<?php
declare(strict_types=1);

/**
 * Shared exact-name checks for editable lookup masterfiles.
 *
 * The database collation remains authoritative for case sensitivity; the
 * application trims the submitted value before checking so whitespace-only
 * differences cannot bypass the validator.
 */
function unique_name_exists(
    PDO $conn,
    string $table,
    string $column,
    string $value,
    ?string $idColumn = null,
    ?int $ignoreId = null
): bool {
    foreach ([$table, $column, $idColumn] as $identifier) {
        if ($identifier !== null && !preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $identifier)) {
            throw new InvalidArgumentException('Invalid unique-name validation identifier.');
        }
    }

    $sql = "SELECT 1 FROM `{$table}` WHERE `{$column}` = :unique_name";
    if ($idColumn !== null && $ignoreId !== null) {
        $sql .= " AND `{$idColumn}` <> :ignore_id";
    }
    $sql .= ' LIMIT 1';

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':unique_name', trim($value));
    if ($idColumn !== null && $ignoreId !== null) {
        $stmt->bindValue(':ignore_id', $ignoreId, PDO::PARAM_INT);
    }
    $stmt->execute();
    return (bool)$stmt->fetchColumn();
}

function unique_name_error_payload(string $field, string $label): array {
    $message = $label . ' already taken. Choose a different ' . strtolower($label) . '.';
    return [
        'success' => false,
        'message' => $message,
        'errors' => [$field => $message],
    ];
}
