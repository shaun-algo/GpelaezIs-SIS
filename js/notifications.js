// Notifications page controller

(function () {
    const apiUrl = () => `${window.API_BASE}/notifications/notifications.php`;

    const els = {
        tbody: () => document.getElementById('dataTableBody'),
        markAll: () => document.getElementById('markAllReadBtn')
    };

    let all = [];
    let filtered = [];
    let showPreviousNotifications = false;
    const NEW_WINDOW_MS = 8 * 60 * 60 * 1000;
    const INITIAL_EARLIER_COUNT = 4;

    function isDesktopViewport() {
        return typeof window.matchMedia === 'function'
            && window.matchMedia('(min-width: 48.0625rem)').matches;
    }

    async function returnToDashboardOnDesktop() {
        if (!isDesktopViewport()) return false;

        let roleName = window.CURRENT_ROLE_NAME || '';
        let roleId = window.CURRENT_ROLE_ID || 0;

        // dashboard.js normally populates these values, but fetch the session
        // here as a safe fallback because this page is intentionally mobile-only.
        if (!roleName && !roleId) {
            try {
                const response = await axios.get(`${window.API_BASE}/auth/me.php`);
                if (!response.data?.success) return false;
                const user = response.data.data || {};
                roleName = user.role_name || '';
                roleId = user.role_id || 0;
            } catch (_) {
                return false;
            }
        }

        if (typeof getDashboardHrefForRole !== 'function') return false;

        const target = getDashboardHrefForRole(roleName, roleId);
        if (!target) return false;

        window.location.replace(target);
        return true;
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function parseMysqlDateTime(value) {
        if (!value || typeof value !== 'string') return null;
        const iso = value.replace(' ', 'T');
        const d = new Date(iso);
        return isNaN(d.getTime()) ? null : d;
    }

    function formatWhen(createdAt) {
        const d = parseMysqlDateTime(createdAt);
        if (!d) return '';

        const diffMs = Date.now() - d.getTime();
        if (!Number.isFinite(diffMs) || diffMs < 0) return '';

        const seconds = Math.floor(diffMs / 1000);
        if (seconds < 60) return 'now';

        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;

        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;

        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}d ago`;

        const weeks = Math.floor(days / 7);
        if (weeks < 5) return `${weeks}w ago`;

        const months = Math.floor(days / 30);
        if (months < 12) return `${months}mo ago`;

        return `${Math.floor(days / 365)}y ago`;
    }

    function getNotificationHref(n) {
        // Use the dashboard dropdown's canonical routing logic first so both
        // surfaces handle announcements, risks, and legacy notification rows
        // in exactly the same way.
        if (typeof window.getNotificationLink === 'function') {
            return window.getNotificationLink(n);
        }

        const ref = String(n?.reference_table || '').toLowerCase();
        const app = window.APP_BASE || '';
        if (ref === 'enrollments') return `${app}/pages/enrollments.html`;
        if (ref === 'risk_assessment' || ref === 'risk_assessments' || ref === 'risk_period_summary') return `${app}/pages/risk-assessment.html`;
        if (ref === 'interventions') return `${app}/pages/risk-assessment.html`;
        return null;
    }

    function getNotificationAgeMs(createdAt) {
        const d = parseMysqlDateTime(createdAt);
        if (!d) return Number.POSITIVE_INFINITY;

        const diffMs = Date.now() - d.getTime();
        return Number.isFinite(diffMs) && diffMs >= 0 ? diffMs : Number.POSITIVE_INFINITY;
    }

    function renderNotificationCard(n) {
        const id = Number(n.notification_id || 0);
        const isRead = Number(n.is_read || 0) === 1;
        const presentation = typeof getNotificationPresentation === 'function'
            ? getNotificationPresentation(n)
            : { title: n.title || 'Notification', message: n.message || '' };
        const title = escapeHtml(presentation.title || 'Notification');
        const message = escapeHtml(presentation.message || '');
        const messageMarkup = message
            ? `<p class="notifications-mobile-item-message">${message}</p>`
            : '';
        const when = escapeHtml(formatWhen(n.created_at));
        const source = typeof getNotificationSource === 'function'
            ? getNotificationSource(n)
            : 'system';
        const sourceIconMarkup = typeof getNotificationSourceIconMarkup === 'function'
            ? getNotificationSourceIconMarkup(source, n)
            : '<span class="notification-source-icon notification-source-icon--system" aria-hidden="true"><i class="fas fa-bell"></i></span>';

        const actionBtn = [
            isRead ? '' : `<button class="notifications-mobile-action notifications-mobile-action--read" data-action="markRead" data-id="${id}" aria-label="Mark as read" title="Mark as read"><i class="fas fa-check" aria-hidden="true"></i></button>`,
            `<button class="notifications-mobile-action notifications-mobile-action--remove" data-action="remove" data-id="${id}" aria-label="Remove notification" title="Remove notification"><i class="fas fa-xmark" aria-hidden="true"></i></button>`
        ].join('');

        return `
            <article class="notifications-mobile-item${isRead ? '' : ' is-unread'}" data-notification-id="${id}" tabindex="0" role="link" aria-label="${title}">
                <div class="notifications-mobile-item-main">
                    ${sourceIconMarkup}
                    <div class="notifications-mobile-item-copy">
                        <div class="notifications-mobile-item-title-row">
                            <strong class="notifications-mobile-item-title">${title}</strong>
                        </div>
                        ${messageMarkup}
                        <time class="notifications-mobile-item-time">${when || 'Just now'}</time>
                    </div>
                </div>
                <div class="notifications-mobile-item-actions">${actionBtn}</div>
            </article>
        `;
    }

    function renderNotificationSection(label, items, sectionClass = '') {
        if (!items.length) return '';

        return `
            <section class="notifications-mobile-section ${sectionClass}" aria-labelledby="notificationsSection${label}">
                <h2 id="notificationsSection${label}" class="notifications-mobile-section-title">${label}</h2>
                <div class="notifications-mobile-section-items">
                    ${items.map(renderNotificationCard).join('')}
                </div>
            </section>
        `;
    }

    function render() {
        const tbody = els.tbody();
        if (!tbody) return;

        if (!filtered.length) {
            tbody.classList.remove('is-expanded');
            tbody.innerHTML = `
                <div class="notifications-mobile-state notifications-mobile-state--empty" role="status">
                    <video class="mp4-surface-blend notifications-mobile-state__video" src="${escapeHtml(`${window.APP_BASE || ''}/assets/icons/notif_done.mp4`)}" autoplay loop muted playsinline preload="metadata" aria-hidden="true"></video>
                    <strong>You're all caught up</strong>
                    <span>No more notifications</span>
                </div>
            `;
            return;
        }

        const newNotifications = filtered.filter((n) => getNotificationAgeMs(n.created_at) < NEW_WINDOW_MS);
        const earlierNotifications = filtered.filter((n) => getNotificationAgeMs(n.created_at) >= NEW_WINDOW_MS);
        const visibleEarlier = showPreviousNotifications
            ? earlierNotifications
            : earlierNotifications.slice(0, INITIAL_EARLIER_COUNT);
        const visibleNotifications = [...newNotifications, ...visibleEarlier];
        const hasPrevious = earlierNotifications.length > visibleEarlier.length;
        const endOfListMarkup = showPreviousNotifications || !hasPrevious
            ? `
                <div class="notifications-mobile-end-state" role="status">
                    <video class="mp4-surface-blend notifications-mobile-end-state__video" src="${escapeHtml(`${window.APP_BASE || ''}/assets/icons/notif_done.mp4`)}" autoplay loop muted playsinline preload="metadata" aria-hidden="true"></video>
                    <strong>You're all caught up</strong>
                    <span>No more notifications</span>
                </div>
            `
            : '';

        tbody.classList.toggle('is-expanded', showPreviousNotifications && earlierNotifications.length > INITIAL_EARLIER_COUNT);
        tbody.innerHTML = [
            renderNotificationSection('New', newNotifications, 'notifications-mobile-section--new'),
            renderNotificationSection('Earlier', visibleEarlier, 'notifications-mobile-section--earlier'),
            hasPrevious
                ? `<button class="notifications-mobile-see-previous" type="button" data-action="showPrevious">See previous notifications</button>`
                : '',
            endOfListMarkup
        ].join('');

        if (typeof populateNotificationSourceAvatar === 'function') {
            tbody.querySelectorAll('.notifications-mobile-item').forEach((row, index) => {
                populateNotificationSourceAvatar(visibleNotifications[index], row);
            });
        }
    }

    async function openNotification(n) {
        const id = Number(n?.notification_id || 0);
        if (!id) return;

        try {
            await markRead(id);
        } catch (_) {
            // Match the dashboard dropdown: navigation should still continue
            // if marking the notification read fails.
        }

        const referenceTable = String(n?.reference_table || '').toLowerCase();
        const referenceId = Number(n?.reference_id || 0);
        const notificationType = String(n?.notification_type || '').toLowerCase();

        if (referenceTable === 'account_deactivation_requests') {
            const isAdmin = typeof isCurrentUserAdmin === 'function' && isCurrentUserAdmin();
            window.location.href = isAdmin
                ? (window.APP_BASE || '') + '/pages/account-deactivation-requests.html'
                : (window.APP_BASE || '') + '/pages/settings.html#account-security';
            return;
        }

        if (typeof isPostReviewNotification === 'function'
            && isPostReviewNotification(n)
            && typeof isCurrentUserAdmin === 'function'
            && isCurrentUserAdmin()) {
            window.location.href = (window.APP_BASE || '') + '/pages/reported-posts.html';
            return;
        }

        if (referenceTable === 'announcements') {
            if (Number.isFinite(referenceId) && referenceId > 0) {
                window.requestFocusAnnouncement?.(referenceId);
                const focusedNow = window.focusAnnouncementInFeedNow?.(referenceId);
                if (!focusedNow && typeof window.getDashboardHrefForRole === 'function') {
                    const target = window.getDashboardHrefForRole(
                        window.CURRENT_ROLE_NAME,
                        window.CURRENT_ROLE_ID
                    );
                    if (target) window.location.href = target;
                }
            }
            return;
        }

        if (
            referenceTable === 'risk_assessment'
            || referenceTable === 'risk_assessments'
            || referenceTable === 'interventions'
            || notificationType === 'risk flag'
        ) {
            const roleName = String(window.CURRENT_ROLE_NAME || '').toLowerCase();
            const isLearner = typeof window.isCurrentUserLearner === 'function'
                ? window.isCurrentUserLearner()
                : Number(window.CURRENT_ROLE_ID || 0) === 10 || roleName.includes('learner') || roleName.includes('student');
            if (isLearner) {
                const target = typeof window.getLearnerAcademicStatusHref === 'function'
                    ? window.getLearnerAcademicStatusHref(n)
                    : `${window.APP_BASE || ''}/pages/academic-status.html${referenceId > 0 ? `?risk_assessment_id=${encodeURIComponent(String(referenceId))}` : ''}`;
                window.location.href = target;
                return;
            }
            if (Number.isFinite(referenceId) && referenceId > 0) {
                window.requestFocusRiskAssessment?.(referenceId);
                window.requestFocusRiskAssessmentContext?.(n);
            }
            window.location.href = `${window.APP_BASE || ''}/pages/risk-assessment.html`;
            return;
        }

        const href = getNotificationHref(n);
        if (href && href !== '#') window.location.href = href;
    }

    function refreshView() {
        filtered = [...all];
        render();
    }

    async function load() {
        const tbody = els.tbody();
        showPreviousNotifications = false;
        if (tbody) {
            tbody.innerHTML = `
                <div class="notifications-mobile-state notifications-mobile-state--loading" role="status">
                    <i class="fas fa-spinner fa-spin" aria-hidden="true"></i>
                    <span>Loading notifications</span>
                </div>
            `;
        }

        const res = await axios.get(apiUrl(), {
            params: { operation: 'getNotifications', limit: 50, _: Date.now() }
        });
        if (!res.data?.success) {
            throw new Error(res.data?.message || 'Failed to load notifications');
        }

        all = Array.isArray(res.data?.data?.notifications) ? res.data.data.notifications : [];
        refreshView();

        try {
            if (typeof window.refreshNotifications === 'function') {
                await window.refreshNotifications({ render: false });
            }
        } catch {
            // ignore
        }
    }

    async function markRead(id) {
        await axios.post(`${apiUrl()}?operation=markRead`, { notification_id: Number(id) });
        all = all.map(n => (Number(n.notification_id) === Number(id) ? { ...n, is_read: 1 } : n));
        refreshView();

        try {
            if (typeof window.refreshNotifications === 'function') {
                await window.refreshNotifications({ render: false });
            }
        } catch {
            // ignore
        }
    }

    async function markAllRead() {
        await axios.post(`${apiUrl()}?operation=markAllRead`, {});
        all = all.map(n => ({ ...n, is_read: 1 }));
        refreshView();

        try {
            if (typeof window.refreshNotifications === 'function') {
                await window.refreshNotifications({ render: false });
            }
        } catch {
            // ignore
        }
    }

    async function removeNotification(id) {
        await axios.post(`${apiUrl()}?operation=removeNotification`, { notification_id: Number(id) });
        all = all.filter(n => Number(n.notification_id) !== Number(id));
        refreshView();

        try {
            if (typeof window.refreshNotifications === 'function') {
                await window.refreshNotifications({ render: false });
            }
        } catch {
            // ignore
        }
    }

    function showNotificationsDialog({ icon, title, text, confirmLabel = 'Done', cancelLabel = '' }) {
        return new Promise((resolve) => {
            document.querySelector('.notifications-action-dialog')?.remove();

            const iconClasses = {
                question: 'fa-circle-question',
                success: 'fa-circle-check',
                error: 'fa-circle-xmark'
            };
            const iconClass = iconClasses[icon] || iconClasses.question;
            const hasCancel = Boolean(cancelLabel);
            const overlay = document.createElement('div');
            overlay.className = `notifications-action-dialog notifications-action-dialog--${icon || 'question'}`;
            overlay.setAttribute('role', 'alertdialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-labelledby', 'notificationsDialogTitle');
            overlay.innerHTML = `
                <div class="notifications-action-dialog__panel" role="document">
                    <div class="notifications-action-dialog__icon" aria-hidden="true">
                        <i class="fas ${iconClass}"></i>
                    </div>
                    <h2 id="notificationsDialogTitle">${escapeHtml(title)}</h2>
                    <p>${escapeHtml(text)}</p>
                    <div class="notifications-action-dialog__actions${hasCancel ? ' has-cancel' : ''}">
                        ${hasCancel ? `<button type="button" class="notifications-action-dialog__button notifications-action-dialog__button--cancel" data-dialog-cancel>${escapeHtml(cancelLabel)}</button>` : ''}
                        <button type="button" class="notifications-action-dialog__button notifications-action-dialog__button--confirm" data-dialog-confirm>${escapeHtml(confirmLabel)}</button>
                    </div>
                </div>
            `;

            let closed = false;
            const close = (confirmed) => {
                if (closed) return;
                closed = true;
                document.body.classList.remove('notifications-dialog-open');
                overlay.classList.remove('is-open');
                window.setTimeout(() => overlay.remove(), 180);
                resolve(confirmed);
            };

            overlay.querySelector('[data-dialog-confirm]')?.addEventListener('click', () => close(true));
            overlay.querySelector('[data-dialog-cancel]')?.addEventListener('click', () => close(false));
            overlay.addEventListener('click', (event) => {
                if (event.target === overlay && hasCancel) close(false);
            });
            overlay.addEventListener('keydown', (event) => {
                if (event.key === 'Escape' && hasCancel) {
                    event.preventDefault();
                    close(false);
                }
            });

            document.body.appendChild(overlay);
            document.body.classList.add('notifications-dialog-open');
            requestAnimationFrame(() => {
                overlay.classList.add('is-open');
                (overlay.querySelector('[data-dialog-cancel]') || overlay.querySelector('[data-dialog-confirm]'))?.focus();
            });
        });
    }

    function confirmMarkAllRead() {
        return showNotificationsDialog({
            icon: 'question',
            title: 'Mark all as read?',
            text: 'All notification unread indicators will be cleared.',
            confirmLabel: 'Mark as read',
            cancelLabel: 'Cancel'
        });
    }

    function showActionAlert(icon, title, text) {
        return showNotificationsDialog({ icon, title, text });
    }

    function wire() {
        els.markAll()?.addEventListener('click', async () => {
            if (!await confirmMarkAllRead()) return;

            try {
                await markAllRead();
                await showActionAlert(
                    'success',
                    'Notifications updated',
                    'All notifications are now marked as read.'
                );
            } catch (err) {
                console.error(err);
                await showActionAlert(
                    'error',
                    'Unable to update notifications',
                    err?.message || 'Failed to mark all as read.'
                );
            }
        });

        els.tbody()?.addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-action]');
            if (btn) {
                if (btn.dataset.action === 'showPrevious') {
                    showPreviousNotifications = true;
                    render();
                    return;
                }

                if (btn.dataset.action === 'markRead') {
                    try {
                        await markRead(btn.dataset.id);
                        await showActionAlert('success', 'Notification updated', 'Marked as read.');
                    } catch (err) {
                        console.error(err);
                        await showActionAlert(
                            'error',
                            'Unable to update notification',
                            err?.message || 'Failed to mark as read.'
                        );
                    }
                }
                if (btn.dataset.action === 'remove') {
                    try {
                        await removeNotification(btn.dataset.id);
                        await showActionAlert('success', 'Notification removed', 'The notification was removed.');
                    } catch (err) {
                        console.error(err);
                        await showActionAlert(
                            'error',
                            'Unable to remove notification',
                            err?.message || 'Failed to remove notification.'
                        );
                    }
                }
                return;
            }

            if (e.target.closest('a[data-notification-link="1"]')) return;

            const card = e.target.closest('.notifications-mobile-item[data-notification-id]');
            if (!card) return;
            const notification = all.find((item) => Number(item.notification_id) === Number(card.dataset.notificationId));
            if (notification) await openNotification(notification);
        });

        els.tbody()?.addEventListener('keydown', async (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            if (e.target.closest('button, a')) return;

            const card = e.target.closest('.notifications-mobile-item[data-notification-id]');
            if (!card) return;
            e.preventDefault();
            const notification = all.find((item) => Number(item.notification_id) === Number(card.dataset.notificationId));
            if (notification) await openNotification(notification);
        });

        // Use the same source-aware navigation as the desktop notification
        // dropdown when a mobile notification title is selected.
        document.addEventListener('click', async (e) => {
            const a = e.target.closest('a[data-notification-link="1"]');
            if (!a) return;
            const id = a.dataset.notificationId;
            if (!id) return;

            e.preventDefault();
            const notification = all.find((item) => Number(item.notification_id) === Number(id));
            if (notification) await openNotification(notification);
        });
    }

    document.addEventListener('DOMContentLoaded', async () => {
        if (await returnToDashboardOnDesktop()) return;

        wire();
        try {
            await load();
        } catch (err) {
            console.error(err);
            const tbody = els.tbody();
            if (tbody) {
                const msg = err?.response?.data?.message || err?.message || 'Failed to load notifications.';
                tbody.innerHTML = `
                    <div class="notifications-mobile-state notifications-mobile-state--error" role="alert">
                        <i class="fas fa-circle-exclamation" aria-hidden="true"></i>
                        <strong>Unable to load notifications</strong>
                        <span>${escapeHtml(msg)}</span>
                    </div>
                `;
            }
        }
    });

    if (typeof window.matchMedia === 'function') {
        const viewport = window.matchMedia('(min-width: 48.0625rem)');
        viewport.addEventListener?.('change', (event) => {
            if (event.matches) void returnToDashboardOnDesktop();
        });
    }
})();
