<?php
require __DIR__ . '/api/database/connection.php';
require __DIR__ . '/api/utils/password_recovery.php';
require_once __DIR__ . '/api/utils/auth.php';

auth_start_session();
if (empty($_SESSION['user_id'])) {
    header('Location: index.html');
    exit;
}

$session = auth_require();
if (!in_array($session['role_key'], ['admin', 'teacher', 'registrar'], true)) {
    http_response_code(403);
    exit('Admin, adviser, or registrar access required.');
}

$returnPath = (string)($_GET['return'] ?? 'pages/profile-security.html');
if (!preg_match('/^(?:pages|dashboard)\/[A-Za-z0-9_\/-]+\.html$/D', $returnPath)) {
    $returnPath = 'pages/profile-security.html';
}

$e = static fn (string $value): string => htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
?>
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>Student account recovery</title>
    <link rel="stylesheet" href="assets/css/adviser-recovery.css?v=20260921-danger-action">
    <link rel="stylesheet" href="assets/css/mobile-polish.css?v=20260924-responsive-foundation">
    <script src="assets/js/auth/adviser-recovery.js?v=20260921-copy-cleanup" defer></script>
</head>
<body>
    <a class="skip-link" href="#main-content">Skip to content</a>

    <header class="recovery-topbar">
        <a class="recovery-brand" href="<?= $e($returnPath) ?>">
            <img src="assets/img/logo/logo.png" alt="G. Pelaez Integrated School">
            <span class="recovery-brand-copy">
                <strong>G. Pelaez Integrated School</strong>
                <small>Student account recovery</small>
            </span>
        </a>
        <nav class="recovery-nav" aria-label="Recovery navigation">
            <a class="button button--secondary" href="<?= $e($returnPath) ?>">← Back</a>
        </nav>
    </header>

    <main id="main-content" class="recovery-shell">
        <section class="recovery-intro" aria-labelledby="pageTitle">
            <div>
                <h1 id="pageTitle">Student account recovery</h1>
            </div>
            <p id="pageStatus" class="panel-meta" role="status" aria-live="polite"></p>
        </section>

        <div class="recovery-workspace">
            <section class="request-queue" aria-labelledby="queueTitle">
                <div class="queue-heading">
                    <div>
                        <h2 id="queueTitle">Recovery requests</h2>
                    </div>
                    <button id="refresh" class="button button--secondary" type="button">Refresh</button>
                </div>

                <div class="queue-controls">
                    <label class="search-field" for="requestSearch">
                        Search requests
                        <input id="requestSearch" type="search" placeholder="Name, LRN, or section" autocomplete="off">
                    </label>
                    <div class="queue-tabs" role="tablist" aria-label="Request status">
                        <button class="queue-tab is-active" type="button" role="tab" aria-selected="true" data-filter="pending">Needs review</button>
                        <button class="queue-tab" type="button" role="tab" aria-selected="false" data-filter="history">History</button>
                    </div>
                </div>

                <p id="queueState" class="queue-state" role="status" aria-live="polite" hidden></p>
                <div id="requests" class="request-list" aria-live="polite"></div>
            </section>

            <aside class="review-column" aria-label="Recovery review">
                <section id="reviewEmpty" class="review-panel review-empty" aria-labelledby="reviewEmptyTitle">
                    <h2 id="reviewEmptyTitle">Choose a request to review</h2>
                    <div class="review-rule">
                        <strong>Verify in person.</strong>
                        <span>Only issue a reset link after confirming the learner or guardian’s identity.</span>
                    </div>
                </section>

                <section id="decision" class="review-panel" aria-labelledby="decisionTitle" hidden>
                    <div class="review-panel-heading">
                        <div>
                            <p class="panel-kicker">Review request</p>
                            <h2 id="decisionTitle">Review learner</h2>
                        </div>
                        <button id="closeDecision" class="text-button" type="button">Close</button>
                    </div>

                    <form id="decisionForm" class="decision-form">
                        <section class="form-section">
                            <label for="verificationMethod">
                                Verification method
                                <select id="verificationMethod">
                                    <option value="">Choose a method</option>
                                    <option value="in_person_learner">Verified learner in person</option>
                                    <option value="in_person_guardian">Verified guardian in person</option>
                                </select>
                            </label>
                            <label class="check-row" for="identityVerified">
                                <input id="identityVerified" type="checkbox">
                                <span>I verified the person’s identity.</span>
                            </label>
                            <p id="identityVerificationError" class="field-error" hidden>Confirm identity verification before approving this request.</p>
                        </section>

                        <section id="fallbackField" class="form-section" hidden>
                            <h3>Registrar assistance</h3>
                            <p class="section-help">Record why registrar assistance is needed for this request.</p>
                            <label for="fallbackReason">
                                Reason
                                <textarea id="fallbackReason" maxlength="300" placeholder="For example, the learner has no assigned adviser."></textarea>
                            </label>
                        </section>

                        <section class="form-section reauthentication-section">
                            <p class="section-help">Enter your current password to approve a reset link.</p>
                            <label for="currentPassword">
                                Current password
                                <input id="currentPassword" type="password" autocomplete="current-password">
                            </label>
                        </section>

                        <div class="decision-actions">
                            <button id="approve" class="button button--primary" type="submit" value="approve">Approve and generate link</button>
                            <button id="reject" class="button button--danger" type="submit" value="reject">Reject request</button>
                        </div>
                        <p id="decisionStatus" class="inline-status" role="status" aria-live="polite" hidden></p>
                    </form>
                </section>

                <section id="issued" class="review-panel issued-panel" aria-labelledby="issuedTitle" hidden>
                    <div class="issued-icon" aria-hidden="true">✓</div>
                    <h2 id="issuedTitle">Reset link ready</h2>
                    <p>Give this link privately to the verified learner or guardian. It expires in 20 minutes and works once.</p>
                    <label for="issuedUrl">One-time reset link</label>
                    <div class="copy-row">
                        <input id="issuedUrl" type="text" readonly>
                        <button id="copyLink" class="button button--secondary" type="button">Copy link</button>
                    </div>
                    <div class="issued-actions">
                        <a id="openLink" class="button button--primary" target="_blank" rel="noopener noreferrer">Open reset page</a>
                        <button id="finishReview" class="button button--quiet" type="button">Finish review</button>
                    </div>
                    <p class="issued-footnote">The learner chooses their own password. Do not ask them to share it.</p>
                </section>
            </aside>
        </div>
    </main>
    <script src="assets/js/network-status.js?v=20261009-network-status-v1" data-network-status="true" defer></script>
</body>
</html>
