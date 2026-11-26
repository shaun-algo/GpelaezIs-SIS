<?php
/** CLI-only, maintenance-window migration. Back up database AND application first.
 * Usage: php centralize_staff_accounts.php DATABASE
 * Credentials: DB_HOST/DB_PORT/DB_USER/DB_PASSWORD (local XAMPP defaults).
 * MariaDB DDL commits implicitly; restore the backup if an intermediate step fails.
 */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$db = $argv[1] ?? '';
if (!preg_match('/^capstone_[a-zA-Z0-9_]+$/', $db)) { throw new RuntimeException('Explicit capstone database name required.'); }
$c = new PDO('mysql:host=' . (getenv('DB_HOST') ?: '127.0.0.1') . ';port=' . (getenv('DB_PORT') ?: '3307') . ';dbname=' . $db . ';charset=utf8mb4', getenv('DB_USER') ?: 'root', getenv('DB_PASSWORD') ?: '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
function columns(PDO $c, string $t): array { return array_column($c->query("SHOW COLUMNS FROM `$t`")->fetchAll(), 'Field'); }
function ensure(PDO $c, string $sql, string $message): void { if ((int)$c->query($sql)->fetchColumn() !== 0) throw new RuntimeException($message); }
$fields = [
    'username' => 'VARCHAR(100) NULL', 'password' => 'VARCHAR(255) NULL',
    'must_change_password' => 'TINYINT(1) NOT NULL DEFAULT 1', 'password_updated_at' => 'DATETIME NULL',
    'failed_login_count' => 'INT NOT NULL DEFAULT 0', 'locked_until' => 'DATETIME NULL',
    'is_active' => 'TINYINT(1) DEFAULT 1', 'last_login' => 'DATETIME NULL',
    'account_created_at' => 'DATETIME NULL', 'purpose' => 'VARCHAR(150) NULL'
];
$employeeFields = columns($c, 'employees');
$old = in_array('username', $employeeFields, true);
$beforeLearners = $c->query('SELECT * FROM learners ORDER BY learner_id')->fetchAll();
$beforeIds = $c->query('SELECT user_id FROM users ORDER BY user_id')->fetchAll();
if ($old) {
    ensure($c, 'SELECT COUNT(*) FROM employees e JOIN learners l ON l.user_id=e.user_id', 'Employee and learner identities overlap.');
    ensure($c, 'SELECT COUNT(*) FROM system_accounts s LEFT JOIN users u ON u.user_id=s.legacy_user_id WHERE u.user_id IS NULL', 'Unmapped system accounts.');
    ensure($c, 'SELECT COUNT(*) FROM system_accounts s JOIN employees e ON e.user_id=s.legacy_user_id', 'System and employee identities overlap.');
    ensure($c, 'SELECT COUNT(*) FROM system_accounts s JOIN learners l ON l.user_id=s.legacy_user_id', 'System and learner identities overlap.');
}
$present = columns($c, 'users');
foreach ($fields as $name => $definition) if (!in_array($name, $present, true)) $c->exec("ALTER TABLE users ADD COLUMN `$name` $definition");
if ($old) {
    $copy = array_diff(array_keys($fields), ['purpose']);
    $sets = array_map(fn($f) => "u.`$f`=e.`$f`", $copy);
    $sets[] = 'u.role_id=e.role_id';
    // Preserve the identity timestamps; profile deletion also disables authentication.
    $sets[] = 'u.is_deleted=GREATEST(COALESCE(u.is_deleted,0),COALESCE(e.is_deleted,0))';
    $sets[] = 'u.deleted_at=COALESCE(u.deleted_at,e.deleted_at)';
    $sets[] = 'u.updated_at=u.updated_at';
    $c->exec('UPDATE users u JOIN employees e ON e.user_id=u.user_id SET ' . implode(',', $sets));
    $sets = array_map(fn($f) => "u.`$f`=s.`$f`", array_diff(array_keys($fields), ['account_created_at']));
    $sets[] = 'u.account_created_at=s.created_at';
    $sets[] = 'u.role_id=s.role_id';
    $sets[] = 'u.is_deleted=GREATEST(COALESCE(u.is_deleted,0),COALESCE(s.is_deleted,0))';
    $sets[] = 'u.deleted_at=COALESCE(u.deleted_at,s.deleted_at)';
    $sets[] = 'u.updated_at=u.updated_at';
    $c->exec('UPDATE users u JOIN system_accounts s ON s.legacy_user_id=u.user_id SET ' . implode(',', $sets));
    foreach (['employees' => 'user_id', 'system_accounts' => 'legacy_user_id'] as $table => $key) {
        $checks = array_map(fn($f) => "NOT(u.`$f` <=> a.`$f`)", array_diff(array_keys($fields), ['purpose','account_created_at']));
        ensure($c, "SELECT COUNT(*) FROM `$table` a JOIN users u ON u.user_id=a.`$key` WHERE " . implode(' OR ', $checks), 'Credential copy verification failed for ' . $table);
    }
}
$indexes = $c->query('SHOW INDEX FROM users')->fetchAll();
if (!in_array('uq_users_staff_username', array_column($indexes, 'Key_name'), true)) $c->exec('ALTER TABLE users ADD UNIQUE KEY uq_users_staff_username (username)');
if ($old) {
    $fks = $c->query("SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employees' AND COLUMN_NAME='role_id' AND REFERENCED_TABLE_NAME IS NOT NULL")->fetchAll();
    foreach ($fks as $fk) $c->exec('ALTER TABLE employees DROP FOREIGN KEY `' . $fk['CONSTRAINT_NAME'] . '`');
    $drop = array_intersect(array_merge(array_keys($fields), ['role_id']), $employeeFields);
    $c->exec('ALTER TABLE employees ' . implode(',', array_map(fn($f) => "DROP COLUMN `$f`", $drop)));
}
$c->exec('DROP TABLE IF EXISTS system_accounts');
if ($beforeLearners !== $c->query('SELECT * FROM learners ORDER BY learner_id')->fetchAll()) throw new RuntimeException('Learner data changed.');
if ($beforeIds !== $c->query('SELECT user_id FROM users ORDER BY user_id')->fetchAll()) throw new RuntimeException('User identities changed.');
$checks = [
    ['staff_missing_credentials', 'SELECT COUNT(*) FROM employees e JOIN users u ON u.user_id=e.user_id WHERE u.username IS NULL OR u.password IS NULL'],
    ['learner_credentials_duplicated_in_users', 'SELECT COUNT(*) FROM learners l JOIN users u ON u.user_id=l.user_id WHERE u.username IS NOT NULL OR u.password IS NOT NULL'],
    ['learner_accounts_missing_credentials', 'SELECT COUNT(*) FROM learners WHERE user_id IS NOT NULL AND (username IS NULL OR password IS NULL)'],
    ['learner_role_mismatches', 'SELECT COUNT(*) FROM learners l JOIN users u ON u.user_id=l.user_id WHERE NOT(l.role_id <=> u.role_id)'],
    ['duplicate_usernames', 'SELECT COUNT(*) FROM (SELECT username FROM (SELECT username FROM users WHERE username IS NOT NULL UNION ALL SELECT username FROM learners WHERE username IS NOT NULL) names GROUP BY username HAVING COUNT(*) > 1) d'],
];
foreach ($checks as [$name, $sql]) {
    $issueCount = (int)$c->query($sql)->fetchColumn();
    echo $name . ': ' . $issueCount . PHP_EOL;
    if ($issueCount) throw new RuntimeException('Validation failed.');
}
echo "Central staff accounts migration verified for $db.\n";
