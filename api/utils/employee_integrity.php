<?php
require_once __DIR__ . '/account_identity_queries.php';
// Employee integrity / validation layer.
// Centralizes the rules that keep employee registration accurate and prevent
// employee accounts from being assigned learner roles.

require_once __DIR__ . '/auth.php';

const EI_EMPLOYEE_NUMBER_MIN = 3;
const EI_EMPLOYEE_NUMBER_MAX = 50;
const EI_NAME_MAX = 100;
const EI_EXTENSION_MAX = 10;
const EI_MIN_AGE = 18;
const EI_MAX_AGE = 100;

/**
 * Determine whether the supplied role is forbidden for an employee.
 * Any role whose normalized key is "learners" (Learner, Student, etc.) is blocked.
 */
function ei_is_forbidden_employee_role(PDO $conn, int $roleId): bool {
    $stmt = $conn->prepare('SELECT role_name FROM roles WHERE role_id = :role_id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':role_id', $roleId, PDO::PARAM_INT);
    $stmt->execute();
    $roleName = $stmt->fetchColumn();
    if ($roleName === false || $roleName === null) {
        return true;
    }
    return auth_normalize_role((string)$roleName) === 'learners';
}

function ei_get_role_name(PDO $conn, int $roleId): ?string {
    $stmt = $conn->prepare('SELECT role_name FROM roles WHERE role_id = :role_id AND is_deleted = 0 LIMIT 1');
    $stmt->bindValue(':role_id', $roleId, PDO::PARAM_INT);
    $stmt->execute();
    $name = $stmt->fetchColumn();
    return ($name === false || $name === null) ? null : (string)$name;
}

function ei_role_exists(PDO $conn, int $roleId): bool {
    return ei_get_role_name($conn, $roleId) !== null;
}

function ei_validate_employee_number(string $value): array {
    $v = trim($value);
    if ($v === '') {
        return [false, 'Employee number is required.'];
    }
    if (strlen($v) < EI_EMPLOYEE_NUMBER_MIN || strlen($v) > EI_EMPLOYEE_NUMBER_MAX) {
        return [false, 'Employee number must be between ' . EI_EMPLOYEE_NUMBER_MIN . ' and ' . EI_EMPLOYEE_NUMBER_MAX . ' characters.'];
    }
    if (!preg_match('/^[A-Za-z0-9\-_.]+$/', $v)) {
        return [false, 'Employee number may only contain letters, numbers, dashes, underscores, and periods.'];
    }
    return [true, ''];
}

function ei_validate_name(string $value, bool $required, string $label): array {
    $v = trim($value);
    if ($required && $v === '') {
        return [false, "$label is required."];
    }
    if ($v === '') {
        return [true, ''];
    }
    if (strlen($v) > EI_NAME_MAX) {
        return [false, "$label must be at most " . EI_NAME_MAX . ' characters.'];
    }
    if (!preg_match("/^[\\p{L}\\s\\-'\\.]+$/u", $v)) {
        return [false, "$label may only contain letters, spaces, dashes, apostrophes, and periods."];
    }
    return [true, ''];
}

function ei_validate_name_extension(?string $value): array {
    $v = trim((string)$value);
    if ($v === '') {
        return [true, ''];
    }
    if (strlen($v) > EI_EXTENSION_MAX) {
        return [false, 'Name extension must be at most ' . EI_EXTENSION_MAX . ' characters.'];
    }
    if (!preg_match("/^[\\p{L}0-9\\s\\-'\\.]+$/u", $v)) {
        return [false, 'Name extension contains invalid characters.'];
    }
    return [true, ''];
}

function ei_normalize_date(?string $value): ?string {
    if ($value === null || trim($value) === '') {
        return null;
    }
    $s = trim($value);
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) && checkdate((int)substr($s, 5, 2), (int)substr($s, 8, 2), (int)substr($s, 0, 4))) {
        return $s;
    }
    if (preg_match('/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/', $s, $m)) {
        $y = (int)$m[3];
        $mm = (int)$m[1];
        $dd = (int)$m[2];
        if (checkdate($mm, $dd, $y)) {
            return sprintf('%04d-%02d-%02d', $y, $mm, $dd);
        }
    }
    return $s; // un-normalized; the date validator will catch invalid formats
}

function ei_validate_date(?string $value, string $label, bool $required = false, ?string $notAfter = null, ?string $notBefore = null): array {
    if ($value === null || trim($value) === '') {
        if ($required) {
            return [false, "$label is required."];
        }
        return [true, ''];
    }
    $s = trim($value);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) || !checkdate((int)substr($s, 5, 2), (int)substr($s, 8, 2), (int)substr($s, 0, 4))) {
        return [false, "$label must be a valid date (YYYY-MM-DD)."];
    }
    if ($notAfter !== null && $s > $notAfter) {
        return [false, "$label cannot be later than $notAfter."];
    }
    if ($notBefore !== null && $s < $notBefore) {
        return [false, "$label cannot be earlier than $notBefore."];
    }
    return [true, ''];
}

function ei_compute_age(string $dob): int {
    try {
        $birth = new DateTime($dob);
        $now = new DateTime();
        return (int)$now->diff($birth)->y;
    } catch (Throwable $e) {
        return 0;
    }
}

function ei_validate_date_of_birth(?string $dob): array {
    if ($dob === null || trim($dob) === '') {
        return [true, ''];
    }
    $today = date('Y-m-d');
    $result = ei_validate_date($dob, 'Birth date', true, $today, '1900-01-01');
    if (!$result[0]) {
        return $result;
    }
    $age = ei_compute_age($dob);
    if ($age < EI_MIN_AGE) {
        return [false, 'Employee must be at least ' . EI_MIN_AGE . ' years old.'];
    }
    if ($age > EI_MAX_AGE) {
        return [false, 'Birth date appears unrealistic (age over ' . EI_MAX_AGE . ').'];
    }
    return [true, ''];
}

function ei_validate_date_hired(?string $hired, ?string $dob = null): array {
    if ($hired === null || trim($hired) === '') {
        return [true, ''];
    }
    $today = date('Y-m-d');
    $result = ei_validate_date($hired, 'Date hired', false, $today);
    if (!$result[0]) {
        return $result;
    }
    if ($dob !== null && $hired < $dob) {
        return [false, 'Date hired cannot be earlier than birth date.'];
    }
    return [true, ''];
}

function ei_normalize_contact_number(?string $value): ?string {
    if ($value === null || trim($value) === '') {
        return null;
    }
    $raw = trim($value);
    $digits = preg_replace('/\D/', '', $raw);
    if (strlen($digits) === 12 && strpos($digits, '63') === 0) {
        return '0' . substr($digits, 2);
    }
    if (strlen($digits) === 10 && strpos($digits, '9') === 0) {
        return '0' . $digits;
    }
    if (strlen($digits) === 11 && strpos($digits, '09') === 0) {
        return $digits;
    }
    return $raw; // return as-is for the caller to validate
}

function ei_validate_contact_number(?string $value): array {
    if ($value === null || trim($value) === '') {
        return [true, '', null];
    }
    $canonical = ei_normalize_contact_number($value);
    if (preg_match('/^09\d{9}$/', $canonical)) {
        return [true, '', $canonical];
    }
    return [false, 'Contact number must be a valid PH mobile number (e.g. 09123456789 or +639123456789).', null];
}

function ei_validate_email(?string $value): array {
    if ($value === null || trim($value) === '') {
        return [true, ''];
    }
    $v = trim($value);
    if (strlen($v) > 150) {
        return [false, 'Email address is too long.'];
    }
    if (!filter_var($v, FILTER_VALIDATE_EMAIL)) {
        return [false, 'Email address is invalid.'];
    }
    return [true, ''];
}

function ei_validate_gender(?string $value): array {
    $allowed = ['Male', 'Female', 'Other'];
    $v = trim((string)$value);
    if ($v === '') {
        return [true, ''];
    }
    if (!in_array($v, $allowed, true)) {
        return [false, 'Gender must be Male, Female, or Other.'];
    }
    return [true, ''];
}

function ei_employee_number_exists(PDO $conn, string $employeeNumber, ?int $excludeUserId = null, ?int $excludeEmployeeId = null): bool {
    $sql = 'SELECT COUNT(*) FROM employees WHERE employee_number = :emp_no AND is_deleted = 0';
    $params = [':emp_no' => $employeeNumber];
    if ($excludeEmployeeId !== null && $excludeEmployeeId > 0) {
        $sql .= ' AND employee_id != :exclude_employee_id';
        $params[':exclude_employee_id'] = $excludeEmployeeId;
    }
    $stmt = $conn->prepare($sql);
    $stmt->execute($params);
    if ((int)$stmt->fetchColumn() > 0) {
        return true;
    }

    $sql = 'SELECT COUNT(*) FROM (' . account_credentials_derived_sql() . ') ac WHERE ac.username = :emp_no AND ac.is_deleted = 0';
    $params = [':emp_no' => $employeeNumber];
    if ($excludeUserId !== null && $excludeUserId > 0) {
        $sql .= ' AND COALESCE(legacy_user_id, 0) != :exclude_user_id';
        $params[':exclude_user_id'] = $excludeUserId;
    }
    $stmt = $conn->prepare($sql);
    $stmt->execute($params);
    return (int)$stmt->fetchColumn() > 0;
}

/**
 * Full employee payload validation for create / update.
 *
 * Returns [
 *     'valid' => bool,
 *     'errors' => [field => message, ...],
 *     'normalized' => [field => cleanValue, ...]
 * ]
 */
function ei_validate_employee_payload(
    PDO $conn,
    array $data,
    bool $isCreate,
    ?int $excludeUserId = null,
    ?int $excludeEmployeeId = null
): array {
    $errors = [];
    $normalized = [];

    $employeeNumber = isset($data['employee_number']) ? trim((string)$data['employee_number']) : '';
    [$ok, $msg] = ei_validate_employee_number($employeeNumber);
    if (!$ok) {
        $errors['employee_number'] = $msg;
    }
    $normalized['employee_number'] = $employeeNumber;

    foreach (['first_name' => 'First name', 'last_name' => 'Last name', 'middle_name' => 'Middle name'] as $key => $label) {
        $val = isset($data[$key]) ? (string)$data[$key] : '';
        $required = in_array($key, ['first_name', 'last_name'], true);
        [$ok, $msg] = ei_validate_name($val, $required, $label);
        if (!$ok) {
            $errors[$key] = $msg;
        }
        $normalized[$key] = trim($val) ?: null;
    }

    $nameExt = isset($data['name_extension']) ? (string)$data['name_extension'] : null;
    [$ok, $msg] = ei_validate_name_extension($nameExt);
    if (!$ok) {
        $errors['name_extension'] = $msg;
    }
    $normalized['name_extension'] = ($nameExt !== null ? trim($nameExt) : '') ?: null;

    $dob = !empty($data['date_of_birth']) ? ei_normalize_date($data['date_of_birth']) : null;
    $hired = !empty($data['date_hired']) ? ei_normalize_date($data['date_hired']) : null;

    [$ok, $msg] = ei_validate_date_of_birth($dob);
    if (!$ok) {
        $errors['date_of_birth'] = $msg;
    }
    [$ok, $msg] = ei_validate_date_hired($hired, $dob);
    if (!$ok) {
        $errors['date_hired'] = $msg;
    }
    $normalized['date_of_birth'] = $dob;
    $normalized['date_hired'] = $hired;

    $gender = isset($data['gender']) ? trim((string)$data['gender']) : null;
    [$ok, $msg] = ei_validate_gender($gender);
    if (!$ok) {
        $errors['gender'] = $msg;
    }
    $normalized['gender'] = $gender ?: null;

    [$ok, $msg, $canonicalContact] = ei_validate_contact_number($data['contact_number'] ?? null);
    if (!$ok) {
        $errors['contact_number'] = $msg;
    }
    $normalized['contact_number'] = $canonicalContact;

    [$ok, $msg] = ei_validate_email($data['email'] ?? null);
    if (!$ok) {
        $errors['email'] = $msg;
    }
    $normalized['email'] = !empty($data['email']) ? trim((string)$data['email']) : null;

    $positionId = isset($data['position_id']) && $data['position_id'] !== '' ? (int)$data['position_id'] : null;
    if ($positionId !== null && $positionId <= 0) {
        $positionId = null;
    }
    $normalized['position_id'] = $positionId;

    $normalized['address'] = !empty($data['address']) ? trim((string)$data['address']) : null;

    $roleId = $data['role_id'] ?? null;
    if ($roleId === '' || $roleId === null) {
        if ($isCreate) {
            $errors['role_id'] = 'Role is required.';
        }
    } else {
        $roleIdInt = is_numeric($roleId) ? (int)$roleId : 0;
        if ($roleIdInt <= 0) {
            $errors['role_id'] = 'Role is invalid.';
        } else {
            $roleName = ei_get_role_name($conn, $roleIdInt);
            if ($roleName === null) {
                $errors['role_id'] = 'Selected role does not exist.';
            } elseif (ei_is_forbidden_employee_role($conn, $roleIdInt)) {
                $errors['role_id'] = 'Employees cannot be assigned the Learner role.';
            }
            $normalized['role_id'] = $roleIdInt;
        }
    }

    if ($isCreate || (isset($data['employee_number']) && $employeeNumber !== '')) {
        if (ei_employee_number_exists($conn, $employeeNumber, $excludeUserId, $excludeEmployeeId)) {
            $existing = $errors['employee_number'] ?? '';
            $errors['employee_number'] = ($existing ? $existing . ' ' : '') . 'Employee number is already in use.';
        }
    }

    return [
        'valid' => empty($errors),
        'errors' => $errors,
        'normalized' => $normalized,
    ];
}

/**
 * Validation for the self-service employee profile update endpoint.
 * Only validates the fields that were actually supplied.
 */
function ei_validate_employee_self_update(array $data): array {
    $errors = [];
    $normalized = [];

    foreach (['first_name' => 'First name', 'last_name' => 'Last name', 'middle_name' => 'Middle name'] as $key => $label) {
        if (!array_key_exists($key, $data)) {
            continue;
        }
        [$ok, $msg] = ei_validate_name((string)$data[$key], $key !== 'middle_name', $label);
        if (!$ok) {
            $errors[$key] = $msg;
        }
        $normalized[$key] = trim((string)$data[$key]) ?: null;
    }

    if (array_key_exists('name_extension', $data)) {
        [$ok, $msg] = ei_validate_name_extension((string)$data['name_extension']);
        if (!$ok) {
            $errors['name_extension'] = $msg;
        }
        $normalized['name_extension'] = trim((string)$data['name_extension']) ?: null;
    }

    if (array_key_exists('date_of_birth', $data)) {
        $dob = !empty($data['date_of_birth']) ? ei_normalize_date($data['date_of_birth']) : null;
        [$ok, $msg] = ei_validate_date_of_birth($dob);
        if (!$ok) {
            $errors['date_of_birth'] = $msg;
        }
        $normalized['date_of_birth'] = $dob;
    }

    if (array_key_exists('date_hired', $data)) {
        $hired = !empty($data['date_hired']) ? ei_normalize_date($data['date_hired']) : null;
        $dob = $normalized['date_of_birth'] ?? null;
        [$ok, $msg] = ei_validate_date_hired($hired, $dob);
        if (!$ok) {
            $errors['date_hired'] = $msg;
        }
        $normalized['date_hired'] = $hired;
    }

    if (array_key_exists('gender', $data)) {
        [$ok, $msg] = ei_validate_gender((string)$data['gender']);
        if (!$ok) {
            $errors['gender'] = $msg;
        }
        $normalized['gender'] = trim((string)$data['gender']) ?: null;
    }

    if (array_key_exists('contact_number', $data)) {
        [$ok, $msg, $canonical] = ei_validate_contact_number($data['contact_number']);
        if (!$ok) {
            $errors['contact_number'] = $msg;
        }
        $normalized['contact_number'] = $canonical;
    }

    if (array_key_exists('email', $data)) {
        [$ok, $msg] = ei_validate_email($data['email']);
        if (!$ok) {
            $errors['email'] = $msg;
        }
        $normalized['email'] = trim((string)$data['email']) ?: null;
    }

    if (array_key_exists('address', $data)) {
        $normalized['address'] = trim((string)$data['address']) ?: null;
    }

    if (array_key_exists('position_id', $data)) {
        $pid = is_numeric($data['position_id']) ? (int)$data['position_id'] : null;
        $normalized['position_id'] = ($pid !== null && $pid > 0) ? $pid : null;
    }

    return [
        'valid' => empty($errors),
        'errors' => $errors,
        'normalized' => $normalized,
    ];
}
