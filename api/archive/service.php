<?php
// Masterfile archives use existing soft-delete columns. No schema or data migration.
require_once __DIR__ . '/../utils/work_position_rules.php';

function archive_modules(PDO $db): array {
    $config = json_decode(file_get_contents(__DIR__ . '/modules.json'), true, 512, JSON_THROW_ON_ERROR);
    $columns = $db->query("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()")->fetchAll(PDO::FETCH_ASSOC);
    $schema = [];
    foreach ($columns as $column) $schema[$column['TABLE_NAME']][] = $column['COLUMN_NAME'];
    foreach ($config as $table => &$module) {
        if (!isset($schema[$table]) || !in_array('is_deleted', $schema[$table], true)) {
            unset($config[$table]);
            continue;
        }
        $module['fields'] = array_values(array_intersect(array_merge([$module['pk']], $module['fields'], ['deleted_at']), $schema[$table]));
        $module['label'] = ucwords(str_replace('_', ' ', $table));
    }
    return $config;
}

function archive_dependencies(PDO $db, string $table, array $row, array $skip = []): void {
    // FK identifiers come only from database metadata, never request parameters.
    $stmt = $db->prepare('SELECT k.COLUMN_NAME, k.REFERENCED_TABLE_NAME AS parent_table, k.REFERENCED_COLUMN_NAME AS parent_key
        FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = k.REFERENCED_TABLE_SCHEMA
            AND c.TABLE_NAME = k.REFERENCED_TABLE_NAME AND c.COLUMN_NAME = "is_deleted"
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL');
    $stmt->execute([$table]);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $fk) {
        $value = $row[$fk['COLUMN_NAME']] ?? null;
        if ($value === null || in_array($fk['COLUMN_NAME'], $skip, true)) continue;
        $parent = $db->prepare("SELECT is_deleted FROM `{$fk['parent_table']}` WHERE `{$fk['parent_key']}` = ? FOR UPDATE");
        $parent->execute([$value]);
        $deleted = $parent->fetchColumn();
        if ($deleted === false || (int)$deleted !== 0) {
            throw new DomainException('Restore the related ' . str_replace('_', ' ', $fk['parent_table']) . ' record first.');
        }
    }
}

function archive_restore(PDO $db, string $table, array $module, int $id): void {
    $pk = $module['pk'];
    $db->beginTransaction();
    try {
        $stmt = $db->prepare("SELECT * FROM `$table` WHERE `$pk` = ? FOR UPDATE");
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row || (int)$row['is_deleted'] !== 1) throw new DomainException('This record is no longer archived. Refresh the archive.');
        if ($table === 'users' && $row['username'] === null) throw new DomainException('Learner identities must be reinstated through Import Learners.');
        archive_dependencies($db, $table, $row, $table === 'employees' ? ['user_id'] : []);
        if ($table === 'positions') {
            work_position_assert_name_available($db, (string)($row['position_name'] ?? ''), $id);
        }

        // A user and its employee profile are one staff identity. Restore together
        // and reactivate staff login as part of the administrative restore action.
        $userId = $table === 'users' ? $id : ($table === 'employees' ? (int)$row['user_id'] : 0);
        if ($userId) {
            $userStmt = $db->prepare('SELECT * FROM users WHERE user_id = ? FOR UPDATE');
            $userStmt->execute([$userId]);
            $user = $userStmt->fetch(PDO::FETCH_ASSOC);
            if (!$user) throw new DomainException('The linked staff account is missing.');
            archive_dependencies($db, 'users', $user);
            $employees = $db->prepare('SELECT * FROM employees WHERE user_id = ? FOR UPDATE');
            $employees->execute([$userId]);
            $employeeRows = $employees->fetchAll(PDO::FETCH_ASSOC);
            foreach ($employeeRows as $employee) archive_dependencies($db, 'employees', $employee, ['user_id']);
            foreach ($employeeRows as $employee) {
                work_position_assert_principal_available($db, (int)($employee['position_id'] ?? 0), $userId, 'restore');
            }
            $db->prepare('UPDATE users SET is_deleted = 0, deleted_at = NULL, is_active = 1 WHERE user_id = ?')->execute([$userId]);
            $db->prepare('UPDATE employees SET is_deleted = 0, deleted_at = NULL WHERE user_id = ? AND is_deleted = 1')->execute([$userId]);
        } else {
            // Do not reactivate a historical school year/curriculum on restore.
            $inactive = in_array($table, ['school_years', 'curricula'], true) ? ', is_active = 0' : '';
            $db->prepare("UPDATE `$table` SET is_deleted = 0, deleted_at = NULL$inactive WHERE `$pk` = ? AND is_deleted = 1")->execute([$id]);
        }
        // Record only state changes; never copy passwords/contact data into audit logs.
        if (!audit_log($db, $table, $id, 'UPDATE', ['is_deleted' => 1, 'deleted_at' => $row['deleted_at']],
            ['is_deleted' => 0, 'deleted_at' => null, 'operation' => 'restoreMasterfile', 'linked_user_id' => $userId ?: null])) {
            throw new RuntimeException('Unable to record the restore in the audit log.');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}
