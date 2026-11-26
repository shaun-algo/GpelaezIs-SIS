// Plain-language activity log controller.
// The API still returns structured audit data; this layer turns it into a
// readable feed for people who need to understand what happened.

const AL_API = `${window.API_BASE}/audit_logs/audit_logs.php`;
const AL_PER_PAGE = 20;
const alState = {
    page: 1,
    totalPages: 1,
    totalRecords: 0,
    records: [],
    category: '',
    openId: null,
    loading: false,
};

document.addEventListener('DOMContentLoaded', () => {
    initializeAuditDatePickers();
    wireAuditEvents();
    loadAuditFilterOptions();
    loadAuditLogs();
});

function initializeAuditDatePickers() {
    const fromInput = document.getElementById('filterDateFrom');
    const toInput = document.getElementById('filterDateTo');
    const datePicker = window.AcademicCalendarDatePicker;
    if (!fromInput || !toInput || !datePicker?.attach) return;

    const fromPicker = datePicker.attach(fromInput, {
        label: 'From date',
        placeholder: 'Choose from date',
        max: () => toInput.value || ''
    });
    const toPicker = datePicker.attach(toInput, {
        label: 'To date',
        placeholder: 'Choose to date',
        min: () => fromInput.value || ''
    });

    [fromPicker, toPicker].forEach((picker) => {
        const input = picker?.input;
        const trigger = picker?.trigger;
        if (!input || !trigger) return;
        trigger.id = `${input.id}Display`;
        trigger.setAttribute('aria-describedby', 'auditDateRangeError');
        input.closest('.filter-group')?.querySelector(`label[for="${input.id}"]`)?.setAttribute('for', trigger.id);
    });

    const refresh = () => {
        fromPicker?.refresh();
        toPicker?.refresh();
        validateAuditDateRange();
    };
    fromInput.addEventListener('change', refresh);
    toInput.addEventListener('change', refresh);
}

function setAuditDateRangeError(message = '') {
    const text = String(message || '').trim();
    const error = document.getElementById('auditDateRangeError');
    if (error) {
        error.textContent = text;
        error.hidden = !text;
    }
    ['filterDateFrom', 'filterDateTo'].forEach((id) => {
        const input = document.getElementById(id);
        const group = input?.closest('.audit-filter-date-group');
        const trigger = input?._academicCalendarDatePicker?.trigger;
        group?.classList.toggle('is-error', Boolean(text));
        if (input) {
            if (text) input.setAttribute('aria-invalid', 'true');
            else input.removeAttribute('aria-invalid');
        }
        trigger?.classList.toggle('error', Boolean(text));
    });
}

function validateAuditDateRange() {
    const from = String(document.getElementById('filterDateFrom')?.value || '');
    const to = String(document.getElementById('filterDateTo')?.value || '');
    if (from && to && from > to) {
        setAuditDateRangeError('From date must be on or before the To date.');
        return false;
    }
    setAuditDateRangeError('');
    return true;
}

function wireAuditEvents() {
    const searchInput = document.getElementById('searchInput');
    let searchTimer;
    searchInput?.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => loadAuditLogs(), 320);
    });

    ['filterTable', 'filterAction', 'filterStatus', 'filterUser', 'filterDateFrom', 'filterDateTo']
        .forEach((id) => document.getElementById(id)?.addEventListener('change', () => loadAuditLogs()));

    document.getElementById('btnClearFilters')?.addEventListener('click', clearAuditFilters);
    document.getElementById('btnRefresh')?.addEventListener('click', () => loadAuditLogs());
    document.getElementById('auditLoadMore')?.addEventListener('click', () => loadAuditLogs({ append: true }));

    document.querySelectorAll('[data-audit-category]').forEach((chip) => {
        chip.addEventListener('click', () => {
            alState.category = chip.dataset.auditCategory || '';
            document.querySelectorAll('[data-audit-category]').forEach((item) => {
                const active = (item.dataset.auditCategory || '') === alState.category;
                item.classList.toggle('is-active', active);
                item.setAttribute('aria-pressed', String(active));
            });
            loadAuditLogs();
        });
    });

    document.getElementById('auditFeed')?.addEventListener('click', (event) => {
        const row = event.target.closest('.audit-entry-main');
        const entry = row?.closest('.audit-entry');
        const toggle = entry?.querySelector('[data-audit-toggle]');
        const interactive = event.target.closest('a, button, input, select, textarea');
        if (!row || !entry || !toggle || (interactive && interactive !== toggle)) return;
        const id = Number(toggle.dataset.auditToggle || 0);
        alState.openId = alState.openId === id ? null : id;
        renderAuditFeed();
    });
}

async function loadAuditFilterOptions() {
    try {
        const response = await axios.get(`${AL_API}?operation=getAuditLogFilters&_=${Date.now()}`);
        const data = response.data || {};
        if (!data.success) return;

        const tableSelect = document.getElementById('filterTable');
        (data.tables || []).forEach((table) => addSelectOption(tableSelect, table, humanizeEntity(table)));

        const actionSelect = document.getElementById('filterAction');
        const actionLabels = {
            INSERT: 'Create (legacy)', CREATE: 'Create', UPDATE: 'Change', DELETE: 'Delete', HIDE: 'Hide',
            LOGIN: 'Sign-in', LOGOUT: 'Sign-out', REPORT: 'Report', REPORT_REVIEW: 'Review report',
            EXPORT: 'Export', PASSWORD_CHANGE: 'Password change', PASSWORD_RESET: 'Password reset',
            OTP_VERIFY: 'Code verification', OTP_SEND: 'Code sent', RECOVERY_REQUEST: 'Recovery request',
            ACCESS: 'Access decision', SESSION: 'Session decision', ACCOUNT_REACTIVATED: 'Account reactivation',
            ACCOUNT_REACTIVATION: 'Account reactivation attempt',
        };
        (data.actions || []).forEach((action) => {
            if ([...actionSelect.options].some((option) => option.value === action)) return;
            addSelectOption(actionSelect, action, actionLabels[action] || humanizeEntity(action));
        });

        const statusSelect = document.getElementById('filterStatus');
        (data.statuses || []).forEach((status) => {
            if ([...statusSelect.options].some((option) => option.value === status)) return;
            addSelectOption(statusSelect, status, statusLabel(status));
        });

        const userSelect = document.getElementById('filterUser');
        (data.users || []).forEach((user) => {
            addSelectOption(userSelect, user.user_id, user.actor_name || user.username || `User #${user.user_id}`);
        });
    } catch (error) {
        console.warn('Activity filters are temporarily unavailable.', error);
    }
}

function addSelectOption(select, value, label) {
    if (!select) return;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
}

function auditFilterParams() {
    const params = {
        operation: 'getAuditLogs',
        page: alState.page,
        perPage: AL_PER_PAGE,
        category: alState.category,
        search: document.getElementById('searchInput')?.value.trim() || '',
        table_name: document.getElementById('filterTable')?.value || '',
        action: document.getElementById('filterAction')?.value || '',
        status: document.getElementById('filterStatus')?.value || '',
        user_id: document.getElementById('filterUser')?.value || '',
        date_from: document.getElementById('filterDateFrom')?.value || '',
        date_to: document.getElementById('filterDateTo')?.value || '',
        _: Date.now(),
    };

    Object.keys(params).forEach((key) => {
        if (params[key] === '') delete params[key];
    });
    return params;
}

async function loadAuditLogs({ append = false } = {}) {
    if (alState.loading) return;
    if (append && alState.page >= alState.totalPages) return;
    if (!validateAuditDateRange()) return;

    if (append) {
        alState.page += 1;
    } else {
        alState.page = 1;
        alState.records = [];
        alState.openId = null;
        renderAuditFeed('loading');
    }

    alState.loading = true;
    setAuditBusy(true);

    try {
        const response = await axios.get(AL_API, { params: auditFilterParams() });
        const data = response.data || {};
        if (!data.success) throw new Error(data.message || 'Unable to load activity.');

        const page = Array.isArray(data.data) ? data.data : [];
        alState.records = append ? [...alState.records, ...page] : page;
        alState.totalRecords = Number(data.pagination?.totalRecords || 0);
        alState.totalPages = Math.max(1, Number(data.pagination?.totalPages || 1));
        renderAuditFeed();
    } catch (error) {
        console.error('Error loading audit logs:', error);
        if (append) alState.page = Math.max(1, alState.page - 1);
        renderAuditFeed('error');
    } finally {
        alState.loading = false;
        setAuditBusy(false);
    }
}

function setAuditBusy(isBusy) {
    const feed = document.getElementById('auditFeed');
    const refresh = document.getElementById('btnRefresh');
    const button = document.getElementById('auditLoadMore');
    if (feed) feed.setAttribute('aria-busy', String(isBusy));
    if (refresh) {
        refresh.disabled = isBusy;
        refresh.setAttribute('aria-busy', String(isBusy));
        refresh.innerHTML = isBusy
            ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Refreshing'
            : '<i class="fas fa-rotate-right" aria-hidden="true"></i> Refresh';
    }
    if (button) {
        button.disabled = isBusy;
        button.innerHTML = isBusy
            ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading'
            : 'Show older activity';
    }
}

function clearAuditFilters() {
    ['filterTable', 'filterAction', 'filterStatus', 'filterUser', 'filterDateFrom', 'filterDateTo']
        .forEach((id) => {
            const element = document.getElementById(id);
            if (!element) return;
            element.value = '';
            element._academicCalendarDatePicker?.refresh();
        });
    setAuditDateRangeError('');
    const search = document.getElementById('searchInput');
    if (search) search.value = '';
    alState.category = '';
    document.querySelectorAll('[data-audit-category]').forEach((item) => {
        const active = !item.dataset.auditCategory;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
    });
    loadAuditLogs();
}

function renderAuditFeed(state = '') {
    const feed = document.getElementById('auditFeed');
    const loadMore = document.getElementById('auditLoadMore');
    const count = document.getElementById('auditFeedCount');
    if (!feed) return;

    if (state === 'loading') {
        feed.innerHTML = '<div class="audit-feed-state"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i><p>Loading activity…</p></div>';
        if (count) count.textContent = 'Loading recent activity';
        if (loadMore) loadMore.hidden = true;
        return;
    }
    if (state === 'error') {
        feed.innerHTML = '<div class="audit-feed-state is-error"><i class="fas fa-circle-exclamation" aria-hidden="true"></i><strong>Could not load audit logs</strong><p>Check the connection and try again.</p><button type="button" class="btn btn-outline" data-audit-retry>Try again</button></div>';
        feed.querySelector('[data-audit-retry]')?.addEventListener('click', () => loadAuditLogs());
        if (count) count.textContent = 'Activity is unavailable';
        if (loadMore) loadMore.hidden = true;
        return;
    }

    if (!alState.records.length) {
        feed.innerHTML = '<div class="audit-feed-state"><i class="fas fa-clipboard-check" aria-hidden="true"></i><strong>No activity found</strong><p>Try a different search or filter.</p></div>';
        if (count) count.textContent = 'No activity found';
        if (loadMore) loadMore.hidden = true;
        return;
    }

    const groups = groupAuditRecords(alState.records);
    feed.innerHTML = [...groups.entries()].map(([label, records]) => `
        <section class="audit-day-group" aria-labelledby="audit-day-${slugify(label)}">
            <h2 class="audit-day-heading" id="audit-day-${slugify(label)}">${escapeHtml(label)}</h2>
            <div class="audit-day-list">${records.map(renderAuditEntry).join('')}</div>
        </section>
    `).join('');

    if (count) count.textContent = `Showing ${alState.records.length} of ${alState.totalRecords} activities`;
    if (loadMore) loadMore.hidden = alState.page >= alState.totalPages;
}

function groupAuditRecords(records) {
    const groups = new Map();
    records.forEach((record) => {
        const date = parseAuditDate(record.action_time);
        const label = auditDayLabel(date);
        if (!groups.has(label)) groups.set(label, { label, records: [], sortTime: 0 });
        const group = groups.get(label);
        group.records.push(record);
        if (date) group.sortTime = Math.max(group.sortTime, date.getTime());
    });
    return new Map([...groups.values()]
        .sort((first, second) => second.sortTime - first.sortTime)
        .map((group) => [
            group.label,
            group.records.sort((first, second) => (parseAuditDate(second.action_time)?.getTime() || 0) - (parseAuditDate(first.action_time)?.getTime() || 0))
        ]));
}

function renderAuditEntry(record) {
    const id = Number(record.audit_id || 0);
    const activity = auditActivity(record);
    const status = statusLabel(record.status);
    const severity = auditSeverity(record);
    const isOpen = alState.openId === id;
    const datetime = parseAuditDate(record.action_time)?.toISOString() || '';
    const detailHtml = isOpen ? renderAuditDetails(record) : '';

    return `<article class="audit-entry is-${severity} ${isOpen ? 'is-open' : ''}" data-audit-id="${id}">
        <div class="audit-entry-main" aria-label="${escapeHtml(`${activity.actor} ${activity.rest}. ${isOpen ? 'Hide details' : 'Show details'}`)}">
            <div class="audit-entry-copy">
                <p class="audit-entry-sentence"><strong>${escapeHtml(activity.actor)}</strong> ${escapeHtml(activity.rest)}</p>
                <div class="audit-entry-meta">
                    <time datetime="${escapeHtml(datetime)}">${escapeHtml(formatRelativeAuditTime(record.action_time))}</time>
                    <span class="audit-status is-${statusSlug(record.status)}">${escapeHtml(status)}</span>
                </div>
            </div>
            <button type="button" class="audit-entry-toggle" data-audit-toggle="${id}" aria-label="${isOpen ? 'Hide activity details' : 'Show activity details'}" aria-expanded="${String(isOpen)}">
                <i class="fas fa-chevron-${isOpen ? 'up' : 'down'}" aria-hidden="true"></i>
            </button>
        </div>
        ${detailHtml}
    </article>`;
}

function renderAuditDetails(record) {
    const changes = renderAuditChanges(record);
    const why = auditWhy(record);
    const whenWhere = auditWhenWhere(record);

    return `<div class="audit-entry-details">
        <div class="audit-detail-section"><h3>Why this matters</h3><p>${escapeHtml(why)}</p></div>
        <div class="audit-detail-section"><h3>What happened</h3><div class="audit-change-list">${changes}</div></div>
        <div class="audit-detail-section"><h3>When &amp; where</h3><p>${escapeHtml(whenWhere)}</p></div>
    </div>`;
}

function auditActivity(record) {
    const action = String(record.action || '').toUpperCase();
    const status = String(record.status || '').toUpperCase();
    const actor = humanizeActorName(record.actor_name, record.username, record.user_id);
    const oldValues = parseAuditValues(record.old_values);
    const newValues = parseAuditValues(record.new_values);
    const metadata = parseAuditValues(record.metadata);
    const title = auditValue(newValues, 'title') || auditValue(oldValues, 'title') || auditValue(metadata, 'post_title');
    const entity = humanizeEntity(record.table_name);
    const article = /^[aeiou]/i.test(entity) ? 'an' : 'a';
    const quotedTitle = title ? ` “${String(title).trim()}”` : '';

    if (action === 'LOGIN') {
        if (status === 'SUCCESS') return { actor, rest: 'signed in', icon: 'fa-arrow-right-to-bracket' };
        const accountMatch = ['true', '1', 'yes'].includes(String(metadata.account_match ?? '').toLowerCase());
        const accountName = String(record.matched_account_name || '').trim();
        return accountMatch && accountName
            ? { actor: 'Someone', rest: 'tried to sign in using ' + accountName + "'s account but it did not go through", icon: 'fa-arrow-right-to-bracket' }
            : { actor: 'Someone', rest: 'tried to sign in but it did not go through', icon: 'fa-arrow-right-to-bracket' };
    }
    if (action === 'LOGOUT') return { actor, rest: 'signed out', icon: 'fa-arrow-right-from-bracket' };
    if (action === 'CREATE' || action === 'INSERT') return { actor, rest: `created ${article} ${entity}${quotedTitle}`, icon: 'fa-plus' };
    if (action === 'UPDATE') return { actor, rest: `updated ${article} ${entity}${quotedTitle}`, icon: 'fa-pen' };
    if (action === 'DELETE') {
        const removedAfterReport = String(record.reason_code || '').toUpperCase() === 'POST_REMOVED_AFTER_REPORT';
        return { actor, rest: removedAfterReport ? `removed ${article} ${entity}${quotedTitle} after a community report` : `deleted ${article} ${entity}${quotedTitle}`, icon: 'fa-trash-can' };
    }
    if (action === 'REPORT') return { actor, rest: `reported ${article} ${entity}${quotedTitle}`, icon: 'fa-flag' };
    if (action === 'HIDE') return { actor, rest: `hid ${article} ${entity}${quotedTitle}`, icon: 'fa-eye-slash' };
    if (action === 'REPORT_REVIEW') return { actor, rest: `reviewed ${article} ${entity} report${quotedTitle}`, icon: 'fa-clipboard-check' };
    if (action === 'EXPORT') return { actor, rest: `exported ${article} ${entity}`, icon: 'fa-file-export' };
    if (action === 'ACCESS' || action === 'SESSION') {
        const accessTarget = String(record.table_name || '').toLowerCase() === 'authorization' ? 'the system' : entity;
        return status === 'DENIED' || status === 'FAILURE'
            ? { actor: 'Someone', rest: `was denied access to ${accessTarget}`, icon: 'fa-user-shield' }
            : { actor, rest: `completed an access check for ${accessTarget}`, icon: 'fa-user-shield' };
    }
    if (action === 'PASSWORD_CHANGE') return { actor, rest: 'changed a password', icon: 'fa-key' };
    if (action === 'PASSWORD_RESET') return { actor, rest: 'completed a password reset', icon: 'fa-key' };
    if (action === 'DEACTIVATION_REQUEST') return { actor, rest: status === 'SUCCESS' ? 'requested account deactivation' : 'could not send an account deactivation request', icon: 'fa-user-slash' };
    if (action === 'DEACTIVATION_REQUEST_REVIEW') return { actor, rest: 'reviewed an account deactivation request', icon: 'fa-user-check' };
    if (action === 'ACCOUNT_DEACTIVATED') return { actor, rest: 'deactivated an account after an approved request', icon: 'fa-user-slash' };
    if (action === 'ACCOUNT_REACTIVATED') return { actor, rest: status === 'SUCCESS' ? 'reactivated a user account' : 'could not reactivate a user account', icon: 'fa-user-check' };
    if (action === 'ACCOUNT_REACTIVATION') return { actor: status === 'FAILURE' || status === 'DENIED' ? 'Someone' : actor, rest: 'could not reactivate a user account', icon: 'fa-user-check' };
    if (['OTP_SEND', 'OTP_VERIFY', 'RECOVERY_REQUEST'].includes(action)) return { actor: action === 'OTP_VERIFY' && status !== 'SUCCESS' ? 'Someone' : actor, rest: actionLabel(action).toLowerCase(), icon: 'fa-shield-halved' };
    return { actor, rest: `recorded activity for ${article} ${entity}`, icon: 'fa-clock-rotate-left' };
}

function renderAuditChanges(record) {
    const oldValues = parseAuditValues(record.old_values);
    const newValues = parseAuditValues(record.new_values);
    const action = String(record.action || '').toUpperCase();
    const fields = auditChangedFields(oldValues, newValues);
    if (!fields.length) {
        if (action === 'DELETE') return '<p class="audit-detail-muted">The record was removed from the system.</p>';
        if (action === 'REPORT') return '<p class="audit-detail-muted">A post was sent for review.</p>';
        if (action === 'HIDE') return '<p class="audit-detail-muted">This post was hidden from this person’s feed.</p>';
        if (action === 'REPORT_REVIEW') return '<p class="audit-detail-muted">The report was marked as reviewed with no issue found.</p>';
        if (action === 'ACCOUNT_REACTIVATED') return '<p class="audit-detail-muted">The user account was reactivated and can sign in again.</p>';
        if (action === 'ACCOUNT_REACTIVATION') return '<p class="audit-detail-muted">The account reactivation attempt did not go through.</p>';
        return '<p class="audit-detail-muted">No field-level change was recorded.</p>';
    }
    return fields.map(({ key, oldValue, newValue }) => {
        const label = friendlyAuditField(key);
        const before = formatAuditValue(oldValue, key);
        const after = formatAuditValue(newValue, key);
        if (oldValue === undefined) return `<div class="audit-change-row"><strong>${escapeHtml(label)}</strong><span>Created: ${escapeHtml(after)}</span></div>`;
        if (newValue === undefined) return `<div class="audit-change-row"><strong>${escapeHtml(label)}</strong><span>Removed: ${escapeHtml(before)}</span></div>`;
        return `<div class="audit-change-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(before)} <b aria-hidden="true">→</b> ${escapeHtml(after)}</span></div>`;
    }).join('');
}

function auditChangedFields(oldValues, newValues) {
    const oldMap = oldValues && typeof oldValues === 'object' ? oldValues : {};
    const newMap = newValues && typeof newValues === 'object' ? newValues : {};
    const keys = [...new Set([...Object.keys(oldMap), ...Object.keys(newMap)])]
        .filter((key) => !['created_at', 'updated_at', 'deleted_at', 'is_deleted', 'announcement_id', 'user_id'].includes(key));
    const hasRoleName = keys.includes('role_name');
    return keys.filter((key) => !(hasRoleName && key === 'role_id'))
        .filter((key) => JSON.stringify(oldMap[key]) !== JSON.stringify(newMap[key]))
        .slice(0, 12)
        .map((key) => ({ key, oldValue: oldMap[key], newValue: newMap[key] }));
}

function auditWhy(record) {
    const reason = String(record.reason_code || '').toUpperCase();
    const action = String(record.action || '').toUpperCase();
    const status = String(record.status || '').toUpperCase();
    if (action === 'LOGIN' && status !== 'SUCCESS') return 'A sign-in attempt did not go through. Repeated attempts may need a quick account check.';
    if (reason === 'POST_REMOVED_AFTER_REPORT') return 'A post was removed from the school feed after community feedback.';
    if (action === 'REPORT') return 'A community member flagged a post so an administrator can review it.';
    if (action === 'DEACTIVATION_REQUEST') return 'An employee asked an administrator to close access to their account. The request can be reviewed without deleting records.';
    if (action === 'DEACTIVATION_REQUEST_REVIEW' || action === 'ACCOUNT_DEACTIVATED') return 'An account deactivation request was reviewed and the account status was recorded.';
    if (action === 'ACCOUNT_REACTIVATED') return 'A previously deactivated user account was reactivated and can sign in again.';
    if (action === 'ACCOUNT_REACTIVATION') return 'An account reactivation attempt did not go through and may need review.';
    if (action === 'DELETE') return 'A record was removed. Check the details if this was not expected.';
    if (action === 'ACCESS' || action === 'SESSION' || reason.includes('PERMISSION')) return 'An access decision was recorded. This can explain why someone could or could not complete an action.';
    if (action === 'PASSWORD_RESET' || action === 'PASSWORD_CHANGE') return 'Account credentials changed. Confirm the person expected this activity.';
    if (status === 'DENIED' || status === 'FAILURE') return 'The activity did not go through and may need a quick review.';
    return 'This is part of the system’s record of important activity.';
}

function auditWhenWhere(record) {
    return `${formatRelativeAuditTime(record.action_time)} using ${browserAndDevice(record.user_agent)}`;
}

function browserAndDevice(userAgent) {
    const value = String(userAgent || '');
    let browser = 'a browser';
    if (/Edg\//i.test(value)) browser = 'Edge';
    else if (/Chrome\//i.test(value)) browser = 'Chrome';
    else if (/Firefox\//i.test(value)) browser = 'Firefox';
    else if (/Safari\//i.test(value)) browser = 'Safari';

    let device = 'an unknown device';
    if (/iPhone/i.test(value)) device = 'iPhone';
    else if (/iPad/i.test(value)) device = 'iPad';
    else if (/Android/i.test(value)) device = 'Android';
    else if (/Windows/i.test(value)) device = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(value)) device = 'Mac';
    else if (/Linux/i.test(value)) device = 'Linux';
    return `${browser} on ${device}`;
}

function parseAuditValues(value) {
    if (!value) return {};
    if (typeof value === 'object') return value || {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

function auditValue(values, ...keys) {
    for (const key of keys) {
        if (values?.[key] !== undefined && values[key] !== null && String(values[key]).trim() !== '') return values[key];
    }
    return '';
}

function friendlyAuditField(key) {
    const labels = {
        role_id: 'Role', role_name: 'Role', target_role_id: 'Audience', title: 'Title', body: 'Post content',
        username: 'Username', is_active: 'Account status', is_pinned: 'Pinned status', posted_by: 'Post owner',
        reason_code: 'Reason', report_reason: 'Report reason', feedback_type: 'Feedback type',
    };
    return labels[key] || humanizeEntity(key);
}

function formatAuditValue(value, key = '') {
    if (value === undefined) return '—';
    if (value === null || value === '') return 'None';
    if (typeof value === 'boolean' || value === 0 || value === 1) {
        if (['is_active', 'is_pinned', 'removed_from_feed'].includes(key)) return Number(value) ? 'Yes' : 'No';
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function humanizeActorName(actorName, username, userId) {
    const name = String(actorName || '').trim();
    if (name && !/^User #?0?$/i.test(name)) return name;
    const account = String(username || '').trim();
    if (account) return account;
    return Number(userId) > 0 ? `User #${userId}` : 'Someone';
}

function humanizeEntity(value) {
    const labels = {
        announcements: 'post', users: 'user account', roles: 'role', employees: 'employee profile',
        learners: 'learner', class_schedules: 'class schedule', class_offerings: 'class offering',
        grades: 'grade record', final_grades: 'final grade', attendance: 'attendance record',
        report_cards: 'report card', risk_assessments: 'risk assessment', enrollments: 'enrollment',
        sections: 'section', subjects: 'subject', school_years: 'school year', authentication: 'account',
        application: 'record',
    };
    const normalized = String(value || '').trim().toLowerCase();
    if (labels[normalized]) return labels[normalized];
    return normalized.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).trim() || 'record';
}

function actionLabel(action) {
    const labels = {
        INSERT: 'Create', CREATE: 'Create', UPDATE: 'Change', DELETE: 'Delete', LOGIN: 'Sign-in', LOGOUT: 'Sign-out',
        REPORT: 'Report', HIDE: 'Hide', REPORT_REVIEW: 'Report review', EXPORT: 'Export', PASSWORD_CHANGE: 'Password change',
        PASSWORD_RESET: 'Password reset', OTP_VERIFY: 'Code verification', OTP_SEND: 'Code sent',
        RECOVERY_REQUEST: 'Recovery request', ACCESS: 'Access decision', SESSION: 'Session decision',
    };
    return labels[String(action || '').toUpperCase()] || humanizeEntity(action || 'Activity');
}

function statusLabel(status) {
    const normalized = String(status || '').toUpperCase();
    return normalized === 'SUCCESS' ? 'Completed' : (['FAILURE', 'DENIED'].includes(normalized) ? 'Did not go through' : 'Recorded');
}

function statusSlug(status) {
    const normalized = String(status || '').toUpperCase();
    return normalized === 'SUCCESS' ? 'success' : (['FAILURE', 'DENIED'].includes(normalized) ? 'failure' : 'other');
}

function auditSeverity(record) {
    const status = String(record.status || '').toUpperCase();
    if (status === 'FAILURE' || status === 'DENIED') return 'red';
    if (['DELETE', 'REPORT', 'HIDE', 'REPORT_REVIEW', 'ACCESS', 'SESSION', 'PASSWORD_RESET', 'DEACTIVATION_REQUEST', 'DEACTIVATION_REQUEST_REVIEW', 'ACCOUNT_DEACTIVATED', 'ACCOUNT_REACTIVATED', 'ACCOUNT_REACTIVATION'].includes(String(record.action || '').toUpperCase())) return 'amber';
    return 'normal';
}

function parseAuditDate(value) {
    if (!value) return null;
    const date = new Date(String(value).replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatRelativeAuditTime(value) {
    const date = parseAuditDate(value);
    if (!date) return 'Recently';
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

function auditDayLabel(date) {
    if (!date) return 'Earlier activity';
    const today = new Date();
    const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const days = Math.max(0, Math.round((startToday - startDate) / 86400000));
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days <= 7) return '1 week ago';
    if (days <= 30) return '1 month ago';

    const years = today.getFullYear() - date.getFullYear();
    if (years >= 1) return `${years} year${years === 1 ? '' : 's'} ago`;
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function slugify(value) {
    return String(value || 'activity').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'activity';
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character]));
}
