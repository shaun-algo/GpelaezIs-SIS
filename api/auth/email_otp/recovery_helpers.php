<?php

require_once __DIR__ . '/../../utils/account_identity_queries.php';

/*
 * These guards let the endpoints survive a PHP OPcache process that has not
 * reloaded config.php yet. A normal Apache restart will use the same helpers
 * already defined in config.php, so they are intentionally idempotent.
 */
if (!function_exists('valid_username')) {
    function valid_username($value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $username = trim($value);
        if ($username === '' || strlen($username) > 191 || preg_match('/[\x00-\x1F\x7F]/', $username)) {
            return null;
        }

        return $username;
    }
}

if (!function_exists('otp_find_account_by_username')) {
    function otp_find_account_by_username(PDO $conn, string $username): ?array
    {
        /* Resolve the recovery address from the same active employee identity used by login. */
        $stmt = $conn->prepare(
            'SELECT ac.account_type, ac.actor_id, ac.legacy_user_id, ac.username, ac.password,
                    ac.role_id, ac.role_name, ac.is_active, ac.is_deleted, e.email
             FROM employees e
             INNER JOIN (' . account_credentials_derived_sql() . ') ac
                 ON ac.account_type = "employee"
                AND ac.actor_id = e.employee_id
                AND ac.legacy_user_id = e.user_id
             WHERE LOWER(TRIM(ac.username)) = LOWER(:username)
               AND e.is_deleted = 0
             LIMIT 2'
        );
        $stmt->execute(['username' => $username]);
        $rows = $stmt->fetchAll();

        /* Refuse ambiguous usernames or missing/invalid recovery addresses. */
        if (count($rows) !== 1) {
            return null;
        }

        $account = $rows[0];
        $accountEmail = valid_email($account['email'] ?? null);
        if ((int)$account['is_deleted'] !== 0 || (int)$account['is_active'] !== 1 || $accountEmail === null) {
            return null;
        }

        $account['email'] = $accountEmail;
        return $account;
    }
}

if (!function_exists('otp_find_account_by_identifier')) {
    function otp_find_account_by_identifier(PDO $conn, string $identifier): ?array
    {
        /* Usernames are used for normal sign-in. A 12-digit LRN is also accepted
         * so students can start adviser-assisted recovery without an email address. */
        $stmt = $conn->prepare(
            'SELECT legacy_user_id
             FROM (' . account_credentials_derived_sql() . ') ac
             WHERE LOWER(TRIM(ac.username)) = LOWER(:identifier)
             LIMIT 2'
        );
        $stmt->execute(['identifier' => $identifier]);
        $ids = array_values(array_unique(array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN))));

        if (count($ids) === 0 && preg_match('/^\d{12}$/D', $identifier)) {
            $stmt = $conn->prepare(
                'SELECT user_id
                 FROM learners
                 WHERE lrn = :identifier AND is_deleted = 0
                 LIMIT 2'
            );
            $stmt->execute(['identifier' => $identifier]);
            $ids = array_values(array_unique(array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN))));
        }

        if (count($ids) !== 1) {
            return null;
        }

        $account = account_credentials_find_by_legacy_user($conn, $ids[0]);
        if (!$account || (int)$account['is_deleted'] !== 0 || (int)$account['is_active'] !== 1) {
            return null;
        }

        return $account;
    }
}

if (!function_exists('otp_mask_email')) {
    function otp_mask_email(string $email): string
    {
        [$local, $domain] = explode('@', $email, 2);
        if (strlen($local) <= 2) {
            return substr($local, 0, 1) . '••••@' . $domain;
        }

        return substr($local, 0, 1) . '••••' . substr($local, -1) . '@' . $domain;
    }
}
