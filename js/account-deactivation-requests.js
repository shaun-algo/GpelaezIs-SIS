const ACCOUNT_REQUESTS_API_BASE = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;
const ACCOUNT_REQUESTS_API = `${ACCOUNT_REQUESTS_API_BASE}/account_security/account_security.php`;

axios.defaults.withCredentials = true;

(function initAccountDeactivationRequests() {
    const pendingList = document.getElementById('accountRequestsPendingList');
    const archiveModal = document.getElementById('accountRequestArchiveModal');
    const archiveList = document.getElementById('accountRequestArchiveList');
    const archiveTitle = document.getElementById('accountRequestArchiveTitle');
    const archiveSearch = document.getElementById('accountRequestArchiveSearch');
    const archiveLoadMore = document.getElementById('accountRequestArchiveLoadMoreBtn');
    const moreButton = document.getElementById('accountRequestsMoreBtn');
    const moreMenu = document.getElementById('accountRequestsMoreMenu');
    const modal = document.getElementById('accountRequestDetailModal');
    const detailTitle = document.getElementById('accountRequestDetailTitle');
    const detailBody = document.getElementById('accountRequestDetailBody');
    const approveButton = document.getElementById('accountRequestApproveBtn');
    const rejectButton = document.getElementById('accountRequestRejectBtn');
    const reactivateButton = document.getElementById('accountRequestReactivateBtn');
    const reauthModal = document.getElementById('accountRequestReauthModal');
    const reauthTitle = document.getElementById('accountRequestReauthTitle');
    const reauthPassword = document.getElementById('accountRequestReauthPassword');
    const reauthError = document.getElementById('accountRequestReauthError');
    const reauthConfirm = document.getElementById('accountRequestReauthConfirmBtn');
    let records = [];
    let activeRequest = null;
    let activeDecision = '';
    let activeArchiveView = 'approved';
    let archiveRows = [];
    let archiveVisibleLimit = 8;

    function notify(message, type = 'info') {
        const text = String(message || '').trim();
        if (!text) return;
        if (typeof window.showNotification === 'function') {
            window.showNotification(escapeHtml(text), type);
        }
    }

    function actionLabel(decision) {
        if (decision === 'REACTIVATE') return 'Reactivate account';
        if (decision === 'APPROVE') return 'Approve request';
        return 'Reject request';
    }

    function setReviewError(message = '') {
        const text = String(message || '').trim();
        if (reauthError) reauthError.textContent = text;
        if (reauthPassword) {
            if (text) reauthPassword.setAttribute('aria-invalid', 'true');
            else reauthPassword.removeAttribute('aria-invalid');
        }
    }

    function setReviewButtonBusy(busy) {
        if (!reauthConfirm) return;
        if (busy) {
            reauthConfirm.disabled = true;
            reauthConfirm.setAttribute('aria-busy', 'true');
            reauthConfirm.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Processing...</span>';
            return;
        }
        reauthConfirm.disabled = false;
        reauthConfirm.removeAttribute('aria-busy');
        reauthConfirm.textContent = actionLabel(activeDecision);
    }

    if (!pendingList || !archiveModal || !archiveList || !modal) return;

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function parseDate(value) {
        if (!value) return null;
        const date = new Date(String(value).replace(' ', 'T'));
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function formatDate(value) {
        const date = parseDate(value);
        return date
            ? date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
            : 'Not available';
    }

    function relativeDate(value) {
        const date = parseDate(value);
        if (!date) return 'Recently';
        const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
        if (minutes < 1) return 'Just now';
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}d ago`;
        return formatDate(value);
    }

    function normalizedStatus(row) {
        return String(row?.status || '').toUpperCase();
    }

    function rowMarkup(row, archiveMode = false) {
        const name = row.full_name || row.username || 'Employee account';
        const dateValue = archiveMode ? (row.reviewed_at || row.requested_at) : row.requested_at;
        return `<button type="button" class="account-request-row" data-account-request-id="${Number(row.request_id) || 0}">
            <span class="account-request-row__main">
                <span class="account-request-row__name">${escapeHtml(name)}</span>
                <span class="account-request-row__meta"><span>${escapeHtml(row.reason_label || 'Other')}</span><span>${escapeHtml(relativeDate(dateValue))}</span></span>
            </span>
            <i class="fas fa-chevron-right account-request-row__arrow" aria-hidden="true"></i>
        </button>`;
    }

    function emptyStateMarkup(message) {
        return `<div class="account-requests-empty account-requests-empty--search">
            <video class="account-requests-empty__video" autoplay muted loop playsinline aria-hidden="true">
                <source src="../assets/icons/search.mp4" type="video/mp4">
            </video>
            <p>${escapeHtml(message)}</p>
        </div>`;
    }

    function renderList(node, rows, emptyText, archiveMode = false) {
        node.innerHTML = rows.length
            ? rows.map((row) => rowMarkup(row, archiveMode)).join('')
            : emptyStateMarkup(emptyText);
    }

    function renderLists() {
        const pending = records.filter((row) => normalizedStatus(row) === 'PENDING');
        renderList(pendingList, pending, 'No requests are waiting for review.');
    }

    function archiveDateValue(row) {
        return row?.reviewed_at || row?.requested_at;
    }

    function archiveDateLabel(value) {
        const date = parseDate(value);
        if (!date) return 'Earlier';
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const days = Math.floor((todayStart.getTime() - dateStart.getTime()) / 86400000);
        if (days <= 0) return 'Today';
        if (days === 1) return 'Yesterday';
        if (days < 7) return `${days} days ago`;
        if (days < 30) return `${Math.floor(days / 7)}w`;
        if (days < 365) return `${Math.floor(days / 30)}mo`;
        const years = Math.floor(days / 365);
        return years === 1 ? 'a year ago' : `${years}y`;
    }

    function archiveMatchesSearch(row) {
        const query = String(archiveSearch?.value || '').trim().toLowerCase();
        if (!query) return true;
        return [row.full_name, row.username, row.reason_label, row.reason_other, row.requested_at, row.reviewed_at]
            .some((value) => String(value || '').toLowerCase().includes(query));
    }

    function renderArchive() {
        const filtered = archiveRows
            .filter(archiveMatchesSearch)
            .sort((left, right) => {
                const leftTime = parseDate(archiveDateValue(left))?.getTime() || 0;
                const rightTime = parseDate(archiveDateValue(right))?.getTime() || 0;
                return rightTime - leftTime;
            });
        const visible = filtered.slice(0, archiveVisibleLimit);
        const groups = [];
        visible.forEach((row) => {
            const label = archiveDateLabel(archiveDateValue(row));
            let group = groups.find((item) => item.label === label);
            if (!group) {
                group = { label, rows: [] };
                groups.push(group);
            }
            group.rows.push(row);
        });
        archiveList.innerHTML = groups.length
            ? groups.map((group) => `<section class="account-request-date-group">
                <h3>${escapeHtml(group.label)}</h3>
                <div class="account-request-date-group__list">${group.rows.map((row) => rowMarkup(row, true)).join('')}</div>
            </section>`).join('')
            : `<p class="account-requests-empty">${escapeHtml(archiveSearch?.value ? 'No matching archived requests.' : 'No archived requests are available.')}</p>`;
        if (archiveLoadMore) archiveLoadMore.hidden = visible.length >= filtered.length;
    }

    function detailField(label, value) {
        return `<div class="account-request-detail"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || 'Not provided')}</dd></div>`;
    }

    function openDetails(request) {
        activeRequest = request;
        activeDecision = '';
        const status = normalizedStatus(request);
        const name = request.full_name || request.username || 'Employee account';
        const isPending = status === 'PENDING';
        const isApprovedInactive = status === 'APPROVED' && Number(request.is_active) !== 1;
        if (detailTitle) detailTitle.textContent = name;
        if (detailBody) {
            detailBody.innerHTML = `<dl class="account-request-detail-grid">
                ${detailField('Reason', request.reason_label || 'Other')}
                ${detailField('Requested', formatDate(request.requested_at))}
                ${detailField('Reviewed', request.reviewed_at ? formatDate(request.reviewed_at) : 'Not reviewed')}
                ${detailField('Account status', Number(request.is_active) === 1 ? 'Active' : 'Inactive / archived')}
                ${detailField('Explanation', request.reason_other || 'None provided')}
            </dl>`;
        }
        if (approveButton) approveButton.hidden = !isPending;
        if (rejectButton) rejectButton.hidden = !isPending;
        if (reactivateButton) reactivateButton.hidden = !isApprovedInactive;
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
        setTimeout(() => document.getElementById('accountRequestCloseBtn')?.focus(), 30);
    }

    function closeDetails() {
        closeReviewConfirmation();
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        activeRequest = null;
        activeDecision = '';
    }

    function openReviewConfirmation(decision) {
        if (!activeRequest || !reauthModal) return;
        activeDecision = decision;
        const approving = decision === 'APPROVE';
        const reactivating = decision === 'REACTIVATE';
        if (reauthTitle) reauthTitle.textContent = reactivating
            ? 'Confirm reactivation'
            : (approving ? 'Confirm approval' : 'Confirm rejection');
        if (reauthConfirm) {
            reauthConfirm.textContent = actionLabel(decision);
            reauthConfirm.classList.toggle('btn-primary', approving || reactivating);
            reauthConfirm.classList.toggle('btn-outline', !approving && !reactivating);
            reauthConfirm.disabled = false;
            reauthConfirm.removeAttribute('aria-busy');
        }
        if (reauthPassword) reauthPassword.value = '';
        setReviewError('');
        reauthModal.classList.add('is-open');
        reauthModal.setAttribute('aria-hidden', 'false');
        setTimeout(() => reauthPassword?.focus(), 30);
    }

    function closeReviewConfirmation() {
        if (!reauthModal) return;
        reauthModal.classList.remove('is-open');
        reauthModal.setAttribute('aria-hidden', 'true');
        if (reauthPassword) reauthPassword.value = '';
        setReviewError('');
        setReviewButtonBusy(false);
    }

    function closeArchive() {
        archiveModal.classList.remove('is-open');
        archiveModal.setAttribute('aria-hidden', 'true');
        if (moreButton) moreButton.focus();
    }

    function openArchive(view) {
        activeArchiveView = view;
        const isApproved = view === 'approved';
        archiveRows = records.filter((row) => isApproved
            ? normalizedStatus(row) === 'APPROVED' && Number(row.is_active) !== 1
            : ['DECLINED', 'CANCELLED'].includes(normalizedStatus(row)));
        archiveVisibleLimit = 8;
        if (archiveTitle) archiveTitle.textContent = isApproved ? 'Deactivated / archive' : 'Closed / rejected requests';
        if (archiveSearch) archiveSearch.value = '';
        renderArchive();
        if (moreMenu) moreMenu.hidden = true;
        if (moreButton) moreButton.setAttribute('aria-expanded', 'false');
        archiveModal.classList.add('is-open');
        archiveModal.setAttribute('aria-hidden', 'false');
        setTimeout(() => document.getElementById('accountRequestArchiveCloseBtn')?.focus(), 30);
    }

    async function loadRequests({ announceError = true } = {}) {
        pendingList.setAttribute('aria-busy', 'true');
        archiveList.setAttribute('aria-busy', 'true');
        try {
            const response = await axios.get(`${ACCOUNT_REQUESTS_API}?operation=getDeactivationRequests&status=ALL&_=${Date.now()}`);
            if (response.data?.success !== true) throw new Error(response.data?.message || 'Unable to load requests.');
            records = Array.isArray(response.data?.data) ? response.data.data : [];
            renderLists();
            if (archiveModal.classList.contains('is-open')) {
                const isApproved = activeArchiveView === 'approved';
                archiveRows = records.filter((row) => isApproved
                    ? normalizedStatus(row) === 'APPROVED' && Number(row.is_active) !== 1
                    : ['DECLINED', 'CANCELLED'].includes(normalizedStatus(row)));
                renderArchive();
            }
            return true;
        } catch (error) {
            const message = error?.response?.data?.message || error?.message || 'Account deactivation requests are temporarily unavailable.';
            pendingList.innerHTML = `<p class="account-requests-error">${escapeHtml(message)}</p>`;
            archiveList.innerHTML = '<p class="account-requests-empty">Archive unavailable.</p>';
            if (announceError) notify(message, 'error');
            return false;
        } finally {
            pendingList.removeAttribute('aria-busy');
            archiveList.removeAttribute('aria-busy');
        }
    }

    async function submitDecision(decision) {
        if (!activeRequest) return;
        const status = normalizedStatus(activeRequest);
        const accountIsActive = Number(activeRequest.is_active) === 1;
        if (decision === 'REACTIVATE' && (status !== 'APPROVED' || accountIsActive)) {
            setReviewError(accountIsActive
                ? 'This account is already active. Refresh the request list before trying again.'
                : 'Only approved inactive accounts can be reactivated. Refresh the request list before trying again.');
            return;
        }
        if (decision !== 'REACTIVATE' && status !== 'PENDING') {
            setReviewError('This request is no longer waiting for review. Refresh the request list before trying again.');
            return;
        }
        const password = reauthPassword?.value || '';
        if (!password) {
            setReviewError('Re-enter your administrator password first.');
            reauthPassword?.focus();
            return;
        }
        activeDecision = decision;
        setReviewError('');
        setReviewButtonBusy(true);
        try {
            const isReactivation = decision === 'REACTIVATE';
            const payload = {
                request_id: Number(activeRequest.request_id),
                admin_password: password,
            };
            if (!isReactivation) payload.decision = decision;
            const response = await axios.post(`${ACCOUNT_REQUESTS_API}?operation=${isReactivation ? 'reactivateAccount' : 'reviewDeactivation'}`, payload);
            if (response.data?.success !== true) throw new Error(response.data?.message || 'The action could not be completed.');
            const fallbackMessage = isReactivation
                ? 'Account reactivated successfully. The account is active again.'
                : (decision === 'APPROVE'
                    ? 'Deactivation request approved successfully.'
                    : 'Deactivation request rejected successfully.');
            const successMessage = response.data?.message || fallbackMessage;
            closeReviewConfirmation();
            closeDetails();
            notify(successMessage, 'success');
            const refreshed = await loadRequests({ announceError: false });
            if (!refreshed) {
                notify('The action succeeded, but the request list could not refresh. Reload the page to verify the current status.', 'info');
            }
        } catch (error) {
            setReviewError(error?.response?.data?.message || error?.message || 'The action could not be completed. Try again.');
        } finally {
            if (reauthModal?.classList.contains('is-open')) setReviewButtonBusy(false);
        }
    }

    moreButton?.addEventListener('click', () => {
        if (!moreMenu) return;
        moreMenu.hidden = !moreMenu.hidden;
        moreButton.setAttribute('aria-expanded', String(!moreMenu.hidden));
    });
    moreMenu?.addEventListener('click', (event) => {
        const option = event.target.closest('[data-archive-view]');
        if (option) openArchive(option.dataset.archiveView);
    });
    archiveSearch?.addEventListener('input', () => {
        archiveVisibleLimit = 8;
        renderArchive();
    });
    archiveLoadMore?.addEventListener('click', () => {
        archiveVisibleLimit += 8;
        renderArchive();
    });
    document.addEventListener('click', (event) => {
        const row = event.target.closest('[data-account-request-id]');
        if (row) {
            const request = records.find((item) => Number(item.request_id) === Number(row.dataset.accountRequestId));
            if (request) openDetails(request);
            return;
        }
        if (moreMenu && !moreMenu.hidden && !event.target.closest('.account-requests-menu-wrap')) {
            moreMenu.hidden = true;
            moreButton?.setAttribute('aria-expanded', 'false');
        }
    });
    document.getElementById('accountRequestArchiveCloseBtn')?.addEventListener('click', closeArchive);
    document.getElementById('accountRequestArchiveCloseBtnFooter')?.addEventListener('click', closeArchive);
    archiveModal.addEventListener('click', (event) => {
        if (event.target === archiveModal) closeArchive();
    });
    document.getElementById('accountRequestCloseBtn')?.addEventListener('click', closeDetails);
    document.getElementById('accountRequestCloseBtnFooter')?.addEventListener('click', closeDetails);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeDetails();
    });
    approveButton?.addEventListener('click', () => openReviewConfirmation('APPROVE'));
    rejectButton?.addEventListener('click', () => openReviewConfirmation('DECLINE'));
    reactivateButton?.addEventListener('click', () => openReviewConfirmation('REACTIVATE'));
    reauthConfirm?.addEventListener('click', () => submitDecision(activeDecision));
    reauthPassword?.addEventListener('input', () => {
        if (reauthError?.textContent) setReviewError('');
    });
    document.getElementById('accountRequestReauthCloseBtn')?.addEventListener('click', closeReviewConfirmation);
    document.getElementById('accountRequestReauthCancelBtn')?.addEventListener('click', closeReviewConfirmation);
    reauthModal?.addEventListener('click', (event) => {
        if (event.target === reauthModal) closeReviewConfirmation();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (reauthModal?.classList.contains('is-open')) {
            closeReviewConfirmation();
            return;
        }
        if (modal.classList.contains('is-open')) closeDetails();
        if (archiveModal.classList.contains('is-open')) closeArchive();
    });

    loadRequests();
})();
