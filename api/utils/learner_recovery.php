<?php
// Resolve authority from current school records, never from caller-supplied adviser IDs.
function learner_recovery_route(PDO $conn, int $userId): ?array {
    $stmt = $conn->prepare("SELECT CASE WHEN u.is_active=1 AND u.is_deleted=0 AND u.role_id=9 THEN e.user_id ELSE NULL END AS adviser_user_id, s.section_name, y.is_active AS school_year_active, y.school_year_id, n.enrollment_id
        FROM learners l JOIN enrollments n ON n.learner_id=l.learner_id
        JOIN school_years y ON y.school_year_id=n.school_year_id AND y.is_deleted=0
        JOIN sections s ON s.section_id=n.section_id AND s.school_year_id=n.school_year_id AND s.is_deleted=0
        LEFT JOIN employees e ON e.employee_id=s.adviser_id AND e.is_deleted=0
        LEFT JOIN users u ON u.user_id=e.user_id
        WHERE l.user_id=? AND l.is_deleted=0 AND n.is_deleted=0 AND n.enrollment_status='Enrolled'
        ORDER BY y.is_active DESC, y.school_year_id DESC, n.enrollment_id DESC FOR UPDATE");
    $stmt->execute([$userId]);
    $rows = $stmt->fetchAll();
    if (!$rows) return null;

    /* Prefer one current-school-year placement. Older but valid placements are
     * a local-data fallback when no school year is currently flagged active. */
    $activeRows = array_values(array_filter($rows, static fn(array $row): bool => (int)$row['school_year_active'] === 1));
    if ($activeRows) {
        $candidates = $activeRows;
    } else {
        $latestSchoolYear = max(array_map(static fn(array $row): int => (int)$row['school_year_id'], $rows));
        $candidates = array_values(array_filter($rows, static fn(array $row): bool => (int)$row['school_year_id'] === $latestSchoolYear));
    }

    // Missing, ambiguous, or inactive adviser goes to the registrar fallback.
    return count($candidates) === 1 && !empty($candidates[0]['adviser_user_id']) ? $candidates[0] : null;
}

function learner_recovery_request(PDO $conn, array $account, int $version): bool {
    $uid = (int)$account['legacy_user_id'];
    $conn->prepare("UPDATE learner_recovery_requests r LEFT JOIN password_reset_tokens t ON t.id=r.token_id
        SET r.status='expired' WHERE r.user_id=? AND r.status IN ('pending','approved')
        AND (r.auth_version<>? OR (r.status='pending' AND r.expires_at<=NOW())
        OR (r.status='approved' AND (t.id IS NULL OR t.expires_at<=NOW() OR t.consumed_at IS NOT NULL)))")->execute([$uid,$version]);
    $stmt = $conn->prepare("SELECT * FROM learner_recovery_requests WHERE user_id=? AND status IN ('pending','approved') LIMIT 1 FOR UPDATE");
    $stmt->execute([$uid]);
    $existing=$stmt->fetch();
    if ($existing) {
        $issuer=$existing['approved_by'] ? account_credentials_find_by_legacy_user($conn,(int)$existing['approved_by']) : null;
        if ($existing['status']==='pending' || learner_recovery_actor_allowed($conn,$issuer,$uid,$existing['fallback_reason']??'')) return false;
        // A reassigned/deactivated issuer must not strand the learner until link expiry.
        $conn->prepare("UPDATE learner_recovery_requests SET status='expired' WHERE id=?")->execute([$existing['id']]);
        $conn->prepare('UPDATE password_reset_tokens SET consumed_at=NOW() WHERE id=?')->execute([$existing['token_id']]);
    }
    $conn->prepare('INSERT INTO learner_recovery_requests (user_id,auth_version,expires_at) VALUES (?,?,NOW()+INTERVAL 1 DAY)')->execute([$uid,$version]);
    recovery_event($conn, $uid, 'learner_request_submitted');
    $route = learner_recovery_route($conn, $uid);
    if ($route) {
        $email = recovery_employee_email($conn, (int)$route['adviser_user_id']);
        /* A local install may not have the optional encrypted mail queue configured.
         * The request remains visible in the adviser workspace; when mail is configured,
         * a failure still aborts the transaction so a notification cannot be lost. */
        if ($email && recovery_mail_is_configured()) {
            recovery_capture($conn, $email, 'Learner recovery request', 'A learner needs help recovering their account. Sign in to review the request: ' . recovery_base_url() . '/adviser-recovery.php');
        }
    }
    return true;
}

function learner_recovery_submit_request(PDO $conn, array $account): array {
    $key = 'user:' . (int)$account['legacy_user_id'];
    $wait = function_exists('recovery_resend_wait') ? recovery_resend_wait($conn, $key) : 0;
    if ($wait > 0) {
        return ['accepted' => false, 'retry_after' => $wait];
    }

    $ipAllowed = recovery_rate_allow($conn, 'request-ip:' . ($_SERVER['REMOTE_ADDR'] ?? ''), 30);
    $accountAllowed = recovery_rate_allow($conn, 'request-account:' . $key, 3);
    if (!$ipAllowed || !$accountAllowed) {
        return ['accepted' => false, 'retry_after' => 900];
    }

    $created = false;
    $conn->beginTransaction();
    try {
        $stmt = $conn->prepare('SELECT auth_version FROM users WHERE user_id = ? FOR UPDATE');
        $stmt->execute([(int)$account['legacy_user_id']]);
        $version = (int)$stmt->fetchColumn();
        $fresh = account_credentials_find_by_legacy_user($conn, (int)$account['legacy_user_id']);
        if ($fresh && $fresh['account_type'] === 'learner' && (int)$fresh['is_deleted'] === 0 && (int)$fresh['is_active'] === 1) {
            $created = learner_recovery_request($conn, $fresh, $version);
        }
        $conn->commit();
    } catch (Throwable $e) {
        if ($conn->inTransaction()) $conn->rollBack();
        throw $e;
    }

    return ['accepted' => true, 'created' => $created, 'retry_after' => 60];
}

function learner_recovery_actor_allowed(PDO $conn, ?array $actor, int $learnerUserId, string $fallback): bool {
    if (!$actor || (int)$actor['is_deleted'] || (int)$actor['is_active'] !== 1) return false;
    if ((int)$actor['role_id'] === 8 || ($actor['role_key'] ?? '') === 'admin') return true;
    if (in_array((int)$actor['role_id'],[7,11],true)) return mb_strlen(trim($fallback)) >= 10;
    if ((int)$actor['role_id'] !== 9 || $actor['account_type'] !== 'employee') return false;
    $route = learner_recovery_route($conn, $learnerUserId);
    return $route && (int)$route['adviser_user_id'] === (int)$actor['legacy_user_id'];
}

function learner_recovery_token_allowed(PDO $conn, array $account, array $token): bool {
    if ($account['account_type'] !== 'learner') return false;
    $stmt = $conn->prepare("SELECT * FROM learner_recovery_requests WHERE user_id=? AND token_id=? AND status='approved' FOR UPDATE");
    $stmt->execute([$account['legacy_user_id'], $token['id']]);
    $request = $stmt->fetch();
    if (!$request) return false;
    $actor = account_credentials_find_by_legacy_user($conn, (int)$request['approved_by']);
    return $actor && learner_recovery_actor_allowed($conn, $actor, (int)$account['legacy_user_id'], $request['fallback_reason'] ?? '');
}

function learner_recovery_list(PDO $conn, array $session): array {
    $rows = $conn->query("SELECT r.*,l.first_name,l.last_name,l.lrn,t.expires_at AS link_expires_at,t.consumed_at,
        u.auth_version AS current_version, r.expires_at>NOW() AS request_fresh, t.expires_at>NOW() AS token_fresh FROM learner_recovery_requests r JOIN learners l ON l.user_id=r.user_id
        JOIN users u ON u.user_id=r.user_id LEFT JOIN password_reset_tokens t ON t.id=r.token_id
        WHERE l.is_deleted=0 AND l.is_active=1 AND u.is_deleted=0 AND u.is_active=1 ORDER BY r.id DESC LIMIT 200")->fetchAll();
    $out = [];
    foreach ($rows as $row) {
        $route = learner_recovery_route($conn, (int)$row['user_id']);
        if (!in_array(($session['role_key'] ?? ''), ['admin', 'registrar'], true)
            && (!$route || (int)$route['adviser_user_id'] !== (int)$session['user_id'])) continue;
        $status = $row['status'];
        $issuer=$row['approved_by'] ? account_credentials_find_by_legacy_user($conn,(int)$row['approved_by']) : null;
        if (in_array($status,['pending','approved'],true) && ((int)$row['auth_version'] !== (int)$row['current_version']
            || !($status==='pending'?$row['request_fresh']:$row['token_fresh'])
            || ($status==='approved' && ($row['consumed_at'] || !learner_recovery_actor_allowed($conn,$issuer,(int)$row['user_id'],$row['fallback_reason']??''))))) $status='expired';
        $out[] = ['id'=>(int)$row['id'],'learner'=>$row['first_name'].' '.$row['last_name'],'lrn'=>$row['lrn'],
            'section'=>$route['section_name']??'Registrar assistance','status'=>$status,'requested_at'=>$row['requested_at'],
            'decided_at'=>$row['decided_at'],'link_expires_at'=>$row['link_expires_at']];
    }
    return $out;
}

function learner_recovery_decide(PDO $conn, array $session, array $data): array {
    if (!recovery_rate_allow($conn,'adviser-reauth:'.$session['user_id'],5)) return ['code'=>429,'message'=>'Too many attempts. Try again in 15 minutes.'];
    $action = (string)($data['action'] ?? '');
    if (!in_array($action, ['approve','reject'], true)) return ['code'=>422,'message'=>'Choose approve or reject.'];
    if ($action === 'approve') {
        $actor = account_credentials_find_by_legacy_user($conn,(int)$session['user_id']);
        if (!$actor || !password_verify($data['current_password'] ?? '', $actor['password'])) return ['code'=>401,'message'=>'Current password is incorrect.'];
    }
    if ($action==='approve' && ($data['identity_verified']??'') !== 'yes') return ['code'=>422,'message'=>'Verify the learner or guardian identity before approving.'];
    $method = $data['verification_method']??'';
    if ($action==='approve' && !in_array($method,['in_person_learner','in_person_guardian'],true)) return ['code'=>422,'message'=>'Choose how you verified identity.'];
    if ($action==='reject') $method='not_approved';
    $fallback = trim($data['fallback_reason']??'');
    if (mb_strlen($fallback)>300) return ['code'=>422,'message'=>'Keep the reason under 300 characters.'];
    $stmt=$conn->prepare('SELECT user_id FROM learner_recovery_requests WHERE id=?');
    $stmt->execute([(int)($data['request_id']??0)]); $uid=(int)$stmt->fetchColumn();
    if (!$uid) return ['code'=>404,'message'=>'Request unavailable.'];
    $conn->beginTransaction();
    $stmt=$conn->prepare('SELECT auth_version FROM users WHERE user_id=? FOR UPDATE'); $stmt->execute([$uid]); $version=(int)$stmt->fetchColumn();
    $stmt=$conn->prepare('SELECT auth_version FROM users WHERE user_id=? FOR UPDATE'); $stmt->execute([$session['user_id']]);
    if ((int)$stmt->fetchColumn() !== (int)$_SESSION['auth_version']) { $conn->rollBack(); return ['code'=>401,'message'=>'Please sign in again.']; }
    $account=account_credentials_find_by_legacy_user($conn,$uid);
    $actor=account_credentials_find_by_legacy_user($conn,(int)$session['user_id']);
    if (!$account || $account['account_type']!=='learner' || (int)$account['is_deleted'] || (int)$account['is_active']!==1
        || !learner_recovery_actor_allowed($conn,$actor,$uid,$fallback)) {
        $conn->rollBack(); return ['code'=>403,'message'=>'You cannot handle this learner request. Registrars must record a fallback reason.'];
    }
    $stmt=$conn->prepare('SELECT *,expires_at>NOW() AS fresh FROM learner_recovery_requests WHERE id=? FOR UPDATE');
    $stmt->execute([(int)$data['request_id']]); $request=$stmt->fetch();
    if (!$request || $request['status']!=='pending' || !$request['fresh'] || (int)$request['auth_version']!==$version) {
        $conn->rollBack(); return ['code'=>409,'message'=>'This request has already been handled or expired.'];
    }
    $status=$action==='approve'?'approved':'rejected'; $tokenId=null; $url=null;
    if ($status==='approved') {
        $token=bin2hex(random_bytes(32));
        $conn->prepare("INSERT INTO password_reset_tokens (user_id,token_hash,delivery_kind,auth_version,expires_at) VALUES (?,?,'adviser',?,NOW()+INTERVAL 20 MINUTE)")->execute([$uid,hash('sha256',$token),$version]);
        $tokenId=(int)$conn->lastInsertId();
        $url=recovery_base_url().'/reset-password.html#token='.$token;
    }
    $conn->prepare('UPDATE learner_recovery_requests SET status=?,approved_by=?,verification_method=?,fallback_reason=?,decided_at=NOW(),token_id=? WHERE id=?')->execute([$status,$session['user_id'],$method,$fallback?:null,$tokenId,$request['id']]);
    recovery_event($conn,$uid,'learner_request_'.$status);
    $conn->commit();
    return ['code'=>200,'message'=>$status==='approved'?'Link created. Give it privately to the verified learner or guardian. It expires in 20 minutes.':'Request rejected.', 'reset_url'=>$url];
}
