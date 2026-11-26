// ===========================
// Dashboard Announcements
// ===========================

// Ensure API_BASE is set (same-origin)
if (!window.API_BASE) {
    const pathname = String(window.location.pathname || '/');
    let appPrefix = '';
    if (pathname.includes('/dashboard/')) {
        appPrefix = pathname.split('/dashboard/')[0] || '';
    } else if (pathname.includes('/pages/')) {
        appPrefix = pathname.split('/pages/')[0] || '';
    } else if (pathname.includes('/api/')) {
        appPrefix = pathname.split('/api/')[0] || '';
    } else if (pathname.endsWith('.html')) {
        appPrefix = pathname.substring(0, pathname.lastIndexOf('/')) || '';
    } else {
        const parts = pathname.split('/').filter(Boolean);
        appPrefix = parts.length ? `/${parts[0]}` : '';
    }

    if (appPrefix === '/') appPrefix = '';

    window.API_BASE = `${appPrefix}/api`;
}

let currentUser = null;
let editingAnnouncementId = null;
let editingAnnouncementPinned = 0;
let announcementsIndex = new Map();
let announcementsLoadPromise = null;
let announcementsRefreshQueued = false;
let announcementsRefreshTimer = null;
const ANNOUNCEMENTS_REFRESH_INTERVAL_MS = 15000;

function isLearnerRole(roleName) {
    const normalized = String(roleName || '').trim().toLowerCase();
    return normalized.includes('learner') || normalized.includes('student');
}

function isAdminRole(roleName) {
    const normalized = String(roleName || '').trim().toLowerCase();
    return normalized.includes('admin');
}

function isTeacherRole(roleName) {
    const normalized = String(roleName || '').trim().toLowerCase();
    return normalized.includes('teacher');
}

function canCurrentUserPostAnnouncements() {
    if (!currentUser) return false;
    return isAdminRole(currentUser.role_name) || isTeacherRole(currentUser.role_name);
}

function applyAnnouncementPostingPermissions() {
    if (!currentUser) return;
    if (canCurrentUserPostAnnouncements()) return;

    const createBtn = document.getElementById('createAnnouncementBtn');
    const composeField = document.getElementById('composeField');
    const composeCard = document.getElementById('composeCard');
    const modal = document.getElementById('createAnnouncementModal');

    if (createBtn) createBtn.style.display = 'none';
    if (composeField) composeField.style.display = 'none';
    if (composeCard) composeCard.style.display = 'none';
    if (modal) modal.classList.remove('active');
}

document.addEventListener('DOMContentLoaded', function() {
    if (window.axios) {
        try {
            window.axios.defaults.withCredentials = true;
        } catch (_) {
            // ignore
        }
    }
    console.log('🚀 Dashboard Announcements initialized');
    initializeAnnouncementNavigation();
    initializeAnnouncementModal();
    initializeComposerFeatures();
    initializeReadMoreToggle();
    initializeAnnouncementActions();
    loadCurrentUser();
    startAnnouncementsRealtimeRefresh();
});

function isAnnouncementsHomeActive() {
    const homeSection = document.getElementById('homeSection');
    return !homeSection || homeSection.classList.contains('active');
}

function startAnnouncementsRealtimeRefresh() {
    if (announcementsRefreshTimer) return;

    announcementsRefreshTimer = window.setInterval(() => {
        if (document.visibilityState === 'hidden' || !isAnnouncementsHomeActive()) return;
        void loadAnnouncements({ silent: true });
    }, ANNOUNCEMENTS_REFRESH_INTERVAL_MS);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && isAnnouncementsHomeActive()) {
            void loadAnnouncements({ silent: true });
        }
    });
}

function initializeReadMoreToggle() {
    const feed = document.getElementById('announcementsFeed');
    if (!feed) return;

    feed.addEventListener('click', (event) => {
        const toggleBtn = event.target.closest('.announcement-readmore');
        if (!toggleBtn) return;

        const content = toggleBtn.closest('.announcement-content');
        if (!content) return;

        const isExpanded = content.dataset.expanded === 'true';
        content.dataset.expanded = isExpanded ? 'false' : 'true';
        toggleBtn.textContent = isExpanded ? 'Read more' : 'Read less';
    });
}

function closeAnnouncementMenus(except = null) {
    document.querySelectorAll('.announcement-action-menu:not([hidden])').forEach((menu) => {
        if (menu === except) return;
        menu.hidden = true;
        menu.closest('.announcement-menu')?.querySelector('.announcement-menu-toggle')?.setAttribute('aria-expanded', 'false');
    });
    document.body.classList.toggle('announcement-sheet-open', Boolean(document.querySelector('.announcement-action-menu:not([hidden])')));
}

function initializeAnnouncementActions() {
    const feed = document.getElementById('announcementsFeed');
    if (!feed) return;

    feed.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-announcement-menu-toggle]');
        if (toggle) {
            event.preventDefault();
            event.stopPropagation();
            const menu = toggle.closest('.announcement-menu')?.querySelector('.announcement-action-menu');
            if (!menu) return;
            const opening = menu.hidden;
            closeAnnouncementMenus(menu);
            menu.hidden = !opening;
            toggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
            document.body.classList.toggle('announcement-sheet-open', opening);
            return;
        }

        const action = event.target.closest('[data-announcement-action]');
        if (!action) return;
        event.preventDefault();
        const card = action.closest('.announcement-card');
        const announcementId = card?.dataset.id;
        if (!announcementId) return;
        closeAnnouncementMenus();

        const actionName = action.dataset.announcementAction;
        if (actionName === 'pin') pinAnnouncement(announcementId, Number(action.dataset.pinned) === 1);
        if (actionName === 'edit') editAnnouncement(announcementId);
        if (actionName === 'delete') deleteAnnouncement(announcementId);
        if (actionName === 'hide') hideAnnouncement(announcementId, card);
        if (actionName === 'report') reportAnnouncement(announcementId);
    });

    document.addEventListener('click', (event) => {
        if (!event.target.closest('.announcement-menu')) closeAnnouncementMenus();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeAnnouncementMenus();
    });
}

const ANNOUNCEMENT_FEEDBACK_OPTIONS = {
    hide: [
        { value: 'not_relevant', label: 'This post is not relevant to me' },
        { value: 'already_seen', label: 'I have already seen this' },
        { value: 'too_frequent', label: 'I am seeing too many similar posts' },
        { value: 'other', label: 'Other' }
    ],
    report: [
        { value: 'inappropriate', label: 'Inappropriate or unsafe content' },
        { value: 'harassment', label: 'Harassment or a personal attack' },
        { value: 'spam', label: 'Spam or misleading information' },
        { value: 'privacy', label: 'Personal or private information' },
        { value: 'other', label: 'Other' }
    ]
};

function ensureAnnouncementFeedbackModal() {
    let modal = document.getElementById('announcementFeedbackModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'announcementFeedbackModal';
    modal.className = 'announcement-feedback-modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('[data-feedback-cancel]')) {
            closeAnnouncementFeedbackDialog();
        }
    });
    modal.addEventListener('change', (event) => {
        if (!event.target.matches('input[name="announcement_feedback_reason"]')) return;
        const details = modal.querySelector('[data-feedback-details]');
        const isOther = event.target.value === 'other';
        if (details) {
            details.hidden = !isOther;
            if (isOther) details.querySelector('textarea')?.focus();
        }
        clearAnnouncementFeedbackError(modal.querySelector('form[data-feedback-form]'));
    });
    modal.addEventListener('input', () => {
        clearAnnouncementFeedbackError(modal.querySelector('form[data-feedback-form]'));
    });
    modal.addEventListener('submit', (event) => {
        event.preventDefault();
        const form = event.target.closest('form[data-feedback-form]');
        if (!form) return;
        void submitAnnouncementFeedback(form);
    });
    modal.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeAnnouncementFeedbackDialog();
        }
    });

    return modal;
}

function setAnnouncementFeedbackError(form, message) {
    const error = form?.querySelector('[data-feedback-error]');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
}

function clearAnnouncementFeedbackError(form) {
    setAnnouncementFeedbackError(form, '');
}

function openAnnouncementFeedbackDialog(announcementId, actionType, card) {
    const modal = ensureAnnouncementFeedbackModal();
    const isReport = actionType === 'report';
    const options = ANNOUNCEMENT_FEEDBACK_OPTIONS[isReport ? 'report' : 'hide'];
    const submitLabel = isReport ? 'Send report' : 'Hide post';
    modal.__returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal.__announcementCard = card || null;
    modal.innerHTML = `
        <div class="announcement-feedback-dialog" role="document">
            <div class="announcement-feedback-dialog__header">
                <div>
                    <p id="announcementFeedbackDescription">${isReport ? 'Tell us why you want to report this post.' : 'Tell us why you want to hide this post.'}</p>
                </div>
                <button type="button" class="announcement-feedback-close" data-feedback-cancel aria-label="Close feedback form">&times;</button>
            </div>
            <form data-feedback-form data-action-type="${isReport ? 'report' : 'hide'}" data-announcement-id="${String(announcementId)}">
                <fieldset class="announcement-feedback-options" aria-label="Choose feedback">
                    ${options.map((option) => `
                        <label class="announcement-feedback-option">
                            <input type="radio" name="announcement_feedback_reason" value="${option.value}">
                            <span>${option.label}</span>
                        </label>
                    `).join('')}
                </fieldset>
                <p class="announcement-feedback-error" data-feedback-error role="alert" hidden></p>
                <div class="announcement-feedback-details" data-feedback-details hidden>
                    <label for="announcementFeedbackDetails">Please specify</label>
                    <textarea id="announcementFeedbackDetails" name="reason_details" rows="3" maxlength="420" placeholder="Tell us briefly what happened"></textarea>
                    <small>Keep it clear and specific.</small>
                </div>
                <div class="announcement-feedback-dialog__footer">
                    <p class="announcement-feedback-note">Your feedback helps the school system identify the next appropriate action.</p>
                    <div class="announcement-feedback-actions">
                        <button type="button" class="btn btn-outline" data-feedback-cancel>Cancel</button>
                        <button type="submit" class="btn btn-primary" data-feedback-submit>${submitLabel}</button>
                    </div>
                </div>
            </form>
        </div>
    `;
    modal.hidden = false;
    modal.classList.add('is-open');
    document.body.classList.add('announcement-feedback-open');
    modal.setAttribute('aria-labelledby', 'announcementFeedbackDescription');
    modal.setAttribute('aria-describedby', 'announcementFeedbackDescription');
    window.setTimeout(() => modal.querySelector('input[name="announcement_feedback_reason"]')?.focus(), 0);
}

function closeAnnouncementFeedbackDialog() {
    const modal = document.getElementById('announcementFeedbackModal');
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.hidden = true;
    document.body.classList.remove('announcement-feedback-open');
    const returnFocus = modal.__returnFocus;
    modal.__returnFocus = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

async function submitAnnouncementFeedback(form) {
    const submit = form.querySelector('[data-feedback-submit]');
    if (!submit || submit.disabled) return;

    const actionType = form.dataset.actionType === 'report' ? 'report' : 'hide';
    const operation = actionType === 'report' ? 'reportAnnouncement' : 'hideAnnouncement';
    const announcementId = Number(form.dataset.announcementId || 0);
    const selected = form.querySelector('input[name="announcement_feedback_reason"]:checked');
    const reasonDetails = String(form.querySelector('textarea[name="reason_details"]')?.value || '').trim();
    const option = ANNOUNCEMENT_FEEDBACK_OPTIONS[actionType].find((item) => item.value === selected?.value);
    if (!announcementId) {
        setAnnouncementFeedbackError(form, 'This post could not be identified. Please close this form and try again.');
        return;
    }
    if (!selected || !option) {
        setAnnouncementFeedbackError(form, 'Choose an option before sending your feedback.');
        form.querySelector('input[name="announcement_feedback_reason"]')?.focus();
        return;
    }
    if (selected.value === 'other' && !reasonDetails) {
        setAnnouncementFeedbackError(form, 'Please type a short reason before sending your feedback.');
        form.querySelector('textarea[name="reason_details"]')?.focus();
        return;
    }

    clearAnnouncementFeedbackError(form);

    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    const card = document.getElementById('announcementFeedbackModal')?.__announcementCard;

    try {
        const response = await axios.post(
            `${window.API_BASE}/announcements/announcements.php?operation=${operation}`,
            {
                announcement_id: announcementId,
                reason_code: selected.value,
                reason_details: reasonDetails,
                reason: `${option.label}${reasonDetails ? `: ${reasonDetails}` : ''}`
            }
        );
        if (!response.data?.success) {
            throw new Error(response.data?.message || 'Unable to save feedback');
        }

        closeAnnouncementFeedbackDialog();
        if (actionType === 'hide') {
            card?.remove();
            announcementsIndex.delete(String(announcementId));
            await loadAnnouncements({ silent: true });
            showNotification('Thanks for helping us improve your feed. This post is hidden from your view.', 'success');
        } else {
            card?.classList.add('has-feedback');
            showNotification('Thanks for helping us identify this post. We will review it and take the next appropriate action.', 'success');
        }
    } catch (error) {
        submit.disabled = false;
        submit.removeAttribute('aria-busy');
        showNotification(error.response?.data?.message || error.message || 'Unable to save feedback.', 'error');
    }
}

function hideAnnouncement(announcementId, card) {
    openAnnouncementFeedbackDialog(announcementId, 'hide', card);
}

function reportAnnouncement(announcementId) {
    openAnnouncementFeedbackDialog(announcementId, 'report', null);
}

function openComposeModal() {
    const modal = document.getElementById('createAnnouncementModal');
    const form = document.getElementById('createAnnouncementForm');
    if (!modal || !form) {
        console.error('Compose modal elements not found.');
        return;
    }

    editingAnnouncementId = null;
    editingAnnouncementPinned = 0;
    modal.classList.add('active');
    form.reset();
    window.resetAnnouncementBackgroundControl?.();

    setComposerMode('create');

    const titleCounter = document.getElementById('titleCounter');
    const contentCounter = document.getElementById('contentCounter');
    if (titleCounter) titleCounter.textContent = '0';
    if (contentCounter) contentCounter.textContent = '0';

    const attachmentPreview = document.getElementById('attachmentPreview');
    if (attachmentPreview) attachmentPreview.style.display = 'none';
}

window.openComposeModal = openComposeModal;

// ===========================
// Navigation Management
// ===========================

function initializeAnnouncementNavigation() {
    // Handle sidebar section navigation
    const navLinks = document.querySelectorAll('.nav-link[data-section]');
    const submenuLinks = document.querySelectorAll('.submenu a[data-section]');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const section = link.dataset.section;
            navigateToSection(section);

            // Update active state
            document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
            link.classList.add('active');
        });
    });

    submenuLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const section = link.dataset.section;
            navigateToSection(section);

            // Update active state
            document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
            document.querySelectorAll('.submenu a').forEach(l => l.classList.remove('active'));
            link.classList.add('active');
        });
    });

    // Handle hash navigation
    window.addEventListener('hashchange', handleHashChange);
    handleHashChange(); // Initial load
}

function handleHashChange() {
    const hash = window.location.hash.substring(1) || 'home';
    navigateToSection(hash);
}

function navigateToSection(sectionName) {
    window.closeDashboardSidebar?.();

    // Hide all sections
    const sections = document.querySelectorAll('.content-section');
    sections.forEach(section => section.classList.remove('active'));

    // Show target section
    const targetSection = document.getElementById(`${sectionName}Section`);
    if (targetSection) {
        targetSection.classList.add('active');

        // Update only the hash without dropping an existing query string.
        // Reported-post navigation uses the query string as a fallback focus
        // carrier when sessionStorage is unavailable.
        const nextUrl = new URL(window.location.href);
        nextUrl.hash = `#${sectionName}`;
        history.pushState(null, null, `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);

        // Load section-specific data
        loadSectionData(sectionName);
    }
}

function loadSectionData(sectionName) {
    switch(sectionName) {
        case 'home':
            loadAnnouncements();
            break;
        case 'dashboard-overview':
        case 'enrollment-analytics':
        case 'performance-analytics':
        case 'grade-distribution':
            if (sectionName === 'dashboard-overview') {
                setTimeout(() => initializeDashboardOverviewCharts(), 100);
            }
            break;
    }
}

// ===========================
// User Management
// ===========================

async function loadCurrentUser() {
    try {
        const response = await axios.get(`${window.API_BASE}/auth/me.php`);
        if (!response.data?.success) {
            return;
        }

        currentUser = response.data.data;

        const composerUserName = document.getElementById('composerUserName');
        if (composerUserName) {
            const fullName = currentUser.full_name || `${currentUser.first_name || ''} ${currentUser.last_name || ''}`.trim();
            composerUserName.textContent = fullName || currentUser.username || 'User';
        }

        applyAnnouncementPostingPermissions();
        if (canCurrentUserPostAnnouncements()) {
            loadRoles();
        }
    } catch (error) {
        if (error?.response?.status === 401) {
            return;
        }
        console.error('Error loading user:', error);
    }
}

// ===========================
// Composer Features
// ===========================

function initializeComposerFeatures() {
    // Character counters
    const titleInput = document.getElementById('announcementTitle');
    const bodyTextarea = document.getElementById('announcementBody');
    const titleCounter = document.getElementById('titleCounter');
    const contentCounter = document.getElementById('contentCounter');

    if (titleInput && titleCounter) {
        titleInput.addEventListener('input', (e) => {
            const length = e.target.value.length;
            titleCounter.textContent = length;

            // Update counter color
            titleCounter.classList.remove('warning', 'danger');
            if (length > 180) titleCounter.classList.add('warning');
            if (length > 195) titleCounter.classList.add('danger');
        });
    }

    if (bodyTextarea && contentCounter) {
        bodyTextarea.addEventListener('input', (e) => {
            const length = e.target.value.length;
            contentCounter.textContent = length;
        });
    }

    // Advanced options toggle
    const advancedToggle = document.getElementById('advancedToggle');
    const advancedOptions = document.getElementById('advancedOptions');

    if (advancedToggle && advancedOptions) {
        advancedToggle.addEventListener('click', () => {
            const isVisible = advancedOptions.style.display === 'block';
            advancedOptions.style.display = isVisible ? 'none' : 'block';
            advancedToggle.classList.toggle('active');
        });
    }
}

// ===========================
// Announcements Management
// ===========================

function normalizeAnnouncementsPayload(payload) {
    if (!payload) return [];

    if (Array.isArray(payload)) {
        return payload;
    }

    if (typeof payload === 'string') {
        try {
            const parsed = JSON.parse(payload);
            return normalizeAnnouncementsPayload(parsed);
        } catch (_) {
            return [];
        }
    }

    if (typeof payload === 'object') {
        if (payload.success === false) {
            return [];
        }
        if (Array.isArray(payload.data)) {
            return payload.data;
        }
        if (Array.isArray(payload.announcements)) {
            return payload.announcements;
        }
    }

    return [];
}

async function loadAnnouncements({ silent = false } = {}) {
    if (announcementsLoadPromise) {
        announcementsRefreshQueued = true;
        return announcementsLoadPromise;
    }

    console.log('🔄 Loading announcements...');
    const request = (async () => {
        try {
            const response = await axios.get(`${window.API_BASE}/announcements/announcements.php?operation=getAllAnnouncements`);
            const announcements = normalizeAnnouncementsPayload(response.data);
            console.log('✅ Announcements loaded:', announcements);

            // displayAnnouncements([]) immediately swaps in the empty state when
            // a realtime refresh finds that the last post is gone.
            displayAnnouncements(announcements);
        } catch (error) {
            console.error('❌ Error loading announcements:', error);
            if (silent) return;

            const apiMessage = error?.response?.data?.message;
            const message = apiMessage || error?.message || 'Failed to load announcements';
            showNotification(message, 'error');

            // Show error in feed
            const feedContainer = document.getElementById('announcementsFeed');
            if (feedContainer) {
                feedContainer.innerHTML = `
                    <div style="padding: 2rem; background: #fee; border: 2px solid #f00; border-radius: 8px;">
                        <strong>Error loading announcements:</strong> ${message}
                        <br><br>
                        <button onclick="loadAnnouncements()" class="btn btn-primary">
                            <i class="fas fa-sync"></i> Try Again
                        </button>
                    </div>
                `;
            }
        }
    })();

    announcementsLoadPromise = request;
    try {
        return await request;
    } finally {
        announcementsLoadPromise = null;
        if (announcementsRefreshQueued) {
            announcementsRefreshQueued = false;
            void loadAnnouncements({ silent: true });
        }
    }
}

window.loadAnnouncements = loadAnnouncements;

function readPendingAnnouncementId() {
    let queryId = 0;
    try {
        queryId = Number(new URLSearchParams(window.location.search).get('focus_announcement') || 0);
    } catch (_) {
        queryId = 0;
    }

    let sessionId = 0;
    try {
        sessionId = Number(sessionStorage.getItem('focusAnnouncementId') || 0);
    } catch (_) {
        sessionId = 0;
    }

    const id = Number.isFinite(queryId) && queryId > 0 ? queryId : sessionId;
    if (!Number.isFinite(id) || id <= 0) return 0;

    try {
        sessionStorage.removeItem('focusAnnouncementId');
    } catch (_) {
        // ignore
    }

    try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('focus_announcement')) {
            url.searchParams.delete('focus_announcement');
            window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
        }
    } catch (_) {
        // Ignore URL cleanup failures.
    }

    return id;
}

async function tryFocusAnnouncementFromNotification() {
    const id = readPendingAnnouncementId();
    if (!id) return;

    // The shared helper handles expansion, centered scrolling, and highlight styling.
    if (typeof window.focusAnnouncementInFeedNow === 'function' && window.focusAnnouncementInFeedNow(id)) {
        return;
    }

    // The initial feed can omit an older or otherwise filtered item. Load the
    // selected announcement directly before reporting it as unavailable.
    try {
        const response = await axios.get(`${window.API_BASE}/announcements/announcements.php`, {
            params: { operation: 'getAnnouncement', id, _: Date.now() }
        });
        const announcement = response.data?.success ? response.data.data : null;
        if (!announcement || typeof announcement !== 'object') throw new Error('Announcement not found');

        const existingAnnouncements = Array.from(announcementsIndex.values())
            .filter((item) => String(item?.announcement_id || '') !== String(id));
        displayAnnouncements([announcement, ...existingAnnouncements]);

        if (typeof window.focusAnnouncementInFeedNow === 'function' && window.focusAnnouncementInFeedNow(id)) {
            return;
        }

        const feed = document.getElementById('announcementsFeed');
        const card = feed?.querySelector(`.announcement-card[data-id="${String(id)}"]`);
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (card) return;
    } catch (_) {
        // Fall through to the composed status message below.
    }

    showNotification('This announcement is no longer available. It may have been removed.', 'announcement');
}

function displayAnnouncements(announcements) {
    const feedContainer = document.getElementById('announcementsFeed');
    const safeAnnouncements = normalizeAnnouncementsPayload(announcements);
    console.log('📝 Displaying announcements:', safeAnnouncements?.length || 0, 'items');

    // Keep an index for edit lookups.
    announcementsIndex = new Map(
        (safeAnnouncements || []).map((a) => [String(a.announcement_id), a])
    );

    if (!feedContainer) {
        console.error('❌ announcementsFeed element not found!');
        return;
    }

    if (!safeAnnouncements || safeAnnouncements.length === 0) {
        feedContainer.innerHTML = `
            <div class="announcements-empty" role="status" aria-live="polite">
                <div class="announcements-empty__frame">
                    <div class="announcements-empty__icon" aria-hidden="true">
                        <video class="mp4-surface-blend empty-state-video empty-state-video--large" autoplay loop muted playsinline preload="metadata" aria-hidden="true">
                            <source src="../assets/icons/sorry.mp4" type="video/mp4">
                        </video>
                    </div>
                    <h3>No announcements yet</h3>
                </div>
            </div>
        `;

        // If we were trying to focus a specific announcement, it won't exist.
        void tryFocusAnnouncementFromNotification();
        return;
    }

    try {
        feedContainer.innerHTML = safeAnnouncements.map(announcement => createAnnouncementCard(announcement)).join('')
            + renderAnnouncementFeedEnd();
        console.log('✅ Announcements displayed in feed');

        // If we navigated here from a notification, focus the matching post.
        void tryFocusAnnouncementFromNotification();
    } catch (error) {
        console.error('❌ Error creating announcement cards:', error);
        feedContainer.innerHTML = `
            <div style="padding: 2rem; background: #fee; border: 2px solid #f00; border-radius: 8px;">
                <strong>Error displaying announcements:</strong> ${error.message}
            </div>
        `;
    }
}

window.displayAnnouncements = displayAnnouncements;

function renderAnnouncementFeedEnd() {
    const appBase = String(
        window.APP_BASE || String(window.API_BASE || '').replace(/\/api\/?$/, '')
    ).replace(/\/$/, '');
    const sorryUrl = `${appBase}/assets/icons/sorry.mp4`;
    return `
        <div class="announcement-feed-end" role="status" aria-label="End of announcements">
            <video class="mp4-surface-blend announcement-feed-end__icon announcement-feed-end__video" autoplay loop muted playsinline preload="auto" aria-hidden="true">
                <source src="${sorryUrl}" type="video/mp4">
            </video>
            <div class="announcement-feed-end__copy">
                <p class="announcement-feed-end__title">Oops, dead end.</p>
                <p class="announcement-feed-end__note">There are no more posts to show.</p>
            </div>
        </div>
    `;
}

function createAnnouncementCard(announcement) {
    const publishedDate = new Date(announcement.published_at);
    const isExpired = announcement.expires_at && new Date(announcement.expires_at) < new Date();
    const isPinned = announcement.is_pinned == 1;
    const canManage = canCurrentUserManageAnnouncement(announcement);

    const postedAt = announcement.seconds_ago !== undefined
        ? formatTimeAgoFromSeconds(announcement.seconds_ago, publishedDate)
        : formatTimeAgo(publishedDate);

    const authorName = announcement.first_name && announcement.last_name
        ? `${announcement.first_name} ${announcement.last_name}`
        : announcement.posted_by_name || 'System';
    const authorInitials = typeof getAccountInitials === 'function'
        ? getAccountInitials(authorName)
        : (() => {
            const parts = authorName.split(/\s+/).filter(Boolean);
            return parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase() : (parts[0] || 'U').slice(0, 2).toUpperCase();
        })();
    const authorGender = typeof normalizeAccountGender === 'function'
        ? normalizeAccountGender(announcement.gender)
        : (String(announcement.gender || '').toLowerCase() === 'female' ? 'female' : String(announcement.gender || '').toLowerCase() === 'male' ? 'male' : 'neutral');
    const profileLink = Number(announcement.posted_by) > 0
        ? `${window.APP_BASE || ''}/pages/profile.html?user_id=${encodeURIComponent(announcement.posted_by)}`
        : '';
    const safeProfileLink = profileLink ? escapeHtml(profileLink) : '';
    const authorAvatarMarkup = profileLink
        ? `<a class="profile-user-link profile-user-link--avatar" href="${safeProfileLink}" aria-label="View ${escapeHtml(authorName)}'s profile"><div class="author-avatar gender-${authorGender}">${escapeHtml(authorInitials || 'U')}</div></a>`
        : `<div class="author-avatar gender-${authorGender}" aria-label="${escapeHtml(authorName)} profile">${escapeHtml(authorInitials || 'U')}</div>`;
    const approvedBadgeMarkup = typeof renderDeveloperApprovedBadgeMarkup === 'function'
        ? renderDeveloperApprovedBadgeMarkup(announcement)
        : '';
    const authorNameMarkup = profileLink
        ? `<a class="profile-user-link profile-user-link--name" href="${safeProfileLink}">${escapeHtml(authorName)}${approvedBadgeMarkup}</a>`
        : escapeHtml(authorName);

    const targetAudience = announcement.target_role_name || 'Everyone';
    const audienceLabel = targetAudience === 'Everyone' ? 'Everyone' : 'Custom audience';
    const audienceIcon = targetAudience === 'Everyone' ? 'fa-earth-americas' : 'fa-users';
    const audienceMarkup = `<span class="announcement-audience-icon" title="${audienceLabel}" aria-label="${audienceLabel}"><i class="fas ${audienceIcon}" aria-hidden="true"></i></span>`;
    const pinnedMarkup = isPinned ? '<span class="pin-badge"><i class="fas fa-thumbtack"></i>Pinned</span>' : '';
    const menuOptionsMarkup = canManage
        ? `<button type="button" data-announcement-action="pin" data-pinned="${isPinned ? '0' : '1'}"><i class="fas fa-thumbtack announcement-action-icon" aria-hidden="true"></i>${isPinned ? 'Unpin' : 'Pin'}</button><button type="button" data-announcement-action="edit"><i class="fas fa-pen-to-square announcement-action-icon" aria-hidden="true"></i>Edit</button><button type="button" data-announcement-action="delete" class="is-danger"><i class="fas fa-trash-can announcement-action-icon" aria-hidden="true"></i>Delete</button>`
        : '<button type="button" data-announcement-action="hide"><i class="fas fa-eye-slash announcement-action-icon" aria-hidden="true"></i>Hide</button><button type="button" data-announcement-action="report"><i class="fas fa-triangle-exclamation announcement-action-icon" aria-hidden="true"></i>Report</button>';
    const menuMarkup = `<div class="announcement-menu"><button type="button" class="announcement-menu-toggle" data-announcement-menu-toggle aria-expanded="false" aria-label="Post options"><i class="fas fa-ellipsis-vertical" aria-hidden="true"></i></button><div class="announcement-action-menu" hidden>${menuOptionsMarkup}</div></div>`;
    const bodyText = announcement.body || '';
    const maxLength = 280;
    const isLongContent = bodyText.length > maxLength;
    const shortContent = escapeHtml(bodyText.slice(0, maxLength)).replace(/\n/g, '<br>');
    const fullContent = escapeHtml(bodyText).replace(/\n/g, '<br>');
    const contentHtml = isLongContent
        ? `
            <span class="announcement-content-short">${shortContent}</span>
            <span class="announcement-content-ellipsis">...</span>
            <span class="announcement-content-full">${fullContent}</span>
            <button class="announcement-readmore" type="button">Read more</button>
        `
        : fullContent;
    const messageBackground = typeof getAnnouncementBackgroundForAnnouncement === 'function'
        ? getAnnouncementBackgroundForAnnouncement(announcement)
        : '#ffffff';
    const isPlainBackground = typeof isAnnouncementPlainBackground === 'function'
        ? isAnnouncementPlainBackground(messageBackground)
        : messageBackground.trim().toLowerCase() === '#ffffff';
    const messageBackgroundClass = isPlainBackground ? ' announcement-content--plain' : '';
    const messageStyle = ` style="background: ${escapeHtml(messageBackground)};"`;

    return `
        <div class="announcement-card ${isExpired ? 'expired' : ''} ${isPinned ? 'pinned' : ''}" data-id="${announcement.announcement_id}">
            <div class="announcement-header">
                <div class="announcement-author">
                    ${authorAvatarMarkup}
                    <div class="author-info">
                        <h4 class="author-name">${authorNameMarkup}</h4>
                        <div class="announcement-meta">
                            <span class="announcement-time">${postedAt}</span>
                            ${audienceMarkup}
                            ${pinnedMarkup}
                            ${isExpired ? '<span class="expired-badge"><i class="fas fa-times-circle"></i> Expired</span>' : ''}
                        </div>
                    </div>
                </div>
                ${menuMarkup}
            </div>
            <div class="announcement-body">
                <h3 class="announcement-title">${escapeHtml(announcement.title)}</h3>
                <div class="announcement-content${messageBackgroundClass}"${messageStyle} ${isLongContent ? 'data-expanded="false"' : ''}>
                    <div class="announcement-copy">${contentHtml}</div>
                </div>
                ${announcement.attachment_url ? `
                    <div class="announcement-attachment">
                        <i class="fas fa-paperclip"></i>
                        <div class="attachment-info">
                            <strong>Attachment</strong>
                            <small>${announcement.attachment_url.split('/').pop()}</small>
                        </div>
                        <a href="${announcement.attachment_url}" class="btn btn-sm btn-outline" download>
                            <i class="fas fa-download"></i>
                        </a>
                    </div>
                ` : ''}
            </div>
            <div class="announcement-footer">
                ${announcement.expires_at ? `
                    <div class="announcement-expiry">
                        <i class="fas fa-calendar-times"></i>
                        Expires: ${formatDate(new Date(announcement.expires_at))}
                    </div>
                ` : ''}
            </div>
        </div>
    `;
}

function canCurrentUserManageAnnouncement(announcement) {
    // Prefer backend-provided ownership flag (returned by announcements API).
    if (['1', 'true'].includes(String(announcement?.is_owner).toLowerCase())) return true;

    if (!currentUser) return false;

    // Fallback for older payloads: compare IDs.
    return String(currentUser.user_id) === String(announcement?.posted_by);
}

// ===========================
// Pin/Unpin Announcement
// ===========================

async function pinAnnouncement(announcementId, isPinned) {
    const announcement = announcementsIndex?.get(String(announcementId));
    if (!announcement || !canCurrentUserManageAnnouncement(announcement)) {
        showNotification('Not authorized to manage this announcement.', 'error');
        return;
    }
    try {
        const response = await axios.post(
            `${window.API_BASE}/announcements/announcements.php?operation=pinAnnouncement`,
            {
                announcement_id: announcementId,
                is_pinned: isPinned
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (response.data.success) {
            showNotification(response.data.message, 'success');
            loadAnnouncements();
        } else {
            showNotification(response.data.message || 'Failed to update pin status', 'error');
        }
    } catch (error) {
        console.error('Error pinning announcement:', error);
        showNotification('An error occurred while updating pin status', 'error');
    }
}

// Make function globally accessible
window.pinAnnouncement = pinAnnouncement;

// ===========================
// Announcement Modal
// ===========================

function initializeAnnouncementModal() {
    const createBtn = document.getElementById('createAnnouncementBtn');
    const composeField = document.getElementById('composeField');
    const composeCard = document.getElementById('composeCard');
    const modal = document.getElementById('createAnnouncementModal');
    const closeBtn = document.getElementById('closeAnnouncementModal');
    const cancelBtn = document.getElementById('cancelAnnouncementBtn');
    const form = document.getElementById('createAnnouncementForm');

    // If this page doesn't include the compose modal UI, exit safely.
    if (!modal) {
        return;
    }

    window.initializeAnnouncementBackgroundControl?.();

    if (createBtn) {
        createBtn.addEventListener('click', openComposeModal);
    }

    if (composeField) {
        composeField.addEventListener('click', openComposeModal);
    }

    if (composeCard) {
        composeCard.addEventListener('click', (event) => {
            if (event.target.closest('#composeField')) return;
            openComposeModal();
        });
        composeCard.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openComposeModal();
            }
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            modal.classList.remove('active');
            editingAnnouncementId = null;
            editingAnnouncementPinned = 0;
            setComposerMode('create');
        });
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            modal.classList.remove('active');
            editingAnnouncementId = null;
            editingAnnouncementPinned = 0;
            setComposerMode('create');
        });
    }

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('active');
            editingAnnouncementId = null;
            editingAnnouncementPinned = 0;
            setComposerMode('create');
        }
    });

    if (form) {
        form.addEventListener('submit', handleAnnouncementSubmit);
    }
}

async function handleAnnouncementSubmit(e) {
    e.preventDefault();

    if (!canCurrentUserPostAnnouncements()) {
        showNotification('Learners are not allowed to post announcements.', 'error');
        return;
    }

    const formData = new FormData(e.target);
    const selectedBackground = document.getElementById('messageBackground')?.value || '#ffffff';
    const data = {
        title: formData.get('title'),
        body: formData.get('body'),
        target_role_id: formData.get('target_role_id') || null,
        expires_at: formData.get('expires_at') || null,
        message_background: selectedBackground,
        // New posts are never pinned from the composer. When editing an
        // existing post, preserve its current state without exposing a pin
        // control in the posting flow.
        is_pinned: editingAnnouncementPinned
    };

    if (!data.title || !data.body) {
        showNotification('Please fill in all required fields', 'error');
        return;
    }

    const submitBtn = document.getElementById('submitAnnouncementBtn');
    const isEditing = !!editingAnnouncementId;
    submitBtn.disabled = true;
    submitBtn.innerHTML = isEditing
        ? '<i class="fas fa-spinner fa-spin"></i> Updating...'
        : '<i class="fas fa-spinner fa-spin"></i> Posting...';

    try {
        const operation = isEditing ? 'updateAnnouncement' : 'createAnnouncement';
        const payload = isEditing
            ? { ...data, announcement_id: editingAnnouncementId }
            : data;

        const response = await axios.post(
            `${window.API_BASE}/announcements/announcements.php?operation=${operation}`,
            payload,
            { headers: { 'Content-Type': 'application/json' } }
        );

        console.log('Create announcement response:', response.data);

        if (response.data && response.data.success) {
            const savedAnnouncementId = response.data.announcement?.announcement_id || editingAnnouncementId;
            window.rememberAnnouncementBackground?.(savedAnnouncementId, selectedBackground);
            showNotification(isEditing ? 'Announcement updated.' : 'Announcement posted.', 'success');
            document.getElementById('createAnnouncementModal').classList.remove('active');
            document.getElementById('createAnnouncementForm').reset();
            document.getElementById('titleCounter').textContent = '0';
            document.getElementById('contentCounter').textContent = '0';
            window.resetAnnouncementBackgroundControl?.();
            editingAnnouncementId = null;
            editingAnnouncementPinned = 0;
            setComposerMode('create');
            loadAnnouncements();
        } else {
            showNotification(
                response.data?.message || (isEditing ? 'Failed to update announcement' : 'Failed to post announcement'),
                'error'
            );
        }
    } catch (error) {
        console.error('Error posting announcement:', error);
        const errorMessage = error.response?.data?.message || error.message || 'An error occurred while posting the announcement';
        showNotification(errorMessage, 'error');
    } finally {
        submitBtn.disabled = false;
        setComposerMode(isEditing ? 'edit' : 'create');
    }
}

// ===========================
// Load Roles for Dropdown
// ===========================

async function loadRoles() {
    try {
        const response = await axios.get(`${window.API_BASE}/roles/roles.php?operation=getAllRoles`);
        const roles = response.data;

        const select = document.getElementById('targetRole');
        if (select && roles && roles.length > 0) {
            // Clear existing options except first one
            while (select.options.length > 1) {
                select.remove(1);
            }

            roles.forEach(role => {
                const option = document.createElement('option');
                option.value = role.role_id;
                option.textContent = role.role_name;
                select.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading roles:', error);
    }
}

// ===========================
// Delete Announcement
// ===========================

async function deleteAnnouncement(announcementId) {
    const announcement = announcementsIndex?.get(String(announcementId));
    if (!announcement || !canCurrentUserManageAnnouncement(announcement)) {
        showNotification('Not authorized to manage this announcement.', 'error');
        return;
    }

    const confirmed = await window.showConfirmationDialog({
        title: 'Delete announcement?',
        message: 'This action cannot be undone. The announcement will be permanently removed from the school feed.',
        confirmText: 'Delete announcement',
        cancelText: 'Keep announcement',
        icon: 'fa-trash-can'
    });
    if (!confirmed) return;
    try {
        const response = await axios.post(
            `${window.API_BASE}/announcements/announcements.php?operation=deleteAnnouncement`,
            { announcement_id: announcementId },
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (response.data.success) {
            showNotification('Announcement deleted.', 'success');
            loadAnnouncements();
        } else {
            showNotification(response.data.message || 'Failed to delete announcement', 'error');
        }
    } catch (error) {
        console.error('Error deleting announcement:', error);
        const apiMessage = error?.response?.data?.message;
        showNotification(apiMessage || 'An error occurred while deleting the announcement', 'error');
    }
}

// Make function globally accessible
window.deleteAnnouncement = deleteAnnouncement;

// ===========================
// Edit Announcement
// ===========================

function setComposerMode(mode) {
    const modalTitle = document.querySelector('#createAnnouncementModal .modal-title');
    const submitBtn = document.getElementById('submitAnnouncementBtn');

    if (modalTitle) {
        modalTitle.textContent = mode === 'edit' ? 'Edit Announcement' : 'Create Announcement';
    }

    if (submitBtn) {
        submitBtn.innerHTML = mode === 'edit'
            ? '<i class="fas fa-save"></i> Update'
            : '<i class="fas fa-paper-plane"></i> Post';
    }
}

function toDatetimeLocalValue(dateValue) {
    if (!dateValue) return '';

    // Handle common SQL datetime format: YYYY-MM-DD HH:MM:SS
    const raw = String(dateValue).trim();
    const sqlLike = raw.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/);
    const normalized = sqlLike ? raw.replace(' ', 'T') : raw;

    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function editAnnouncement(announcementId) {
    const announcement = announcementsIndex.get(String(announcementId));
    if (!announcement) {
        showNotification('This announcement is no longer available. It may have been removed.', 'announcement');
        return;
    }

    if (!canCurrentUserManageAnnouncement(announcement)) {
        showNotification('Not authorized to manage this announcement.', 'error');
        return;
    }

    const modal = document.getElementById('createAnnouncementModal');
    const form = document.getElementById('createAnnouncementForm');
    if (!modal || !form) {
        showNotification('Composer modal is not available on this page.', 'error');
        return;
    }

    editingAnnouncementId = announcementId;
    editingAnnouncementPinned = announcement.is_pinned === true
        || announcement.is_pinned === 1
        || String(announcement.is_pinned) === '1'
        ? 1
        : 0;
    modal.classList.add('active');
    form.reset();

    setComposerMode('edit');

    const titleInput = document.getElementById('announcementTitle');
    const bodyTextarea = document.getElementById('announcementBody');
    const targetRole = document.getElementById('targetRole');
    const expiresAt = document.getElementById('expiresAt');

    if (titleInput) titleInput.value = announcement.title || '';
    if (bodyTextarea) bodyTextarea.value = announcement.body || '';
    if (targetRole) targetRole.value = announcement.target_role_id ? String(announcement.target_role_id) : '';
    if (expiresAt) expiresAt.value = toDatetimeLocalValue(announcement.expires_at);
    window.setAnnouncementBackgroundControl?.(
        announcement.message_background || window.getStoredAnnouncementBackground?.(announcement.announcement_id)
    );

    const titleCounter = document.getElementById('titleCounter');
    const contentCounter = document.getElementById('contentCounter');
    if (titleCounter) titleCounter.textContent = String((announcement.title || '').length);
    if (contentCounter) contentCounter.textContent = String((announcement.body || '').length);

    // If any advanced fields are set, show the advanced panel.
    const advancedOptions = document.getElementById('advancedOptions');
    if (advancedOptions && announcement.expires_at) {
        advancedOptions.style.display = 'block';
        document.getElementById('advancedToggle')?.classList.add('active');
    }
}

// Make function globally accessible
window.editAnnouncement = editAnnouncement;

// ===========================
// Utility Functions
// ===========================

function formatTimeAgoFromSeconds(seconds, fallbackDate) {
    const elapsed = Number(seconds);
    if (!Number.isFinite(elapsed) || elapsed < 60) return 'Just now';

    const minutes = Math.floor(elapsed / 60);
    if (minutes < 60) return `${minutes} min ago`;

    const hours = Math.floor(elapsed / 3600);
    if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;

    const days = Math.floor(elapsed / 86400);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;

    const weeks = Math.floor(days / 7);
    if (days < 30) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;

    const months = Math.floor(days / 30);
    if (days < 365) return `${months} month${months === 1 ? '' : 's'} ago`;

    const years = Math.floor(days / 365);
    return `${years} yr${years === 1 ? '' : 's'} ago`;
}

function formatTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);

    return formatTimeAgoFromSeconds(Math.max(0, diffSecs), date);
}

function formatDate(date) {
    return date.toLocaleString('en-US', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showNotification(message, type = 'info') {
    const ensureGovToastStyles = () => {
        if (document.getElementById('govToastStyles')) return;
        const style = document.createElement('style');
        style.id = 'govToastStyles';
        style.textContent = `
            .gov-toast{position:fixed;bottom:80px;right:20px;background:var(--gray-50);border:0;box-shadow:var(--shadow-sm);border-radius:6px;padding:.9rem 1rem;z-index:10001;min-width:320px;max-width:420px;opacity:0;transform:translateX(30px);transition:opacity .25s ease,transform .25s ease}
            .gov-toast.show{opacity:1;transform:translateX(0)}
            .gov-toast__content{display:flex;align-items:flex-start;gap:.75rem}
            .gov-toast__icon{font-size:1.1rem;margin-top:.05rem}
            .gov-toast__text{display:flex;flex-direction:column;gap:.15rem;min-width:0;flex:1}
            .gov-toast__title{font-size:.78rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--gray-700);line-height:1.15}
            .gov-toast__message{font-size:.92rem;color:var(--gray-900);line-height:1.35;word-break:break-word}
            .gov-toast__dismiss{background:transparent;border:none;color:var(--gray-500);font-size:1rem;cursor:pointer;line-height:1}
            .gov-toast--success{border:0}
            .gov-toast--success .gov-toast__icon{color:var(--gray-500)}
            .gov-toast--error{border:0}
            .gov-toast--error .gov-toast__icon{color:var(--color-danger)}
            .gov-toast--info{border:0}
            .gov-toast--info .gov-toast__icon{color:var(--gray-500)}
            .gov-toast--announcement{border:0;box-shadow:var(--shadow-sm)}
            .gov-toast--announcement .gov-toast__icon{color:var(--gray-500)}
        `;
        document.head.appendChild(style);
    };

    ensureGovToastStyles();
    document.querySelectorAll('.gov-toast').forEach((el) => el.remove());

    const normalizedType = type === 'success' || type === 'error' || type === 'info' || type === 'announcement' ? type : 'info';
    const title = normalizedType === 'success' ? 'Completed' : normalizedType === 'error' ? 'Action Required' : normalizedType === 'announcement' ? 'Announcement status' : 'Notice';
    const iconClass = normalizedType === 'success' ? 'fa-circle-check' : normalizedType === 'error' ? 'fa-triangle-exclamation' : normalizedType === 'announcement' ? 'fa-bullhorn' : 'fa-circle-info';

    const toast = document.createElement('div');
    toast.className = `gov-toast gov-toast--${normalizedType}`;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    toast.setAttribute('aria-atomic', 'true');
    toast.innerHTML = `
        <div class="gov-toast__content">
            <i class="fas ${iconClass} gov-toast__icon"></i>
            <div class="gov-toast__text">
                <div class="gov-toast__title">${title}</div>
                <div class="gov-toast__message">${message}</div>
            </div>
            <button type="button" class="gov-toast__dismiss" aria-label="Dismiss">&times;</button>
        </div>
    `;

    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    const timeoutMs = normalizedType === 'error' ? 9000 : 4500;
    let timer = setTimeout(dismiss, timeoutMs);

    function dismiss() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
    }

    const dismissBtn = toast.querySelector('button[aria-label="Dismiss"]');
    if (dismissBtn) dismissBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); dismiss(); });
    toast.addEventListener('mouseenter', () => { if (timer) { clearTimeout(timer); timer = null; } });
    toast.addEventListener('mouseleave', () => { if (!timer) timer = setTimeout(dismiss, timeoutMs); });
}

// ===========================
// Dashboard Overview Charts
// ===========================

function initializeDashboardOverviewCharts() {
    // This function is called from dashboard-charts.js
    if (typeof window.initializeDashboardCharts === 'function') {
        window.initializeDashboardCharts();
    }
}
