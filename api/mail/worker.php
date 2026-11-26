<?php
// Run once per minute via the host scheduler. Never invoke through HTTP.
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require __DIR__.'/../database/connection.php';
require __DIR__.'/../utils/password_recovery.php';
if(empty(recovery_config()['enabled'])){fwrite(STDERR,"Recovery is not enabled.\n");exit(1);}
$lock='recovery-mail:'.$conn->query('SELECT DATABASE()')->fetchColumn();
$stmt=$conn->prepare('SELECT GET_LOCK(?,0)');$stmt->execute([$lock]);if(!(int)$stmt->fetchColumn())exit;
try {
    $conn->exec("UPDATE recovery_mail_queue SET status='expired',encrypted_payload=NULL,finished_at=NOW() WHERE status IN ('pending','sending') AND expires_at<=NOW()");
    foreach($conn->query("SELECT * FROM recovery_mail_queue WHERE status='pending' AND expires_at>NOW() ORDER BY id LIMIT 20")->fetchAll() as $job){
        $conn->prepare("UPDATE recovery_mail_queue SET status='sending' WHERE id=?")->execute([$job['id']]);
        try {
            $payload=recovery_decrypt($job['encrypted_payload']);$c=recovery_config();
            // Suppress queued links invalidated before the scheduler could deliver them.
            if (preg_match('/#token=([a-f0-9]{64})\b/', $payload['body'], $match)) {
                $valid=$conn->prepare('SELECT COUNT(*) FROM password_reset_tokens t JOIN users u ON u.user_id=t.user_id WHERE t.token_hash=? AND t.consumed_at IS NULL AND t.expires_at>NOW() AND t.auth_version=u.auth_version AND u.is_active=1 AND u.is_deleted=0');
                $valid->execute([hash('sha256',$match[1])]);
                if (!(int)$valid->fetchColumn()) {
                    $conn->prepare("UPDATE recovery_mail_queue SET status='expired',encrypted_payload=NULL,finished_at=NOW() WHERE id=?")->execute([$job['id']]);
                    continue;
                }
            }
            if(($c['transport']??'')==='capture'){
                // Capture may run only against explicit test schemas, never the live database.
                if(!preg_match('/^capstone_recovery_(demo|app)_[0-9]+$/D',$conn->query('SELECT DATABASE()')->fetchColumn()))throw new RuntimeException('Capture requires a test clone.');
                $dir=$c['capture_dir']??'';
                if(!is_dir($dir) || str_starts_with(realpath($dir),realpath(__DIR__.'/../..').DIRECTORY_SEPARATOR))throw new RuntimeException('Private capture directory required.');
                $path=$dir.'/mail-'.$job['id'].'.html';
                file_put_contents($path,recovery_email_html($payload['subject'],$payload['body'],recovery_base_url(),(string)($c['email_logo_url']??'')));chmod($path,0600);
            }elseif(($c['transport']??'')==='smtp') recovery_build_mail($job['recipient'],$payload)->send();
            else throw new RuntimeException('Unknown mail transport.');
            $conn->prepare("UPDATE recovery_mail_queue SET status='sent',encrypted_payload=NULL,finished_at=NOW() WHERE id=?")->execute([$job['id']]);
            echo 'Processed mail job '.(int)$job['id']."\n";
        }catch(Throwable $e){
            // Do not automatically retry an ambiguous SMTP result; avoid duplicate deliveries.
            $conn->prepare("UPDATE recovery_mail_queue SET status='failed',encrypted_payload=NULL,finished_at=NOW() WHERE id=?")->execute([$job['id']]);
            fwrite(STDERR,'Mail job '.(int)$job['id']." failed. Request a fresh message after checking configuration.\n");
        }
    }
    $conn->exec("DELETE FROM recovery_rate_limits WHERE window_started<NOW()-INTERVAL 1 DAY");
}finally{$stmt=$conn->prepare('SELECT RELEASE_LOCK(?)');$stmt->execute([$lock]);}
