<?php
declare(strict_types=1);

/**
 * SQL projections used in place of the account_credentials_v and
 * user_identity_v database views. InfinityFree's shared MySQL service does
 * not reliably permit application-created views, so callers embed these
 * read-only projections as derived tables.
 */
function account_credentials_derived_sql(): string
{
    return <<<'SQL'
SELECT CASE WHEN e.employee_id IS NULL THEN 'system' ELSE 'employee' END AS account_type,
       COALESCE(e.employee_id, u.user_id) AS actor_id,
       u.user_id AS legacy_user_id,
       u.username,
       u.password,
       u.must_change_password,
       u.password_updated_at,
       u.failed_login_count,
       u.locked_until,
       u.role_id,
       r.role_name,
       u.is_active,
       u.last_login,
       u.last_seen_at,
       GREATEST(COALESCE(u.is_deleted, 0), COALESCE(e.is_deleted, 0)) AS is_deleted,
       COALESCE(u.deleted_at, e.deleted_at) AS deleted_at
FROM users u
LEFT JOIN employees e ON e.user_id = u.user_id
LEFT JOIN roles r ON r.role_id = u.role_id
WHERE u.username IS NOT NULL
UNION ALL
SELECT 'learner' AS account_type,
       l.learner_id AS actor_id,
       l.user_id AS legacy_user_id,
       l.username,
       l.password,
       l.must_change_password,
       l.password_updated_at,
       l.failed_login_count,
       l.locked_until,
       u.role_id,
       r.role_name,
       l.is_active,
       l.last_login,
       l.last_seen_at,
       GREATEST(COALESCE(l.is_deleted, 0), COALESCE(u.is_deleted, 0)) AS is_deleted,
       COALESCE(l.deleted_at, u.deleted_at) AS deleted_at
FROM learners l
JOIN users u ON u.user_id = l.user_id
LEFT JOIN roles r ON r.role_id = u.role_id
WHERE l.username IS NOT NULL
SQL;
}

function user_identity_derived_sql(): string
{
    $accounts = account_credentials_derived_sql();
    return "SELECT ac.legacy_user_id AS user_id,
                    ac.username,
                    ac.role_id,
                    ac.role_name,
                    ac.is_active,
                    ac.last_login,
                    ac.last_seen_at,
                    ac.is_deleted,
                    ac.deleted_at,
                    ac.account_type,
                    ac.actor_id
             FROM ({$accounts}) ac
             WHERE ac.legacy_user_id IS NOT NULL
             UNION ALL
             SELECT u.user_id,
                    CONCAT('Identity #', u.user_id) AS username,
                    u.role_id,
                    r.role_name,
                    CASE WHEN COALESCE(u.is_deleted, 0) = 1 THEN 0 ELSE 1 END AS is_active,
                    NULL AS last_login,
                    NULL AS last_seen_at,
                    u.is_deleted,
                    u.deleted_at,
                    'identity' AS account_type,
                    u.user_id AS actor_id
             FROM users u
             LEFT JOIN roles r ON r.role_id = u.role_id
             WHERE NOT EXISTS (
                 SELECT 1
                 FROM ({$accounts}) ac_missing
                 WHERE ac_missing.legacy_user_id = u.user_id
             )";
}
