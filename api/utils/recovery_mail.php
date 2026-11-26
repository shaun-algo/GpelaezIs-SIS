<?php
require_once __DIR__.'/recovery_email_template.php';

function recovery_config(): array {
    static $config;
    if ($config !== null) return $config;
    $path = getenv('APP_RECOVERY_CONFIG');
    if (is_string($path) && trim($path) !== '' && is_file($path)) {
        $root=realpath(__DIR__.'/../..'); $real=realpath($path);
        if (!$real || str_starts_with($real,$root.DIRECTORY_SEPARATOR) || (fileperms($real)&0077)!==0) throw new RuntimeException('Recovery configuration must be private and outside the web root.');
        $config=json_decode(file_get_contents($real),true,512,JSON_THROW_ON_ERROR);
        return $config;
    }

    /*
     * InfinityFree does not provide a dependable private path outside htdocs.
     * The deployment package therefore supports a PHP config fallback in the
     * protected api/recovery_private directory. Its .htaccess denies direct
     * web access, and the file returns configuration rather than emitting it.
     * A real APP_RECOVERY_CONFIG still takes precedence whenever available.
     */
    $hostFallback = dirname(__DIR__) . '/recovery_private/app-recovery.php';
    if (is_file($hostFallback)) {
        $loaded = require $hostFallback;
        if (!is_array($loaded)) throw new RuntimeException('Invalid host recovery configuration.');
        return $config = $loaded;
    }

    return $config=['enabled'=>false];
}

function recovery_is_local_http_host(string $host): bool {
    $host = strtolower(trim($host));

    if ($host === 'localhost' || $host === '127.0.0.1') {
        return true;
    }

    if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false) {
        return false;
    }

    $parts = array_map('intval', explode('.', $host));

    return count($parts) === 4 && (
        $parts[0] === 10 ||
        ($parts[0] === 172 && $parts[1] >= 16 && $parts[1] <= 31) ||
        ($parts[0] === 192 && $parts[1] === 168)
    );
}

function recovery_base_url(): string {
    $c=recovery_config(); $url=rtrim($c['base_url']??'','/');
    if ($url === '') {
        /* Local XAMPP fallback: derive the URL from the current trusted LAN request. */
        $host = trim((string)($_SERVER['HTTP_HOST'] ?? ''));
        $hostName = parse_url('http://' . $host, PHP_URL_HOST);
        if ($host === '' || !is_string($hostName) || !recovery_is_local_http_host($hostName)
            || !preg_match('/^[A-Za-z0-9.:-]+$/', $host)) {
            throw new RuntimeException('A trusted HTTPS application URL is required.');
        }
        $scheme = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off' ? 'https' : 'http';
        $script = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? ''));
        $apiMarker = strpos($script, '/api/auth/');
        $basePath = $apiMarker === false
            ? rtrim(str_replace('\\', '/', dirname($script)), '/')
            : substr($script, 0, $apiMarker);
        return $scheme . '://' . $host . ($basePath === '/' ? '' : rtrim($basePath, '/'));
    }
    $p=parse_url($url);
    $local=recovery_is_local_http_host((string)($p['host']??''));
    if (!$p || empty($p['host']) || isset($p['user']) || isset($p['pass']) || isset($p['query']) || isset($p['fragment'])
        || (($p['scheme']??'')!=='https' && !(($p['scheme']??'')==='http' && $local && !empty($c['allow_local_http'])))) throw new RuntimeException('A trusted HTTPS application URL is required.');
    return $url;
}

function recovery_mail_is_configured(): bool {
    return !empty(recovery_config()['enabled']);
}

function recovery_origin(): string {
    $p=parse_url(recovery_base_url());
    return $p['scheme'].'://'.$p['host'].(isset($p['port'])?':'.$p['port']:'');
}

function recovery_require_ready(PDO $conn, bool $mailRequired = true): void {
    if (!password_policy_has_column($conn,'auth_version')) {
        recovery_json(['success'=>false,'message'=>'Account recovery is being configured. Please contact the school office.'],503);
    }
    recovery_base_url();
    if ($mailRequired && empty(recovery_config()['enabled'])) {
        recovery_json(['success'=>false,'message'=>'Account recovery is being configured. Please contact the school office.'],503);
    }
}

function recovery_mail_key(): string {
    $key=base64_decode(recovery_config()['queue_key']??'',true);
    if ($key===false || strlen($key)!==32) throw new RuntimeException('Invalid recovery queue key.');
    return $key;
}

function recovery_encrypt(array $payload): string {
    $iv=random_bytes(12);$tag='';
    $cipher=openssl_encrypt(json_encode($payload,JSON_THROW_ON_ERROR),'aes-256-gcm',recovery_mail_key(),OPENSSL_RAW_DATA,$iv,$tag,'recovery-mail-v1');
    if ($cipher===false) throw new RuntimeException('Mail queue encryption failed.');
    return base64_encode($iv.$tag.$cipher);
}

function recovery_decrypt(string $encoded): array {
    $raw=base64_decode($encoded,true);
    if ($raw===false || strlen($raw)<29) throw new RuntimeException('Invalid queued mail.');
    $plain=openssl_decrypt(substr($raw,28),'aes-256-gcm',recovery_mail_key(),OPENSSL_RAW_DATA,substr($raw,0,12),substr($raw,12,16),'recovery-mail-v1');
    if ($plain===false) throw new RuntimeException('Queued mail failed authentication.');
    return json_decode($plain,true,512,JSON_THROW_ON_ERROR);
}

function recovery_queue_mail(PDO $conn, string $recipient, string $subject, string $body): void {
    if (!filter_var($recipient,FILTER_VALIDATE_EMAIL)) throw new RuntimeException('Invalid recipient.');
    $payload=recovery_encrypt(['subject'=>$subject,'body'=>$body]);
    $conn->prepare('INSERT INTO recovery_mail_queue (recipient,encrypted_payload,expires_at) VALUES (?,?,NOW()+INTERVAL 20 MINUTE)')->execute([$recipient,$payload]);
}

function recovery_build_mail(string $recipient, array $payload) {
    $c=recovery_config();
    require_once $c['autoload_path'];
    $m=new \PHPMailer\PHPMailer\PHPMailer(true);
    $m->isSMTP();$m->Host='smtp.gmail.com';$m->Port=465;$m->SMTPSecure='ssl';$m->SMTPAuth=true;$m->SMTPDebug=0;$m->Timeout=20;
    $m->Username=$c['sender'];
    $credentialsPath=$c['credentials_path'];
    $real=realpath($credentialsPath);
    if (!$real || str_starts_with($real,realpath(__DIR__.'/../..').DIRECTORY_SEPARATOR) || (fileperms($real)&0077)!==0) throw new RuntimeException('SMTP credentials must be private.');
    $credentials=json_decode(file_get_contents($real),true,512,JSON_THROW_ON_ERROR);
    if (($credentials['sender']??'')!==$c['sender']) throw new RuntimeException('SMTP sender mismatch.');
    $m->Password=$credentials['app_password'];
    $m->setFrom($c['sender'],'G. Pelaez Integrated School');$m->addAddress($recipient);$m->CharSet='UTF-8';
    $m->Subject=$payload['subject'].' | G. Pelaez Integrated School';
    /* Use only a public HTTPS URL in the HTML. Never embed or attach logo bytes. */
    $logoUrl=(string)($c['email_logo_url']??'');
    $m->isHTML(true);$m->Body=recovery_email_html($payload['subject'],$payload['body'],recovery_base_url(),$logoUrl);$m->AltBody=$payload['body']."\n\nG. Pelaez Integrated School\nGitagum, Misamis Oriental";
    return $m;
}
