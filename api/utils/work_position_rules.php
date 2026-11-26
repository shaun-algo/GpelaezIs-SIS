<?php

/**
 * Work-position rules shared by user, employee, position, and archive flows.
 * Position IDs are only used to reach the stored position row; the business
 * rule itself is based on the normalized position text.
 */
function work_position_normalize_name($value): string {
    $name = trim((string)($value ?? ''));
    $name = preg_replace('/\s+/u', ' ', $name) ?? $name;
    return function_exists('mb_strtolower')
        ? mb_strtolower($name, 'UTF-8')
        : strtolower($name);
}

function work_position_is_principal($value): bool {
    return work_position_normalize_name($value) === 'principal';
}

function work_position_get(PDO $conn, int $positionId, bool $forUpdate = false): ?array {
    if ($positionId <= 0) return null;
    $sql = 'SELECT position_id, position_name, is_deleted FROM positions WHERE position_id = ? LIMIT 1';
    if ($forUpdate) $sql .= ' FOR UPDATE';
    $stmt = $conn->prepare($sql);
    $stmt->execute([$positionId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function work_position_assert_name_available(PDO $conn, string $positionName, ?int $excludeId = null): void {
    $normalized = work_position_normalize_name($positionName);
    if ($normalized === '') {
        throw new DomainException('Work position is required.');
    }

    $rows = $conn->query('SELECT position_id, position_name, is_deleted FROM positions WHERE position_name IS NOT NULL ORDER BY position_id FOR UPDATE')
        ->fetchAll(PDO::FETCH_ASSOC);
    $archivedMatch = false;
    foreach ($rows as $row) {
        $id = (int)($row['position_id'] ?? 0);
        if ($excludeId !== null && $id === $excludeId) continue;
        if (work_position_normalize_name($row['position_name'] ?? '') !== $normalized) continue;

        if ((int)($row['is_deleted'] ?? 0) === 1) {
            $archivedMatch = true;
            continue;
        }
        throw new DomainException('This work position already exists. Use the existing position instead.');
    }
    if ($archivedMatch) {
        throw new DomainException('This work position already exists in the archive. Please restore that position to use it.');
    }
}

function work_position_active_user_count(PDO $conn, int $positionId, ?int $excludeUserId = null): int {
    if ($positionId <= 0) return 0;
    $sql = 'SELECT COUNT(*)
            FROM employees e
            JOIN users u ON u.user_id = e.user_id
            WHERE e.position_id = ?
              AND e.is_deleted = 0
              AND u.is_deleted = 0
              AND u.is_active = 1';
    $params = [$positionId];
    if ($excludeUserId !== null && $excludeUserId > 0) {
        $sql .= ' AND u.user_id <> ?';
        $params[] = $excludeUserId;
    }
    $stmt = $conn->prepare($sql);
    $stmt->execute($params);
    return (int)$stmt->fetchColumn();
}

function work_position_assert_principal_available(PDO $conn, ?int $positionId, ?int $excludeUserId = null, string $context = 'assignment'): void {
    if (!$positionId || $positionId <= 0) return;

    // Lock and inspect all active position names so this rule remains text-
    // based even if old data contains more than one Principal seed row.
    $positions = $conn->query('SELECT position_id, position_name FROM positions WHERE is_deleted = 0 ORDER BY position_id FOR UPDATE')
        ->fetchAll(PDO::FETCH_ASSOC);
    $principalPositionIds = [];
    $selectedIsPrincipal = false;
    foreach ($positions as $position) {
        $currentId = (int)($position['position_id'] ?? 0);
        if ($currentId === $positionId) {
            $selectedIsPrincipal = work_position_is_principal($position['position_name'] ?? null);
        }
        if (work_position_is_principal($position['position_name'] ?? null)) {
            $principalPositionIds[] = $currentId;
        }
    }
    if (!$selectedIsPrincipal || !$principalPositionIds) return;

    $placeholders = implode(',', array_fill(0, count($principalPositionIds), '?'));
    $sql = 'SELECT COUNT(*)
            FROM employees e
            JOIN users u ON u.user_id = e.user_id
            WHERE e.position_id IN (' . $placeholders . ')
              AND e.is_deleted = 0
              AND u.is_deleted = 0
              AND u.is_active = 1';
    $params = $principalPositionIds;
    if ($excludeUserId !== null && $excludeUserId > 0) {
        $sql .= ' AND u.user_id <> ?';
        $params[] = $excludeUserId;
    }
    $stmt = $conn->prepare($sql);
    $stmt->execute($params);
    if ((int)$stmt->fetchColumn() > 0) {
        if ($context === 'restore') {
            throw new DomainException('This archived account cannot be restored because another active account already uses the Principal work position. Reassign or archive the current Principal account first, then try again.');
        }
        throw new DomainException('Only one active user account may use the Principal work position. Reassign or archive the existing Principal account before continuing.');
    }
}

function work_position_assert_proposed_principal_available(PDO $conn, int $positionId): void {
    if ($positionId <= 0) return;
    $positions = $conn->query('SELECT position_id, position_name FROM positions WHERE is_deleted = 0 ORDER BY position_id FOR UPDATE')
        ->fetchAll(PDO::FETCH_ASSOC);
    $principalPositionIds = [$positionId];
    foreach ($positions as $position) {
        $currentId = (int)($position['position_id'] ?? 0);
        if ($currentId !== $positionId && work_position_is_principal($position['position_name'] ?? null)) {
            $principalPositionIds[] = $currentId;
        }
    }

    $placeholders = implode(',', array_fill(0, count($principalPositionIds), '?'));
    $stmt = $conn->prepare(
        'SELECT COUNT(*) FROM employees e
         JOIN users u ON u.user_id = e.user_id
         WHERE e.position_id IN (' . $placeholders . ')
           AND e.is_deleted = 0
           AND u.is_deleted = 0
           AND u.is_active = 1'
    );
    $stmt->execute($principalPositionIds);
    if ((int)$stmt->fetchColumn() > 1) {
        throw new DomainException('This position cannot be renamed to Principal while more than one active user account is assigned to Principal.');
    }
}

function work_position_assert_can_archive(PDO $conn, int $positionId): void {
    if (work_position_active_user_count($conn, $positionId) > 0) {
        throw new DomainException('This work position is assigned to an active user account. Reassign or archive that account before archiving the position.');
    }
}
