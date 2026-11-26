const LEARNER_PROFILE_API_BASE = window.API_BASE || `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`;

let learnerProfileRecord = null;
let learnerProfileEditMode = false;

function isLearnerRole() {
    const rname = String(window.CURRENT_ROLE_NAME || '').toLowerCase();
    const rid = Number(window.CURRENT_ROLE_ID || 0);
    return rname.includes('learner') || rname.includes('student') || rid === 10;
}

function isAdminViewer() {
    const roleName = String(window.CURRENT_ROLE_NAME || '').trim().toLowerCase();
    return Number(window.CURRENT_ROLE_ID || 0) === 8 || roleName.includes('admin');
}

function getRequestedLearnerUserId() {
    const rawUserId = new URLSearchParams(window.location.search).get('user_id');
    const userId = Number(rawUserId);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function isLearnerProfilePublicView() {
    return Boolean(getRequestedLearnerUserId());
}

function canEditLearnerProfile() {
    return isAdminViewer() && !isLearnerProfilePublicView();
}

function waitForRole(cb, attempts = 0) {
    const rid = Number(window.CURRENT_ROLE_ID || 0);
    const rname = String(window.CURRENT_ROLE_NAME || '');
    if (rid > 0 || rname) {
        cb();
    } else if (attempts < 40) {
        setTimeout(() => waitForRole(cb, attempts + 1), 150);
    } else {
        cb();
    }
}

function learnerProfileInitials(record) {
    const first = String(record?.first_name || '').trim();
    const last = String(record?.last_name || '').trim();
    if (first && last) return `${first[0]}${last[0]}`.toUpperCase();
    const name = String(record?.full_name_raw || first || last || 'Learner').trim();
    return name.slice(0, 2).toUpperCase() || 'LP';
}

function learnerProfileGender(record) {
    const gender = String(record?.gender || record?.sex || '').trim().toLowerCase();
    if (gender === 'm' || gender === 'male') return 'male';
    if (gender === 'f' || gender === 'female') return 'female';
    return gender ? 'other' : 'neutral';
}

function learnerProfileFullName(record) {
    return `${record?.last_name || ''}, ${record?.first_name || ''} ${record?.middle_name || ''}`
        .replace(/\s+/g, ' ')
        .replace(/,\s*$/, '')
        .trim();
}

function setLearnerProfileIdentity(record, publicView) {
    const fullName = learnerProfileFullName(record) || 'Learner profile';
    const pageTitle = document.getElementById('pageTitle');
    const role = document.getElementById('learnerProfileRole');
    const avatar = document.getElementById('learnerProfileAvatar');

    if (pageTitle) pageTitle.textContent = fullName;
    if (role) role.textContent = 'Learner';
    const presenceAccount = {
        is_online: record?.is_online,
        last_seen_at: record?.last_seen_at,
        last_login: record?.last_login,
        last_seen_seconds_ago: record?.last_seen_seconds_ago,
        last_login_seconds_ago: record?.last_login_seconds_ago
    };
    const presenceLabel = typeof getAccountPresenceLabel === 'function'
        ? getAccountPresenceLabel(presenceAccount)
        : '';
    const presenceNode = document.getElementById('learnerProfilePresence');
    if (presenceNode) {
        presenceNode.textContent = presenceLabel;
        presenceNode.classList.toggle(
            'is-online',
            typeof getAccountPresence === 'function' && getAccountPresence(presenceAccount).isOnline
        );
    }

    if (avatar) {
        avatar.textContent = learnerProfileInitials(record);
        avatar.classList.remove('gender-male', 'gender-female', 'gender-other', 'gender-neutral');
        avatar.classList.add(`gender-${learnerProfileGender(record)}`);
        avatar.setAttribute('aria-label', `${fullName} profile`);
        if (typeof applyAccountPresence === 'function') {
            applyAccountPresence(avatar, presenceAccount);
        }
    }

    document.title = publicView ? `${fullName} · Learner profile` : `${fullName} · My profile`;
}

function applyLearnerProfileAccess() {
    const options = document.getElementById('learnerProfileOptions');
    const admin = canEditLearnerProfile();
    const publicView = isLearnerProfilePublicView();

    if (options) options.hidden = !admin;
    document.body.classList.toggle('learner-profile-admin', admin);
    document.body.classList.toggle('learner-profile-public-view', publicView);
}

function lockLearnerProfileChoices(select) {
    if (!select) return;
    if (typeof syncChoicesDisabledState === 'function') {
        syncChoicesDisabledState(select);
    }

    const choices = select?._choicesInstance?.containerOuter?.element
        || select.closest('.choices');
    if (!choices) return;

    // Choices replaces the native select with its own focusable/clickable
    // container. Disabling the hidden select alone still lets a read-only
    // profile open and change the visible dropdown.
    choices.classList.add('is-disabled');
    choices.setAttribute('aria-disabled', 'true');
    choices.setAttribute('tabindex', '-1');
    choices.querySelectorAll('.choices__input, [tabindex]').forEach((el) => {
        el.setAttribute('tabindex', '-1');
        if ('disabled' in el) el.disabled = true;
    });
    choices.querySelector('.choices__list--dropdown')?.setAttribute('aria-expanded', 'false');
    select?._choicesInstance?.hideDropdown?.(true);
}

function setReadOnly(form) {
    if (!form) return;

    const controls = form.querySelectorAll('input, select, textarea, button');
    controls.forEach((el) => {
        el.disabled = true;
        if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number' || el.type === 'tel' || el.type === 'email' || el.type === 'date')) {
            el.readOnly = true;
        }
        if (el.tagName === 'SELECT') lockLearnerProfileChoices(el);
    });

    form.querySelectorAll('.academic-date-value').forEach((input) => {
        input._academicCalendarDatePicker?.close?.();
    });
    form.querySelectorAll('.academic-date-trigger').forEach((trigger) => {
        trigger.disabled = true;
        trigger.setAttribute('aria-disabled', 'true');
        trigger.tabIndex = -1;
    });

    form.classList.add('readonly-form');
    form.setAttribute('aria-readonly', 'true');

    // Re-apply after dynamically enhanced selects finish initializing.
    window.requestAnimationFrame(() => form.querySelectorAll('select').forEach(lockLearnerProfileChoices));
    window.setTimeout(() => form.querySelectorAll('select').forEach(lockLearnerProfileChoices), 100);
}

function markLearnerComputedFields(form) {
    form.querySelectorAll('[readonly]').forEach((el) => {
        el.dataset.learnerComputed = 'true';
    });
    ['school_id', 'school_name', 'age_by_june'].forEach((id) => {
        form.querySelector(`#${id}`)?.setAttribute('data-learner-computed', 'true');
    });
}

function setLearnerFormEditable(form, enabled) {
    if (!form) return;

    form.querySelectorAll('input, select, textarea').forEach((el) => {
        const computed = el.dataset.learnerComputed === 'true';
        const editable = enabled && !computed;
        el.disabled = !editable;
        if (el.tagName === 'INPUT' && !computed) el.readOnly = !editable;
        if (el.tagName === 'SELECT' && typeof syncChoicesDisabledState === 'function') {
            syncChoicesDisabledState(el);
        }
    });

    form.querySelectorAll('.birthday-picker-container input, .birthday-picker-container select').forEach((el) => {
        const computed = el.dataset.learnerComputed === 'true';
        const editable = enabled && !computed;
        el.disabled = !editable;
        el.style.background = editable ? '' : 'var(--surface-0)';
        el.style.border = editable ? '' : '1px solid var(--gray-300)';
        el.style.color = editable ? '' : 'var(--gray-900)';
        el.style.padding = editable ? '' : '0.25rem 0';
    });

    form.classList.toggle('readonly-form', !enabled);
}

function setLearnerProfileEditMode(enabled) {
    if (!canEditLearnerProfile()) return;

    learnerProfileEditMode = Boolean(enabled);
    const form = document.getElementById('sf1RecordForm');
    const actions = document.getElementById('learnerProfileEditActions');
    const editLink = document.querySelector('[data-learner-edit]');

    setLearnerFormEditable(form, learnerProfileEditMode);
    if (actions) actions.hidden = !learnerProfileEditMode;
    if (editLink) editLink.hidden = learnerProfileEditMode;
}

async function cancelLearnerProfileEdit() {
    const form = document.getElementById('sf1RecordForm');
    if (!form || !learnerProfileRecord) return;

    populateForm(form, learnerProfileRecord);
    restrictLearnerGradeLevelToRecord(form, learnerProfileRecord);
    await populateSections(form, learnerProfileRecord);
    setReadOnly(form);
    setLearnerProfileEditMode(false);
}

function notifyLearnerProfile(type, message) {
    if (typeof window.showNotification === 'function') {
        window.showNotification(message, type);
        return;
    }
    console[type === 'error' ? 'error' : 'log'](message);
}

async function saveLearnerProfile() {
    if (!canEditLearnerProfile() || !learnerProfileEditMode || !learnerProfileRecord) return;

    const form = document.getElementById('sf1RecordForm');
    const saveButton = document.getElementById('learnerProfileSave');
    if (!form) return;

    const payload = typeof getFormPayload === 'function' ? getFormPayload(form) : {};
    payload.learner_id = Number(learnerProfileRecord.learner_id);
    if (!payload.learner_id) return;

    if (saveButton) {
        saveButton.disabled = true;
        saveButton.setAttribute('aria-busy', 'true');
    }

    try {
        const response = await axios.post(
            `${LEARNER_PROFILE_API_BASE}/learner_registration/learner_registration.php?operation=updateProfileRegistration`,
            payload,
            { withCredentials: true }
        );
        if (!response.data?.success) {
            throw new Error(response.data?.message || 'Unable to save the learner profile.');
        }
        notifyLearnerProfile('success', 'Learner profile updated.');
        await loadMyProfile();
    } catch (error) {
        console.error('Failed to save learner profile:', error);
        notifyLearnerProfile('error', error?.response?.data?.message || error.message || 'Unable to save the learner profile.');
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.removeAttribute('aria-busy');
        }
    }
}

function closeLearnerProfileMenu(restoreFocus = false) {
    const toggle = document.getElementById('learnerProfileOptionsToggle');
    const menu = document.getElementById('learnerProfileOptionsMenu');
    if (!toggle || !menu) return;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open profile options');
    menu.classList.remove('is-open');
    menu.setAttribute('aria-hidden', 'true');
    menu.hidden = true;
    if (restoreFocus) toggle.focus();
}

function openLearnerProfileMenu() {
    const toggle = document.getElementById('learnerProfileOptionsToggle');
    const menu = document.getElementById('learnerProfileOptionsMenu');
    if (!toggle || !menu || !canEditLearnerProfile()) return;
    menu.hidden = false;
    menu.setAttribute('aria-hidden', 'false');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close profile options');
    requestAnimationFrame(() => menu.classList.add('is-open'));
}

function setLearnerProfileView() {
    const detailsPanel = document.getElementById('profileCard');
    detailsPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function initializeLearnerProfileControls() {
    const toggle = document.getElementById('learnerProfileOptionsToggle');
    const menu = document.getElementById('learnerProfileOptionsMenu');
    const saveButton = document.getElementById('learnerProfileSave');
    const cancelButton = document.getElementById('learnerProfileCancelEdit');
    if (!toggle || !menu) return;

    toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const isOpen = toggle.getAttribute('aria-expanded') === 'true';
        if (isOpen) closeLearnerProfileMenu();
        else openLearnerProfileMenu();
    });

    menu.querySelectorAll('[data-learner-view]').forEach((item) => {
        item.addEventListener('click', (event) => {
            event.preventDefault();
            setLearnerProfileView(item.dataset.learnerView);
            closeLearnerProfileMenu();
        });
    });

    menu.querySelector('[data-learner-edit]')?.addEventListener('click', (event) => {
        event.preventDefault();
        setLearnerProfileEditMode(true);
        closeLearnerProfileMenu();
        document.getElementById('profileCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    saveButton?.addEventListener('click', () => void saveLearnerProfile());
    cancelButton?.addEventListener('click', () => void cancelLearnerProfileEdit());

    document.addEventListener('click', (event) => {
        if (!document.getElementById('learnerProfileOptions')?.contains(event.target)) closeLearnerProfileMenu();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
            event.preventDefault();
            closeLearnerProfileMenu(true);
        }
    });
}

async function loadMyProfile() {
    const status = document.getElementById('profileStatus');
    const card = document.getElementById('profileCard');
    const form = document.getElementById('sf1RecordForm');
    const requestedUserId = getRequestedLearnerUserId();
    const publicView = Boolean(requestedUserId);

    if (!form) return;

    try {
        const meRes = await axios.get(`${LEARNER_PROFILE_API_BASE}/auth/me.php`, { withCredentials: true });
        const user = meRes.data?.data || {};
        const learnerId = Number(user.learner_id || 0);

        if (publicView && isLearnerRole() && requestedUserId !== Number(user.user_id || 0)) {
            if (status) status.innerHTML = '<p>You may only view your own learner profile.</p>';
            return;
        }

        if (!publicView && learnerId <= 0) {
            if (status) status.innerHTML = '<p>No learner record is linked to this account.</p>';
            return;
        }

        const registrationParams = publicView
            ? { operation: 'getRegistrationById', user_id: requestedUserId }
            : { operation: 'getRegistrationById', learner_id: learnerId };

        const [recordRes, selectOptions] = await Promise.all([
            axios.get(`${LEARNER_PROFILE_API_BASE}/learner_registration/learner_registration.php`, {
                params: registrationParams,
                withCredentials: true
            }),
            preloadSelectOptions()
        ]);

        const record = recordRes.data;
        if (!record || record.success === false) {
            if (status) status.innerHTML = `<p>${escapeHtml(record?.message || 'Unable to load the learner record.')}</p>`;
            return;
        }

        learnerProfileRecord = record;
        setLearnerProfileIdentity(record, publicView);
        applyLearnerProfileAccess();
        if (status) status.style.display = 'none';
        if (card) card.style.display = 'block';

        if (typeof optionConfig !== 'undefined' && optionConfig.guardian_relationship) {
            optionConfig.guardian_relationship.valueKey = 'relationship_name';
            optionConfig.guardian_relationship.labelKey = 'relationship_name';
        }

        renderForm(form, selectOptions);
        markLearnerComputedFields(form);
        if (!form.dataset.learnerSegmentsReady) {
            initializeLearnerSegments();
            form.dataset.learnerSegmentsReady = 'true';
        }
        setLearnerSegment('personal');
        populateForm(form, record);
        restrictLearnerGradeLevelToRecord(form, record);
        wireGradeSectionCascade(form);
        await populateSections(form, record);
        setReadOnly(form);
        setLearnerProfileEditMode(false);
    } catch (error) {
        console.error('Failed to load learner profile:', error);
        if (status) status.innerHTML = '<p style="color: var(--color-danger);">Unable to load the learner profile. Please try again later.</p>';
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
    const requestedUserId = getRequestedLearnerUserId();
    initializeLearnerProfileControls();

    waitForRole(() => {
        applyLearnerProfileAccess();

        if (requestedUserId) {
            loadMyProfile();
            return;
        }

        if (!isLearnerRole()) {
            const form = document.getElementById('sf1RecordForm');
            if (form) {
                form.innerHTML = '<p class="text-center" style="color: var(--color-danger);">This page is for learner accounts only.</p>';
            }
            return;
        }
        loadMyProfile();
    });
});
