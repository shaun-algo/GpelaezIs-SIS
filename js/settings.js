const SETTINGS_API_BASE = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;
const ACCOUNT_SECURITY_API = `${SETTINGS_API_BASE}/account_security/account_security.php`;

axios.defaults.withCredentials = true;

(function initSettingsPage() {
    function setSettingsDisclosure(toggle, expanded) {
        if (!toggle) return;
        const panel = document.getElementById(toggle.getAttribute('aria-controls') || '');
        if (!panel) return;
        const owner = toggle.closest('.settings-option-card, .settings-suboption-card, .settings-about-detail');
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        panel.hidden = !expanded;
        owner?.classList.toggle('is-open', expanded);
        if (owner) {
            owner.classList.remove('is-toggling');
            requestAnimationFrame(() => {
                owner.classList.add('is-toggling');
                window.setTimeout(() => owner.classList.remove('is-toggling'), 360);
            });
        }
    }

    function syncSettingsDisclosure(toggle) {
        if (!toggle) return;
        const panel = document.getElementById(toggle.getAttribute('aria-controls') || '');
        if (!panel) return;
        const owner = toggle.closest('.settings-option-card, .settings-suboption-card, .settings-about-detail');
        const expanded = toggle.getAttribute('aria-expanded') === 'true' && !panel.hidden;
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        panel.hidden = !expanded;
        owner?.classList.toggle('is-open', expanded);
        owner?.classList.remove('is-toggling');
    }

    function openSettingsDisclosure(toggleId) {
        setSettingsDisclosure(document.getElementById(toggleId), true);
    }

    document.querySelectorAll('[data-settings-toggle]').forEach((toggle) => {
        syncSettingsDisclosure(toggle);
        toggle.addEventListener('click', () => {
            setSettingsDisclosure(toggle, toggle.getAttribute('aria-expanded') !== 'true');
        });
    });

    const els = {
        value: document.getElementById('sessionTimeoutValue'),
        select: document.getElementById('sessionTimeoutSelect'),
        summary: document.getElementById('sessionTimeoutSummary'),
        help: document.getElementById('sessionTimeoutHelp'),
    };

    if (!els.value || !els.select) return;

    const defaultTimeoutOptions = [5, 10, 15, 20, 30];
    let timeoutOptions = [...defaultTimeoutOptions];
    let currentMinutes = 30;
    let canUpdateTimeout = false;
    let deactivationUndoUntil = 0;
    let deactivationUndoTimer = null;
    function notify(message, type = 'info') {
        if (typeof window.showNotification === 'function') {
            window.showNotification(message, type === 'warning' ? 'info' : type);
            return;
        }
        if (typeof window.alert === 'function') window.alert(message);
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function parseSettingsDate(value) {
        if (!value) return null;
        const date = new Date(String(value).replace(' ', 'T'));
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function formatAccountDate(value) {
        const date = parseSettingsDate(value);
        return date
            ? date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
            : 'Not available';
    }

    function formatAccountSystemPosition(data) {
        const raw = String(data?.role_name || data?.role_key || data?.account_type || '').trim();
        if (!raw) return 'Not available';
        const labels = {
            admin: 'Administrator',
            administrator: 'Administrator',
            teacher: 'Teacher',
            adviser: 'Adviser',
            advisor: 'Adviser',
            registrar: 'Registrar',
            learners: 'Learner',
            learner: 'Learner',
            employee: 'Employee'
        };
        const key = raw.toLowerCase().replace(/[\s_-]+/g, '');
        return labels[key] || raw.replace(/[\s_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function formatSecurityTime(value, ageSeconds = null) {
        const date = parseSettingsDate(value);
        const measuredAge = Number(ageSeconds);
        const seconds = Number.isFinite(measuredAge) && measuredAge >= 0
            ? Math.floor(measuredAge)
            : (date ? Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000)) : null);
        if (seconds === null) return 'For a while';
        if (seconds < 60) return 'Just now';
        if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
        if (seconds < 86400) return `${Math.max(1, Math.floor(seconds / 3600))}hr ago`;
        if (seconds < 604800) return `${Math.max(1, Math.floor(seconds / 86400))}d ago`;
        if (seconds < 2592000) {
            const weeks = Math.max(1, Math.floor(seconds / 604800));
            return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
        }
        if (seconds < 31536000) {
            const months = Math.max(1, Math.floor(seconds / 2592000));
            return `${months} month${months === 1 ? '' : 's'} ago`;
        }
        const years = Math.max(1, Math.floor(seconds / 31536000));
        return `${years} year${years === 1 ? '' : 's'} ago`;
    }

    function securityBrowserAndDevice(userAgent) {
        const value = String(userAgent || '');
        let browser = 'Unknown browser';
        if (/EdgA?\//i.test(value) || /EdgiOS\//i.test(value)) browser = 'Edge';
        else if (/OPR\//i.test(value)) browser = 'Opera';
        else if (/SamsungBrowser\//i.test(value)) browser = 'Samsung Internet';
        else if (/CriOS\//i.test(value) || /Chrome\//i.test(value)) browser = 'Chrome';
        else if (/FxiOS\//i.test(value) || /Firefox\//i.test(value)) browser = 'Firefox';
        else if (/Safari\//i.test(value)) browser = 'Safari';

        let device = 'Unknown device';
        if (/iPhone/i.test(value)) device = 'iPhone';
        else if (/iPad/i.test(value)) device = 'iPad';
        else if (/Android/i.test(value)) device = 'Android';
        else if (/Windows/i.test(value)) device = 'Windows';
        else if (/Mac OS X|Macintosh/i.test(value)) device = 'Mac';
        else if (/Linux/i.test(value)) device = 'Linux';
        return `${browser} on ${device}`;
    }

    function normalizeSecurityAgent(value) {
        return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function isCurrentSecuritySession(row) {
        if (Object.prototype.hasOwnProperty.call(row || {}, 'is_current')) return row.is_current === true;
        const currentAgent = normalizeSecurityAgent(window.navigator?.userAgent);
        const sessionAgent = normalizeSecurityAgent(row?.user_agent);
        return Boolean(currentAgent && sessionAgent && currentAgent === sessionAgent);
    }

    function sessionSortTime(row) {
        const ageSeconds = Number(row?.last_seen_age_seconds ?? row?.action_age_seconds);
        if (Number.isFinite(ageSeconds) && ageSeconds >= 0) return -ageSeconds;
        return parseSettingsDate(row?.last_seen_at || row?.action_time)?.getTime() || 0;
    }

    function renderSecuritySessions(rows) {
        const container = document.getElementById('accountSecuritySessions');
        if (!container) return;
        const groups = Array.isArray(rows) ? rows : [];
        if (!groups.length) {
            container.innerHTML = '<div class="settings-session-list"><p class="settings-inline-state">No logged-in devices are recorded yet.</p></div>';
            return;
        }
        const orderedGroups = groups
            .map((row, index) => ({ row, index, isCurrent: isCurrentSecuritySession(row), sortTime: sessionSortTime(row) }))
            .sort((first, second) => Number(second.isCurrent) - Number(first.isCurrent)
                || second.sortTime - first.sortTime
                || first.index - second.index);
        const currentRow = orderedGroups.find(({ isCurrent }) => isCurrent)?.row || null;
        const isMainDevice = (row) => row?.is_main_device === true || Number(row?.is_main_device || 0) === 1;
        const canManageSessions = isMainDevice(currentRow);
        const currentDeviceIsPending = currentRow?.new_device_pending === true;
        const visibleGroups = !canManageSessions && currentDeviceIsPending
            ? orderedGroups.filter(({ isCurrent }) => isCurrent)
            : orderedGroups;
        const showSecurityBadges = canManageSessions;
        container.innerHTML = `<div class="settings-session-list">${visibleGroups.map(({ row, isCurrent }) => {
            const status = String(row?.status || '').toUpperCase();
            const isBlocked = row?.is_blocked === true || status === 'BLOCKED';
            const isActive = typeof row?.is_active === 'boolean'
                ? row.is_active
                : !['BLOCKED', 'SIGNED_OUT'].includes(status);
            const lastSeen = formatSecurityTime(
                row?.last_seen_at || row?.action_time,
                row?.last_seen_age_seconds ?? row?.action_age_seconds
            );
            const activeDuration = lastSeen === 'For a while'
                ? 'a while'
                : lastSeen === 'Just now'
                    ? 'less than 1m'
                    : lastSeen.replace(/\s+ago$/, '');
            const sessionKey = String(row?.session_key || '');
            const canActOnSession = canManageSessions && !isCurrent && !isBlocked && /^[a-f0-9]{64}$/i.test(sessionKey);
            const needsConfirmation = canActOnSession && row?.new_device_pending === true;
            const manageAction = canActOnSession
                ? needsConfirmation
                    ? `<button type="button" class="settings-session-not-you settings-session-check" data-session-confirm data-session-key="${escapeHtml(sessionKey)}" data-session-device-id="${escapeHtml(row?.session_device_id || '')}" data-session-device="${escapeHtml(row?.device_label || securityBrowserAndDevice(row.user_agent))}">Check device</button>`
                    : `<button type="button" class="settings-session-not-you" data-session-manage data-session-key="${escapeHtml(sessionKey)}" data-session-device="${escapeHtml(row?.device_label || securityBrowserAndDevice(row.user_agent))}">Manage</button>`
                : '';
            const statusText = isCurrent
                ? 'Active now'
                : isBlocked
                    ? `Blocked · last seen ${lastSeen}`
                    : isActive
                        ? `Active for ${activeDuration}`
                        : `Last seen ${lastSeen}`;
            const locationLabel = String(row?.location_label || '').trim();
            const locationMarkup = locationLabel
                ? `<span class="settings-session-location">${escapeHtml(locationLabel)}</span>`
                : '';
            const badges = `${showSecurityBadges && isMainDevice(row) ? '<span class="settings-session-main-device">Main device</span>' : ''}${isCurrent ? '<span class="settings-session-current">Current</span>' : ''}${showSecurityBadges && row?.new_device_pending ? '<span class="settings-session-pending">Confirmation needed</span>' : ''}`;
            return `<div class="settings-session-row${isCurrent ? ' is-current' : ''}${isBlocked ? ' is-blocked' : ''}">
                <div class="settings-session-main">
                    <p class="settings-session-title">${escapeHtml(row?.device_label || securityBrowserAndDevice(row.user_agent))} ${badges}</p>
                    <div class="settings-session-meta">${locationMarkup}<span>${escapeHtml(statusText)}</span></div>
                </div>
                ${manageAction}
            </div>`;
        }).join('')}</div>`;
    }

    let selectedSessionKey = '';

    function setSessionActionError(message = '') {
        const node = document.getElementById('sessionActionError');
        if (!node) return;
        node.textContent = message;
    }

    function closeSessionActionModal() {
        const modal = document.getElementById('sessionActionModal');
        if (!modal) return;
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');
        selectedSessionKey = '';
        setSessionActionError('');
    }

    function openSessionActionModal(sessionKey, deviceLabel) {
        const modal = document.getElementById('sessionActionModal');
        if (!modal || !/^[a-f0-9]{64}$/i.test(sessionKey)) return;
        selectedSessionKey = sessionKey;
        const device = document.getElementById('sessionActionDevice');
        if (device) device.textContent = deviceLabel || 'Selected login session';
        setSessionActionError('');
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
        document.getElementById('sessionTerminateBtn')?.focus();
    }

    async function applySessionAction(action) {
        if (!selectedSessionKey || !['terminate', 'block'].includes(action)) return;
        if (action === 'block' && !window.confirm('Block this device? Its active sessions will be ended, and future sign-ins from this browser/device will be denied for this account.')) return;

        const buttons = [document.getElementById('sessionTerminateBtn'), document.getElementById('sessionBlockBtn')];
        buttons.forEach((button) => { if (button) button.disabled = true; });
        setSessionActionError('');
        try {
            const response = await axios.post(`${ACCOUNT_SECURITY_API}?operation=manageSession`, {
                action,
                session_key: selectedSessionKey,
            });
            if (response.data?.success === false) throw new Error(response.data?.message || 'Unable to update this login session.');
            closeSessionActionModal();
            notify(response.data?.message || (action === 'block' ? 'Device blocked.' : 'Login session terminated.'), 'success');
            await loadAccountSecurity();
        } catch (error) {
            setSessionActionError(error?.response?.data?.message || error?.message || 'The login-session action could not be completed.');
        } finally {
            buttons.forEach((button) => { if (button) button.disabled = false; });
        }
    }

    function setRequestStatus(message, tone = '') {
        const node = document.getElementById('deactivationRequestStatus');
        if (!node) return;
        node.className = `settings-request-status${tone ? ` is-${tone}` : ''}`;
        node.textContent = message || '';
    }

    let deactivationRequest = null;
    let deactivationAvailableAt = 0;

    function formatCountdown(milliseconds) {
        const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
        return `${seconds}s`;
    }

    function stopDeactivationTicker() {
        if (deactivationUndoTimer) {
            clearInterval(deactivationUndoTimer);
            deactivationUndoTimer = null;
        }
    }

    function finishDeactivationUndoWindow() {
        deactivationUndoUntil = 0;
        const submit = document.getElementById('deactivationSubmitBtn');
        const availability = document.getElementById('deactivationAvailabilityValue');
        if (availability) availability.textContent = 'Pending review';
        if (!submit) return;
        submit.hidden = true;
        submit.disabled = false;
        submit.classList.remove('is-undo');
        submit.removeAttribute('aria-label');
    }

    function updateDeactivationAction() {
        const submit = document.getElementById('deactivationSubmitBtn');
        if (!submit) return;
        const availability = document.getElementById('deactivationAvailabilityValue');
        const status = String(deactivationRequest?.status || '').toUpperCase();
        const undoRemaining = deactivationUndoUntil - Date.now();
        const availableRemaining = deactivationAvailableAt - Date.now();
        if (status === 'PENDING') {
            if (undoRemaining > 0) {
                if (availability) availability.textContent = `Undo · ${formatCountdown(undoRemaining)}`;
                submit.hidden = false;
                submit.disabled = false;
                submit.classList.add('is-undo');
                submit.textContent = `Undo request · ${formatCountdown(undoRemaining)}`;
            } else {
                finishDeactivationUndoWindow();
            }
            return;
        }
        submit.hidden = false;
        submit.classList.remove('is-undo');
        if (availableRemaining > 0) {
            if (availability) availability.textContent = `Available in ${formatCountdown(availableRemaining)}`;
            submit.disabled = true;
            submit.textContent = `Available in ${formatCountdown(availableRemaining)}`;
        } else {
            if (availability) availability.textContent = 'Available';
            submit.disabled = false;
            submit.textContent = 'Request account deactivation';
        }
    }

    function scheduleDeactivationTicker() {
        stopDeactivationTicker();
        deactivationUndoTimer = setInterval(() => {
            const now = Date.now();
            const status = String(deactivationRequest?.status || '').toUpperCase();
            const availableRemaining = deactivationAvailableAt - now;
            if (status === 'PENDING' && deactivationUndoUntil <= now) {
                finishDeactivationUndoWindow();
                setRequestStatus('Waiting for an administrator to review your request.');
            } else if (status !== 'PENDING' && availableRemaining > 0) {
                setRequestStatus(`You can send another request in ${formatCountdown(availableRemaining)}.`);
            } else if (status !== 'PENDING' && deactivationAvailableAt > 0) {
                deactivationAvailableAt = 0;
                setRequestStatus('No request has been sent.');
            }
            updateDeactivationAction();
            const undoActive = status === 'PENDING' && deactivationUndoUntil > now;
            const cooldownActive = status !== 'PENDING' && deactivationAvailableAt > now;
            if (!undoActive && !cooldownActive) stopDeactivationTicker();
        }, 250);
    }

    function setDeactivationSubmitError(message = '') {
        const error = document.getElementById('deactivationSubmitError');
        if (error) error.textContent = message;
    }

    function openDeactivationSubmitModal() {
        const modal = document.getElementById('deactivationSubmitModal');
        setDeactivationSubmitError('');
        if (!modal) return;
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
        setTimeout(() => document.getElementById('deactivationReason')?.focus(), 30);
    }

    function closeDeactivationSubmitModal() {
        const modal = document.getElementById('deactivationSubmitModal');
        if (!modal) return;
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');
        setDeactivationSubmitError('');
    }

    function renderDeactivationRequest(request, accountType, availableAt, identity = {}) {
        const card = document.getElementById('deactivationRequestCard');
        if (!card) return;
        const normalizedAccountType = String(accountType || '').trim().toLowerCase();
        const normalizedRoleKey = String(identity?.role_key || '').trim().toLowerCase();
        const normalizedRoleName = String(identity?.role_name || '').trim().toLowerCase();
        const roleId = Number(identity?.role_id || 0);
        const isLearner = normalizedAccountType === 'learner'
            || normalizedRoleKey === 'learners'
            || normalizedRoleKey.includes('learner')
            || normalizedRoleKey.includes('student')
            || normalizedRoleName.includes('learner')
            || normalizedRoleName.includes('student')
            || roleId === 10;
        const isEmployee = normalizedAccountType === 'employee' && !isLearner;
        card.hidden = !isEmployee;
        card.setAttribute('aria-hidden', String(!isEmployee));
        if (!isEmployee) {
            card.classList.remove('is-open', 'is-toggling');
            const toggle = document.getElementById('deactivationRequestToggle');
            const panel = document.getElementById('deactivationRequestPanel');
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
            if (panel) panel.hidden = true;
            closeDeactivationSubmitModal();
            return;
        }

        deactivationRequest = request || null;
        deactivationAvailableAt = availableAt ? (parseSettingsDate(availableAt)?.getTime() || 0) : 0;
        const submit = document.getElementById('deactivationSubmitBtn');
        const status = String(request?.status || '').toUpperCase();
        if (!request) {
            deactivationUndoUntil = 0;
            if (deactivationAvailableAt > Date.now()) {
                setRequestStatus(`You can send another request in ${formatCountdown(deactivationAvailableAt - Date.now())}.`);
            } else {
                deactivationAvailableAt = 0;
                setRequestStatus('No request has been sent.');
            }
            updateDeactivationAction();
            scheduleDeactivationTicker();
            return;
        }

        if (status === 'PENDING') {
            setRequestStatus('Waiting for an administrator to review your request.');
            updateDeactivationAction();
            scheduleDeactivationTicker();
        } else if (status === 'APPROVED') {
            deactivationUndoUntil = 0;
            setRequestStatus('This account is inactive.', 'success');
            updateDeactivationAction();
        } else if (status === 'DECLINED') {
            deactivationUndoUntil = 0;
            setRequestStatus('No request has been sent.');
            updateDeactivationAction();
        } else {
            deactivationUndoUntil = 0;
            setRequestStatus('No request has been sent.');
            updateDeactivationAction();
        }
    }

    async function loadAccountSecurity() {
        try {
            const response = await axios.get(`${ACCOUNT_SECURITY_API}?operation=getAccountSecurity&_=${Date.now()}`);
            if (response.data?.success === false) throw new Error(response.data?.message || 'Unable to load account security');
            const data = response.data?.data || {};
            const created = document.getElementById('accountCreatedValue');
            if (created) created.textContent = formatAccountDate(data.account_created_at);
            const position = document.getElementById('accountSystemPositionValue');
            if (position) position.textContent = formatAccountSystemPosition(data);
            renderSecuritySessions(data.sessions || []);
            renderDeactivationRequest(
                data.deactivation_request || null,
                data.account_type,
                data.deactivation_available_at,
                data
            );
        } catch (error) {
            const created = document.getElementById('accountCreatedValue');
            if (created) created.textContent = 'Unavailable';
            const sessions = document.getElementById('accountSecuritySessions');
            if (sessions) sessions.innerHTML = `<p class="settings-inline-state">${escapeHtml(error?.response?.data?.message || 'Account security is temporarily unavailable.')}</p>`;
        }
    }

    async function submitDeactivationRequest() {
        const reason = document.getElementById('deactivationReason');
        const explanation = document.getElementById('deactivationOther')?.value.trim() || '';
        const selectedReason = reason?.value || '';
        if (!selectedReason) {
            setDeactivationSubmitError('Choose a reason first.');
            reason?.focus();
            return;
        }
        if (selectedReason === 'OTHER' && !explanation) {
            setDeactivationSubmitError('Briefly explain the other reason.');
            document.getElementById('deactivationOther')?.focus();
            return;
        }
        const button = document.getElementById('deactivationSubmitConfirmBtn');
        if (button) button.disabled = true;
        try {
            const response = await axios.post(`${ACCOUNT_SECURITY_API}?operation=requestDeactivation`, {
                reason_code: selectedReason,
                reason_other: explanation,
            });
            if (response.data?.success === false) throw new Error(response.data?.message || 'Unable to send request');
            deactivationUndoUntil = Date.now() + 10000;
            closeDeactivationSubmitModal();
            notify('Request sent. Undo is available for 10 seconds.', 'success');
            await loadAccountSecurity();
        } catch (error) {
            const availableAt = error?.response?.data?.data?.available_at;
            if (availableAt) {
                deactivationRequest = null;
                deactivationAvailableAt = parseSettingsDate(availableAt)?.getTime() || 0;
                closeDeactivationSubmitModal();
                setRequestStatus(`You can send another request in ${formatCountdown(deactivationAvailableAt - Date.now())}.`);
                updateDeactivationAction();
                scheduleDeactivationTicker();
            } else {
                setDeactivationSubmitError(error?.response?.data?.message || error?.message || 'The request could not be sent.');
            }
        } finally {
            if (button) button.disabled = false;
        }
    }

    async function cancelDeactivationRequest() {
        deactivationUndoUntil = 0;
        const button = document.getElementById('deactivationSubmitBtn');
        if (button) button.disabled = true;
        try {
            const response = await axios.post(`${ACCOUNT_SECURITY_API}?operation=cancelDeactivation`, {});
            if (response.data?.success === false) throw new Error(response.data?.message || 'Unable to cancel request');
            notify(response.data?.message || 'Request cancelled.', 'success');
            await loadAccountSecurity();
        } catch (error) {
            if (error?.response?.status === 409) finishDeactivationUndoWindow();
            setRequestStatus(error?.response?.data?.message || error?.message || 'The request could not be cancelled.', 'error');
        } finally {
            if (button) button.disabled = false;
        }
    }

    function handleDeactivationAction() {
        if (String(deactivationRequest?.status || '').toUpperCase() === 'PENDING') {
            if (deactivationUndoUntil > Date.now()) cancelDeactivationRequest();
            return;
        }
        if (deactivationAvailableAt > Date.now()) return;
        openDeactivationSubmitModal();
    }

    function formatMinutes(minutes) {
        const n = Number(minutes) || 30;
        if (n % 60 === 0) return `${n / 60} hour${n === 60 ? '' : 's'}`;
        return `${n} minute${n === 1 ? '' : 's'}`;
    }

    function setLoading(isLoading) {
        els.select.disabled = isLoading || !canUpdateTimeout;
    }

    function renderTimeoutOptions(options, selected) {
        const values = [...new Set((Array.isArray(options) ? options : defaultTimeoutOptions)
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0))];
        if (!values.includes(selected)) values.push(selected);
        values.sort((first, second) => first - second);
        timeoutOptions = values;
        els.select.innerHTML = values.map((value) => `<option value="${value}">${formatMinutes(value)}</option>`).join('');
        els.select.value = String(selected);
    }

    function applyTimeoutState(payload) {
        const rawMinutes = Number(payload?.setting_value);
        const actualMinutes = Number.isInteger(rawMinutes) && rawMinutes > 0 ? rawMinutes : 30;
        currentMinutes = actualMinutes;
        canUpdateTimeout = payload?.can_update !== false;
        renderTimeoutOptions(payload?.allowed_values, currentMinutes);
        els.value.textContent = formatMinutes(currentMinutes);
        if (els.summary) {
            const scopeLabel = String(payload?.setting_scope_label || (payload?.setting_scope === 'account' ? 'This account' : 'School default'));
            els.summary.textContent = `Auto end Session · ${scopeLabel}`;
        }
        if (els.help) {
            const scope = String(payload?.setting_scope || 'school');
            els.help.textContent = canUpdateTimeout
                ? (scope === 'account'
                    ? 'This duration is saved for this account.'
                    : 'This duration is the school default for accounts without a personal setting.')
                : 'This account follows the school default. Only an administrator can change it.';
        }
        setLoading(false);
    }

    async function loadTimeout() {
        try {
            const res = await axios.get(`${SETTINGS_API_BASE}/school_settings/school_settings.php`, {
                params: { operation: 'getSetting', setting_key: 'session_timeout_minutes', _: Date.now() }
            });
            applyTimeoutState(res.data || {});
        } catch (error) {
            canUpdateTimeout = false;
            els.value.textContent = 'Unavailable';
            els.select.disabled = true;
            if (els.summary) els.summary.textContent = 'Auto end Session';
            if (els.help) els.help.textContent = 'The account session setting could not be loaded.';
        }
    }

    async function saveTimeout() {
        const minutes = Math.trunc(Number(els.select.value || 0));
        if (!Number.isFinite(minutes) || !timeoutOptions.includes(minutes)) {
            notify('Choose one of the available session durations.', 'warning');
            return;
        }

        setLoading(true);
        try {
            const res = await axios.post(`${SETTINGS_API_BASE}/school_settings/school_settings.php?operation=updateSetting`, {
                setting_key: 'session_timeout_minutes',
                setting_value: String(minutes),
                description: 'Idle session timeout duration in minutes'
            });
            if (res.data?.success === false) throw new Error(res.data?.message || 'Unable to save timeout');
            applyTimeoutState({
                ...res.data,
                setting_value: res.data?.setting_value ?? minutes,
                can_update: true,
            });
            notify('Auto end Session setting updated.', 'success');
        } catch (error) {
            els.select.value = String(currentMinutes);
            notify(error?.response?.data?.message || error?.message || 'Unable to save timeout.', 'error');
        } finally {
            setLoading(false);
        }
    }

    els.select.addEventListener('change', saveTimeout);
    document.getElementById('accountSecuritySessions')?.addEventListener('click', (event) => {
        const confirmationTrigger = event.target.closest('[data-session-confirm]');
        if (confirmationTrigger) {
            event.preventDefault();
            event.stopPropagation();
            if (typeof window.openPendingDeviceConfirmation === 'function') {
                void window.openPendingDeviceConfirmation({
                    sessionDeviceId: Number(confirmationTrigger.dataset.sessionDeviceId || 0),
                    sessionKey: confirmationTrigger.dataset.sessionKey || '',
                });
            }
            return;
        }
        const trigger = event.target.closest('[data-session-manage]');
        if (!trigger) return;
        event.preventDefault();
        event.stopPropagation();
        openSessionActionModal(trigger.dataset.sessionKey || '', trigger.dataset.sessionDevice || 'Selected login session');
    });
    document.getElementById('sessionTerminateBtn')?.addEventListener('click', () => applySessionAction('terminate'));
    document.getElementById('sessionBlockBtn')?.addEventListener('click', () => applySessionAction('block'));
    document.getElementById('sessionActionCloseBtn')?.addEventListener('click', closeSessionActionModal);
    document.getElementById('sessionActionCancelBtn')?.addEventListener('click', closeSessionActionModal);
    document.getElementById('sessionActionModal')?.addEventListener('click', (event) => {
        if (event.target.id === 'sessionActionModal') closeSessionActionModal();
    });
    document.getElementById('changePasswordSettingsBtn')?.addEventListener('click', () => {
        window.location.href = 'profile-security.html';
    });
    document.getElementById('deactivationSubmitBtn')?.addEventListener('click', handleDeactivationAction);
    document.getElementById('deactivationSubmitConfirmBtn')?.addEventListener('click', submitDeactivationRequest);
    document.getElementById('deactivationSubmitCloseBtn')?.addEventListener('click', closeDeactivationSubmitModal);
    document.getElementById('deactivationSubmitCancelBtn')?.addEventListener('click', closeDeactivationSubmitModal);
    document.getElementById('deactivationSubmitModal')?.addEventListener('click', (event) => {
        if (event.target.id === 'deactivationSubmitModal') closeDeactivationSubmitModal();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && document.getElementById('deactivationSubmitModal')?.classList.contains('show')) closeDeactivationSubmitModal();
        if (event.key === 'Escape' && document.getElementById('sessionActionModal')?.classList.contains('show')) closeSessionActionModal();
    });

    loadTimeout();
    loadAccountSecurity();

    const hash = String(window.location.hash || '').toLowerCase();
    if (hash.includes('account-security')) {
        setTimeout(() => {
            document.getElementById('settings-option-account')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 180);
    }
})();
