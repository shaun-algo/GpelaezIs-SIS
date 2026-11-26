<?php
declare(strict_types=1);

require_once __DIR__ . '/../../utils/account_identity_queries.php';

/* Defense in depth for PHP hosts that do not read the accompanying .htaccess. */
if (realpath((string)($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) {
    http_response_code(403);
    exit;
}

/*
 * Email OTP recovery configuration.
 *
 * Keep SMTP and database secrets outside the web root in production. These
 * environment-variable defaults make the module easy to run locally without
 * committing credentials to the repository.
 */
$otpLocalConfig = [];
$otpLocalConfigPath = __DIR__ . '/config.local.php';
if (is_file($otpLocalConfigPath)) {
    $loadedOtpConfig = require $otpLocalConfigPath;
    if (is_array($loadedOtpConfig)) {
        $otpLocalConfig = $loadedOtpConfig;
    }
}
$sharedDbConfig = [];
$sharedDbConfigPath = __DIR__ . '/../../database/config.local.php';
if (is_file($sharedDbConfigPath)) {
    $loadedSharedDbConfig = require $sharedDbConfigPath;
    if (is_array($loadedSharedDbConfig)) $sharedDbConfig = $loadedSharedDbConfig;
}

define('OTP_DB_HOST', getenv('OTP_DB_HOST') ?: (getenv('DB_HOST') ?: ($otpLocalConfig['db_host'] ?? ($sharedDbConfig['db_host'] ?? '127.0.0.1'))));
define('OTP_DB_PORT', getenv('OTP_DB_PORT') ?: (getenv('DB_PORT') ?: ($otpLocalConfig['db_port'] ?? ($sharedDbConfig['db_port'] ?? '3307'))));
define('OTP_DB_NAME', getenv('OTP_DB_NAME') ?: (getenv('DB_NAME') ?: ($otpLocalConfig['db_name'] ?? ($sharedDbConfig['db_name'] ?? 'capstone_migration'))));
define('OTP_DB_USER', getenv('OTP_DB_USER') ?: (getenv('DB_USER') ?: ($otpLocalConfig['db_user'] ?? ($sharedDbConfig['db_user'] ?? 'root'))));
define('OTP_DB_PASSWORD', getenv('OTP_DB_PASSWORD') !== false ? (string)getenv('OTP_DB_PASSWORD') : (string)(getenv('DB_PASSWORD') ?: ($otpLocalConfig['db_password'] ?? ($sharedDbConfig['db_password'] ?? ''))));

define('OTP_SMTP_HOST', getenv('OTP_SMTP_HOST') ?: ($otpLocalConfig['smtp_host'] ?? 'smtp.gmail.com'));
define('OTP_SMTP_PORT', (int)(getenv('OTP_SMTP_PORT') ?: ($otpLocalConfig['smtp_port'] ?? 465)));
define('OTP_SMTP_ENCRYPTION', strtolower(getenv('OTP_SMTP_ENCRYPTION') ?: ($otpLocalConfig['smtp_encryption'] ?? 'ssl')));
define('OTP_SMTP_USERNAME', getenv('OTP_SMTP_USERNAME') ?: ($otpLocalConfig['smtp_username'] ?? ''));
define('OTP_SMTP_PASSWORD', getenv('OTP_SMTP_PASSWORD') ?: ($otpLocalConfig['smtp_password'] ?? ''));
define('OTP_SMTP_FROM_EMAIL', getenv('OTP_SMTP_FROM_EMAIL') ?: ($otpLocalConfig['smtp_from_email'] ?? OTP_SMTP_USERNAME));
define('OTP_SMTP_FROM_NAME', getenv('OTP_SMTP_FROM_NAME') ?: ($otpLocalConfig['smtp_from_name'] ?? 'G. Pelaez Integrated School'));
define('OTP_EMAIL_LOGO_URL', getenv('OTP_EMAIL_LOGO_URL') ?: ($otpLocalConfig['email_logo_url'] ?? ''));
$configuredOtpCorsOrigins = getenv('OTP_CORS_ORIGINS');
if ($configuredOtpCorsOrigins === false || trim((string)$configuredOtpCorsOrigins) === '') {
    $configuredOtpCorsOrigins = $otpLocalConfig['cors_origins']
        ?? ($otpLocalConfig['cors_origin'] ?? 'http://localhost');
}
if (!is_array($configuredOtpCorsOrigins)) {
    $configuredOtpCorsOrigins = preg_split(
        '/\s*,\s*/',
        (string)$configuredOtpCorsOrigins,
        -1,
        PREG_SPLIT_NO_EMPTY
    );
}
define('OTP_CORS_ORIGINS', array_values(array_filter(array_map(
    static fn($origin): string => rtrim(trim((string)$origin), '/'),
    $configuredOtpCorsOrigins
))));
define('OTP_PHPMAILER_AUTOLOAD', getenv('OTP_PHPMAILER_AUTOLOAD') ?: ($otpLocalConfig['phpmailer_autoload'] ?? __DIR__ . '/../../mail/vendor/autoload.php'));

require_once dirname(__DIR__, 2) . '/utils/auth.php';
require_once dirname(__DIR__, 2) . '/utils/account_credentials.php';
require_once dirname(__DIR__, 2) . '/utils/audit.php';

function json_response(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Referrer-Policy: no-referrer');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function valid_email($value): ?string
{
    if (!is_string($value)) {
        return null;
    }

    $email = strtolower(trim($value));
    if ($email === '' || strlen($email) > 254 || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
        return null;
    }

    return $email;
}

function otp_apply_cors(): void
{
    $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');

    /* Never use Access-Control-Allow-Origin: *. An origin explicitly listed in
     * local config or matching the current request host is safe to reflect. */
    $origin = rtrim(trim($origin), '/');
    $scheme = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off'
        ? 'https'
        : 'http';
    $currentHostOrigin = $scheme . '://' . trim((string)($_SERVER['HTTP_HOST'] ?? ''));
    $sameOrigin = $origin !== '' && $currentHostOrigin !== '://' && $origin === rtrim($currentHostOrigin, '/');
    $allowlisted = in_array($origin, OTP_CORS_ORIGINS, true) || $sameOrigin;

    if ($origin !== '' && !$allowlisted) {
        json_response(['success' => false, 'message' => 'Request origin is not allowed.'], 403);
    }

    if ($origin !== '') {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Access-Control-Allow-Credentials: true');
        header('Vary: Origin');
    }
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
}

function otp_bootstrap(): void
{
    otp_apply_cors();
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        header('Allow: POST, OPTIONS');
        json_response(['success' => false, 'message' => 'POST is required.'], 405);
    }

    auth_start_session();
}

function otp_json_input(): array
{
    $contentType = strtolower(trim(explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? ''))[0]));
    if ($contentType !== 'application/json') {
        json_response(['success' => false, 'message' => 'Send JSON.'], 415);
    }

    $raw = file_get_contents('php://input', false, null, 0, 4097);
    if (!is_string($raw) || strlen($raw) > 4096) {
        json_response(['success' => false, 'message' => 'Invalid request.'], 400);
    }

    $data = json_decode($raw, true);
    if (!is_array($data)) {
        json_response(['success' => false, 'message' => 'Invalid request.'], 400);
    }

    foreach ($data as $value) {
        if (!is_string($value)) {
            json_response(['success' => false, 'message' => 'Invalid request.'], 400);
        }
    }

    return $data;
}

function otp_db(): PDO
{
    static $connection;
    if ($connection instanceof PDO) {
        return $connection;
    }

    $dsn = 'mysql:host=' . OTP_DB_HOST . ';port=' . OTP_DB_PORT . ';dbname=' . OTP_DB_NAME . ';charset=utf8mb4';
    $connection = new PDO($dsn, OTP_DB_USER, OTP_DB_PASSWORD, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);

    return $connection;
}

function otp_audit_event(PDO $conn, string $action, string $status, string $reasonCode, ?array $account = null, ?string $principal = null, array $metadata = []): void
{
    $legacyUserId = $account && isset($account['legacy_user_id']) ? (int)$account['legacy_user_id'] : null;
    audit_log_event($conn, $action, $status, [
        'event_type' => 'SECURITY',
        'table_name' => 'authentication',
        'record_id' => $legacyUserId ?: null,
        'target_type' => 'account',
        // OTP recovery is pre-authentication. The account is the target, not
        // an authenticated actor, even after a code is verified.
        'actor_user_id' => null,
        'reason_code' => $reasonCode,
        'principal' => $principal ?: (string)($account['username'] ?? ''),
        'metadata' => $metadata,
    ]);
}

function otp_find_account_by_email(PDO $conn, string $email): ?array
{
    /* Only active employee accounts with a current school-record email can self-recover. */
    $stmt = $conn->prepare(
        'SELECT ac.account_type, ac.actor_id, ac.legacy_user_id, ac.username, ac.password,
                ac.role_id, ac.role_name, ac.is_active, ac.is_deleted, e.email
         FROM employees e
         INNER JOIN (' . account_credentials_derived_sql() . ') ac
             ON ac.account_type = "employee"
            AND ac.actor_id = e.employee_id
            AND ac.legacy_user_id = e.user_id
         WHERE LOWER(TRIM(e.email)) = LOWER(:email)
           AND e.is_deleted = 0
         LIMIT 2'
    );
    $stmt->execute(['email' => $email]);
    $rows = $stmt->fetchAll();

    /* Ambiguous addresses are not eligible. This avoids choosing the wrong account. */
    if (count($rows) !== 1) {
        return null;
    }

    $account = $rows[0];
    if ((int)$account['is_deleted'] !== 0 || (int)$account['is_active'] !== 1) {
        return null;
    }

    return $account;
}

function otp_mail_html(string $code, string $logoUrl = ''): string
{
    $safeCode = htmlspecialchars($code, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeLogoUrl = '';
    if ($logoUrl !== '' && filter_var($logoUrl, FILTER_VALIDATE_URL) !== false) {
        $scheme = strtolower((string)(parse_url($logoUrl, PHP_URL_SCHEME) ?? ''));
        if ($scheme === 'https') {
            $safeLogoUrl = htmlspecialchars($logoUrl, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        }
    }
    $logoMarkup = $safeLogoUrl !== ''
        ? '<img src="' . $safeLogoUrl . '" alt="G. Pelaez Integrated School logo" width="72" height="72" style="display:block;width:72px;height:72px;margin:0 0 18px;border-radius:50%;object-fit:cover;background:#fff">'
        : '';
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your verification code</title></head>' .
        '<body style="margin:0;padding:24px 12px;background:#eef2f5;font-family:Arial,sans-serif;color:#18324c">' .
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">' .
        '<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;background:#fff;border:1px solid #d7e0e8;border-radius:12px;overflow:hidden">' .
        '<tr><td style="padding:28px 30px;background:#173e63;color:#fff">' . $logoMarkup . '<p style="margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.82">G. Pelaez Integrated School</p><h1 style="margin:14px 0 0;font-size:25px;line-height:1.2">Verify your email</h1></td></tr>' .
        '<tr><td style="padding:30px"><p style="margin:0;font-size:15px;line-height:1.7">Use this six-digit code to continue recovering your school portal account.</p>' .
        '<p style="margin:24px 0;text-align:center;font-size:34px;letter-spacing:.28em;font-weight:700;color:#173e63">' . $safeCode . '</p>' .
        '<p style="margin:0;color:#5c6f80;font-size:13px;line-height:1.7">This code expires in 5 minutes. If you did not request a password reset, you can ignore this message.</p></td></tr>' .
        '<tr><td style="padding:20px 30px;background:#f7f9fb;border-top:1px solid #e4e9ee;color:#647587;font-size:12px;line-height:1.6">Never share this code or your password with anyone.</td></tr>' .
        '</table></td></tr></table></body></html>';
}

function otp_send_email(string $recipient, string $code): void
{
    if (!is_file(OTP_PHPMAILER_AUTOLOAD)) {
        throw new RuntimeException('PHPMailer is not installed.');
    }
    if (OTP_SMTP_USERNAME === '' || OTP_SMTP_PASSWORD === '' || !valid_email(OTP_SMTP_FROM_EMAIL)) {
        throw new RuntimeException('SMTP settings are incomplete.');
    }

    require_once OTP_PHPMAILER_AUTOLOAD;

    $mailer = new \PHPMailer\PHPMailer\PHPMailer(true);
    $mailer->isSMTP();
    $mailer->Host = OTP_SMTP_HOST;
    $mailer->Port = OTP_SMTP_PORT;
    $mailer->SMTPAuth = true;
    $mailer->SMTPDebug = 0;
    $mailer->Timeout = 20;
    $mailer->Username = OTP_SMTP_USERNAME;
    $mailer->Password = OTP_SMTP_PASSWORD;
    $mailer->SMTPSecure = OTP_SMTP_ENCRYPTION === 'tls'
        ? \PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_STARTTLS
        : \PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_SMTPS;
    $mailer->CharSet = 'UTF-8';
    $mailer->setFrom(OTP_SMTP_FROM_EMAIL, OTP_SMTP_FROM_NAME);
    $mailer->addAddress($recipient);
    $mailer->Subject = 'Your school portal verification code';
    $mailer->isHTML(true);
    /* Use a public HTTPS logo URL in the HTML only. No MIME/CID attachment is added. */
    $mailer->Body = otp_mail_html($code, OTP_EMAIL_LOGO_URL);
    $mailer->AltBody = "Your school portal verification code is {$code}. It expires in 5 minutes. If you did not request a password reset, ignore this message.";
    $mailer->send();
}
