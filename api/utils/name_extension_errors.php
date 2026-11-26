<?php

/**
 * Detect the two lookup constraints without exposing SQL details to clients.
 * Other integrity errors must continue through their existing handlers.
 */
function is_name_extension_fk_violation(Throwable $exception): bool {
    if ((string)$exception->getCode() !== '23000') {
        return false;
    }

    $details = [$exception->getMessage()];
    if ($exception instanceof PDOException && is_array($exception->errorInfo ?? null)) {
        $details = array_merge($details, $exception->errorInfo);
    }

    $message = strtolower(implode(' ', array_map('strval', array_filter($details, static fn ($value) => $value !== null))));
    return str_contains($message, 'fk_employees_name_extension')
        || str_contains($message, 'fk_learners_name_extension');
}

function name_extension_fk_error_payload(): array {
    $fieldMessage = 'Select an approved name extension from the Name Extensions masterfile, or leave this field blank.';

    return [
        'success' => false,
        'code' => 'INVALID_NAME_EXTENSION',
        'message' => 'The supplied name extension is not approved. Select a value from the Name Extensions masterfile or leave it blank.',
        'errors' => [
            'name_extension' => $fieldMessage,
        ],
    ];
}

