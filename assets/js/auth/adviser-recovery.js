'use strict';

const $ = (id) => document.getElementById(id);
const form = $('decisionForm');
const requestsElement = $('requests');
const queueState = $('queueState');
const pageStatus = $('pageStatus');
const refreshButton = $('refresh');
const searchInput = $('requestSearch');
const decision = $('decision');
const reviewEmpty = $('reviewEmpty');
const issued = $('issued');

let csrf = '';
let requestId = '';
let selectedRequest = null;
let requests = [];
let currentFilter = 'pending';
let busy = false;
let role = 'teacher';

function setPageStatus(message, error = false) {
    pageStatus.textContent = message || '';
    pageStatus.dataset.error = String(error);
}

function setDecisionStatus(message, error = false) {
    const status = $('decisionStatus');
    status.textContent = message || '';
    status.hidden = !message;
    status.dataset.error = String(error);
    if (message) status.focus();
}

function setQueueState(message, { empty = false, error = false } = {}) {
    queueState.textContent = message || '';
    queueState.hidden = !message;
    queueState.classList.toggle('is-empty', empty);
    queueState.dataset.error = String(error);
}

async function api(data) {
    const response = await fetch('api/auth/adviser_recovery.php', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    let result;
    try {
        result = await response.json();
    } catch (_) {
        throw new Error('The recovery service returned an invalid response.');
    }
    return { response, result };
}

function parseRecoveryDate(value) {
    if (!value) return null;
    const normalized = String(value).replace(' ', 'T');
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatRelativeTime(value) {
    const date = parseRecoveryDate(value);
    if (!date) return 'Time unavailable';

    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
    }
    if (seconds < 86400) {
        const hours = Math.floor(seconds / 3600);
        return `${hours} hr${hours === 1 ? '' : 's'} ago`;
    }
    if (seconds < 604800) {
        const days = Math.floor(seconds / 86400);
        return `${days} day${days === 1 ? '' : 's'} ago`;
    }
    if (seconds < 2592000) {
        const weeks = Math.floor(seconds / 604800);
        return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
    }
    if (seconds < 31536000) {
        const months = Math.floor(seconds / 2592000);
        return `${months} month${months === 1 ? '' : 's'} ago`;
    }

    const years = Math.floor(seconds / 31536000);
    return `${years} year${years === 1 ? '' : 's'} ago`;
}

function formatExpiry(value) {
    const date = parseRecoveryDate(value);
    if (!date) return 'Expiry unavailable';

    const seconds = Math.floor((date.getTime() - Date.now()) / 1000);
    if (seconds <= 0) return 'Expired';
    if (seconds < 3600) {
        const minutes = Math.max(1, Math.floor(seconds / 60));
        return `Expires in ${minutes}m`;
    }
    if (seconds < 86400) {
        const hours = Math.floor(seconds / 3600);
        return `Expires in ${hours}h`;
    }

    const days = Math.floor(seconds / 86400);
    return `Expires in ${days}d`;
}

function statusLabel(status) {
    return {
        pending: 'Needs review',
        approved: 'Link active',
        completed: 'Completed',
        rejected: 'Rejected',
        expired: 'Expired'
    }[status] || 'Unavailable';
}

function statusClass(status) {
    return ['pending', 'approved', 'completed', 'rejected', 'expired'].includes(status) ? status : 'expired';
}

function makeRequestItem(request) {
    const article = document.createElement('article');
    article.className = 'request-item';

    const main = document.createElement('div');
    main.className = 'request-main';

    const name = document.createElement('strong');
    name.className = 'request-name';
    name.textContent = request.learner || 'Unnamed learner';

    const statusRow = document.createElement('div');
    statusRow.className = 'request-status-row';
    const badge = document.createElement('span');
    badge.className = `status-badge status-badge--${statusClass(request.status)}`;
    badge.textContent = statusLabel(request.status);
    const time = document.createElement('span');
    time.className = 'request-time';
    time.textContent = formatRelativeTime(request.status === 'pending'
        ? request.requested_at
        : request.decided_at || request.requested_at);
    statusRow.append(badge, time);
    main.append(name);
    article.append(main, statusRow);

    const actionColumn = document.createElement('div');
    actionColumn.className = 'request-action-column';

    if (request.status === 'pending') {
        const reviewButton = document.createElement('button');
        reviewButton.type = 'button';
        reviewButton.className = 'review-action';
        reviewButton.textContent = 'Review request';
        reviewButton.addEventListener('click', () => openDecision(request));
        actionColumn.append(reviewButton);
    } else if (request.status === 'approved' && request.link_expires_at) {
        const linkState = document.createElement('span');
        linkState.className = 'request-time';
        linkState.textContent = formatExpiry(request.link_expires_at);
        actionColumn.append(linkState);
    }

    actionColumn.setAttribute('aria-hidden', actionColumn.childElementCount ? 'false' : 'true');
    article.append(actionColumn);

    return article;
}

function renderRequests() {
    const query = String(searchInput.value || '').trim().toLowerCase();
    const visible = requests.filter((request) => {
        const inView = currentFilter === 'pending' ? request.status === 'pending' : request.status !== 'pending';
        if (!inView) return false;
        if (!query) return true;
        return [request.learner, request.lrn, request.section]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(query));
    });

    requestsElement.replaceChildren(...visible.map(makeRequestItem));
    if (!visible.length) {
        const message = query
            ? 'No requests match that search.'
            : currentFilter === 'pending'
                ? 'There are no student requests waiting for review.'
                : 'Completed and decided requests will appear here.';
        setQueueState(message, { empty: true });
    } else {
        setQueueState('');
    }
}

function renderLoadingState() {
    requestsElement.replaceChildren();
    setQueueState('Loading requests...');
    for (let index = 0; index < 3; index += 1) {
        const skeleton = document.createElement('div');
        skeleton.className = 'request-skeleton';
        skeleton.setAttribute('aria-hidden', 'true');
        requestsElement.append(skeleton);
    }
}

function closeDecision() {
    selectedRequest = null;
    requestId = '';
    form.reset();
    setDecisionStatus('');
    setIdentityValidationState(false);
    decision.hidden = true;
    reviewEmpty.hidden = false;
}

function openDecision(request) {
    if (busy || request.status !== 'pending') return;
    selectedRequest = request;
    requestId = String(request.id);
    form.reset();
    setDecisionStatus('');
    setIdentityValidationState(false);
    $('decisionTitle').textContent = request.learner || 'Review request';
    setReauthenticationMode(true);
    $('fallbackField').hidden = role !== 'registrar';
    $('fallbackReason').required = role === 'registrar';
    decision.hidden = false;
    reviewEmpty.hidden = true;
    issued.hidden = true;
    $('decisionTitle').setAttribute('tabindex', '-1');
    $('decisionTitle').focus();
}

function setReauthenticationMode(requiresPassword) {
    const section = document.querySelector('.reauthentication-section');
    const input = $('currentPassword');
    if (!section || !input) return;
    input.required = false;
    input.setAttribute('aria-required', String(requiresPassword));
    section.hidden = !requiresPassword;
    if (!requiresPassword) input.value = '';
}

function setIdentityValidationState(isInvalid) {
    const checkbox = $('identityVerified');
    const row = checkbox?.closest('.check-row');
    const error = $('identityVerificationError');
    if (!checkbox || !row || !error) return;

    row.classList.toggle('is-invalid', isInvalid);
    error.hidden = !isInvalid;
    if (isInvalid) {
        checkbox.setAttribute('aria-invalid', 'true');
    } else {
        checkbox.removeAttribute('aria-invalid');
    }
}

function setButtonBusy(button, isBusy, busyLabel) {
    if (!button) return;
    if (isBusy) {
        button.dataset.idleLabel = button.textContent;
        button.disabled = true;
        button.textContent = busyLabel;
    } else {
        button.disabled = false;
        button.textContent = button.dataset.idleLabel || button.textContent;
    }
}

async function refresh(force = false) {
    if (busy && !force) return;
    setButtonBusy(refreshButton, true, 'Refreshing');
    setPageStatus('Loading requests...');
    renderLoadingState();
    try {
        const { response, result } = await api({ action: 'list' });
        if (!response.ok || !result.success) throw new Error(result.message || 'Unable to load requests.');
        csrf = String(result.csrf || '');
        role = result.role === 'registrar' ? 'registrar' : (result.role === 'admin' ? 'admin' : 'teacher');
        $('fallbackField').hidden = role !== 'registrar';
        $('fallbackReason').required = role === 'registrar';
        requests = Array.isArray(result.requests) ? result.requests : [];
        renderRequests();
        const pending = requests.filter((item) => item.status === 'pending').length;
        setPageStatus('');
        if (selectedRequest) {
            const refreshed = requests.find((item) => String(item.id) === requestId);
            if (!refreshed || refreshed.status !== 'pending') closeDecision();
        }
    } catch (error) {
        setPageStatus(error.message || 'Unable to load requests.', true);
        requestsElement.replaceChildren();
        setQueueState('We could not load the recovery queue. Refresh and try again.', { error: true });
    } finally {
        setButtonBusy(refreshButton, false, 'Refreshing');
    }
}

async function submitDecision(event) {
    event.preventDefault();
    if (busy || !requestId || !selectedRequest) return;
    const action = event.submitter?.value || 'approve';
    const currentPassword = String($('currentPassword').value || '');

    setDecisionStatus('');
    setReauthenticationMode(action === 'approve');
    if (action === 'approve' && !$('identityVerified').checked) {
        setIdentityValidationState(true);
        $('identityVerified').focus();
        return;
    }
    setIdentityValidationState(false);
    if (action === 'approve' && !currentPassword) {
        setDecisionStatus('Enter your current password to continue.', true);
        $('currentPassword').focus();
        return;
    }
    if (role === 'registrar' && String($('fallbackReason').value || '').trim().length < 10) {
        setDecisionStatus('Record at least 10 characters explaining the registrar assistance.', true);
        $('fallbackReason').focus();
        return;
    }
    if (action === 'approve') {
        if (!$('verificationMethod').value) {
            setDecisionStatus('Choose how you verified the learner or guardian.', true);
            $('verificationMethod').focus();
            return;
        }
    }

    busy = true;
    setButtonBusy($('approve'), true, action === 'approve' ? 'Authorizing' : 'Approve and generate link');
    setButtonBusy($('reject'), true, action === 'reject' ? 'Rejecting' : 'Reject request');
    setButtonBusy($('closeDecision'), true, 'Closing');
    try {
        const { response, result } = await api({
            action,
            request_id: requestId,
            csrf,
            current_password: action === 'approve' ? currentPassword : '',
            identity_verified: $('identityVerified').checked ? 'yes' : 'no',
            verification_method: $('verificationMethod').value,
            fallback_reason: $('fallbackReason').value
        });
        $('currentPassword').value = '';
        if (!response.ok || !result.success) {
            setDecisionStatus(result.message || 'The request could not be completed.', true);
            if (response.status === 409) await refresh(true);
            return;
        }

        if (action === 'approve' && result.reset_url) {
            $('issuedUrl').value = result.reset_url;
            $('openLink').href = result.reset_url;
            decision.hidden = true;
            issued.hidden = false;
            selectedRequest = null;
            requestId = '';
            setFilter('history');
            await refresh(true);
            $('issuedTitle').setAttribute('tabindex', '-1');
            $('issuedTitle').focus();
        } else {
            closeDecision();
            await refresh(true);
            setPageStatus('Request rejected. The student can submit a new request if needed.');
        }
    } catch (_) {
        setDecisionStatus('Unable to complete the request. Refresh and try again.', true);
    } finally {
        busy = false;
        setButtonBusy($('approve'), false, 'Authorizing');
        setButtonBusy($('reject'), false, 'Rejecting');
        setButtonBusy($('closeDecision'), false, 'Closing');
    }
}

async function copyLink() {
    const input = $('issuedUrl');
    const button = $('copyLink');
    try {
        await navigator.clipboard.writeText(input.value);
        button.textContent = 'Link copied';
    } catch (_) {
        input.focus();
        input.select();
        button.textContent = 'Select and copy';
    }
    window.setTimeout(() => { button.textContent = 'Copy link'; }, 2200);
}

function setFilter(filter) {
    currentFilter = filter === 'history' ? 'history' : 'pending';
    document.querySelectorAll('.queue-tab').forEach((tab) => {
        const active = tab.dataset.filter === currentFilter;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-selected', String(active));
    });
    renderRequests();
}

refreshButton.addEventListener('click', refresh);
searchInput.addEventListener('input', renderRequests);
document.querySelectorAll('.queue-tab').forEach((tab) => tab.addEventListener('click', () => setFilter(tab.dataset.filter)));
form.addEventListener('submit', submitDecision);
$('approve').addEventListener('click', () => setReauthenticationMode(true));
$('reject').addEventListener('click', () => setReauthenticationMode(false));
$('identityVerified').addEventListener('change', () => {
    if ($('identityVerified').checked) setIdentityValidationState(false);
});
$('closeDecision').addEventListener('click', closeDecision);
$('finishReview').addEventListener('click', () => {
    issued.hidden = true;
    reviewEmpty.hidden = false;
    setFilter('pending');
});
$('copyLink').addEventListener('click', copyLink);

refresh();
window.setInterval(() => {
    if (!requests.length) return;
    renderRequests();
    if (selectedRequest) {
        $('decisionTitle').textContent = selectedRequest.learner || 'Review request';
    }
}, 60000);
