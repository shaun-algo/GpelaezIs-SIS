<?php
$corsPath = __DIR__ . '/../utils/cors.php';
if (file_exists($corsPath)) {
    require_once $corsPath;
}

$localConfig = [];
$localConfigPath = __DIR__ . '/config.local.php';
if (is_file($localConfigPath)) {
    $loadedConfig = require $localConfigPath;
    if (is_array($loadedConfig)) $localConfig = $loadedConfig;
}

$servername = getenv('DB_HOST') ?: ($localConfig['db_host'] ?? 'localhost');
$port = getenv('DB_PORT') ?: ($localConfig['db_port'] ?? null);
$username = getenv('DB_USER') ?: ($localConfig['db_user'] ?? 'root');
$password = getenv('DB_PASSWORD') ?: ($localConfig['db_password'] ?? '');
$dbname = getenv('DB_NAME') ?: ($localConfig['db_name'] ?? 'capstone_migration');
try {
    $dsn = "mysql:host=$servername" . ($port ? ";port=$port" : '') . ";dbname=$dbname;charset=utf8mb4";
    $options = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ];
    $conn = new PDO($dsn, $username, $password, $options);
} catch (PDOException $e) {
    die("Connection failed: " . $e->getMessage());
}
?>
