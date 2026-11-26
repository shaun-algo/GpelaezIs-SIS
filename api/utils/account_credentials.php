<?php
require_once __DIR__ . '/password_policy.php';
require_once __DIR__ . '/../services/ApplicationIntegrityService.php';
require_once __DIR__ . '/account_identity_queries.php';

// Employee actor IDs stay profile IDs; writes resolve through the central user identity.
function account_credentials_source_for_type(string $accountType): ?array {
    return match ($accountType) {
        'employee', 'system' => ['table' => 'users', 'pk' => 'user_id'],
        'learner' => ['table' => 'learners', 'pk' => 'learner_id'],
        default => null,
    };
}

function account_credentials_write_id(PDO $conn, string $accountType, int $actorId, ?int $userId): int {
    if ($accountType !== 'employee') return $actorId;
    $stmt = $conn->prepare('SELECT user_id FROM employees WHERE employee_id = ?');
    $stmt->execute([$actorId]);
    $resolved = (int)$stmt->fetchColumn();
    if ($resolved <= 0 || ($userId && $resolved !== $userId)) throw new RuntimeException('Invalid employee identity.');
    return $resolved;
}

function account_identity_create(PDO $conn, int $roleId, int $isDeleted = 0): int {
    // Learner identities deliberately have no credentials in users.
    $stmt = $conn->prepare('INSERT INTO users (role_id, is_deleted) VALUES (?, ?)');
    $stmt->execute([$roleId, $isDeleted]);
    return (int)$conn->lastInsertId();
}

function account_identity_set_deleted(PDO $conn, int $userId, bool $deleted): void {
    if ($userId <= 0 || !password_policy_has_column($conn, 'is_deleted')) {
        return;
    }
    $deletedAtSql = password_policy_has_column($conn, 'deleted_at') ? ', deleted_at = ' . ($deleted ? 'NOW()' : 'NULL') : '';
    $stmt = $conn->prepare('UPDATE users SET is_deleted = :is_deleted' . ($deleted ? ', is_active = 0' : '') . $deletedAtSql . ' WHERE user_id = :user_id');
    $stmt->bindValue(':is_deleted', $deleted ? 1 : 0, PDO::PARAM_INT);
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $stmt->execute();
}

function account_credentials_username_exists(PDO $conn, string $username, ?string $excludeType = null, ?int $excludeActorId = null): bool {
    $sql = 'SELECT COUNT(*) FROM (' . account_credentials_derived_sql() . ') ac WHERE ac.username = :username';
    if ($excludeType !== null && $excludeActorId !== null && $excludeActorId > 0) {
        $sql .= ' AND NOT (ac.account_type = :account_type AND ac.actor_id = :actor_id)';
    }
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':username', $username);
    if ($excludeType !== null && $excludeActorId !== null && $excludeActorId > 0) {
        $stmt->bindValue(':account_type', $excludeType);
        $stmt->bindValue(':actor_id', $excludeActorId, PDO::PARAM_INT);
    }
    $stmt->execute();
    return (int)$stmt->fetchColumn() > 0;
}

function account_credentials_find_by_legacy_user(PDO $conn, int $userId): ?array {
    if ($userId <= 0) return null;
    $stmt = $conn->prepare('SELECT * FROM (' . account_credentials_derived_sql() . ') ac WHERE ac.legacy_user_id = :user_id LIMIT 1');
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function account_credentials_find_by_username(PDO $conn, string $username): ?array {
    $stmt = $conn->prepare('SELECT * FROM (' . account_credentials_derived_sql() . ') ac WHERE ac.username = :username LIMIT 1');
    $stmt->bindValue(':username', $username);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function account_identity_employee_id(PDO $conn, int $userId): int {
    $employeeStmt = $conn->prepare('SELECT employee_id FROM employees WHERE user_id = :user_id AND is_deleted = 0 LIMIT 1');
    $employeeStmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $employeeStmt->execute();
    return (int)($employeeStmt->fetchColumn() ?: 0);
}

function account_identity_learner_id(PDO $conn, int $userId): int {
    $learnerStmt = $conn->prepare('SELECT learner_id FROM learners WHERE user_id = :user_id AND is_deleted = 0 LIMIT 1');
    $learnerStmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $learnerStmt->execute();
    return (int)($learnerStmt->fetchColumn() ?: 0);
}

function account_credentials_update_last_login(PDO $conn, string $accountType, int $actorId, ?int $legacyUserId = null): void {
    $source = account_credentials_source_for_type($accountType);
    $actorId = account_credentials_write_id($conn, $accountType, $actorId, $legacyUserId);
    if ($source && $actorId > 0) {
        $stmt = $conn->prepare("UPDATE `{$source['table']}` SET last_login = NOW() WHERE `{$source['pk']}` = :actor_id");
        $stmt->bindValue(':actor_id', $actorId, PDO::PARAM_INT);
        $stmt->execute();
    }
}

function account_credentials_touch_last_seen(PDO $conn, string $accountType, int $actorId, ?int $legacyUserId = null): void {
    $source = account_credentials_source_for_type($accountType);
    $actorId = account_credentials_write_id($conn, $accountType, $actorId, $legacyUserId);
    if (!$source || $actorId <= 0 || !password_policy_has_column($conn, 'last_seen_at', $source['table'])) {
        return;
    }

    $stmt = $conn->prepare("UPDATE `{$source['table']}` SET last_seen_at = NOW() WHERE `{$source['pk']}` = :actor_id");
    $stmt->bindValue(':actor_id', $actorId, PDO::PARAM_INT);
    $stmt->execute();
}

function account_credentials_clear_last_seen_by_legacy_user(PDO $conn, int $legacyUserId): void {
    if ($legacyUserId <= 0) return;
    $account = account_credentials_find_by_legacy_user($conn, $legacyUserId);
    if (!$account) return;

    $source = account_credentials_source_for_type((string)($account['account_type'] ?? ''));
    $actorId = account_credentials_write_id(
        $conn,
        (string)($account['account_type'] ?? ''),
        (int)($account['actor_id'] ?? 0),
        $legacyUserId
    );
    if (!$source || $actorId <= 0 || !password_policy_has_column($conn, 'last_seen_at', $source['table'])) {
        return;
    }

    $stmt = $conn->prepare("UPDATE `{$source['table']}` SET last_seen_at = NULL WHERE `{$source['pk']}` = :actor_id");
    $stmt->bindValue(':actor_id', $actorId, PDO::PARAM_INT);
    $stmt->execute();
}

/**
 * Return the credential row's current failed-login state.
 * The caller should hold a transaction when this state influences a login.
 */
function account_credentials_login_state(PDO $conn, string $accountType, int $actorId, ?int $legacyUserId = null): ?array {
    $source = account_credentials_source_for_type($accountType);
    $actorId = account_credentials_write_id($conn, $accountType, $actorId, $legacyUserId);
    if (!$source || $actorId <= 0) return null;

    $columns = [];
    if (password_policy_has_column($conn, 'failed_login_count', $source['table'])) $columns[] = 'failed_login_count';
    if (password_policy_has_column($conn, 'locked_until', $source['table'])) $columns[] = 'locked_until';
    if (!$columns) return ['failed_login_count' => 0, 'locked_until' => null];

    $stmt = $conn->prepare(
        'SELECT ' . implode(', ', $columns) . ' FROM `' . $source['table'] . '` WHERE `' . $source['pk'] . '` = :actor_id LIMIT 1 FOR UPDATE'
    );
    $stmt->bindValue(':actor_id', $actorId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;

    return [
        'failed_login_count' => (int)($row['failed_login_count'] ?? 0),
        'locked_until' => $row['locked_until'] ?? null,
    ];
}

/**
 * Increment failed-login state and apply a bounded account lock.
 * The caller owns the transaction so the security event and counter change
 * can commit together.
 */
function account_credentials_record_login_failure(
    PDO $conn,
    string $accountType,
    int $actorId,
    ?int $legacyUserId = null,
    int $lockThreshold = 5,
    int $lockMinutes = 15
): array {
    $source = account_credentials_source_for_type($accountType);
    $sourceActorId = $actorId;
    $actorId = account_credentials_write_id($conn, $accountType, $sourceActorId, $legacyUserId);
    if (!$source || $actorId <= 0) return ['failed_login_count' => 0, 'locked_until' => null, 'locked' => false];

    // login_state expects the account row's native actor ID. For employees
    // that is employee_id, while the write target is users.user_id.
    $state = account_credentials_login_state($conn, $accountType, $sourceActorId, $legacyUserId)
        ?? ['failed_login_count' => 0, 'locked_until' => null];
    $existingLock = $state['locked_until'] !== null && strtotime((string)$state['locked_until']) > time();
    if ($existingLock) {
        return [
            'failed_login_count' => (int)$state['failed_login_count'],
            'locked_until' => $state['locked_until'],
            'locked' => true,
        ];
    }

    $nextCount = (int)$state['failed_login_count'] + 1;
    $shouldLock = $nextCount >= max(1, $lockThreshold);
    $sets = [];
    $params = [];
    if (password_policy_has_column($conn, 'failed_login_count', $source['table'])) {
        $sets[] = 'failed_login_count = :failed_login_count';
        $params[':failed_login_count'] = $nextCount;
    }
    if (password_policy_has_column($conn, 'locked_until', $source['table'])) {
        if ($shouldLock) {
            $sets[] = 'locked_until = :locked_until';
            $params[':locked_until'] = date('Y-m-d H:i:s', time() + (max(1, min(1440, $lockMinutes)) * 60));
        } else {
            $sets[] = 'locked_until = NULL';
        }
    }
    if ($sets) {
        $stmt = $conn->prepare('UPDATE `' . $source['table'] . '` SET ' . implode(', ', $sets) . ' WHERE `' . $source['pk'] . '` = :actor_id');
        $stmt->bindValue(':actor_id', $actorId, PDO::PARAM_INT);
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value, str_contains($key, 'count') ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $stmt->execute();
    }

    return [
        'failed_login_count' => $nextCount,
        'locked_until' => $shouldLock ? date('Y-m-d H:i:s', time() + (max(1, min(1440, $lockMinutes)) * 60)) : null,
        'locked' => $shouldLock,
    ];
}

/**
 * Reset failed-login state after a successful authentication and update the
 * last-login timestamp in the account's credential source.
 */
function account_credentials_record_login_success(PDO $conn, string $accountType, int $actorId, ?int $legacyUserId = null): void {
    $source = account_credentials_source_for_type($accountType);
    $actorId = account_credentials_write_id($conn, $accountType, $actorId, $legacyUserId);
    if (!$source || $actorId <= 0) return;

    $sets = [];
    if (password_policy_has_column($conn, 'failed_login_count', $source['table'])) $sets[] = 'failed_login_count = 0';
    if (password_policy_has_column($conn, 'locked_until', $source['table'])) $sets[] = 'locked_until = NULL';
    if (password_policy_has_column($conn, 'last_login', $source['table'])) $sets[] = 'last_login = NOW()';
    if (password_policy_has_column($conn, 'last_seen_at', $source['table'])) $sets[] = 'last_seen_at = NOW()';
    if (!$sets) return;

    $stmt = $conn->prepare('UPDATE `' . $source['table'] . '` SET ' . implode(', ', $sets) . ' WHERE `' . $source['pk'] . '` = :actor_id');
    $stmt->bindValue(':actor_id', $actorId, PDO::PARAM_INT);
    $stmt->execute();
}

function account_credentials_mark_default_password(PDO $conn, string $accountType, int $actorId, ?int $legacyUserId = null): void {
    $source = account_credentials_source_for_type($accountType);
    $actorId = account_credentials_write_id($conn, $accountType, $actorId, $legacyUserId);
    if ($source && $actorId > 0) {
        $sql = "UPDATE `{$source['table']}` SET `{$source['pk']}` = `{$source['pk']}`" . password_policy_default_update_sql($conn, $source['table']) . " WHERE `{$source['pk']}` = :actor_id";
        $stmt = $conn->prepare($sql);
        $stmt->bindValue(':actor_id', $actorId, PDO::PARAM_INT);
        $stmt->execute();
    }
}

function account_credentials_change_password(PDO $conn, string $accountType, int $actorId, ?int $legacyUserId, string $passwordHash): void {
    $source = account_credentials_source_for_type($accountType);
    $actorId = account_credentials_write_id($conn, $accountType, $actorId, $legacyUserId);
    if (!$source || $actorId <= 0) {
        throw new RuntimeException('Invalid account source for password update.');
    }

    $sql = "UPDATE `{$source['table']}` SET password = :password" . password_policy_changed_update_sql($conn, $source['table']) . " WHERE `{$source['pk']}` = :actor_id";
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':password', $passwordHash);
    $stmt->bindValue(':actor_id', $actorId, PDO::PARAM_INT);
    $stmt->execute();

    // The former learners/users password triggers invalidated every active
    // session. Keep that security invariant in the shared application path.
    if ($accountType === 'learner') {
        app_integrity_bump_auth_version_for_learner($conn, $actorId);
    } else {
        app_integrity_bump_auth_version($conn, $actorId);
    }

}
?>
