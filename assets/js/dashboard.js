// ===========================
// Dashboard Main JavaScript
// ===========================

// Authenticated pages do not share a PHP footer, so load the dependency-free
// network indicator from this common shell once per document.
(function ensureNetworkStatusModule() {
    if (window.__networkStatusController || document.querySelector('script[data-network-status]')) return;

    const dashboardScript = document.currentScript?.src || '';
    const script = document.createElement('script');
    script.dataset.networkStatus = 'true';
    script.defer = true;
    const networkUrl = dashboardScript
        ? new URL('network-status.js', dashboardScript)
        : new URL(`${window.APP_BASE || ''}/assets/js/network-status.js`, window.location.href);
    networkUrl.searchParams.set('v', '20261009-network-status-v1');
    script.src = networkUrl.href;
    document.head.appendChild(script);
})();

// Authenticated pages are often opened directly at /pages/*.html. Add the
// shared favicon there as well as on the root login page so those loads do not
// generate a noisy /favicon.ico 404.
(function ensureDepEdFavicon() {
    if (document.querySelector('link[rel~="icon"]')) return;

    const scriptSource = document.currentScript?.src || '';
    const fallback = '/deped_capstone2/assets/img/logo/logo.png';
    const href = scriptSource
        ? new URL('../../assets/img/logo/logo.png', scriptSource).href
        : fallback;
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = href;
    document.head.appendChild(link);
})();

// API base (same-origin by default; avoids hard-coded localhost issues)
(function initAppAndApiBase() {
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

    if (!window.APP_BASE) {
        window.APP_BASE = appPrefix;
    }

    if (!window.API_BASE) {
        // Same-origin API base. This supports deployment at the domain root
        // or under any folder, e.g. /deped_capstone2 or /gsis.
        window.API_BASE = `${appPrefix}/api`;
    }

    // If the page is opened via file://, API calls will fail.
    if (window.location.protocol === 'file:') {
        let msg = status ? `Error loading dashboard data (HTTP ${status})` : 'Error loading dashboard data';
        if (status === 404 || status === 405) {
            msg += ' — open via http://localhost/deped_capstone2/ (Apache/PHP), not Live Server.';
        }
    }
})();

// Default to compact form density to reduce scrolling on heavy forms.
(function initDensity() {
    const root = document.documentElement;
    if (root && !root.dataset.density) {
        root.dataset.density = 'compact';
    }
})();

// Subtle click-spark effect for empty-space clicks
(function initClickSparks() {
    if (window.__clickSparksInitialized) return;
    window.__clickSparksInitialized = true;

    try {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return;
        }
    } catch (_) {
        // ignore
    }

    const ensureLayer = () => {
        let layer = document.getElementById('clickSparkLayer');
        if (layer) return layer;
        layer = document.createElement('div');
        layer.id = 'clickSparkLayer';
        document.body.appendChild(layer);
        return layer;
    };

    const isInteractive = (el) => {
        if (!el) return false;
        if (el.closest('a, button, input, select, textarea, label')) return true;
        if (el.closest('[role="button"], [role="link"], [contenteditable="true"]')) return true;
        if (el.closest('.btn, .action-btn, .choices, .choices__inner')) return true;
        return false;
    };

    const isEmptySpaceClick = (target) => {
        // “Empty” means not an interactive/control element.
        return !isInteractive(target);
    };

    const createSpark = (x, y) => {
        const layer = ensureLayer();
        const wrap = document.createElement('div');
        wrap.className = 'click-spark';
        wrap.style.setProperty('--x', `${x}px`);
        wrap.style.setProperty('--y', `${y}px`);

        // Subtle intensity: 6 sparks
        const count = 6;
        for (let i = 0; i < count; i++) {
            const spark = document.createElement('span');
            spark.className = 'spark';
            const angle = (Math.random() * 120 - 60) + (i * (360 / count));
            const dist = 10 + Math.random() * 14;
            spark.style.setProperty('--rot', `${angle}deg`);
            spark.style.setProperty('--dist', `${dist}px`);
            spark.style.animationDelay = `${Math.random() * 45}ms`;
            wrap.appendChild(spark);
        }

        layer.appendChild(wrap);
        // Cleanup after animation
        setTimeout(() => {
            try { wrap.remove(); } catch (_) { /* ignore */ }
        }, 650);
    };

    document.addEventListener('click', (e) => {
        if (!e || e.defaultPrevented) return;
        if (!document.body) return;
        if (!isEmptySpaceClick(e.target)) return;
        // Don’t trigger on text selection
        try {
            const sel = window.getSelection && window.getSelection();
            if (sel && String(sel.toString() || '').trim()) return;
        } catch (_) {
            // ignore
        }
        createSpark(e.clientX, e.clientY);
    }, { passive: true });
})();

// Axios fallback: if CDN fails, provide a minimal wrapper using fetch.
(function ensureAxios() {
    if (window.axios) {
        try {
            // Keep PHP sessions working when API_BASE is absolute.
            window.axios.defaults.withCredentials = true;
            if (window.axios.interceptors?.response && !window.__session401InterceptorInstalled) {
                window.__session401InterceptorInstalled = true;
                window.axios.interceptors.response.use(
                    (response) => response,
                    (error) => {
                        if (error?.response?.status === 401) {
                            handleExpiredSession(error?.response?.data?.message || 'Session expired');
                        }
                        return Promise.reject(error);
                    }
                );
            }
        } catch (_) {
            // ignore
        }
        return;
    }

    const buildUrl = (url, config) => {
        const params = config?.params;
        if (!params || typeof params !== 'object') return url;
        const u = new URL(url, window.location.origin);
        Object.entries(params).forEach(([k, v]) => {
            if (v === undefined || v === null) return;
            u.searchParams.set(k, String(v));
        });
        return u.toString();
    };

    const parseResponse = async (res) => {
        const contentType = res.headers.get('content-type') || '';
        const isJson = contentType.includes('application/json');
        const data = isJson ? await res.json().catch(() => null) : await res.text().catch(() => null);
        const response = { status: res.status, data, headers: res.headers };
        if (!res.ok) {
            const err = new Error((data && data.message) ? data.message : `Request failed with status ${res.status}`);
            err.response = response;
            if (res.status === 401) {
                handleExpiredSession((data && data.message) ? data.message : 'Session expired');
            }
            throw err;
        }
        return response;
    };

    const request = async (method, url, data, config) => {
        const finalUrl = buildUrl(url, config);
        const headers = { ...(config?.headers || {}) };

        const isForm = (typeof FormData !== 'undefined') && (data instanceof FormData);
        const body = (method === 'GET' || method === 'HEAD') ? undefined : (isForm ? data : (data === undefined ? undefined : JSON.stringify(data)));
        if (!isForm && body !== undefined && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }

        const res = await fetch(finalUrl, {
            method,
            headers,
            body,
            credentials: 'include'
        });
        return parseResponse(res);
    };

    window.axios = {
        get: (url, config) => request('GET', url, undefined, config),
        post: (url, data, config) => request('POST', url, data, config),
        put: (url, data, config) => request('PUT', url, data, config),
        delete: (url, config) => request('DELETE', url, undefined, config),
        defaults: { withCredentials: true },
        create: () => window.axios
    };
})();

function initializeSessionBackGuard() {
    const pathname = String(window.location.pathname || '');
    const isLoginPage = pathname.endsWith('/index.html') || pathname === '/' || pathname.endsWith('/deped_capstone2/');

    if (isLoginPage) {
        return;
    }

    const historyStateKey = '__depedSessionHistory';
    const historyIndexStorageKey = 'depedSessionHistoryIndex';
    const navigationType = performance.getEntriesByType('navigation')[0]?.type || '';
    let verificationPromise = null;
    let verificationShield = null;
    let historyLogoutPromise = null;

    const readStoredHistoryIndex = () => {
        try {
            const raw = sessionStorage.getItem(historyIndexStorageKey);
            if (raw === null) return null;
            const value = Number(raw);
            return Number.isInteger(value) ? value : null;
        } catch (_) {
            return null;
        }
    };

    const writeStoredHistoryIndex = (index) => {
        try {
            sessionStorage.setItem(historyIndexStorageKey, String(index));
        } catch (_) {
            // History direction detection is best-effort when storage is blocked.
        }
    };

    const readCurrentEntryIndex = () => {
        const state = history.state;
        const value = state && typeof state === 'object'
            ? Number(state[historyStateKey]?.index)
            : NaN;
        return Number.isInteger(value) ? value : null;
    };

    const ensureHistoryEntryIndex = () => {
        const storedIndex = readStoredHistoryIndex();
        let entryIndex = readCurrentEntryIndex();

        if (entryIndex === null) {
            // A normal link creates a new entry after the current one. A
            // history traversal keeps the index already assigned to that
            // browser entry when this code has not seen it before.
            entryIndex = navigationType === 'navigate'
                ? (storedIndex === null ? 0 : storedIndex + 1)
                : (storedIndex === null ? 0 : storedIndex);
            try {
                const currentState = history.state && typeof history.state === 'object'
                    ? history.state
                    : {};
                history.replaceState(
                    { ...currentState, [historyStateKey]: { index: entryIndex } },
                    '',
                    window.location.href
                );
            } catch (_) {
                // Continue with the in-memory/sessionStorage fallback.
            }
        }

        const direction = navigationType === 'back_forward'
            && storedIndex !== null
            && entryIndex !== storedIndex
            ? (entryIndex > storedIndex ? 'forward' : 'back')
            : null;

        writeStoredHistoryIndex(entryIndex);
        return direction;
    };

    const initialHistoryDirection = ensureHistoryEntryIndex();

    const coverPageUntilVerified = () => {
        if (verificationShield || !document.body) return;
        verificationShield = document.createElement('div');
        verificationShield.id = 'sessionVerificationShield';
        verificationShield.setAttribute('role', 'status');
        verificationShield.setAttribute('aria-live', 'polite');
        verificationShield.textContent = 'Verifying your session…';
        verificationShield.style.cssText = [
            'position:fixed',
            'inset:0',
            'z-index:2147483647',
            'display:grid',
            'place-items:center',
            'background:#f8fafc',
            'color:#334155',
            'font:500 15px/1.4 system-ui,sans-serif'
        ].join(';');
        document.body.appendChild(verificationShield);
        document.documentElement.setAttribute('aria-busy', 'true');
    };

    const redirectToLogin = () => {
        markSessionEnded('expired');
        window.location.replace(getLoginTarget());
    };

    const endSessionForForwardHistory = () => {
        // A forward history entry is still a normal page navigation. Never
        // revoke a valid account session merely because the browser restored
        // an entry whose index differs from sessionStorage.
        return verifySession();
    };

    const verifySession = () => {
        coverPageUntilVerified();
        if (verificationPromise) return verificationPromise;

        verificationPromise = (async () => {
            try {
                const res = await fetch(`${window.API_BASE}/auth/me.php`, {
                    credentials: 'include',
                    cache: 'no-store',
                    headers: {
                        'Cache-Control': 'no-store',
                        'Pragma': 'no-cache'
                    }
                });
                // Only a confirmed authentication failure should send the
                // user to login. A 403 is an authorization result and a 5xx
                // may be a transient backend/database failure; neither means
                // that the browser session has expired.
                if (res.status === 401) {
                    redirectToLogin();
                    return false;
                }

                if (!res.ok) {
                    console.warn('Session verification temporarily unavailable', res.status);
                }

                verificationShield?.remove();
                verificationShield = null;
                document.documentElement.removeAttribute('aria-busy');
                return true;
            } catch (error) {
                // A failed verification request is not proof that the session
                // expired. Preserve the page on a transient network outage;
                // the next authenticated API request will still enforce 401.
                console.warn('Session verification request failed', error);
                verificationShield?.remove();
                verificationShield = null;
                document.documentElement.removeAttribute('aria-busy');
                return true;
            } finally {
                verificationPromise = null;
            }
        })();

        return verificationPromise;
    };

    const handleHistoryNavigation = () => {
        if (historyLogoutPromise) return historyLogoutPromise;

        const currentIndex = readCurrentEntryIndex();
        const previousIndex = readStoredHistoryIndex();
        let direction = null;

        if (currentIndex !== null && previousIndex !== null && currentIndex !== previousIndex) {
            direction = currentIndex > previousIndex ? 'forward' : 'back';
            writeStoredHistoryIndex(currentIndex);
        } else if (currentIndex !== null) {
            writeStoredHistoryIndex(currentIndex);
        }

        if (direction === 'forward') {
            return endSessionForForwardHistory();
        }

        // Back restores the previous page normally. Revalidate it, but do not
        // terminate a still-valid session.
        return verifySession();
    };

    // A browser history restore is a normal navigation. Keep the page covered
    // only while checking the session; do not log out merely because the user
    // clicked Back or the browser restored a cached document.
    window.addEventListener('pagehide', coverPageUntilVerified);
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) handleHistoryNavigation();
    });
    window.addEventListener('popstate', handleHistoryNavigation);

    // This also covers a document navigation reported as back_forward.
    // Back and forward remain valid; only a failed auth check redirects to login.
    verifySession();
}

function markSessionEnded(reason = 'expired') {
    try {
        sessionStorage.setItem('sessionEnded', '1');
        sessionStorage.setItem('sessionEndReason', reason);
    } catch (_) {
        // ignore storage errors
    }
}

function getLoginTarget() {
    return `${window.APP_BASE || ''}/index.html`;
}

function showExpiredSessionDisplay(message = 'Your session has expired.', { redirectDelay = 2200 } = {}) {
    const pathname = String(window.location.pathname || '');
    const isLoginPage = pathname.endsWith('/index.html') || pathname === '/' || pathname.endsWith('/deped_capstone2/');
    if (isLoginPage) return;

    markSessionEnded('expired');
    if (window.__sessionExpiredDisplayShown) return;
    window.__sessionExpiredDisplayShown = true;

    const overlay = document.createElement('div');
    overlay.className = 'session-expired-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
        <div class="session-expired-panel">
            <div class="session-expired-icon"><i class="fas fa-clock"></i></div>
            <h2>Session Expired</h2>
            <p>${escapeHtml(message || 'Your session has expired. Please sign in again.')}</p>
            <button type="button" class="btn btn-primary" id="sessionExpiredLoginBtn">
                <i class="fas fa-sign-in-alt"></i> Sign In Again
            </button>
        </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    const goLogin = () => window.location.replace(getLoginTarget());
    overlay.querySelector('#sessionExpiredLoginBtn')?.addEventListener('click', goLogin);
    window.setTimeout(goLogin, redirectDelay);
}

function handleExpiredSession(message = 'Session expired') {
    const normalized = String(message || '').toLowerCase();
    const displayMessage = normalized.includes('not authenticated')
        ? 'Your session has expired or is no longer active. Please sign in again.'
        : 'Your session has expired due to inactivity. Please sign in again.';
    showExpiredSessionDisplay(displayMessage);
}

// Wait for DOM to load
document.addEventListener('DOMContentLoaded', function () {
    // Remove breadcrumb paths globally (Home / ...)
    document.querySelectorAll('.breadcrumb').forEach((el) => {
        try {
            el.remove();
        } catch (_) {
            // ignore
        }
    });

    initializeDashboard();
    initializeSessionBackGuard();
    initNotifications();
    initAuditLogs();
    removeDeprecatedMasterfileLinks();
    ensureTopbarCenterNav();
    removeSettingsFromSidebar();
    ensureAuditLogsInProfileDropdown();
    ensureAccountDeactivationRequestsLink();
});

function initAuditLogs() {
    const btn = document.getElementById('auditLogsBtn');
    if (btn) {
        const wrapper = btn.closest('.audit-menu');
        if (wrapper) {
            wrapper.remove();
        } else {
            btn.remove();
        }
    }
}

function ensureTopbarNotificationToggle() {
    const btn = document.getElementById('notificationBtn');
    if (!btn) return null;

    let wrapper = btn.closest('.notification-menu');
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.className = 'notification-menu';
        const parent = btn.parentNode;
        if (!parent) return null;
        parent.insertBefore(wrapper, btn);
        wrapper.appendChild(btn);
    }

    let dropdown = wrapper.querySelector('.notification-dropdown');
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.className = 'notification-dropdown';
        dropdown.id = 'notificationDropdown';
        wrapper.appendChild(dropdown);
    }

    let badge = btn.querySelector('.notification-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'notification-badge';
        btn.appendChild(badge);
    }
    if (!badge.id) badge.id = 'notificationCount';

    btn.setAttribute('aria-haspopup', 'true');
    return { btn, wrapper, dropdown };
}

function initNotifications() {
    const topbarNotification = ensureTopbarNotificationToggle();
    const getNotificationPanel = () => document.getElementById('dashboardNotificationPanel');
    let gradeMonitoringSyncDone = false;
    let currentDeviceIsMain = false;
    let currentDeviceSecurityPromise = null;
    let pendingDeviceConfirmationKey = '';
    const pendingDeviceConfirmationSkipStorageKey = 'deped_pending_device_confirmation_skip';
    let pendingDeviceConfirmationSkippedKey = (() => {
        try {
            return String(window.sessionStorage?.getItem(pendingDeviceConfirmationSkipStorageKey) || '');
        } catch (_) {
            return '';
        }
    })();

    function rememberSkippedDeviceConfirmation(sessionKey) {
        pendingDeviceConfirmationSkippedKey = String(sessionKey || '');
        try {
            if (pendingDeviceConfirmationSkippedKey) {
                window.sessionStorage?.setItem(pendingDeviceConfirmationSkipStorageKey, pendingDeviceConfirmationSkippedKey);
            } else {
                window.sessionStorage?.removeItem(pendingDeviceConfirmationSkipStorageKey);
            }
        } catch (_) {
            // Session storage may be unavailable in privacy-restricted browsers.
        }
    }

    // Device-security warnings are account-wide records, but the warning toast
    // is intentionally delivered only to the server-designated main device.
    // Fail closed if the current-device check cannot be resolved.
    async function loadCurrentDeviceSecurity() {
        if (currentDeviceSecurityPromise) return currentDeviceSecurityPromise;
        currentDeviceSecurityPromise = axios.get(`${window.API_BASE}/auth/me.php`, {
            params: { _: Date.now() },
            headers: { 'Cache-Control': 'no-store' }
        }).then((response) => {
            currentDeviceIsMain = response.data?.data?.session_device?.is_main_device === true;
            window.CURRENT_DEVICE_IS_MAIN = currentDeviceIsMain;
            return currentDeviceIsMain;
        }).catch(() => {
            currentDeviceIsMain = false;
            window.CURRENT_DEVICE_IS_MAIN = false;
            return false;
        });
        return currentDeviceSecurityPromise;
    }

    function ensurePendingDeviceConfirmationModal() {
        let modal = document.getElementById('dashboardDeviceConfirmModal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.className = 'dashboard-device-confirm-modal';
        modal.id = 'dashboardDeviceConfirmModal';
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        modal.innerHTML = `
            <div class="dashboard-device-confirm-card" role="dialog" aria-modal="true" aria-labelledby="dashboardDeviceConfirmTitle">
                <img class="dashboard-device-confirm-alarm" src="${window.APP_BASE || ''}/assets/icons/alarm.png" alt="" aria-hidden="true">
                <h2 id="dashboardDeviceConfirmTitle">New device sign-in</h2>
                <p class="dashboard-device-confirm-text" data-device-confirm-text>A new device signed in to your account. Was this you?</p>
                <p class="dashboard-device-confirm-location" data-device-confirm-location hidden></p>
                <p class="dashboard-device-confirm-error" data-device-confirm-error role="alert" aria-live="polite"></p>
                <div class="dashboard-device-confirm-actions">
                    <button type="button" class="dashboard-device-confirm-no" data-device-confirm-no>No, block device</button>
                    <button type="button" class="dashboard-device-confirm-yes" data-device-confirm-yes>Yes, it was me</button>
                </div>
                <button type="button" class="dashboard-device-confirm-skip" data-device-confirm-skip>Skip for now</button>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('[data-device-confirm-yes]')?.addEventListener('click', () => resolvePendingDeviceConfirmation('yes'));
        modal.querySelector('[data-device-confirm-no]')?.addEventListener('click', () => resolvePendingDeviceConfirmation('no'));
        modal.querySelector('[data-device-confirm-skip]')?.addEventListener('click', skipPendingDeviceConfirmation);
        return modal;
    }

    function setPendingDeviceConfirmationVisible(visible) {
        const modal = document.getElementById('dashboardDeviceConfirmModal');
        if (!modal) return;
        modal.hidden = !visible;
        modal.setAttribute('aria-hidden', visible ? 'false' : 'true');
        document.body?.classList.toggle('device-confirm-open', visible);
    }

    function skipPendingDeviceConfirmation() {
        const modal = ensurePendingDeviceConfirmationModal();
        const sessionKey = String(modal.dataset.sessionKey || pendingDeviceConfirmationKey || '');
        if (!sessionKey) return;
        rememberSkippedDeviceConfirmation(sessionKey);
        setPendingDeviceConfirmationVisible(false);
    }

    async function resolvePendingDeviceConfirmation(decision) {
        const modal = ensurePendingDeviceConfirmationModal();
        const sessionKey = String(modal.dataset.sessionKey || pendingDeviceConfirmationKey || '');
        const yes = modal.querySelector('[data-device-confirm-yes]');
        const no = modal.querySelector('[data-device-confirm-no]');
        const errorNode = modal.querySelector('[data-device-confirm-error]');
        if (!sessionKey || !/^[a-f0-9]{64}$/i.test(sessionKey)) return;

        if (yes) yes.disabled = true;
        if (no) no.disabled = true;
        if (errorNode) errorNode.textContent = '';
        try {
            const response = await axios.post(`${window.API_BASE}/account_security/account_security.php?operation=resolveNewDevice`, {
                decision,
                session_key: sessionKey,
            });
            if (response.data?.success === false) throw new Error(response.data?.message || 'The device confirmation could not be saved.');
            pendingDeviceConfirmationKey = '';
            modal.dataset.sessionKey = '';
            rememberSkippedDeviceConfirmation('');
            setPendingDeviceConfirmationVisible(false);
            await refreshPendingDeviceConfirmation();
        } catch (error) {
            if (errorNode) errorNode.textContent = error?.response?.data?.message || error?.message || 'The device confirmation could not be saved.';
        } finally {
            if (yes) yes.disabled = false;
            if (no) no.disabled = false;
        }
    }

    async function refreshPendingDeviceConfirmation({ force = false, sessionDeviceId = 0, sessionKey = '' } = {}) {
        if (!currentDeviceIsMain) return;
        try {
            const response = await axios.get(`${window.API_BASE}/account_security/account_security.php`, {
                params: { operation: 'getAccountSecurity', _: Date.now() },
                headers: { 'Cache-Control': 'no-store' }
            });
            const sessions = response.data?.data?.sessions || [];
            const pendingRows = sessions.filter((row) => {
                const isMain = row?.is_main_device === true || Number(row?.is_main_device || 0) === 1;
                return !isMain && row?.new_device_pending === true && row?.is_active === true && /^[a-f0-9]{64}$/i.test(String(row?.session_key || ''));
            });
            const targetKey = String(sessionKey || '').toLowerCase();
            const targetId = Number(sessionDeviceId || 0);
            const pending = pendingRows.find((row) => targetKey && String(row?.session_key || '').toLowerCase() === targetKey)
                || pendingRows.find((row) => targetId > 0 && Number(row?.session_device_id || 0) === targetId)
                || pendingRows[0];
            const modal = ensurePendingDeviceConfirmationModal();
            if (!pending) {
                pendingDeviceConfirmationKey = '';
                modal.dataset.sessionKey = '';
                rememberSkippedDeviceConfirmation('');
                setPendingDeviceConfirmationVisible(false);
                return;
            }

            const pendingSessionKey = String(pending.session_key);
            if (!force && pendingDeviceConfirmationSkippedKey === pendingSessionKey) {
                pendingDeviceConfirmationKey = pendingSessionKey;
                modal.dataset.sessionKey = pendingSessionKey;
                setPendingDeviceConfirmationVisible(false);
                return;
            }
            if (!modal.hidden && pendingDeviceConfirmationKey === pendingSessionKey) return;
            rememberSkippedDeviceConfirmation('');
            pendingDeviceConfirmationKey = pendingSessionKey;
            modal.dataset.sessionKey = pendingSessionKey;
            const text = modal.querySelector('[data-device-confirm-text]');
            const location = modal.querySelector('[data-device-confirm-location]');
            const errorNode = modal.querySelector('[data-device-confirm-error]');
            if (text) text.textContent = `A new device signed in: ${pending.device_label || 'a new device'}. Was this you?`;
            if (location) {
                const locationLabel = String(pending.location_label || '').trim();
                location.textContent = locationLabel;
                location.hidden = !locationLabel;
            }
            if (errorNode) errorNode.textContent = '';
            setPendingDeviceConfirmationVisible(true);
            window.setTimeout(() => modal.querySelector('[data-device-confirm-yes]')?.focus(), 0);
        } catch (error) {
            console.warn('Pending device confirmation refresh failed:', error);
        }
    }

    async function openPendingDeviceConfirmation({ sessionDeviceId = 0, sessionKey = '' } = {}) {
        await loadCurrentDeviceSecurity();
        if (!currentDeviceIsMain) return false;
        rememberSkippedDeviceConfirmation('');
        await refreshPendingDeviceConfirmation({ force: true, sessionDeviceId, sessionKey });
        return document.getElementById('dashboardDeviceConfirmModal')?.hidden === false;
    }

    window.openPendingDeviceConfirmation = openPendingDeviceConfirmation;

    async function refreshDeviceConfirmation() {
        await loadCurrentDeviceSecurity();
        await refreshPendingDeviceConfirmation();
    }

    async function refreshNotifications({ render } = { render: false }) {
        const shouldSyncGradeMonitoring = Boolean(render || !gradeMonitoringSyncDone);
        try {
            await loadCurrentDeviceSecurity();
            await refreshPendingDeviceConfirmation();
            const res = await axios.get(`${window.API_BASE}/notifications/notifications.php`, {
                params: {
                    operation: 'getNotifications',
                    limit: 50,
                    sync_grade_monitoring: shouldSyncGradeMonitoring ? 1 : 0,
                    _: Date.now()
                }
            });
            if (!res.data?.success) throw new Error(res.data?.message || 'Failed to load notifications');
            if (shouldSyncGradeMonitoring) gradeMonitoringSyncDone = true;
            const unread = res.data.data?.unread_count ?? 0;
            const items = res.data.data?.notifications ?? [];
            updateBadge(document.getElementById('notificationCount'), unread);
            renderNotificationPanel(getNotificationPanel(), items, unread);
            if (render && topbarNotification) {
                renderDropdown(topbarNotification.dropdown, items, { unreadCount: unread });
            }
        } catch (err) {
            const status = err?.response?.status;
            if (status !== 401 && status !== 403) {
                console.warn('Notifications refresh failed:', err);
            }
            updateBadge(document.getElementById('notificationCount'), 0);
            renderNotificationPanel(getNotificationPanel(), [], 0, { error: true });
            if (render && topbarNotification) {
                topbarNotification.dropdown.innerHTML = `
                    <div class="notification-dropdown-header">
                        <span class="title">Notifications</span>
                    </div>
                    <div class="notification-item">
                        <p class="notification-title">Unable to load notifications</p>
                        <p class="notification-message">Please try again later.</p>
                    </div>
                `;
            }
        }
    }

    if (topbarNotification && !topbarNotification.btn.dataset.notificationToggleBound) {
        const { btn, wrapper, dropdown } = topbarNotification;
        const close = () => {
            dropdown.classList.remove('show');
            btn.classList.remove('is-open');
            btn.setAttribute('aria-expanded', 'false');
        };
        const open = () => {
            dropdown.classList.add('show');
            btn.classList.add('is-open');
            btn.setAttribute('aria-expanded', 'true');
            void refreshNotifications({ render: true });
        };

        btn.setAttribute('aria-expanded', 'false');
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            btn.classList.remove('is-toggling');
            void btn.offsetWidth;
            btn.classList.add('is-toggling');
            if (dropdown.classList.contains('show')) close();
            else open();
        });
        btn.addEventListener('animationend', (event) => {
            if (event.animationName === 'notificationBellBounce') {
                btn.classList.remove('is-toggling');
            }
        });
        document.addEventListener('click', (event) => {
            if (!wrapper.contains(event.target)) close();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') close();
        });
        btn.dataset.notificationToggleBound = 'true';
    }

    // Expose this for the dashboard panel and mark-all-as-read action.
    window.refreshNotifications = refreshNotifications;

    // Device confirmation belongs to the authenticated shell, not to the
    // notification widget. Some pages (including Settings) do not render a
    // notification button, but the main device must still receive the modal.
    ensurePendingDeviceConfirmationModal();
    const shouldRefreshNotifications = Boolean(document.querySelector('.announcement-dashboard') || topbarNotification);
    if (shouldRefreshNotifications) {
        refreshNotifications({ render: false });
        window.setInterval(() => refreshNotifications({ render: false }), 30000);
    } else {
        refreshDeviceConfirmation();
        window.setInterval(() => refreshDeviceConfirmation(), 30000);
    }
}

function updateBadge(badgeEl, count) {
    if (!badgeEl) return;
    const n = Number(count) || 0;
    badgeEl.textContent = String(n);
    badgeEl.style.display = n > 0 ? 'inline-block' : 'none';
}

async function markAllDashboardNotifications(button, panelEl = document.getElementById('dashboardNotificationPanel')) {
    if (!button || button.disabled) return false;

    const originalLabel = button.textContent.trim() || 'Mark all as read';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Marking as read';

    try {
        const response = await axios.post(
            `${window.API_BASE}/notifications/notifications.php?operation=markAllRead`,
            {}
        );
        if (!response.data?.success) {
            throw new Error(response.data?.message || 'Failed to mark notifications as read');
        }

        if (panelEl && Array.isArray(panelEl.__notificationItems)) {
            const readAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
            const updatedItems = panelEl.__notificationItems.map((item) => ({
                ...item,
                is_read: 1,
                read_at: item.read_at || readAt
            }));
            panelEl.__notificationItems = updatedItems;
            panelEl.__notificationUnread = 0;
            renderNotificationPanel(panelEl, updatedItems, 0);
        }

        updateBadge(document.getElementById('notificationCount'), 0);

        if (typeof window.refreshNotifications === 'function') {
            try {
                await window.refreshNotifications({ render: true });
            } catch (_) {
                // Keep the local read state if the follow-up refresh fails.
            }
        }

        showNotification('All notifications marked as read.', 'success');
        return true;
    } catch (error) {
        showNotification('Could not mark notifications as read. Please try again.', 'error');
        return false;
    } finally {
        if (button.isConnected) {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            button.textContent = originalLabel;
        }
    }
}

function renderNotificationPanel(panelEl, items, unreadCount = 0, { error = false } = {}) {
    if (!panelEl) return;

    const body = panelEl.querySelector('#dashboardNotificationPanelBody');
    const count = panelEl.querySelector('#dashboardNotificationPanelCount');
    const footer = body?.querySelector('.dashboard-notification-panel__footer');
    const toggle = footer?.querySelector('[data-notification-toggle]');
    if (!body) return;

    const restoreFooter = () => {
        if (footer) body.appendChild(footer);
    };

    const unread = Number(unreadCount) || 0;
    const list = Array.isArray(items) ? items : [];
    const initialVisibleCount = 6;
    const additionalCount = Math.max(list.length - initialVisibleCount, 0);
    let expanded = panelEl.dataset.notificationsExpanded === 'true';

    panelEl.__notificationItems = list;
    panelEl.__notificationUnread = unread;

    if (count) {
        count.textContent = unread > 0 ? `${unread} unread` : '';
        count.hidden = unread <= 0;
        count.classList.toggle('has-unread', unread > 0);
    }

    const markAll = panelEl.querySelector('[data-notification-mark-all]');
    if (markAll) {
        markAll.hidden = error || unread <= 0 || list.length === 0;
    }

    if (additionalCount === 0) {
        expanded = false;
        panelEl.dataset.notificationsExpanded = 'false';
    }

    if (toggle) {
        const label = toggle.querySelector('[data-notification-toggle-label]');
        const icon = toggle.querySelector('svg');
        toggle.hidden = error || list.length === 0 || additionalCount === 0;
        toggle.setAttribute('aria-expanded', String(expanded));
        if (label) label.textContent = expanded ? 'Show fewer' : 'Load more';
        if (icon) icon.classList.toggle('is-expanded', expanded);
        toggle.title = expanded ? 'Show fewer notifications' : `Load ${additionalCount} more notifications`;
    }

    if (error) {
        body.innerHTML = `
            <div class="dashboard-notification-empty dashboard-notification-empty--error">
                <span class="dashboard-notification-empty__icon" aria-hidden="true"><i class="fas fa-bell-slash"></i></span>
                <h3>Notifications are unavailable</h3>
                <p>We couldn't refresh this panel. Please try again later.</p>
            </div>
        `;
        restoreFooter();
        return;
    }

    if (list.length === 0) {
        body.innerHTML = `
            <div class="dashboard-notification-empty">
                <video class="dashboard-notification-empty__video"
                    src="${escapeHtml(`${window.APP_BASE || ''}/assets/icons/notif_done.mp4`)}"
                    autoplay loop muted playsinline preload="metadata" aria-hidden="true"></video>
                <h3>You're all caught up</h3>
                <p>No more notifications</p>
            </div>
        `;
        restoreFooter();
        return;
    }

    body.innerHTML = '';
    renderDropdown(body, expanded ? list : list.slice(0, initialVisibleCount), {
        includeHeader: false,
        includeRemove: true
    });
    if (expanded || additionalCount === 0) {
        body.insertAdjacentHTML('beforeend', `
            <div class="dashboard-notification-end-state" role="status">
                <video src="${escapeHtml(`${window.APP_BASE || ''}/assets/icons/notif_done.mp4`)}" autoplay loop muted playsinline preload="metadata" aria-hidden="true"></video>
                <strong>You're all caught up</strong>
                <span>No more notifications</span>
            </div>
        `);
    }
    restoreFooter();
}

function parseMysqlDateTime(value) {
    if (!value || typeof value !== 'string') return null;
    // "YYYY-MM-DD HH:MM:SS" -> ISO-ish
    const iso = value.replace(' ', 'T');
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
}

function formatNotificationTime(createdAt) {
    const d = parseMysqlDateTime(createdAt);
    if (!d) return '';

    const diffMs = Date.now() - d.getTime();
    if (!Number.isFinite(diffMs) || diffMs < 0) return '';

    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return 'now';

    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;

    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;

    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d`;

    const week = Math.floor(day / 7);
    if (week < 5) return `${week}w`;

    const month = Math.floor(day / 30);
    if (month < 12) return `${month}mo`;

    const year = Math.floor(day / 365);
    return `${year}y`;
}

function getLearnerAcademicStatusHref(notification) {
    const app = window.APP_BASE || '';
    const riskAssessmentId = Number(notification?.reference_id || 0);
    const query = Number.isFinite(riskAssessmentId) && riskAssessmentId > 0
        ? `?risk_assessment_id=${encodeURIComponent(String(riskAssessmentId))}`
        : '';
    return `${app}/pages/academic-status.html${query}`;
}

function getNotificationLink(n) {
    const ref = String(n?.reference_table || '').toLowerCase();
    const type = String(n?.notification_type || '').toLowerCase();
    const title = String(n?.title || '').toLowerCase();
    const message = String(n?.message || '').toLowerCase();
    const app = window.APP_BASE || '';

    if (isPostReviewNotification(n) && isCurrentUserAdmin()) {
        return app + '/pages/reported-posts.html';
    }

    if (ref === 'account_deactivation_requests') {
        return isCurrentUserAdmin()
            ? `${app}/pages/account-deactivation-requests.html`
            : `${app}/pages/settings.html#account-security`;
    }

    if (ref === 'auth_session_devices') {
        return `${app}/pages/settings.html#account-security`;
    }

    // Announcements are shown inline (popup) from the notification dropdown.
    if (ref === 'announcements') return null;

    if (ref === 'risk_assessment' || ref === 'risk_assessments'
        || ref === 'interventions' || type === 'risk flag') {
        return isCurrentUserLearner()
            ? getLearnerAcademicStatusHref(n)
            : `${app}/pages/risk-assessment.html`;
    }

    if (ref === 'enrollments') return `${app}/pages/enrollments.html`;
    if (ref === 'grade_monitoring') {
        const params = new URLSearchParams();
        if (Number.isFinite(Number(n?.reference_id)) && Number(n.reference_id) > 0) {
            params.set('grading_period_id', String(Number(n.reference_id)));
        }
        params.set('status', 'incomplete');
        return `${app}/pages/grade-monitoring.html?${params.toString()}`;
    }
    if (ref === 'dashboard_alerts') return null;

    // Fallback for older/missing reference_table rows related to early-risk alerts.
    const looksRiskRelated = type.includes('risk')
        || title.includes('at-risk learner')
        || message.includes('flagged as')
        || message.includes('at risk');
    if (looksRiskRelated) {
        return isCurrentUserLearner()
            ? getLearnerAcademicStatusHref(n)
            : `${app}/pages/risk-assessment.html`;
    }

    return null;
}

function isPostReviewNotification(n) {
    const ref = String(n?.reference_table || '').trim().toLowerCase();
    const title = String(n?.title || '').trim().toLowerCase();
    const message = String(n?.message || '').trim().toLowerCase();
    return ref === 'announcements'
        && /needs review/.test(title)
        && /(feedback|report)/.test(message);
}

function getNotificationReportCount(n) {
    const count = Number(n?.report_count || 0);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
}

function getNotificationReportMessage(n, subject = 'the post') {
    const count = getNotificationReportCount(n);
    return `${count} ${count === 1 ? 'user' : 'users'} reported ${subject}`;
}

function isCurrentUserAdmin() {
    const roleId = Number(window.CURRENT_ROLE_ID || 0);
    const roleName = String(window.CURRENT_ROLE_NAME || '').trim().toLowerCase();
    return roleId === 8 || roleName === 'admin' || roleName === 'administrator' || roleName.includes('admin');
}

function isCurrentUserLearner() {
    const roleId = Number(window.CURRENT_ROLE_ID || 0);
    const roleName = String(window.CURRENT_ROLE_NAME || '').trim().toLowerCase();
    return roleId === 10
        || roleName.includes('learner')
        || roleName.includes('student')
        || document.body?.classList.contains('learner-dashboard-page')
        || document.body?.classList.contains('learner-academic-status-page');
}

function focusAnnouncementInFeedNow(announcementId) {
    const id = Number(announcementId || 0);
    if (!Number.isFinite(id) || id <= 0) return false;

    const feed = document.getElementById('announcementsFeed');
    if (!feed) return false;

    // `id` is numeric; avoid relying on `CSS.escape()`.
    const card = feed.querySelector(`.announcement-card[data-id="${String(id)}"]`);
    if (!card) return false;

    // Expand long content if collapsed.
    try {
        const content = card.querySelector('.announcement-content[data-expanded]');
        const btn = card.querySelector('button.announcement-readmore');
        if (content && btn) {
            content.dataset.expanded = 'true';
            btn.textContent = 'Read less';
        }
    } catch (_) {
        // ignore
    }

    // Desktop/tablet dashboards give the feed rail its own scroll context.
    // Scrolling window here makes the document jump while the target card is
    // still below the fold inside that rail. Find the nearest scroll owner and
    // move only that owner; fall back to the document on content-driven views.
    const getScrollableAncestor = (element) => {
        let parent = element?.parentElement || null;
        while (parent && parent !== document.body && parent !== document.documentElement) {
            try {
                const style = window.getComputedStyle(parent);
                const canScrollY = /(auto|scroll|overlay)/i.test(String(style.overflowY || ''));
                if (canScrollY && parent.scrollHeight > parent.clientHeight + 1) return parent;
            } catch (_) {
                // Continue to the next ancestor when computed styles are unavailable.
            }
            parent = parent.parentElement;
        }
        return null;
    };

    const rect = card.getBoundingClientRect();
    const scrollOwner = getScrollableAncestor(card);

    if (scrollOwner) {
        const ownerRect = scrollOwner.getBoundingClientRect();
        const ownerHeight = scrollOwner.clientHeight || ownerRect.height || 0;
        const desiredTopInOwner = Math.max(16, (ownerHeight / 2) - (rect.height / 2));
        const targetTop = scrollOwner.scrollTop + (rect.top - ownerRect.top) - desiredTopInOwner;
        const maxScrollTop = Math.max(0, scrollOwner.scrollHeight - scrollOwner.clientHeight);
        const clampedTop = Math.min(maxScrollTop, Math.max(0, targetTop));

        try {
            scrollOwner.scrollTo({ top: clampedTop, behavior: 'smooth' });
        } catch (_) {
            scrollOwner.scrollTop = clampedTop;
        }
    } else {
        const headerOffset = (() => {
            const candidates = [
                document.querySelector('.topbar'),
                document.querySelector('header'),
                document.querySelector('.header')
            ].filter(Boolean);

            for (const el of candidates) {
                try {
                    const style = window.getComputedStyle(el);
                    const pos = String(style.position || '').toLowerCase();
                    const top = parseFloat(style.top || '0');
                    if ((pos === 'fixed' || pos === 'sticky') && (Number.isFinite(top) ? top : 0) === 0) {
                        const h = el.getBoundingClientRect().height;
                        if (h > 0) return h;
                    }
                } catch (_) {
                    // ignore
                }
            }
            return 0;
        })();

        const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
        if (viewportH > 0) {
            const effectiveH = Math.max(0, viewportH - headerOffset);
            const desiredTopInViewport = headerOffset + Math.max(12, (effectiveH / 2) - (rect.height / 2));
            const targetTop = (window.scrollY || 0) + rect.top - desiredTopInViewport;
            const maxScrollTop = Math.max(0, document.documentElement.scrollHeight - viewportH);
            const clampedTop = Math.min(maxScrollTop, Math.max(0, targetTop));

            try {
                window.scrollTo({ top: clampedTop, behavior: 'smooth' });
            } catch (_) {
                window.scrollTo(0, clampedTop);
            }
        }
    }

    const prevOutline = card.style.outline;
    const prevShadow = card.style.boxShadow;
    // An inset ring stays inside the feed column's horizontal clipping edge.
    card.style.outline = 'none';
    card.style.boxShadow = 'inset 0 0 0 3px rgba(59, 130, 246, 0.88)';

    window.setTimeout(() => {
        card.style.outline = prevOutline;
        card.style.boxShadow = prevShadow;
    }, 2200);

    return true;
}

function requestFocusAnnouncement(announcementId) {
    const id = Number(announcementId || 0);
    if (!Number.isFinite(id) || id <= 0) return;

    // Persist across navigation so the dashboard feed can focus after it loads.
    try {
        sessionStorage.setItem('focusAnnouncementId', String(id));
    } catch (_) {
        // ignore
    }
}

window.requestFocusAnnouncement = requestFocusAnnouncement;
window.focusAnnouncementInFeedNow = focusAnnouncementInFeedNow;
window.requestFocusRiskAssessment = requestFocusRiskAssessment;
window.requestFocusRiskAssessmentContext = requestFocusRiskAssessmentContext;

function requestFocusRiskAssessment(riskAssessmentId) {
    const id = Number(riskAssessmentId || 0);
    if (!Number.isFinite(id) || id <= 0) return;

    try {
        sessionStorage.setItem('focusRiskAssessmentId', String(id));
    } catch (_) {
        // ignore
    }
}

function requestFocusRiskAssessmentContext(notification) {
    if (!notification || typeof notification !== 'object') return;

    const payload = {
        notification_id: Number(notification.notification_id || 0) || null,
        reference_table: String(notification.reference_table || ''),
        reference_id: Number(notification.reference_id || 0) || null,
        notification_type: String(notification.notification_type || ''),
        title: String(notification.title || ''),
        message: String(notification.message || ''),
        created_at: String(notification.created_at || '')
    };

    try {
        sessionStorage.setItem('focusRiskAssessmentContext', JSON.stringify(payload));
    } catch (_) {
        // ignore
    }
}

function getNotificationActorIdentityName(n) {
    const first = String(n?.actor_first_name || '').trim();
    const last = String(n?.actor_last_name || '').trim();
    const full = `${first} ${last}`.trim();
    if (full) return full;

    return String(n?.actor_username || '').trim();
}

function getNotificationActorName(n) {
    const currentId = Number(window.CURRENT_USER_ID || 0);
    const actorId = Number(n?.actor_user_id || 0);
    if (currentId > 0 && actorId > 0 && currentId === actorId) {
        return 'You';
    }

    return getNotificationActorIdentityName(n);
}

function getNotificationSource(n) {
    const referenceTable = String(n?.reference_table || '').trim().toLowerCase();
    const notificationType = String(n?.notification_type || '').trim().toLowerCase();
    const actorId = Number(n?.actor_user_id || 0);
    const actorName = getNotificationActorIdentityName(n);

    if (referenceTable === 'announcements' || notificationType === 'announcement') {
        return actorId > 0 || Boolean(actorName) ? 'profile' : 'announcement';
    }

    return actorId > 0 || Boolean(actorName) ? 'profile' : 'system';
}

function getNotificationVisualKind(n) {
    const title = String(n?.title || '').trim();
    const message = String(n?.message || '').trim();
    const text = `${title} ${message}`;

    if (title.toLowerCase() === 'your post was removed'
        || /removed from the school feed after (a )?community report/i.test(message)) {
        return 'alarm';
    }

    if (/(password|needs (a )?review|needs attention|failed sign|did not go through|denied access|permission|security|deactivation)/i.test(text)) {
        return 'warning';
    }

    return '';
}

function getNotificationSourceIconMarkup(source, notification = null) {
    const app = window.APP_BASE || '';
    const referenceTable = String(notification?.reference_table || '').trim().toLowerCase();
    const notificationType = String(notification?.notification_type || '').trim().toLowerCase();
    const notificationTitle = String(notification?.title || '').trim();

    if (referenceTable === 'auth_session_devices' || /new device sign-in/i.test(notificationTitle)) {
        return `<span class="notification-source-icon notification-source-icon--attention notification-source-icon--alarm" aria-hidden="true"><img class="notification-source-icon__image" src="${app}/assets/icons/alarm.png" alt=""></span>`;
    }

    if (source === 'profile') {
        return '<span class="notification-source-icon notification-source-avatar notification-source-icon--profile user-avatar" data-notification-avatar="1" aria-hidden="true"></span>';
    }

    if (notificationType === 'grade alert') {
        return `<span class="notification-source-icon notification-source-icon--announcement" aria-hidden="true"><img class="notification-source-icon__image" src="${app}/assets/icons/announcement.png" alt=""></span>`;
    }

    if (notificationType === 'risk flag'
        || referenceTable === 'risk_assessment'
        || referenceTable === 'risk_assessments'
        || referenceTable === 'dashboard_alerts') {
        return `<span class="notification-source-icon notification-source-icon--attention notification-source-icon--alarm" aria-hidden="true"><img class="notification-source-icon__image" src="${app}/assets/icons/alarm.png" alt=""></span>`;
    }

    const visualKind = getNotificationVisualKind(notification);

    if (visualKind) {
        return `<span class="notification-source-icon notification-source-icon--attention notification-source-icon--${visualKind}" aria-hidden="true"><img class="notification-source-icon__image" src="${app}/assets/icons/${visualKind}.png" alt=""></span>`;
    }

    if (source === 'announcement') {
        return `<span class="notification-source-icon notification-source-icon--announcement" aria-hidden="true"><img class="notification-source-icon__image" src="${app}/assets/icons/announcement.png" alt=""></span>`;
    }

    return `<span class="notification-source-icon notification-source-icon--system" aria-hidden="true"><img class="notification-source-icon__image" src="${app}/assets/icons/system.png" alt=""></span>`;
}

function populateNotificationSourceAvatar(n, item) {
    if (!item || getNotificationSource(n) !== 'profile') return;

    const avatar = item.querySelector('[data-notification-avatar="1"]');
    if (!avatar) return;

    const actorName = getNotificationActorIdentityName(n) || 'User';
    const initials = getAccountInitials(actorName);
    const genderClass = `gender-${normalizeAccountGender(n?.actor_gender)}`;
    avatar.classList.add(genderClass);
    avatar.textContent = initials;
    avatar.setAttribute('aria-label', `${actorName} profile`);
}

function getRiskNotificationSummary(message) {
    const source = String(message || '').trim();
    const flagMarker = /\s+flagged\s+as\s+/i;
    const markerMatch = source.match(flagMarker);
    if (!markerMatch || markerMatch.index === undefined) {
        return { level: '', learner: '' };
    }

    let learner = source.slice(0, markerMatch.index).trim();
    const details = source.slice(markerMatch.index + markerMatch[0].length).trim();
    const periodMatch = details.match(/\s+for\s+[^.]+\./i);
    const level = (periodMatch ? details.slice(0, periodMatch.index) : details.split('.')[0])
        .replace(/[.:]+$/, '')
        .trim();

    learner = learner
        .replace(/\s+(?:grade\s+\d+)(?:\s*\([^)]*\))?\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();

    // Risk messages are stored as "Last name, First names". Read them in the
    // natural order used by the rest of the dashboard.
    const commaIndex = learner.indexOf(',');
    if (commaIndex > 0) {
        const lastName = learner.slice(0, commaIndex).trim();
        const givenNames = learner.slice(commaIndex + 1).trim();
        learner = `${givenNames} ${lastName}`.trim();
    }

    return { level, learner };
}

function getRiskNotificationPresentation(message) {
    const summary = getRiskNotificationSummary(message);
    const cleanLevel = String(summary.level || '')
        .replace(/\brisk\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    const title = cleanLevel
        ? `${cleanLevel.charAt(0).toUpperCase()}${cleanLevel.slice(1).toLowerCase()} risk`
        : 'Risk alert';
    const displayName = summary.learner || 'A learner';

    return {
        title,
        message: `${displayName} needs support.`,
        indicator: 'risk'
    };
}

function getLearnerRiskNotificationPresentation(notification) {
    const rawTitle = String(notification?.title || '');
    const rawMessage = String(notification?.message || '');
    const source = `${rawTitle} ${rawMessage}`;
    const match = source.match(/\b(medium|moderate|high|critical)\b/i);
    const rawLevel = String(match?.[1] || '').toLowerCase();
    const level = rawLevel === 'high' || rawLevel === 'critical'
        ? 'High'
        : (rawLevel === 'medium' || rawLevel === 'moderate' ? 'Medium' : 'At risk');
    const periodMatch = rawMessage.match(/\s+for\s+(.+?)(?:\.\s|\.$|$)/i);
    const period = periodMatch?.[1]?.trim() || '';

    return {
        title: `Your Failing Risk is ${level}`,
        message: `Your Failing Risk is ${level}${period ? ` for ${period}` : ''}. Open My Academic Status to review your status.`,
        indicator: 'risk'
    };
}

function getNotificationPresentation(n) {
    const ref = String(n?.reference_table || '').toLowerCase();
    const type = String(n?.notification_type || '').trim().toLowerCase();
    const rawTitle = String(n?.title || '').trim();
    const rawMessage = String(n?.message || '').trim();
    const normalizedMessage = rawMessage
        .replace(/\b1 students\b/gi, '1 student')
        .replace(/\b1 student have\b/gi, '1 student has');
    const actor = getNotificationActorName(n);
    const genericDashboardAlert = rawTitle.toLowerCase() === 'dashboard alert';

    if (rawTitle.toLowerCase() === 'your post was removed') {
        return {
            title: 'Your post was removed',
            message: normalizedMessage || 'Your post was removed from the school feed after a community report.',
            indicator: 'removed'
        };
    }

    if (/your post needs review/i.test(rawTitle)) {
        return {
            title: 'Your post needs review',
            message: getNotificationReportMessage(n, 'your post'),
            indicator: 'attention'
        };
    }

    if (/needs (a )?review/i.test(rawTitle + ' ' + rawMessage)) {
        return {
            title: 'Post report needs review',
            message: getNotificationReportMessage(n),
            indicator: 'attention'
        };
    }

    if (ref === 'account_deactivation_requests') {
        if (/requested/i.test(rawTitle)) {
            return {
                title: 'Account deactivation requested',
                message: actor ? `Needs request review · ${actor}` : 'Needs request review',
                indicator: 'attention'
            };
        }
        if (/approved/i.test(rawTitle)) {
            return {
                title: 'Account deactivation approved',
                message: actor ? `Approved by ${actor}` : 'Request approved',
                indicator: 'attention'
            };
        }
        if (/update/i.test(rawTitle)) {
            return {
                title: 'Account deactivation request update',
                message: actor ? `Updated by ${actor}` : 'Request updated',
                indicator: 'attention'
            };
        }
        if (/reactivated/i.test(rawTitle)) {
            return {
                title: 'Account reactivated',
                message: actor ? `Reactivated by ${actor}` : 'Account active again',
                indicator: 'default'
            };
        }
    }

    if (ref === 'auth_session_devices' || /new device sign-in/i.test(rawTitle)) {
        return {
            title: 'New device sign-in',
            message: normalizedMessage,
            indicator: 'attention'
        };
    }

    if (/password/i.test(rawTitle) && /(changed|reset|updated)/i.test(`${rawTitle} ${rawMessage}`)) {
        return {
            title: 'Password activity',
            message: normalizedMessage,
            indicator: 'attention'
        };
    }

    if (ref === 'announcements') {
        return {
            title: actor ? `${actor} posted an announcement` : 'Announcement',
            message: '',
            indicator: 'announcement'
        };
    }

    if (ref === 'dashboard_alerts') {
        if (/attendance/i.test(rawMessage)) {
            return { title: 'Attendance review', message: normalizedMessage, indicator: 'attendance' };
        }
        if (/at[- ]?risk|flagged as/i.test(`${rawTitle} ${rawMessage}`)) {
            return { title: 'At-risk learners', message: normalizedMessage, indicator: 'risk' };
        }
        return {
            title: genericDashboardAlert ? 'Learner support' : (rawTitle || 'Learner support'),
            message: normalizedMessage,
            indicator: 'support'
        };
    }

    if (ref === 'risk_assessment' || ref === 'risk_assessments' || type === 'risk flag') {
        if (ref === 'risk_period_summary') {
            return {
                title: rawTitle || 'At-risk learners',
                message: normalizedMessage,
                indicator: 'risk'
            };
        }
        if (/^your failing risk is\b/i.test(rawTitle)) {
            return {
                title: rawTitle,
                message: normalizedMessage,
                indicator: 'risk'
            };
        }
        if (isCurrentUserLearner()) {
            return getLearnerRiskNotificationPresentation(n);
        }
        if (/attendance/i.test(rawMessage)) {
            return { title: 'Attendance review', message: normalizedMessage, indicator: 'attendance' };
        }
        if (/at[- ]?risk|flagged as/i.test(`${rawTitle} ${rawMessage}`)) {
            return getRiskNotificationPresentation(rawMessage);
        }
        return getRiskNotificationPresentation(rawMessage);
    }

    if (type === 'grade alert') {
        return {
            title: 'Incomplete grade entries',
            message: 'Some teachers have incomplete grade entries in the active grading periods. Review Grade Monitoring to see which sections still need grades.',
            indicator: 'grade'
        };
    }

    if (type === 'intervention due') {
        return { title: 'Intervention due', message: normalizedMessage, indicator: 'intervention' };
    }

    if (type === 'grading period') {
        return { title: 'Grading period', message: normalizedMessage, indicator: 'grading' };
    }

    return {
        title: genericDashboardAlert ? 'Student support' : (rawTitle || 'Notification'),
        message: normalizedMessage,
        indicator: 'default'
    };
}

async function removeDashboardNotification(notificationId, itemEl) {
    const id = Number(notificationId || 0);
    if (!Number.isFinite(id) || id <= 0 || !itemEl) return false;

    const removeButton = itemEl.querySelector('[data-notification-remove]');
    if (removeButton?.disabled) return false;
    if (removeButton) {
        removeButton.disabled = true;
        removeButton.setAttribute('aria-busy', 'true');
    }

    try {
        const response = await axios.post(
            `${window.API_BASE}/notifications/notifications.php?operation=removeNotification`,
            { notification_id: id }
        );
        if (!response.data?.success) {
            throw new Error(response.data?.message || 'Failed to remove notification');
        }

        const panel = itemEl.closest('#dashboardNotificationPanel');
        if (panel && Array.isArray(panel.__notificationItems)) {
            const wasUnread = itemEl.dataset.notificationRead !== '1';
            panel.__notificationItems = panel.__notificationItems.filter(
                item => Number(item.notification_id || 0) !== id
            );
            panel.__notificationUnread = Math.max(
                0,
                Number(panel.__notificationUnread || 0) - (wasUnread ? 1 : 0)
            );
            renderNotificationPanel(panel, panel.__notificationItems, panel.__notificationUnread);
        }

        try {
            if (typeof window.refreshNotifications === 'function') {
                await window.refreshNotifications({ render: false });
            }
        } catch (_) {
            // The local panel is already updated if the follow-up refresh fails.
        }

        showNotification('Notification removed.', 'success');
        return true;
    } catch (error) {
        if (removeButton) {
            removeButton.disabled = false;
            removeButton.removeAttribute('aria-busy');
        }
        showNotification('Could not remove notification. Please try again.', 'error');
        return false;
    }
}

function renderDropdown(dropdownEl, items, { includeHeader = true, includeRemove = false, unreadCount = null } = {}) {
    const list = Array.isArray(items) ? items : [];
    const hasUnread = unreadCount === null
        ? list.some(item => Number(item?.is_read || 0) !== 1)
        : Number(unreadCount) > 0;

    const header = includeHeader ? `
        <div class="notification-dropdown-header">
            <span class="title">Notifications</span>
            <button type="button" class="notification-mark-all" data-notification-mark-all ${hasUnread && list.length ? '' : 'hidden'}>
                Mark all as read
            </button>
        </div>
    ` : '';

    if (list.length === 0) {
        dropdownEl.innerHTML = header + `
            <div class="notification-empty-state" role="status">
                <video class="notification-empty-state__video"
                    src="${escapeHtml(`${window.APP_BASE || ''}/assets/icons/notif_done.mp4`)}"
                    autoplay loop muted playsinline preload="metadata" aria-hidden="true"></video>
                <strong>You're all caught up</strong>
                <span>No more notifications</span>
            </div>
        `;
        return;
    }

    dropdownEl.innerHTML = header;

    const markAll = dropdownEl.querySelector('[data-notification-mark-all]');
    if (markAll) {
        markAll.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void markAllDashboardNotifications(markAll);
        });
    }

    list.forEach((n) => {
        const id = Number(n.notification_id || 0);
        const isRead = Number(n.is_read || 0) === 1;

        const ref = String(n?.reference_table || '').toLowerCase();
        const refId = Number(n?.reference_id || 0);
        const notificationType = String(n?.notification_type || '').toLowerCase();

        const presentation = getNotificationPresentation(n);
        const displayTitle = presentation.title;
        const displayMessage = presentation.message;

        const title = truncateText(displayTitle, 48);
        const message = truncateText(displayMessage, 90);
        const when = formatNotificationTime(n.created_at);
        const href = getNotificationLink(n);
        const source = getNotificationSource(n);
        const sourceIconMarkup = getNotificationSourceIconMarkup(source, n);
        const timeMarkup = when
            ? `<span class="notification-meta notification-meta--inline">${escapeHtml(when)}</span>`
            : '';

        const item = document.createElement(includeRemove ? 'div' : 'a');
        item.className = `notification-item${isRead ? '' : ' unread'}`;
        item.dataset.notificationId = String(id);
        item.dataset.notificationRead = isRead ? '1' : '0';
        item.dataset.notificationSource = source;
        if (!includeRemove) item.href = href || '#';

        const notificationMarkup = `
            <div class="notification-content-row">
                ${sourceIconMarkup}
                <div class="notification-details">
                    <div class="notification-title-row">
                        <p class="notification-title">${escapeHtml(title)}</p>
                        ${timeMarkup}
                    </div>
                    ${message ? `<p class="notification-message">${escapeHtml(message)}</p>` : ''}
                </div>
            </div>
        `;

        item.innerHTML = includeRemove
            ? `<a class="notification-item__link" href="${href || '#'}">${notificationMarkup}</a>
               <button type="button" class="notification-remove" data-notification-remove aria-label="Remove notification" title="Remove notification">
                   <i class="fas fa-xmark" aria-hidden="true"></i>
               </button>`
            : notificationMarkup;

        populateNotificationSourceAvatar(n, item);

        const link = includeRemove ? item.querySelector('.notification-item__link') : item;
        link.addEventListener('click', async (e) => {
            e.preventDefault();
            if (!id) return;

            try {
                await axios.post(`${window.API_BASE}/notifications/notifications.php?operation=markRead`, {
                    notification_id: id
                });
            } catch (_) {
                // ignore
            }

            // Refresh badge quickly
            try {
                if (typeof window.refreshNotifications === 'function') {
                    await window.refreshNotifications({ render: false });
                }
            } catch (_) {
                // ignore
            }

            if (ref === 'account_deactivation_requests') {
                window.location.href = isCurrentUserAdmin()
                    ? (window.APP_BASE || '') + '/pages/account-deactivation-requests.html'
                    : (window.APP_BASE || '') + '/pages/settings.html#account-security';
                return;
            }

            if (ref === 'auth_session_devices') {
                const opened = typeof window.openPendingDeviceConfirmation === 'function'
                    ? await window.openPendingDeviceConfirmation({ sessionDeviceId: refId })
                    : false;
                if (!opened && href && href !== '#') window.location.href = href;
                dropdownEl.classList.remove('show');
                item.classList.remove('unread');
                return;
            }

            if (isPostReviewNotification(n) && isCurrentUserAdmin()) {
                window.location.href = (window.APP_BASE || '') + '/pages/reported-posts.html';
                return;
            }

            if (ref === 'announcements') {
                if (Number.isFinite(refId) && refId > 0) {
                    requestFocusAnnouncement(refId);

                    // Try focusing immediately if we're already on a dashboard page.
                    const focusedNow = focusAnnouncementInFeedNow(refId);
                    if (!focusedNow) {
                        // Not on a dashboard page (or feed not loaded yet): go to the role dashboard,
                        // then the dashboard announcements script will focus it once rendered.
                        const target = getDashboardHrefForRole(window.CURRENT_ROLE_NAME, window.CURRENT_ROLE_ID);
                        window.location.href = target;
                    }
                }

                dropdownEl.classList.remove('show');
                item.classList.remove('unread');
                return;
            }

            if (ref === 'risk_assessment' || ref === 'risk_assessments' || notificationType === 'risk flag') {
                if (Number.isFinite(refId) && refId > 0) {
                    requestFocusRiskAssessment(refId);
                    requestFocusRiskAssessmentContext(n);
                }
            }

            if (href && href !== '#') {
                window.location.href = href;
            } else {
                // Marked read; close dropdown.
                dropdownEl.classList.remove('show');
                item.classList.remove('unread');
            }
        });

        if (includeRemove) {
            const removeButton = item.querySelector('[data-notification-remove]');
            removeButton?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                void removeDashboardNotification(id, item);
            });
        }

        dropdownEl.appendChild(item);
    });
}

function truncateText(value, maxLen) {
    const s = String(value ?? '').replace(/\s+/g, ' ').trim();
    const n = Number(maxLen) || 0;
    if (n <= 0 || s.length <= n) return s;
    if (n === 1) return s.slice(0, 1);
    return s.slice(0, n - 1) + '…';
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function removeDeprecatedMasterfileLinks() {
    // Previously used to prune deprecated masterfile links.
    // Keep as a no-op for now to avoid hiding valid pages.
    return;
}

function hasAnalyticsAccessForRole(roleName = '', roleId = 0, roleKey = '') {
    const normalizedName = normalizeRoleName(roleName);
    const normalizedKey = normalizeRoleName(roleKey);
    const numericRoleId = Number(roleId || 0);
    return [7, 8, 11].includes(numericRoleId)
        || ['admin', 'registrar', 'principal'].includes(normalizedKey)
        || normalizedKey.includes('principal')
        || normalizedKey.includes('school_head')
        || normalizedKey.includes('school head')
        || normalizedName.includes('principal')
        || normalizedName.includes('school head')
        || normalizedName === 'administrator'
        || normalizedName === 'admin'
        || normalizedName === 'registrar';
}

function topbarAnalyticsMarkup(app) {
    return `
        <div class="topbar-nav-group" data-topbar-analytics-group>
            <button type="button" class="topbar-nav-toggle" data-topbar-nav="analytics" data-topbar-menu-toggle="analytics" aria-haspopup="true" aria-expanded="false" aria-label="Analytics" title="Analytics">
                <i class="fas fa-chart-line" aria-hidden="true"></i>
                <span>Analytics</span>
                <i class="fas fa-caret-down" aria-hidden="true"></i>
            </button>
            <div class="topbar-nav-menu" data-topbar-menu="analytics" role="menu">
                <a href="${app}/pages/analytics/dashboard-overview.html?view=population" role="menuitem">
                    <i class="fas fa-users" aria-hidden="true"></i>
                    <span>Learner Population</span>
                </a>
                <a href="${app}/pages/analytics/dashboard-overview.html?view=proficiency" role="menuitem">
                    <i class="fas fa-award" aria-hidden="true"></i>
                    <span>Proficiency Levels</span>
                </a>
                <a href="${app}/pages/analytics/dashboard-overview.html?view=trends" role="menuitem">
                    <i class="fas fa-chart-line" aria-hidden="true"></i>
                    <span>Trends</span>
                </a>
                <a href="${app}/pages/analytics/risk-analytics.html" role="menuitem">
                    <i class="fas fa-triangle-exclamation" aria-hidden="true"></i>
                    <span>Risk Assessment</span>
                </a>
            </div>
        </div>
    `;
}

function syncTopbarCenterAnalytics(roleKey = '') {
    const container = document.querySelector('.topbar-center-nav');
    if (!container) return;

    const allowed = hasAnalyticsAccessForRole(
        window.CURRENT_ROLE_NAME,
        window.CURRENT_ROLE_ID,
        roleKey || window.CURRENT_ROLE_KEY || ''
    );
    const existing = container.querySelector('[data-topbar-analytics-group]');
    if (!allowed) {
        existing?.remove();
    } else if (!existing) {
        container.insertAdjacentHTML('beforeend', topbarAnalyticsMarkup(getAppPathPrefix()));
        wireTopbarCenterNav(container);
    }
    setTopbarCenterNavActive(container);
}

function ensureTopbarCenterNav() {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;

    let container = topbar.querySelector('.topbar-center-nav');
    if (!container) {
        const app = getAppPathPrefix();

        // Keep the Home button pointing at the current role dashboard.
        // Default to admin dashboard if we're not on a role dashboard page.
        const currentPath = String(window.location.pathname || '');
        let homeRoute = 'dashboard/admin_dashboard.html';
        if (/\/dashboard\/teacher_dashboard\.html$/.test(currentPath)) {
            homeRoute = 'dashboard/teacher_dashboard.html';
        } else if (/\/dashboard\/learner_dashboard\.html$/.test(currentPath)) {
            homeRoute = 'dashboard/learner_dashboard.html';
        }
        const homeHref = `${app}/${homeRoute}`.replace(/\/\/+/, '/');

        container = document.createElement('div');
        container.className = 'topbar-center-nav';
        container.innerHTML = `
            <a class="topbar-nav-link" data-topbar-nav="home" href="${homeHref}" aria-label="Home" title="Home">
                <i class="fas fa-home" aria-hidden="true"></i>
                <span>Home</span>
            </a>
        `;
        topbar.appendChild(container);
        wireTopbarCenterNav(container);
    }

    // Analytics is deliberately absent until auth/me resolves the role.
    // This prevents Teacher and Learner accounts from seeing a privileged
    // topbar option during the session bootstrap window.
    syncTopbarCenterAnalytics(window.CURRENT_ROLE_KEY || '');
}

function setTopbarCenterNavActive(container) {
    const pathname = String(window.location.pathname || '').replace(/\/+$/, '');

    const home = container.querySelector('[data-topbar-nav="home"]');
    const analytics = container.querySelector('[data-topbar-nav="analytics"]');

    [home, analytics].forEach(el => {
        if (!el) return;
        el.classList.remove('active');
        el.removeAttribute('aria-current');
    });

    // Highlight based on current page
    if (/\/pages\/analytics\//.test(pathname)) {
        analytics?.classList.add('active');
        analytics?.setAttribute('aria-current', 'page');
        return;
    }

    if (/\/dashboard\/(admin_dashboard|teacher_dashboard|learner_dashboard)\.html$/.test(pathname)) {
        home?.classList.add('active');
        home?.setAttribute('aria-current', 'page');
    }
}

function removeSettingsFromSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const anchors = Array.from(sidebar.querySelectorAll('a[href]'));
    anchors.forEach((a) => {
        const href = String(a.getAttribute('href') || '');
        const text = String(a.textContent || '');
        if (!/settings\.html(\?|#|$)/i.test(href)) return;
        if (!/\bsettings\b/i.test(text)) return;

        const li = a.closest('li');
        if (li) {
            li.remove();
            return;
        }
        a.remove();
    });
}

function wireTopbarCenterNav(container) {
    const toggles = Array.from(container.querySelectorAll('[data-topbar-menu-toggle]'))
        .filter((toggle) => toggle.dataset.topbarNavBound !== '1');
    const menus = Array.from(container.querySelectorAll('[data-topbar-menu]'));

    const closeAll = () => {
        menus.forEach(m => m.classList.remove('show'));
        toggles.forEach(t => t.setAttribute('aria-expanded', 'false'));
    };

    toggles.forEach(toggle => {
        toggle.dataset.topbarNavBound = '1';
        toggle.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const key = toggle.getAttribute('data-topbar-menu-toggle');
            const menu = container.querySelector(`[data-topbar-menu="${key}"]`);
            if (!menu) return;

            const isOpen = menu.classList.contains('show');
            closeAll();
            if (!isOpen) {
                menu.classList.add('show');
                toggle.setAttribute('aria-expanded', 'true');
            }
        });
    });

    if (container.dataset.topbarDismissBound !== '1') {
        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) closeAll();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeAll();
        });
        container.dataset.topbarDismissBound = '1';
    }
}

// ===========================
// UI Scale (Small/Medium/Large)
// ===========================

const UI_SCALE_STORAGE_KEY = 'deped_ui_scale';

function normalizeUiScale(value) {
    const v = String(value || '').toLowerCase().trim();
    return v === 'small' || v === 'medium' || v === 'large' ? v : null;
}

function applyUiScale(scale) {
    const normalized = normalizeUiScale(scale) || 'small';
    document.documentElement.setAttribute('data-ui-scale', normalized);
    try {
        localStorage.setItem(UI_SCALE_STORAGE_KEY, normalized);
    } catch {
        // ignore storage errors
    }
}

function initializeUiScaleSetting() {
    let stored = null;
    try {
        stored = localStorage.getItem(UI_SCALE_STORAGE_KEY);
    } catch {
        stored = null;
    }

    applyUiScale(stored);

    const select = document.getElementById('uiScaleSelect');
    if (!select) return;

    const current = document.documentElement.getAttribute('data-ui-scale') || 'small';
    select.value = current;
    select.addEventListener('change', () => {
        applyUiScale(select.value);
    });
}

function ensureButtonPolishStyles() {
    document.documentElement.classList.add('app-button-polish');
    loadCssOnce(
        'buttonMinimalStyles',
        `${getAppPathPrefix()}/assets/css/button-minimal.css?v=20260923-control-system-v1`
    );
}

function initializeLogoScrollToTop() {
    document.querySelectorAll('.announcement-dashboard .logo').forEach((logo) => {
        logo.setAttribute('role', 'button');
        logo.setAttribute('tabindex', '0');
        logo.setAttribute('aria-label', 'Scroll to top');

        const scrollToTop = () => {
            const feedColumn = document.querySelector('.announcement-dashboard .dashboard-feed-column');
            if (feedColumn) {
                feedColumn.scrollTo({ top: 0, behavior: 'smooth' });
            }
            window.scrollTo({ top: 0, behavior: 'smooth' });
        };

        logo.addEventListener('click', scrollToTop);
        logo.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                scrollToTop();
            }
        });
    });
}

// Initialize Dashboard
function initializeDashboard() {
    // Prevent role-restricted sidebar links from flashing before session loads.
    setSidebarRoleLoading(true);

    // Apply UI scale as early as possible
    initializeUiScaleSetting();

    ensureButtonPolishStyles();

    initializeLogoScrollToTop();

    // Add a text-logo at the top of the sidebar (global)
    ensureSidebarBranding();

    // Initialize navigation
    initializeNavigation();

    // Initialize user menu
    initializeUserMenu();

    // Provide the account toggle inside the mobile sidebar while keeping the
    // desktop topbar menu unchanged.
    ensureSidebarProfileToggle();

    // Add the shared profile directory search to the topbar on authenticated
    // application pages.
    initializeGlobalProfileSearch();

    // Load user session (also enforces dashboard role); once we know the role,
    // render role-appropriate sidebar nav.
    loadUserSession();

    // Load dashboard data
    loadDashboardData();

    // Initialize sidebar toggle
    initializeSidebarToggle();

    // Initialize scroll animations
    initializeScrollAnimations();

    // Enhance selects + date/time pickers (custom popups for Safari/Chrome)
    initializeEnhancedControls().catch((error) => {
        console.warn('Enhanced controls unavailable:', error);
    });
}

// ===========================
// Enhanced Controls (Choices.js + Flatpickr)
// ===========================

function normalizeAssetUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^(https?:)?\/\//i.test(raw) || raw.startsWith('data:')) return raw;
    if (raw.startsWith('/')) return raw;
    return new URL(raw, window.location.origin + '/').pathname;
}

function loadCssOnce(id, href) {
    if (document.getElementById(id)) return;
    const resolvedHref = normalizeAssetUrl(href);
    if (!resolvedHref) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = resolvedHref;
    document.head.appendChild(link);
}

function loadScriptOnce(id, src) {
    return new Promise((resolve, reject) => {
        if ((/^(https?:)?\/\//i.test(String(id || '')) || String(id || '').includes('/')) && src && !String(src).includes('/')) {
            [id, src] = [src, id];
        }

        const existing = document.getElementById(id);
        if (existing) {
            resolve();
            return;
        }

        const resolvedSrc = normalizeAssetUrl(src);
        if (!resolvedSrc) {
            reject(new Error('Missing script source'));
            return;
        }

        const script = document.createElement('script');
        script.id = id;
        script.src = resolvedSrc;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${resolvedSrc}`));
        document.head.appendChild(script);
    });
}

async function initializeEnhancedControls() {
    // Prefer local vendored assets (offline-safe), fallback to CDN if needed
    const app = getAppPathPrefix();

    const local = {
        CHOICES_CSS: `${app}/assets/vendor/choices/choices.min.css`,
        CHOICES_JS: `${app}/assets/vendor/choices/choices.min.js`,
        FLATPICKR_CSS: `${app}/assets/vendor/flatpickr/flatpickr.min.css`,
        FLATPICKR_JS: `${app}/assets/vendor/flatpickr/flatpickr.min.js`
    };

    const cdn = {
        CHOICES_CSS: 'https://cdn.jsdelivr.net/npm/choices.js/public/assets/styles/choices.min.css',
        CHOICES_JS: 'https://cdn.jsdelivr.net/npm/choices.js/public/assets/scripts/choices.min.js',
        FLATPICKR_CSS: 'https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css',
        FLATPICKR_JS: 'https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.js'
    };

    // CSS: load local first; if it 404s, browser just won't apply it (that's fine)
    loadCssOnce('choices-css', local.CHOICES_CSS);
    loadCssOnce('flatpickr-css', local.FLATPICKR_CSS);

    // JS: try local; if it fails, try CDN
    try {
        await Promise.all([
            loadScriptOnce('choices-js', local.CHOICES_JS),
            loadScriptOnce('flatpickr-js', local.FLATPICKR_JS)
        ]);
    } catch {
        await Promise.all([
            loadScriptOnce('choices-js-cdn', cdn.CHOICES_JS),
            loadScriptOnce('flatpickr-js-cdn', cdn.FLATPICKR_JS)
        ]);
        // If CDN is used, ensure CSS is also available
        loadCssOnce('choices-css-cdn', cdn.CHOICES_CSS);
        loadCssOnce('flatpickr-css-cdn', cdn.FLATPICKR_CSS);
    }

    // Vendor CSS is injected after dashboard.css, so we must override it after load
    ensureEnhancedPopupThemeOverrides();

    enhanceSelectDropdowns();
    enhanceDateTimePickers();

    // Allow other scripts (that add dynamic fields later) to re-run safely
    window.enhanceControls = () => {
        enhanceSelectDropdowns();
        enhanceDateTimePickers();
    };

    // Auto-enhance controls added later (e.g., dynamic modals/forms)
    if (!window.__enhanceControlsObserver && document.body) {
        let timer = null;
        window.__enhanceControlsObserver = new MutationObserver(() => {
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                try {
                    window.enhanceControls?.();
                } catch {
                    // ignore
                }
            }, 50);
        });

        window.__enhanceControlsObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }
}

function ensureEnhancedPopupThemeOverrides() {
    if (document.getElementById('enhancedPopupThemeOverrides')) return;

    const style = document.createElement('style');
    style.id = 'enhancedPopupThemeOverrides';
    style.textContent = `
/* Theme overrides for Choices.js + Flatpickr (must load after vendor CSS) */

/* Choices.js */
.choices.is-open{
    z-index: 10050 !important;
}
.choices__inner{
    background: var(--surface-0) !important;
    border: 1px solid var(--button-line, var(--gray-300)) !important;
    border-radius: var(--button-radius, 10px) !important;
    color: var(--gray-900) !important;
    min-height: 44px !important;
    padding: .67rem 2.5rem .67rem .8rem !important;
    font-size: var(--control-font-size) !important;
    box-shadow: none !important;
    transition: border-color 160ms var(--button-ease, cubic-bezier(.22, 1, .36, 1)),
        background-color 160ms var(--button-ease, cubic-bezier(.22, 1, .36, 1)),
        box-shadow 160ms var(--button-ease, cubic-bezier(.22, 1, .36, 1)) !important;
}
.choices:hover .choices__inner{
    border-color: var(--button-control-line-hover, #9bb3c8) !important;
    background: var(--button-control-hover, #f7fafc) !important;
}
.choices.is-focused .choices__inner,
.choices.is-open .choices__inner{
    border-color: var(--button-blue, var(--deped-blue)) !important;
    background: var(--button-surface, var(--surface-0)) !important;
    box-shadow: 0 0 0 4px var(--button-focus-ring, rgba(0, 85, 164, .18)) !important;
}
.choices__list--dropdown,.choices__list[aria-expanded]{
    background: var(--surface-0) !important;
    margin-top: .35rem !important;
    overflow: hidden !important;
    border: 1px solid var(--button-line, var(--gray-300)) !important;
    border-radius: var(--button-radius, 10px) !important;
    box-shadow: 0 14px 32px rgba(15, 45, 79, .12) !important;
    z-index: 10050 !important;
}
/* Keep any stale/open Choices menu beneath SweetAlert instead of over the prompt. */
body.swal2-shown .choices,
body.swal2-shown .choices__list--dropdown.is-active,
body.swal2-shown .choices__list[aria-expanded="true"]{
    visibility: hidden !important;
    pointer-events: none !important;
    z-index: 1 !important;
}
.choices__list--dropdown .choices__item--selectable,
.choices__list[aria-expanded] .choices__item--selectable{
    min-height: 40px !important;
    padding: .62rem .8rem !important;
    color: var(--gray-900) !important;
    transition: background-color 160ms var(--button-ease, cubic-bezier(.22, 1, .36, 1)),
        color 160ms var(--button-ease, cubic-bezier(.22, 1, .36, 1)) !important;
}
.choices__list--dropdown .choices__item--selectable.is-highlighted,
.choices__list[aria-expanded] .choices__item--selectable.is-highlighted{
    background: var(--button-blue-soft, var(--gray-100)) !important;
    color: var(--button-blue, var(--deped-blue)) !important;
}
.choices__input{
    min-height: 40px !important;
    margin: .45rem !important;
    padding: .55rem .65rem !important;
    border: 1px solid var(--button-line, var(--gray-300)) !important;
    border-radius: 8px !important;
    background: var(--button-surface, transparent) !important;
    color: var(--button-ink, var(--gray-900)) !important;
}
.choices__list--multiple .choices__item{
    background: var(--button-blue-soft, var(--gray-100)) !important;
    border: 1px solid var(--button-blue-line, var(--gray-200)) !important;
    border-radius: 7px !important;
    color: var(--button-ink, var(--gray-900)) !important;
}
.choices__list--multiple .choices__item .choices__button{
    filter: none !important;
    opacity: 0.85 !important;
}
.choices[data-type*="select-one"]::after{
    border-color: var(--button-ink, var(--gray-500)) transparent transparent transparent !important;
}

/* Flatpickr */
.flatpickr-calendar{
    background: var(--surface-0) !important;
    border-color: var(--gray-300) !important;
    box-shadow: var(--shadow-lg) !important;
    z-index: 10050 !important;
}
.flatpickr-months,.flatpickr-weekdays,.flatpickr-days{
    background: var(--surface-0) !important;
}
.flatpickr-current-month,
.flatpickr-monthDropdown-months,
.flatpickr-weekday,
.flatpickr-day,
.flatpickr-time input,
.flatpickr-time .flatpickr-am-pm{
    color: var(--gray-900) !important;
}
.flatpickr-monthDropdown-months,
.flatpickr-monthDropdown-months .flatpickr-monthDropdown-month{
    background: var(--surface-0) !important;
}
.flatpickr-monthDropdown-months .flatpickr-monthDropdown-month:hover,
.flatpickr-monthDropdown-months .flatpickr-monthDropdown-month:focus{
    background: var(--gray-100) !important;
}
.flatpickr-day{
    border-radius: 0.5rem !important;
}
.flatpickr-day:hover{
    background: var(--gray-100) !important;
    border-color: var(--gray-100) !important;
}
.flatpickr-day.today{
    border-color: var(--deped-blue) !important;
}
.flatpickr-day.selected,.flatpickr-day.startRange,.flatpickr-day.endRange{
    background: var(--deped-blue) !important;
    border-color: var(--deped-blue) !important;
    color: #fff !important;
}
.flatpickr-day.flatpickr-disabled,
.flatpickr-day.prevMonthDay,
.flatpickr-day.nextMonthDay{
    color: var(--gray-500) !important;
}
.flatpickr-time{
    border-top: 1px solid var(--gray-200) !important;
}
.flatpickr-time input,
.flatpickr-time .flatpickr-am-pm{
    background: transparent !important;
}
.flatpickr-months .flatpickr-prev-month,
.flatpickr-months .flatpickr-next-month{
    color: var(--gray-900) !important;
    fill: var(--gray-900) !important;
}
.flatpickr-months .flatpickr-prev-month svg path,
.flatpickr-months .flatpickr-next-month svg path{
    fill: var(--gray-900) !important;
}
`;
    document.head.appendChild(style);
}

function enhanceSelectDropdowns() {
    const ChoicesCtor = window.Choices;
    if (!ChoicesCtor) return;

    const selects = Array.from(document.querySelectorAll('select'));

    selects.forEach((selectEl) => {
        if (!selectEl || selectEl.dataset.native === 'true') return;
        if (selectEl.dataset.enhanced === 'choices') return;

        // Avoid enhancing hidden/disabled placeholders used only as templates
        if (selectEl.closest('[aria-hidden="true"]')) return;

        const optionCount = selectEl.options?.length || 0;
        const searchEnabled = selectEl.dataset.searchEnabled === 'true' || optionCount > 8;

        const isAttendanceFilter = document.body.classList.contains('attendance-page')
            && ['attSchoolYear', 'attYearLevel', 'attSection', 'attPeriod', 'myAttSchoolYear'].includes(selectEl.id);
        const choicesOptions = {
            allowHTML: false,
            shouldSort: false,
            searchEnabled,
            searchPlaceholderValue: selectEl.dataset.searchPlaceholder || 'Search...',
            searchResultLimit: isAttendanceFilter ? -1 : 50,
            itemSelectText: '',
            removeItemButton: !!selectEl.multiple,
            placeholder: true,
            placeholderValue: selectEl.getAttribute('placeholder') || ''
        };
        if (isAttendanceFilter) choicesOptions.renderChoiceLimit = -1;
        const instance = new ChoicesCtor(selectEl, choicesOptions);

        selectEl.dataset.enhanced = 'choices';
        selectEl._choicesInstance = instance;

        // Keep in sync for dynamically populated selects (e.g., roles loaded via axios)
        let refreshTimer = null;
        const observer = new MutationObserver(() => {
            if (refreshTimer) window.clearTimeout(refreshTimer);
            refreshTimer = window.setTimeout(() => {
                try {
                    instance.refresh();
                } catch {
                    // ignore refresh errors
                }
            }, 50);
        });

        observer.observe(selectEl, { childList: true, subtree: true });
        selectEl._choicesObserver = observer;
    });
}

function enhanceDateTimePickers() {
    const flatpickr = window.flatpickr;
    if (!flatpickr) return;

    const inputs = Array.from(document.querySelectorAll('input[type="date"], input[type="datetime-local"], input[type="time"]'));

    inputs.forEach((inputEl) => {
        if (!inputEl || inputEl.dataset.native === 'true') return;
        if (inputEl.dataset.enhanced === 'flatpickr') return;

        const originalType = inputEl.getAttribute('type');
        inputEl.dataset.originalType = originalType;

        // Force consistent custom popup across Safari/Chrome
        inputEl.type = 'text';

        const base = {
            allowInput: true,
            disableMobile: true
        };

        let config = base;
        if (originalType === 'datetime-local') {
            config = {
                ...base,
                enableTime: true,
                time_24hr: true,
                dateFormat: 'Y-m-d\\TH:i'
            };
        } else if (originalType === 'time') {
            config = {
                ...base,
                enableTime: true,
                noCalendar: true,
                time_24hr: true,
                dateFormat: 'H:i'
            };
        } else {
            // date
            config = {
                ...base,
                dateFormat: 'Y-m-d'
            };
        }

        flatpickr(inputEl, config);
        inputEl.dataset.enhanced = 'flatpickr';
    });
}

function ensureSidebarBranding() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    if (sidebar.querySelector('.sidebar-branding')) return;

    const app = getAppPathPrefix();
    const branding = document.createElement('div');
    branding.className = 'sidebar-branding';
    branding.innerHTML = `<img src="${app}/assets/img/logo/logo.png" alt="School Logo">`;

    sidebar.insertBefore(branding, sidebar.firstChild);
}

function syncSidebarProfileMenu() {
    const sourceDropdown = document.getElementById('userDropdown');
    const sidebarDropdown = document.getElementById('sidebarProfileDropdown');
    if (!sourceDropdown || !sidebarDropdown) return;

    sidebarDropdown.innerHTML = sourceDropdown.innerHTML;

    sidebarDropdown.querySelectorAll('a').forEach((link) => {
        link.addEventListener('click', (event) => {
            const isLogout = link.classList.contains('logout');
            if (isLogout) {
                event.preventDefault();
                sourceDropdown.querySelector('a.logout')?.click();
            }
            window.closeSidebarProfileMenu?.();
        });
    });
}

function ensureSidebarProfileToggle() {
    const sidebar = document.getElementById('sidebar');
    const sourceDropdown = document.getElementById('userDropdown');
    if (!sidebar || !sourceDropdown) return;

    let profileToggle = sidebar.querySelector('.sidebar-profile-toggle');
    if (!profileToggle) {
        const topbarName = document.querySelector('.user-name')?.textContent?.trim() || 'Account';
        const topbarRole = document.querySelector('.user-role')?.textContent?.trim() || 'User';
        profileToggle = document.createElement('div');
        profileToggle.className = 'sidebar-profile-toggle';
        profileToggle.innerHTML = `
            <button type="button" class="sidebar-profile-button" id="sidebarProfileBtn"
                    aria-haspopup="true" aria-expanded="false" aria-controls="sidebarProfileDropdown">
                <span class="sidebar-profile-avatar user-avatar" aria-hidden="true">U</span>
                <span class="sidebar-profile-copy">
                    <strong class="sidebar-profile-name">${topbarName}</strong>
                    <span class="sidebar-profile-role">${topbarRole}</span>
                </span>
                <i class="fas fa-chevron-down sidebar-profile-chevron" aria-hidden="true"></i>
            </button>
            <div class="user-dropdown sidebar-profile-dropdown" id="sidebarProfileDropdown"
                 role="dialog" aria-label="Account options" aria-modal="true" tabindex="-1"></div>
        `;
        sidebar.insertBefore(profileToggle, sidebar.firstChild);
    }

    const button = profileToggle.querySelector('#sidebarProfileBtn');
    const dropdown = document.getElementById('sidebarProfileDropdown');
    if (!button || !dropdown) return;

    // The sidebar is transformed during its mobile slide-in animation. Portal
    // the sheet to <body> so position:fixed is relative to the viewport, not
    // the sidebar's 280px containing block.
    if (dropdown.parentElement !== document.body) {
        document.body.appendChild(dropdown);
    }

    syncSidebarProfileMenu();

    if (profileToggle.dataset.bound === '1') return;
    profileToggle.dataset.bound = '1';

    const close = () => {
        dropdown.classList.remove('show');
        profileToggle.classList.remove('is-open');
        button.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('sidebar-profile-sheet-open');
    };
    const open = () => {
        const isOpen = dropdown.classList.toggle('show');
        profileToggle.classList.toggle('is-open', isOpen);
        button.setAttribute('aria-expanded', String(isOpen));
        document.body.classList.toggle('sidebar-profile-sheet-open', isOpen);
    };

    window.closeSidebarProfileMenu = close;
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        open();
    });
    dropdown.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', (event) => {
        if (!profileToggle.contains(event.target) && !dropdown.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close();
    });
}

function initializeGlobalProfileSearch() {
    if (document.body?.hasAttribute('data-disable-global-profile-search')) return;
    const topbarRight = document.querySelector('.topbar-right');
    if (!topbarRight || document.getElementById('globalProfileSearch')) return;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'global-profile-search-trigger';
    trigger.setAttribute('data-global-profile-search-trigger', '');
    trigger.setAttribute('aria-label', 'Search profiles');
    trigger.setAttribute('title', 'Search profiles');
    trigger.innerHTML = `
        <i class="fas fa-search" aria-hidden="true"></i>
        <span class="global-profile-search-trigger__label">Search profiles</span>
    `;
    topbarRight.insertBefore(trigger, topbarRight.firstChild);

    const overlay = document.createElement('section');
    overlay.className = 'global-profile-search';
    overlay.id = 'globalProfileSearch';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
        <div class="global-profile-search__panel" role="dialog" aria-modal="true" aria-label="Search profiles">
            <div class="global-profile-search__header">
                <button type="button" class="global-profile-search__back" data-global-profile-search-back aria-label="Back" title="Back">
                    <i class="fas fa-arrow-left" aria-hidden="true"></i>
                </button>
                <label class="global-profile-search__field">
                    <i class="fas fa-search" aria-hidden="true"></i>
                    <input type="search" id="globalProfileSearchInput" placeholder="Search profiles" autocomplete="off" aria-label="Search profiles">
                </label>
            </div>
            <div class="global-profile-search__results" id="globalProfileSearchResults" aria-live="polite"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#globalProfileSearchInput');
    const results = overlay.querySelector('#globalProfileSearchResults');
    const backButton = overlay.querySelector('[data-global-profile-search-back]');
    if (!input || !results || !backButton) return;

    let searchTimer = null;
    let searchFocusTimer = null;
    let searchRequestId = 0;
    let previousFocus = null;

    const setSearchMessage = (message, variant = 'hint') => {
        results.replaceChildren();
        const messageEl = document.createElement('p');
        messageEl.className = `global-profile-search__message global-profile-search__message--${variant}`;
        messageEl.textContent = message;
        results.appendChild(messageEl);
    };

    const renderSearchResults = (profiles) => {
        results.replaceChildren();
        if (!Array.isArray(profiles) || profiles.length === 0) {
            setSearchMessage('No matching profiles found.', 'empty');
            return;
        }

        const fragment = document.createDocumentFragment();
        profiles.forEach((profile) => {
            const userId = Number(profile?.user_id);
            if (!Number.isInteger(userId) || userId < 1) return;

            const fullName = String(profile?.full_name || 'User').trim() || 'User';
            const roleName = String(profile?.role_name || 'User').trim() || 'User';
            const positionName = String(profile?.position_name || '').trim();
            const meta = [roleName, positionName].filter(Boolean).join(' · ');
            const normalizedRole = roleName.toLowerCase();
            const isLearner = Number(profile?.role_id) === 10
                || normalizedRole.includes('learner')
                || normalizedRole.includes('student');
            const resultLink = document.createElement('a');
            resultLink.className = 'global-profile-result';
            const targetPage = isLearner ? 'learner-profile.html' : 'profile.html';
            resultLink.href = `${getAppPathPrefix()}/pages/${targetPage}?user_id=${encodeURIComponent(userId)}`;

            const avatar = document.createElement('span');
            avatar.className = `global-profile-result__avatar presence-avatar gender-${normalizeAccountGender(profile?.gender)}`;
            avatar.setAttribute('aria-hidden', 'true');
            avatar.textContent = getAccountInitials(fullName);
            applyAccountPresence(avatar, profile);

            const copy = document.createElement('span');
            copy.className = 'global-profile-result__copy';

            const name = document.createElement('strong');
            name.className = 'global-profile-result__name';
            const nameText = document.createElement('span');
            nameText.className = 'global-profile-result__name-text';
            nameText.textContent = fullName;
            name.appendChild(nameText);
            applyDeveloperApprovedBadge(name, profile);

            const details = document.createElement('small');
            details.className = 'global-profile-result__meta';
            const presenceLabel = getAccountPresenceLabel(profile);
            details.textContent = [meta || 'Profile', presenceLabel].filter(Boolean).join(' · ');

            copy.append(name, details);

            const arrow = document.createElement('i');
            arrow.className = 'fas fa-chevron-right global-profile-result__arrow';
            arrow.setAttribute('aria-hidden', 'true');

            resultLink.append(avatar, copy, arrow);
            fragment.appendChild(resultLink);
        });

        if (!fragment.childNodes.length) {
            setSearchMessage('No matching profiles found.', 'empty');
            return;
        }
        results.appendChild(fragment);
    };

    const searchProfiles = async (query) => {
        const requestId = ++searchRequestId;
        const trimmedQuery = String(query || '').trim();
        if (trimmedQuery.length < 2) {
            setSearchMessage(trimmedQuery ? 'Type at least 2 characters to search.' : 'Search by name, role, or position.');
            return;
        }

        setSearchMessage('Searching profiles…', 'status');
        try {
            const response = await fetch(
                `${window.API_BASE}/profile/profile.php?operation=searchProfiles&q=${encodeURIComponent(trimmedQuery)}&limit=20&_=${Date.now()}`,
                {
                    credentials: 'include',
                    cache: 'no-store',
                    headers: { 'Cache-Control': 'no-store' }
                }
            );
            if (requestId !== searchRequestId) return;
            if (response.status === 401) {
                handleExpiredSession('Your session has expired. Please sign in again.');
                return;
            }
            const payload = await response.json().catch(() => null);
            if (!response.ok || !payload?.success) {
                throw new Error(payload?.message || 'Profile search failed');
            }
            renderSearchResults(payload.data);
        } catch (error) {
            if (requestId !== searchRequestId) return;
            console.warn('Profile directory search failed', error);
            setSearchMessage('Profile search is unavailable right now.', 'error');
        }
    };

    const closeSearch = ({ restoreFocus = true } = {}) => {
        window.clearTimeout(searchTimer);
        window.clearTimeout(searchFocusTimer);
        searchRequestId += 1;
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('global-profile-search-open');
        input.value = '';
        setSearchMessage('Search by name, role, or position.');
        if (restoreFocus && previousFocus && typeof previousFocus.focus === 'function') {
            previousFocus.focus();
        }
        previousFocus = null;
    };

    const openSearch = () => {
        previousFocus = document.activeElement;
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('global-profile-search-open');
        input.value = '';
        setSearchMessage('Search by name, role, or position.');
        window.clearTimeout(searchFocusTimer);
        searchFocusTimer = window.setTimeout(() => input.focus(), 240);
    };

    // Keep the field focused after the trigger's native button-focus action.
    trigger.addEventListener('mousedown', (event) => event.preventDefault());
    trigger.addEventListener('click', openSearch);
    backButton.addEventListener('click', () => closeSearch());
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeSearch();
    });
    input.addEventListener('input', () => {
        window.clearTimeout(searchTimer);
        const query = input.value;
        searchTimer = window.setTimeout(() => searchProfiles(query), 220);
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeSearch();
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && overlay.classList.contains('is-open')) closeSearch();
    });
}

function disableGlobalProfileSearchForLearner() {
    document.querySelector('[data-global-profile-search-trigger]')?.remove();
    document.getElementById('globalProfileSearch')?.remove();
    document.body?.classList.remove('global-profile-search-open');
}

function setSidebarRoleLoading(isLoading) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('is-role-loading', !!isLoading);
}

// ===========================
// Canonical Sidebar Navigation
// ===========================

function getAppPathPrefix() {
    // Prefer initAppAndApiBase-derived base (works for /deped_capstone2 and Live Server).
    // Important: empty string is a valid app base when the site is served from the domain root.
    const hasBase = (typeof window.APP_BASE === 'string');
    if (hasBase) {
        const base = String(window.APP_BASE);
        return base === '/' ? '' : base;
    }

    // Fallback: first path segment.
    const parts = String(window.location.pathname || '/').split('/').filter(Boolean);
    return parts.length ? `/${parts[0]}` : '';
}

function normalizeRoleName(roleName) {
    return String(roleName || '').trim().toLowerCase();
}

function getDashboardHrefForRole(roleName, roleId) {
    const app = getAppPathPrefix();
    const rid = Number(roleId);
    const normalized = normalizeRoleName(roleName);

    if (Number.isFinite(rid)) {
        if (rid === 10) return `${app}/dashboard/learner_dashboard.html`;
        if (rid === 9) return `${app}/dashboard/teacher_dashboard.html`;
        if (rid === 8) return `${app}/dashboard/admin_dashboard.html`;
        if (rid === 7 || rid === 11) return `${app}/dashboard/registrar_dashboard.html`;
    }

    if (normalized.includes('learner') || normalized.includes('student')) {
        return `${app}/dashboard/learner_dashboard.html`;
    }
    if (normalized.includes('teacher')) {
        return `${app}/dashboard/teacher_dashboard.html`;
    }
    if (normalized.includes('adviser') || normalized.includes('advisor')) {
        return `${app}/dashboard/teacher_dashboard.html`;
    }
    if (normalized.includes('admin')) {
        return `${app}/dashboard/admin_dashboard.html`;
    }
    if (normalized.includes('principal')) {
        return `${app}/dashboard/admin_dashboard.html`;
    }
    if (normalized.includes('registrar')) {
        return `${app}/dashboard/registrar_dashboard.html`;
    }

    return `${app}/dashboard/admin_dashboard.html`;
}

function getCurrentDashboardKind() {
    const path = String(window.location.pathname || '').toLowerCase();
    if (path.endsWith('/dashboard/admin_dashboard.html') || path.endsWith('admin_dashboard.html')) return 'admin';
    if (path.endsWith('/dashboard/teacher_dashboard.html') || path.endsWith('teacher_dashboard.html')) return 'teacher';
    if (path.endsWith('/dashboard/learner_dashboard.html') || path.endsWith('learner_dashboard.html')) return 'learner';
    if (path.endsWith('/dashboard/registrar_dashboard.html') || path.endsWith('registrar_dashboard.html')) return 'registrar';
    return null;
}

function enforceDashboardForRole(user) {
    const current = getCurrentDashboardKind();
    if (!current) return;

    const target = getDashboardHrefForRole(user?.role_name, user?.role_id);
    const targetKind = String(target).toLowerCase().includes('learner_dashboard')
        ? 'learner'
        : String(target).toLowerCase().includes('teacher_dashboard')
            ? 'teacher'
            : String(target).toLowerCase().includes('registrar_dashboard')
                ? 'registrar'
                : 'admin';

    if (current !== targetKind) {
        window.location.href = target;
    }
}

function enforcePageAccessForRole(roleKey) {
    const rk = String(roleKey || '').toLowerCase();
    if (!rk) return;

    const path = String(window.location.pathname || '').toLowerCase().replace(/\/+$/, '');
    const targetDashboard = getDashboardHrefForRole(window.CURRENT_ROLE_NAME, window.CURRENT_ROLE_ID);

    // Balik-Aral / returnee classification comes from the imported LIS/DepEd
    // source record. The standalone review page is retired; use the normal
    // Enrollments import/list for the stored classification and status.
    if (/\/pages\/returnee-review\.html$/.test(path)) {
        window.location.replace(`${getAppPathPrefix()}/pages/enrollments.html`);
        return;
    }

    // SF10 / Permanent Record is registrar-only.
    if (/\/pages\/sf10\.html$/.test(path) && rk !== 'registrar') {
        window.location.replace(targetDashboard);
        return;
    }

    // Promotion is handled automatically inside the Enrollments import workflow.
    if (/\/pages\/promotions\.html$/.test(path)) {
        window.location.replace(`${getAppPathPrefix()}/pages/enrollments.html`);
        return;
    }

    // Admin can access everything else.
    if (rk === 'admin') return;

    if (rk === 'principal') {
        const isPrincipalAllowedPage = (
            /\/dashboard\/admin_dashboard\.html$/.test(path)
            || /\/pages\/(profile|profile-security|learner-profile|settings)\.html$/.test(path)
            || /\/pages\/notifications\.html$/.test(path)
            || /\/pages\/(grade-monitoring|audit-logs|class-records|report-cards|risk-assessment)\.html$/.test(path)
            || /\/pages\/analytics\/(dashboard-overview|risk-analytics)\.html$/.test(path)
        );

        if (/\/pages\//.test(path) && !isPrincipalAllowedPage) {
            window.location.replace(targetDashboard);
        }
    }

    // Guard a few known admin-only pages (regardless of role).
    const isAdminOnlyPage = /\/pages\/masterfiles\/roles\.html$/.test(path)
        || /\/pages\/masterfiles\/risk-actions\.html$/.test(path)
        || /\/pages\/account-deactivation-requests\.html$/.test(path);
    if (isAdminOnlyPage && rk !== 'admin') {
        window.location.replace(targetDashboard);
        return;
    }

    // Learners should not access admin/teacher operational modules.
    if (rk === 'learners') {
        const isLearnerAllowedPage = (
            /\/dashboard\/learner_dashboard\.html$/.test(path)
            || /\/pages\/(profile|profile-security|learner-profile|settings)\.html$/.test(path)
            || /\/pages\/(class-schedules|grades|report-cards|attendance|academic-status|notifications)\.html$/.test(path)
        );

        // Any other /pages/* route is treated as not-for-learners.
        if (/\/pages\//.test(path) && !isLearnerAllowedPage) {
            window.location.replace(targetDashboard);
        }
    }

    // Teachers should only access teacher-allowed modules (UI gating; backend remains authoritative).
    if (rk === 'teacher' || rk === 'adviser' || rk === 'advisor') {
        const isTeacherAllowedPage = (
            /\/dashboard\/teacher_dashboard\.html$/.test(path)
            || /\/pages\/(profile|profile-security|learner-profile|settings)\.html$/.test(path)
            || /\/pages\/notifications\.html$/.test(path)
            || /\/pages\/(class-offerings|class-schedules|class-records|attendance|risk-assessment)\.html$/.test(path)
            || /\/pages\/(enrollments|report-cards)\.html$/.test(path)
            || /\/pages\/masterfiles\/learners\.html$/.test(path)
        );

        if (/\/pages\//.test(path) && !isTeacherAllowedPage) {
            window.location.replace(targetDashboard);
        }
    }

    // Registrar: allow monitoring/reporting modules without granting full admin access.
    if (rk === 'registrar') {
        const isRegistrarAllowedPage = (
            /\/dashboard\/(admin|teacher|registrar)_dashboard\.html$/.test(path)
            || /\/pages\/(profile|profile-security|learner-profile|settings)\.html$/.test(path)
            || /\/pages\/notifications\.html$/.test(path)
            || /\/pages\/class-schedules\.html$/.test(path)
            || /\/pages\/academic-setup\.html$/.test(path)
            || /\/pages\/enrollments\.html$/.test(path)
            || /\/pages\/family-members\.html$/.test(path)
            || /\/pages\/masterfiles\/learners\.html$/.test(path)
            || /\/pages\/masterfiles\/sections\.html$/.test(path)
            || /\/pages\/masterfiles\/(users|employees)\.html$/.test(path)
            || /\/pages\/analytics\/(dashboard-overview|risk-analytics)\.html$/.test(path)
            || /\/pages\/grade-monitoring\.html$/.test(path)
            || /\/pages\/report-cards\.html$/.test(path)
            || /\/pages\/sf10\.html$/.test(path)
        );

        if (/\/pages\//.test(path) && !isRegistrarAllowedPage) {
            window.location.replace(targetDashboard);
        }
    }
}

function ensureCanonicalSidebarNav({ roleKey } = {}) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const nav = sidebar.querySelector('.sidebar-nav');
    if (!nav) return;

    const list = nav.querySelector('.nav-list');
    if (!list) return;

    // Avoid re-rendering if already generated
    if (list.dataset.canonicalNav === '1') return;

    const app = getAppPathPrefix();
    const rk = String(roleKey || '').toLowerCase();

    const isAdmin = rk === 'admin';
    const isTeacher = rk === 'teacher' || rk === 'adviser' || rk === 'advisor';
    const isLearner = rk === 'learners';
    const isRegistrar = rk === 'registrar';
    const isPrincipal = rk === 'principal';

    const homeHref = (() => {
        try {
            return getDashboardHrefForRole(window.CURRENT_ROLE_NAME, window.CURRENT_ROLE_ID);
        } catch (_) {
            return `${app}/dashboard/admin_dashboard.html`;
        }
    })();

    const page = (href, label, icon) => ({ href: `${app}${href}`, label, icon });
    const nestedGroup = (id, label, icon, items) => ({ nested: true, id, label, icon, items });

    const groups = [];

    // Home / Dashboard
    groups.push({
        id: 'home',
        label: 'Home / Dashboard',
        icon: 'fa-home',
        items: [{ href: homeHref, label: 'Home', icon: 'fa-home' }]
    });

    // Academic navigation is exposed as independent sidebar groups without a
    // parent toggle around these options.
    const academicItems = [];
    const learnerEnrollmentItems = [];
    const schoolSetupItems = [];
    if (isAdmin || isRegistrar) {
        schoolSetupItems.push(page('/pages/academic-setup.html', 'Academic Year Setup', 'fa-calendar-plus'));
    }
    if (isAdmin || isRegistrar || isTeacher) {
        learnerEnrollmentItems.push(page('/pages/masterfiles/learners.html', 'Learner Profile', 'fa-user-graduate'));
    }
    if (isAdmin || isRegistrar || isTeacher) {
        learnerEnrollmentItems.push(page('/pages/enrollments.html', 'Enrollments', 'fa-user-plus'));
    }
    if (learnerEnrollmentItems.length) {
        academicItems.push(nestedGroup('learner_enrollment', 'Records', 'fa-user-graduate', learnerEnrollmentItems));
    }
    if (isAdmin || isRegistrar) {
        schoolSetupItems.push(page('/pages/masterfiles/sections.html', 'Sections', 'fa-school'));
    }
    if (schoolSetupItems.length) {
        academicItems.push(nestedGroup('school_setup', 'Setup', 'fa-calendar-check', schoolSetupItems));
    }

    const classSetupItems = [];
    if (isAdmin || isTeacher) {
        classSetupItems.push(page('/pages/class-offerings.html', isTeacher ? 'My classes' : 'Class Offerings', 'fa-clipboard-list'));
    }
    if (isAdmin || isTeacher || isRegistrar || isLearner) {
        classSetupItems.push(page('/pages/class-schedules.html', 'Class Schedules', 'fa-calendar-days'));
    }
    if (classSetupItems.length) {
        academicItems.push(nestedGroup('class_setup', 'Class Setup', 'fa-chalkboard-teacher', classSetupItems));
    }
    groups.push(...academicItems);

    // Operations
    const operationsItems = [];
    if (isLearner) {
        operationsItems.push(page('/pages/academic-status.html', 'My Academic Status', 'fa-chart-pie'));
    }
    if (isAdmin || isTeacher || isLearner) {
        operationsItems.push(page('/pages/attendance.html', 'Attendance', 'fa-user-check'));
    }
    if (isAdmin || isTeacher) {
        operationsItems.push(page('/pages/class-records.html', 'Grade input', 'fa-book'));
    }
    if (isAdmin || isTeacher || isRegistrar || isLearner) {
        operationsItems.push(page('/pages/report-cards.html', isLearner ? 'Grades' : 'Report Cards', 'fa-file-alt'));
    }
    if (isRegistrar) {
        operationsItems.push(page('/pages/sf10.html', 'School Form 10', 'fa-file-contract'));
    }
    if (isAdmin || isTeacher) {
        operationsItems.push(page('/pages/risk-assessment.html', 'Risk Assessment', 'fa-exclamation-triangle'));
    }
    if (isAdmin || isRegistrar || isPrincipal) {
        operationsItems.push(page('/pages/grade-monitoring.html', 'Grade Input Monitoring', 'fa-chart-line'));
    }
    if (operationsItems.length) {
        groups.push({ id: 'operations', label: 'Operations', icon: 'fa-exchange-alt', items: operationsItems });
    }

    // The centered Analytics control is intentionally hidden on small screens.
    // Keep the same role gate and four destinations available through the
    // mobile sidebar instead of duplicating a separate analytics permission
    // model.
    const analyticsRole = normalizeRoleName(rk);
    const canAccessAnalytics = ['admin', 'registrar', 'principal'].includes(analyticsRole)
        || analyticsRole.includes('principal')
        || analyticsRole.includes('school_head')
        || analyticsRole.includes('school head');
    if (canAccessAnalytics) {
        groups.push({
            id: 'mobile_analytics',
            label: 'Analytics',
            icon: 'fa-chart-line',
            mobileOnly: true,
            items: [
                page('/pages/analytics/dashboard-overview.html?view=population', 'Learner Population', 'fa-users'),
                page('/pages/analytics/dashboard-overview.html?view=proficiency', 'Proficiency Levels', 'fa-award'),
                page('/pages/analytics/dashboard-overview.html?view=trends', 'Trends', 'fa-chart-line'),
                page('/pages/analytics/risk-analytics.html', 'Risk Assessment', 'fa-triangle-exclamation')
            ]
        });
    }

    // Admin / System
    const adminItems = [];
    if (isAdmin || isRegistrar) {
        adminItems.push(page('/pages/masterfiles/users.html', 'Users', 'fa-users'));
    }
    if (isAdmin) {
        adminItems.push(page('/pages/reported-posts.html', 'Reported posts', 'fa-flag'));
        adminItems.push(page('/pages/masterfiles/school-years.html', 'School Year & Periods', 'fa-calendar-check'));

        const masterListReferenceItems = [];

        masterListReferenceItems.push(nestedGroup('people', 'People', 'fa-users', [
            page('/pages/masterfiles/roles.html', 'Roles', 'fa-user-tag'),
            page('/pages/masterfiles/positions.html', 'Positions', 'fa-sitemap')
        ]));

        masterListReferenceItems.push(nestedGroup('academic', 'Academic Setup', 'fa-graduation-cap', [
            page('/pages/masterfiles/education-levels.html', 'Education Levels', 'fa-graduation-cap'),
            page('/pages/masterfiles/grade-levels.html', 'Grade Levels', 'fa-layer-group'),
            page('/pages/masterfiles/subjects.html', 'Subjects', 'fa-book'),
            page('/pages/masterfiles/subject-categories.html', 'Subject Categories', 'fa-layer-group')
        ]));

        adminItems.push(page('/pages/masterfiles/curriculum-components.html', 'Curriculum Components', 'fa-puzzle-piece'));

        masterListReferenceItems.push(nestedGroup('reference', 'Reference Data', 'fa-database', [
            page('/pages/masterfiles/honor-levels.html', 'Honor Levels', 'fa-award'),
            page('/pages/masterfiles/name-extensions.html', 'Name Extensions', 'fa-signature')
        ]));

        masterListReferenceItems.push(nestedGroup('risk_support', 'Risk Support', 'fa-exclamation-circle', [
            page('/pages/masterfiles/risk-levels.html', 'Risk Levels', 'fa-triangle-exclamation'),
            page('/pages/masterfiles/risk-actions.html', 'Recommended Actions', 'fa-list-alt')
        ]));

        adminItems.push(nestedGroup('master_list_references', 'Master List References', 'fa-list-check', masterListReferenceItems));
    }
    if (adminItems.length) {
        groups.push({ id: 'admin', label: 'Admin / System', icon: 'fa-cogs', items: adminItems });
    }

    const renderLearnerNavItem = (it) => `
        <li class="nav-item learner-flat-nav-item">
            <a href="${it.href}" class="nav-link">
                <i class="fas ${it.icon || 'fa-folder'}"></i>
                <span>${escapeHtml(it.label)}</span>
            </a>
        </li>
    `;

    const flattenNavItems = (items) => (Array.isArray(items) ? items : []).flatMap((it) => (
        it?.nested ? flattenNavItems(it.items) : [it]
    ));

    const renderItem = (it, groupId = '') => {
        if (it.nested) {
            const nid = `${groupId}_${it.id}`;
            return `
                <li class="nav-item has-submenu nested-submenu" id="${nid}NavGroup">
                    <a href="#" class="nav-link nested-toggle" id="${nid}Toggle" data-toggle="submenu" aria-expanded="false">
                        <i class="fas ${it.icon || 'fa-folder'}"></i>
                        <span>${escapeHtml(it.label)}</span>
                        <i class="fas fa-chevron-down submenu-icon"></i>
                    </a>
                    <ul class="submenu nested" id="${nid}Submenu">
                        ${it.items.map((child) => renderItem(child, nid)).join('')}
                    </ul>
                </li>
            `;
        }
        return `<li><a href="${it.href}"><i class="fas ${it.icon}"></i> ${escapeHtml(it.label)}</a></li>`;
    };

    if (isLearner) {
        const learnerItems = groups.flatMap((group) => flattenNavItems(group.items));
        list.innerHTML = learnerItems.map(renderLearnerNavItem).join('');
    } else {
        list.innerHTML = groups.map((g) => {
        if (g.items.length === 1 && g.id === 'home') {
            const it = g.items[0];
            return `
                <li class="nav-item">
                    <a href="${it.href}" class="nav-link">
                        <i class="fas ${it.icon}"></i>
                        <span>${escapeHtml(it.label)}</span>
                    </a>
                </li>
            `;
        }
        const mobileOnlyClass = g.mobileOnly ? ' mobile-only-nav-group' : '';
        return `
                <li class="nav-item has-submenu${mobileOnlyClass}" id="${g.id}NavGroup">
                <a href="#" class="nav-link" id="${g.id}Toggle" data-toggle="submenu" aria-expanded="false">
                    <i class="fas ${g.icon}"></i>
                    <span>${escapeHtml(g.label)}</span>
                    <i class="fas fa-chevron-down submenu-icon"></i>
                </a>
                <ul class="submenu" id="${g.id}Submenu">
                    ${g.items.map((it) => renderItem(it, g.id)).join('')}
                </ul>
                </li>
        `;
        }).join('');
    }

    renderDashboardShortcuts(groups, roleKey);
    renderMobileDashboardQuickNav(groups, roleKey);
    list.dataset.canonicalNav = '1';

    bindSidebarGroups();
    ensureSidebarSearch();
    setActiveNavLink();
    setSidebarRoleLoading(false);
}

const DASHBOARD_NOTIFICATION_COLLAPSED_KEY = 'depedDashboardNotificationsCollapsed';

function setDashboardNotificationPanelCollapsed(panel, collapsed) {
    if (!panel) return;

    const isCollapsed = Boolean(collapsed);
    panel.dataset.notificationsCollapsed = String(isCollapsed);
    panel.classList.toggle('is-collapsed', isCollapsed);

    const control = panel.querySelector('[data-notification-collapse]');
    if (!control) return;

    const label = control.querySelector('[data-notification-collapse-label]');
    if (label) label.textContent = isCollapsed ? 'Show' : 'Hide';
    control.setAttribute('aria-expanded', String(!isCollapsed));
    control.title = isCollapsed ? 'Show notifications' : 'Hide notifications';
}

function getDashboardNotificationPanelCollapsed() {
    try {
        return window.localStorage.getItem(DASHBOARD_NOTIFICATION_COLLAPSED_KEY) === 'true';
    } catch (_) {
        return false;
    }
}

function ensureDashboardNotificationPanel(home) {
    if (!home) return null;

    let panel = home.querySelector('#dashboardNotificationPanel');
    if (panel) return panel;

    panel = document.createElement('aside');
    panel.id = 'dashboardNotificationPanel';
    panel.className = 'dashboard-notification-panel';
    panel.setAttribute('aria-labelledby', 'dashboardNotificationTitle');
    panel.innerHTML = `
        <div class="dashboard-notification-panel__inner">
            <header class="dashboard-notification-panel__header">
                <div>
                    <h2 id="dashboardNotificationTitle">Notifications</h2>
                </div>
                <div class="dashboard-notification-panel__actions">
                    <button type="button" class="notification-mark-all" data-notification-mark-all hidden>
                        Mark all as read
                    </button>
                    <span class="dashboard-notification-panel__count" id="dashboardNotificationPanelCount">Loading</span>
                    <button type="button" class="dashboard-notification-collapse" data-notification-collapse aria-expanded="true" aria-controls="dashboardNotificationPanelBody" title="Hide notifications">
                        <span data-notification-collapse-label>Hide</span>
                    </button>
                </div>
            </header>
            <div class="dashboard-notification-panel__body" id="dashboardNotificationPanelBody" aria-live="polite">
                <div class="dashboard-notification-empty dashboard-notification-empty--loading">
                    <span class="dashboard-notification-empty__icon" aria-hidden="true"><i class="fas fa-spinner fa-spin"></i></span>
                    <h3>Loading updates</h3>
                    <p>Checking for new announcements and account activity.</p>
                </div>
                <footer class="dashboard-notification-panel__footer">
                    <button type="button" class="dashboard-notification-toggle" data-notification-toggle aria-expanded="false" aria-controls="dashboardNotificationPanelBody" hidden>
                        <span data-notification-toggle-label>Load more</span>
                        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                </footer>
            </div>
        </div>
    `;
    panel.dataset.notificationsExpanded = 'false';
    setDashboardNotificationPanelCollapsed(panel, getDashboardNotificationPanelCollapsed());

    const collapse = panel.querySelector('[data-notification-collapse]');
    if (collapse) {
        collapse.addEventListener('click', () => {
            const isCollapsed = panel.dataset.notificationsCollapsed === 'true';
            const nextCollapsed = !isCollapsed;
            setDashboardNotificationPanelCollapsed(panel, nextCollapsed);
            try {
                window.localStorage.setItem(DASHBOARD_NOTIFICATION_COLLAPSED_KEY, String(nextCollapsed));
            } catch (_) {
                // ignore storage failures; the control still works for this page
            }
        });
    }

    const toggle = panel.querySelector('[data-notification-toggle]');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const expanded = panel.dataset.notificationsExpanded === 'true';
            panel.dataset.notificationsExpanded = String(!expanded);
            renderNotificationPanel(
                panel,
                panel.__notificationItems || [],
                panel.__notificationUnread || 0
            );
        });
    }
    home.appendChild(panel);
    const markAll = panel.querySelector('[data-notification-mark-all]');
    if (markAll) {
        markAll.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void markAllDashboardNotifications(markAll, panel);
        });
    }
    return panel;
}

// Reuse the canonical navigation model so shortcuts inherit its role restrictions.
function renderDashboardShortcuts(groups, roleKey = '') {
    const home = document.querySelector('.announcement-dashboard #homeSection');
    if (!home || !document.getElementById('announcementsFeed')) return;
    let rail = document.getElementById('dashboardShortcuts');
    if (!rail) {
        rail = document.createElement('aside');
        rail.id = 'dashboardShortcuts';
        rail.className = 'dashboard-shortcuts';
        rail.setAttribute('aria-label', 'Profile and module shortcuts');
        home.prepend(rail);
        const feedColumn = document.createElement('div');
        feedColumn.className = 'dashboard-feed-column';
        Array.from(home.children).filter(node => node !== rail).forEach(node => feedColumn.appendChild(node));
        home.appendChild(feedColumn);
        home.classList.add('dashboard-feed-layout', 'active');
    }
    const notificationPanel = ensureDashboardNotificationPanel(home);
    if (notificationPanel && typeof window.refreshNotifications === 'function') {
        void window.refreshNotifications({ render: false });
    }
    const flatten = items => items.flatMap(item => item.nested ? flatten(item.items) : [item]);
    const academicGroupIds = new Set(['learner_enrollment', 'school_setup', 'class_setup']);
    const academic = groups
        .filter((group) => academicGroupIds.has(group.id))
        .flatMap((group) => flatten(group.items || []));
    const operations = flatten(groups.find(group => group.id === 'operations')?.items || []);
    const preferred = ['class-schedules', 'class-records', 'class-offerings', 'risk-assessment', 'report-cards'];
    const candidates = [...academic, ...operations];
    const ordered = preferred.map(slug => candidates.find(item => item.href.endsWith('/' + slug + '.html'))).filter(Boolean);
    operations.forEach(item => { if (!ordered.includes(item)) ordered.push(item); });
    const enrollment = academic.find(item => item.href.endsWith('/enrollments.html'));
    if (enrollment) ordered.push(enrollment);
    const iconAssets = {
        'class-schedules': 'schedule.png',
        'class-records': 'grades.png',
        'class-offerings': 'classoffer.png',
        'risk-assessment': 'riskassess.png',
        'report-cards': 'reportcard.png',
        'attendance': 'attendance.png',
        'academic-status': 'academic.png',
        'enrollments': 'enrollments.png',
        'grade-monitoring': 'gradeinputmonitoring.png',
        'sf10': 'sf10.png',
        'dashboard-overview': 'students-2.png',
        'risk-analytics': 'riskassessanalytics.png'
    };
    const renderShortcutLink = (item, extraClass = '') => {
        const slug = item.href.split('/').pop().split('?')[0].replace('.html', '');
        const label = slug === 'class-records' ? 'Grade input' : item.label;
        // Sidebar items carry Font Awesome class names in `item.icon`, while
        // this dashboard rail renders image assets. Prefer the module-specific
        // PNG mapping and only use `item.icon` for entries that provide a real
        // image filename (for example the Load more analytics links).
        const iconAsset = (item.icon && String(item.icon).includes('.'))
            ? item.icon
            : (iconAssets[slug] || item.icon || iconAssets['report-cards']);
        const iconSrc = `${getAppPathPrefix()}/assets/icons/${iconAsset}`;
        return `<a class="dashboard-module-link ${extraClass}" href="${escapeHtml(item.href)}"><img class="dashboard-option-icon dashboard-option-icon-${slug}" src="${escapeHtml(iconSrc)}" alt="" aria-hidden="true"><span>${escapeHtml(label)}</span></a>`;
    };
    const analyticsRole = normalizeRoleName(roleKey);
    const canAccessAnalytics = ['admin', 'registrar', 'principal'].includes(analyticsRole)
        || analyticsRole.includes('principal')
        || analyticsRole.includes('school_head')
        || analyticsRole.includes('school head');
    const analyticsItems = canAccessAnalytics ? [
        { href: `${getAppPathPrefix()}/pages/analytics/dashboard-overview.html?view=population`, label: 'Learner Population', icon: 'students-2.png' },
        { href: `${getAppPathPrefix()}/pages/analytics/dashboard-overview.html?view=proficiency`, label: 'Proficiency Levels', icon: 'professionalism.png' },
        { href: `${getAppPathPrefix()}/pages/analytics/dashboard-overview.html?view=trends`, label: 'Trends', icon: 'trend.png' },
        { href: `${getAppPathPrefix()}/pages/analytics/risk-analytics.html`, label: 'Risk Assessment', icon: 'data-sample.png' }
    ] : [];
    const analyticsMarkup = analyticsItems.length ? `<div class="dashboard-analytics-disclosure">
        <nav class="dashboard-module-links dashboard-analytics-links" id="dashboardAnalyticsLinks" aria-label="Analytics" hidden>${analyticsItems.map(item => renderShortcutLink(item, 'dashboard-analytics-link')).join('')}</nav>
        <button type="button" class="dashboard-analytics-toggle" data-dashboard-analytics-toggle aria-expanded="false" aria-controls="dashboardAnalyticsLinks">
            <span>Load more</span>
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
    </div>` : '';
    rail.innerHTML = `<div class="dashboard-shortcuts__body">
        <a class="dashboard-profile-link" href="${getAppPathPrefix()}/pages/profile.html">
            <span class="user-avatar" aria-hidden="true"></span>
            <span class="dashboard-profile-copy"><strong class="dashboard-profile-name"></strong><span>View profile</span></span>
        </a><nav class="dashboard-module-links" aria-label="Your modules">${ordered.map(item => renderShortcutLink(item)).join('')}</nav>${analyticsMarkup}
    </div>`;
    if (!rail.dataset.analyticsToggleBound) {
        rail.addEventListener('click', (event) => {
            const analyticsToggle = event.target.closest('[data-dashboard-analytics-toggle]');
            if (!analyticsToggle || !rail.contains(analyticsToggle)) return;
            event.preventDefault();
            const analyticsLinks = rail.querySelector('#dashboardAnalyticsLinks');
            const expanded = analyticsToggle.getAttribute('aria-expanded') === 'true';
            analyticsToggle.setAttribute('aria-expanded', String(!expanded));
            analyticsToggle.querySelector('span').textContent = expanded ? 'Load more' : 'See less';
            analyticsToggle.classList.toggle('is-expanded', !expanded);
            rail.classList.toggle('analytics-expanded', !expanded);
            if (analyticsLinks) {
                analyticsLinks.hidden = expanded;
                analyticsLinks.setAttribute('aria-hidden', String(expanded));
                if (!expanded) analyticsLinks.querySelector('a')?.focus({ preventScroll: true });
            }
        });
        rail.dataset.analyticsToggleBound = '1';
    }
}

// Keep the small-screen dashboard actions visible without duplicating the
// role/access model used by the canonical sidebar.
function renderMobileDashboardQuickNav(groups = [], roleKey = '') {
    const path = String(window.location.pathname || '').toLowerCase().replace(/\/+$/, '');
    const isDashboardRoute = /\/dashboard\/(admin|teacher|registrar|learner)_dashboard\.html$/.test(path);
    const isQuickHeaderRoute = isDashboardRoute
        || /\/pages\/(class-records|attendance|academic-status|risk-assessment|notifications|profile|learner-profile|grade-monitoring|sf10)\.html$/.test(path);
    if (!isQuickHeaderRoute) return;

    const topbar = document.querySelector('.topbar');
    if (!topbar) return;
    document.body.classList.add('mobile-quick-header-page');

    let nav = topbar.querySelector('#mobileDashboardQuickNav');
    if (!nav) {
        nav = document.createElement('nav');
        nav.id = 'mobileDashboardQuickNav';
        nav.className = 'mobile-dashboard-quick-nav';
        nav.setAttribute('aria-label', 'Quick dashboard pages');
        topbar.appendChild(nav);
    }

    const flatten = (items) => (Array.isArray(items) ? items : []).flatMap((item) => (
        item?.nested ? flatten(item.items) : [item]
    ));
    const groupList = Array.isArray(groups) ? groups : [];
    const homeItem = groupList.find((group) => group.id === 'home')?.items?.[0];
    const operations = flatten(groupList.find((group) => group.id === 'operations')?.items || []);
    const getSlug = (item) => String(item?.href || '').split('/').pop().split('?')[0].replace(/\.html$/, '');
    const operationBySlug = new Map(operations.map((item) => [getSlug(item), item]));
    const preferredSlugs = ['class-records', 'attendance', 'risk-assessment'];
    const quickOperations = [];

    preferredSlugs.forEach((slug) => {
        const item = operationBySlug.get(slug);
        if (item) {
            quickOperations.push(item);
        }
    });
    const remainingOperations = operations.filter((item) => {
        const slug = getSlug(item);
        return slug !== 'report-cards' && !quickOperations.includes(item);
    });
    const app = getAppPathPrefix();
    const currentPath = path;
    const iconMarkup = (item) => {
        const slug = getSlug(item);
        const iconClasses = {
            'class-records': 'fa-book',
            attendance: 'fa-user-check',
            'risk-assessment': 'fa-exclamation-triangle',
            'grade-monitoring': 'fa-chart-line',
            profile: 'fa-user',
            'learner-profile': 'fa-user'
        };
        const iconClass = iconClasses[slug] || item.icon || 'fa-arrow-right';
        return `<i class="fas ${escapeHtml(iconClass)}" aria-hidden="true"></i>`;
    };
    const linkMarkup = (item, extraClass = '') => {
        const slug = getSlug(item);
        const label = slug === 'class-records' ? 'Grade input' : item.label;
        const active = currentPath.endsWith('/' + slug + '.html') || (slug === 'home' && /\/dashboard\/[^/]+_dashboard\.html$/.test(currentPath));
        return `<a class="mobile-dashboard-quick-link ${extraClass}${active ? ' is-current' : ''}" href="${escapeHtml(item.href)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"${active ? ' aria-current="page"' : ''}>${iconMarkup(item)}<span>${escapeHtml(label)}</span></a>`;
    };
    const notificationHref = `${app}/pages/notifications.html`;
    const notificationMarkup = `<a class="mobile-dashboard-quick-link mobile-dashboard-quick-link--priority mobile-dashboard-quick-link--notifications" href="${notificationHref}" aria-label="Notifications" title="Notifications"><i class="fas fa-bell" aria-hidden="true"></i><span>Notifications</span></a>`;
    const normalizedRoleKey = String(roleKey || '').toLowerCase();
    const isLearnerQuickNav = normalizedRoleKey.includes('learner') || normalizedRoleKey.includes('student');
    const profileMarkup = isLearnerQuickNav
        ? linkMarkup({ href: `${app}/pages/learner-profile.html`, label: 'Profile', icon: 'fa-user' }, 'mobile-dashboard-quick-link--priority mobile-dashboard-quick-link--profile')
        : '';
    const priorityCount = (homeItem ? 1 : 0) + quickOperations.length + 1 + (isLearnerQuickNav ? 1 : 0);

    nav.style.setProperty('--quick-priority-count', String(Math.max(1, priorityCount)));
    nav.innerHTML = `${homeItem ? linkMarkup({ ...homeItem, label: 'Home', icon: 'fa-home' }, 'mobile-dashboard-quick-link--home mobile-dashboard-quick-link--priority') : ''}${quickOperations.map((item) => linkMarkup(item, 'mobile-dashboard-quick-link--priority')).join('')}${notificationMarkup}${profileMarkup}${remainingOperations.map((item) => linkMarkup(item)).join('')}`;
    nav.dataset.role = String(roleKey || '');
}

// ===========================
// Navigation Functions
// ===========================

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function bindSidebarGroups() {
    document.querySelectorAll('[data-toggle="submenu"]').forEach((toggle) => {
        toggle.addEventListener('click', (e) => {
            e.preventDefault();
            const sidebar = toggle.closest('#sidebar');
            if (sidebar?.classList.contains('is-searching')) return;
            const parentItem = toggle.closest('.nav-item');
            const submenu = parentItem?.querySelector('.submenu');
            if (parentItem) parentItem.classList.toggle('open');
            if (submenu) submenu.classList.toggle('open');
            toggle.setAttribute('aria-expanded', String(parentItem?.classList.contains('open') || false));
        });
    });
}

function initializeNavigation() {
    bindSidebarGroups();
    ensureSidebarSearch();
    setActiveNavLink();
}

function normalizeSidebarSearchText(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function ensureSidebarSearch() {
    const sidebar = document.getElementById('sidebar');
    const nav = sidebar?.querySelector('.sidebar-nav');
    const list = nav?.querySelector('.nav-list');
    if (!sidebar || !nav || !list) return;

    let search = nav.querySelector('#sidebarNavSearch');
    if (!search) {
        const searchWrap = document.createElement('div');
        searchWrap.className = 'sidebar-search';
        searchWrap.innerHTML = `
            <label class="sidebar-search-box" for="sidebarNavSearch">
                <i class="fas fa-search" aria-hidden="true"></i>
                <input type="search" id="sidebarNavSearch" autocomplete="off" placeholder="Search navigation">
            </label>
            <p class="sidebar-search-empty" id="sidebarSearchEmpty">No navigation matches</p>
        `;
        nav.insertBefore(searchWrap, list);
        search = searchWrap.querySelector('#sidebarNavSearch');
        search.addEventListener('input', () => applySidebarSearch(search.value));
        search.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                search.value = '';
                applySidebarSearch('');
                search.blur();
            }
        });
    }

    applySidebarSearch(search.value);
}

function getSidebarItemLabel(item) {
    const ownLink = item.querySelector(':scope > .nav-link, :scope > a');
    return normalizeSidebarSearchText(ownLink?.textContent || item.textContent || '');
}

function setSidebarGroupOpen(item, shouldOpen) {
    const toggle = item.querySelector(':scope > [data-toggle="submenu"]');
    const submenu = item.querySelector(':scope > .submenu');
    item.classList.toggle('open', shouldOpen);
    if (submenu) submenu.classList.toggle('open', shouldOpen);
    if (toggle) toggle.setAttribute('aria-expanded', String(shouldOpen));
}

function filterSidebarItem(item, query) {
    const ownLabel = getSidebarItemLabel(item);
    const ownMatch = ownLabel.includes(query);
    const childItems = Array.from(item.querySelectorAll(':scope > .submenu > li'));
    let childMatched = false;

    childItems.forEach((child) => {
        if (filterSidebarItem(child, query)) {
            childMatched = true;
        }
    });

    const hasChildren = childItems.length > 0;
    const isVisible = ownMatch || childMatched;
    item.classList.toggle('nav-search-hidden', !isVisible);
    item.classList.toggle('nav-search-ancestor', childMatched && !ownMatch);

    if (hasChildren) {
        setSidebarGroupOpen(item, isVisible);
    }

    return isVisible;
}

function resetSidebarSearch() {
    const sidebar = document.getElementById('sidebar');
    const list = sidebar?.querySelector('.nav-list');
    if (!sidebar || !list) return;

    sidebar.classList.remove('is-searching');
    list.querySelectorAll('.nav-search-hidden').forEach((item) => item.classList.remove('nav-search-hidden'));
    list.querySelectorAll('.nav-search-ancestor').forEach((item) => item.classList.remove('nav-search-ancestor'));
    list.querySelectorAll('.has-submenu').forEach((item) => setSidebarGroupOpen(item, false));
    setActiveNavLink();
}

function applySidebarSearch(rawQuery) {
    const sidebar = document.getElementById('sidebar');
    const list = sidebar?.querySelector('.nav-list');
    if (!sidebar || !list) return;

    const query = normalizeSidebarSearchText(rawQuery);
    const empty = sidebar.querySelector('#sidebarSearchEmpty');
    if (!query) {
        if (empty) empty.classList.remove('show');
        resetSidebarSearch();
        return;
    }

    sidebar.classList.add('is-searching');
    const topItems = Array.from(list.children).filter((child) => child.matches('li'));
    let visibleCount = 0;
    topItems.forEach((item) => {
        if (filterSidebarItem(item, query)) {
            visibleCount += 1;
        }
    });

    if (empty) empty.classList.toggle('show', visibleCount === 0);
}

function setActiveNavLink() {
    const currentUrl = new URL(window.location.href);
    const navLinks = document.querySelectorAll('.nav-link, .submenu a');

    const normalizedPath = (pathname) => String(pathname || '/').replace(/\/+$/, '') || '/';

    // Analytics has several destinations on the same HTML page. Comparing
    // only pathname makes every dashboard-overview view look active at once
    // because population, proficiency, and trends differ by query string.
    // Treat the default population view as the canonical no-query URL so the
    // page remains correctly highlighted when opened without ?view=.
    const canonicalSearch = (url) => {
        const params = Array.from(url.searchParams.entries())
            .filter(([key, value]) => !(key === 'view' && value === 'population'))
            .sort(([aKey, aValue], [bKey, bValue]) => (
                aKey.localeCompare(bKey) || aValue.localeCompare(bValue)
            ));
        return params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    };

    const currentPath = normalizedPath(currentUrl.pathname);
    const currentSearch = canonicalSearch(currentUrl);
    const currentHash = currentUrl.hash || '';

    function openParentGroups(link) {
        let parent = link.closest('.has-submenu');
        while (parent) {
            parent.classList.add('open');
            const submenu = parent.querySelector(':scope > .submenu');
            if (submenu) submenu.classList.add('open');
            const toggle = parent.querySelector(':scope > [data-toggle="submenu"]');
            if (toggle) toggle.setAttribute('aria-expanded', 'true');
            parent = parent.parentElement?.closest('.has-submenu');
        }
    }

    navLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (!href || href === '#' || href.startsWith('javascript:')) return;

        const resolved = (() => {
            try {
                return new URL(href, currentUrl.href);
            } catch (_) {
                return null;
            }
        })();

        if (!resolved) return;

        const samePath = currentPath === normalizedPath(resolved.pathname);
        const sameSearch = currentSearch === canonicalSearch(resolved);
        const linkHash = resolved.hash || '';
        const sameHash = linkHash ? linkHash === currentHash : !currentHash;
        const isActive = samePath && sameSearch && sameHash;
        if (isActive) {
            link.classList.add('active');
            link.setAttribute('aria-current', 'page');
            openParentGroups(link);
        } else {
            link.classList.remove('active');
            link.removeAttribute('aria-current');
        }
    });
}

// ===========================
// User Menu Functions
// ===========================

function getStudentRecoveryReturnPath() {
    const appBase = String(window.APP_BASE || '').replace(/\/+$/, '');
    const pathname = String(window.location.pathname || '');
    const basePrefix = appBase && appBase !== '/' ? appBase : '';
    const relativePath = basePrefix && pathname.startsWith(`${basePrefix}/`)
        ? pathname.slice(basePrefix.length + 1)
        : pathname.replace(/^\/+/, '');

    return /^(?:pages|dashboard)\/[A-Za-z0-9/_-]+\.html$/.test(relativePath)
        ? relativePath
        : 'pages/profile-security.html';
}

function buildStudentRecoveryHref() {
    const appBase = String(window.APP_BASE || '').replace(/\/+$/, '');
    return `${appBase}/adviser-recovery.php?return=${encodeURIComponent(getStudentRecoveryReturnPath())}`;
}

function ensureStudentRecoveryLink() {
    const userDropdown = document.getElementById('userDropdown');
    if (!userDropdown) return null;

    let recoveryLink = userDropdown.querySelector('[data-student-recovery]');
    if (recoveryLink) {
        recoveryLink.href = buildStudentRecoveryHref();
        return recoveryLink;
    }

    recoveryLink = document.createElement('a');
    recoveryLink.href = buildStudentRecoveryHref();
    recoveryLink.dataset.studentRecovery = '';
    recoveryLink.innerHTML = '<i class="fas fa-user-shield"></i> Student account recovery';
    recoveryLink.hidden = true;
    recoveryLink.setAttribute('aria-hidden', 'true');

    const settingsLink = userDropdown.querySelector('a[href*="settings"]');
    const divider = userDropdown.querySelector('hr');
    if (settingsLink && settingsLink.nextSibling) {
        userDropdown.insertBefore(recoveryLink, settingsLink.nextSibling);
    } else if (divider) {
        userDropdown.insertBefore(recoveryLink, divider);
    } else {
        userDropdown.appendChild(recoveryLink);
    }

    return recoveryLink;
}

function applyDashboardStudentRecoveryPermission(user) {
    const recoveryLink = ensureStudentRecoveryLink();
    if (!recoveryLink) return;

    const roleId = Number(user?.role_id || 0);
    const roleKey = String(user?.role_key || user?.role_name || '').trim().toLowerCase();
    const canReview = [7, 8, 9, 11].includes(roleId)
        || roleKey === 'teacher'
        || roleKey === 'adviser'
        || roleKey === 'advisor'
        || roleKey === 'registrar'
        || roleKey === 'admin';

    recoveryLink.hidden = !canReview;
    recoveryLink.setAttribute('aria-hidden', String(!canReview));
}

function ensureAuditLogsInProfileDropdown() {
    const userDropdown = document.getElementById('userDropdown');
    if (!userDropdown) return;

    // Password management is available from Settings > Account Passwords.
    // Remove any stale link left by an older cached dashboard script.
    userDropdown.querySelectorAll('a[href*="profile-security.html"]').forEach((link) => link.remove());

    let auditLink = userDropdown.querySelector('a[href*="audit-logs.html"]');
    if (auditLink) {
        auditLink.dataset.adminOnly = 'true';
        auditLink.hidden = true;
        auditLink.setAttribute('aria-hidden', 'true');
        return;
    }

    const sampleLink = userDropdown.querySelector('a[href*="profile.html"], a[href*="settings.html"]');
    let auditHref = 'pages/audit-logs.html';
    if (sampleLink) {
        const href = sampleLink.getAttribute('href') || '';
        if (href.startsWith('../pages/')) {
            auditHref = '../pages/audit-logs.html';
        } else if (href.startsWith('../')) {
            auditHref = '../audit-logs.html';
        } else if (href.startsWith('pages/')) {
            auditHref = 'pages/audit-logs.html';
        } else if (!href.includes('/')) {
            auditHref = 'audit-logs.html';
        }
    }

    auditLink = document.createElement('a');
    auditLink.href = auditHref;
    auditLink.dataset.adminOnly = 'true';
    auditLink.hidden = true;
    auditLink.setAttribute('aria-hidden', 'true');
    auditLink.innerHTML = '<i class="fas fa-clipboard-list"></i> Audit Logs';

    const profileLink = userDropdown.querySelector('a[href*="profile"]');
    const settingsLink = userDropdown.querySelector('a[href*="settings"]');
    const hr = userDropdown.querySelector('hr');

    if (profileLink && profileLink.nextSibling) {
        userDropdown.insertBefore(auditLink, profileLink.nextSibling);
    } else if (settingsLink) {
        userDropdown.insertBefore(auditLink, settingsLink);
    } else if (hr) {
        userDropdown.insertBefore(auditLink, hr);
    } else {
        userDropdown.appendChild(auditLink);
    }
}

function applyDashboardAuditLogPermission(user) {
    const auditLink = document.querySelector('#userDropdown a[data-admin-only="true"][href*="audit-logs.html"]');
    const requestLink = ensureAccountDeactivationRequestsLink();

    const roleId = Number(user?.role_id || 0);
    const roleKey = String(user?.role_key || user?.role_name || '').trim().toLowerCase();
    const isAdmin = roleId === 8
        || roleKey === 'admin'
        || roleKey === 'administrator'
        || roleKey.includes('admin');

    if (auditLink) {
        auditLink.hidden = !isAdmin;
        auditLink.setAttribute('aria-hidden', String(!isAdmin));
    }
    if (requestLink) {
        requestLink.hidden = !isAdmin;
        requestLink.setAttribute('aria-hidden', String(!isAdmin));
    }
}

function ensureAccountDeactivationRequestsLink() {
    const userDropdown = document.getElementById('userDropdown');
    if (!userDropdown) return null;

    let requestLink = userDropdown.querySelector('a[href*="account-deactivation-requests.html"]');
    if (requestLink) {
        requestLink.dataset.adminOnly = 'true';
        requestLink.hidden = true;
        requestLink.setAttribute('aria-hidden', 'true');
        return requestLink;
    }

    const sampleLink = userDropdown.querySelector('a[href*="profile.html"], a[href*="settings.html"]');
    let requestHref = 'pages/account-deactivation-requests.html';
    if (sampleLink) {
        const href = sampleLink.getAttribute('href') || '';
        if (href.startsWith('../pages/')) requestHref = '../pages/account-deactivation-requests.html';
        else if (href.startsWith('../')) requestHref = '../account-deactivation-requests.html';
        else if (href.startsWith('pages/')) requestHref = 'pages/account-deactivation-requests.html';
        else if (!href.includes('/')) requestHref = 'account-deactivation-requests.html';
    }

    requestLink = document.createElement('a');
    requestLink.href = requestHref;
    requestLink.dataset.adminOnly = 'true';
    requestLink.hidden = true;
    requestLink.setAttribute('aria-hidden', 'true');
    requestLink.innerHTML = '<i class="fas fa-user-slash"></i> Account deactivation requests';

    const auditLink = userDropdown.querySelector('a[href*="audit-logs.html"]');
    const settingsLink = userDropdown.querySelector('a[href*="settings"]');
    const divider = userDropdown.querySelector('hr');
    if (auditLink && auditLink.nextSibling) userDropdown.insertBefore(requestLink, auditLink.nextSibling);
    else if (settingsLink) userDropdown.insertBefore(requestLink, settingsLink);
    else if (divider) userDropdown.insertBefore(requestLink, divider);
    else userDropdown.appendChild(requestLink);
    return requestLink;
}

function applyDashboardAccountDeactivationPermission(user) {
    const requestLink = ensureAccountDeactivationRequestsLink();
    if (!requestLink) return;
    const roleId = Number(user?.role_id || 0);
    const roleKey = String(user?.role_key || user?.role_name || '').trim().toLowerCase();
    const isAdmin = roleId === 8 || roleKey === 'admin' || roleKey === 'administrator' || roleKey.includes('admin');
    requestLink.hidden = !isAdmin;
    requestLink.setAttribute('aria-hidden', String(!isAdmin));
}

function showSkippedPasswordPolicyWarningOnce(user) {
    if (!user?.must_change_password) {
        try {
            sessionStorage.removeItem('passwordChangeRequired');
            sessionStorage.removeItem('passwordChangeSkipped');
            sessionStorage.removeItem('passwordChangeSkipAlertShown');
        } catch (_) {
            // ignore storage errors
        }
        return;
    }

    let shouldShow = false;
    try {
        shouldShow = sessionStorage.getItem('passwordChangeSkipped') === '1'
            && sessionStorage.getItem('passwordChangeSkipAlertShown') !== '1';
        if (shouldShow) {
            sessionStorage.setItem('passwordChangeSkipAlertShown', '1');
        }
    } catch (_) {
        shouldShow = false;
    }

    if (!shouldShow) return;

    const message = 'Your account is still using a temporary/default password. Anyone who knows the default pattern may be able to access the account. Please change it soon from Settings > Account Passwords.';
    const target = `${window.APP_BASE || ''}/pages/settings.html#account-security`;

    if (window.Swal && typeof window.Swal.fire === 'function') {
        window.Swal.fire({
            icon: 'warning',
            title: 'Password Security Risk',
            text: message,
            confirmButtonText: 'Change Password',
            showCancelButton: true,
            cancelButtonText: 'Later',
            confirmButtonColor: '#b91c1c'
        }).then((result) => {
            if (result.isConfirmed) {
                window.location.href = target;
            }
        });
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'password-policy-modal-overlay';
    overlay.innerHTML = `
        <div class="password-policy-modal" role="alertdialog" aria-modal="true" aria-labelledby="passwordPolicyTitle">
            <div class="password-policy-modal__icon"><i class="fas fa-triangle-exclamation"></i></div>
            <h2 id="passwordPolicyTitle">Password Security Risk</h2>
            <p>${message}</p>
            <div class="password-policy-modal__actions">
                <button type="button" class="btn btn-outline" data-password-policy-later>Later</button>
                <button type="button" class="btn btn-primary" data-password-policy-open><i class="fas fa-key"></i> Change Password</button>
            </div>
        </div>
    `;

    if (!document.getElementById('passwordPolicyModalStyles')) {
        const style = document.createElement('style');
        style.id = 'passwordPolicyModalStyles';
        style.textContent = `
            .password-policy-modal-overlay{position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(15,23,42,.54)}
            .password-policy-modal{width:min(440px,100%);background:var(--surface-0,#fff);border-radius:8px;box-shadow:0 24px 60px rgba(15,23,42,.28);padding:1.35rem;text-align:center;border-top:5px solid #b91c1c}
            .password-policy-modal__icon{width:54px;height:54px;margin:0 auto .75rem;display:grid;place-items:center;border-radius:999px;background:#fee2e2;color:#b91c1c;font-size:1.45rem}
            .password-policy-modal h2{margin:0;color:var(--gray-900,#111827);font-size:1.15rem;font-weight:850}
            .password-policy-modal p{margin:.65rem 0 0;color:var(--gray-700,#374151);line-height:1.5}
            .password-policy-modal__actions{display:flex;justify-content:center;gap:.75rem;flex-wrap:wrap;margin-top:1.15rem}
        `;
        document.head.appendChild(style);
    }

    const close = () => overlay.remove();
    overlay.querySelector('[data-password-policy-later]')?.addEventListener('click', close);
    overlay.querySelector('[data-password-policy-open]')?.addEventListener('click', () => {
        window.location.href = target;
    });
    document.body.appendChild(overlay);
}

function initializeUserMenu() {
    ensureStudentRecoveryLink();
    ensureAuditLogsInProfileDropdown();
    ensureAccountDeactivationRequestsLink();
    const userMenuBtn = document.getElementById('userMenuBtn');
    const userDropdown = document.getElementById('userDropdown');

    if (userMenuBtn && userDropdown) {
        userMenuBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            userDropdown.classList.toggle('show');
            userMenuBtn.setAttribute('aria-expanded', String(userDropdown.classList.contains('show')));
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', function (e) {
            if (!userMenuBtn.contains(e.target) && !userDropdown.contains(e.target)) {
                userDropdown.classList.remove('show');
                userMenuBtn.setAttribute('aria-expanded', 'false');
            }
        });
    }

    document.querySelectorAll('a.logout').forEach(link => {
        link.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                await axios.post(`${window.API_BASE}/auth/logout.php`);
            } catch (error) {
                console.error('Logout error', error);
            } finally {
                try {
                    sessionStorage.setItem('sessionEnded', '1');
                    sessionStorage.setItem('sessionEndReason', 'logout');
                } catch (_) {
                    // ignore storage errors
                }
                window.location.replace(`${window.APP_BASE}/index.html`);
            }
        });
    });
}

function getWelcomeRoleLabel(user) {
    const roleName = normalizeRoleName(user?.role_name);
    const roleId = Number(user?.role_id || 0);
    const roleKey = normalizeRoleName(user?.role_key);

    if (roleKey.includes('registrar') || roleName.includes('registrar') || roleId === 7 || roleId === 11) return 'Registrar';
    if (roleKey.includes('admin') || roleName.includes('admin') || roleId === 8) return 'Admin';
    if (roleKey.includes('teacher') || roleKey.includes('adviser') || roleKey.includes('advisor') || roleName.includes('teacher') || roleName.includes('adviser') || roleName.includes('advisor') || roleId === 9) return 'Teacher';
    if (roleKey.includes('learner') || roleKey.includes('student') || roleName.includes('learner') || roleName.includes('student') || roleId === 10) return 'Learner';

    return String(user?.role_name || 'User').trim() || 'User';
}

function shouldPlayWelcomeSpeech() {
    try {
        return sessionStorage.getItem('welcomeSpeechPending') === '1';
    } catch (_) {
        return false;
    }
}

function clearWelcomeSpeechFlag() {
    try {
        sessionStorage.removeItem('welcomeSpeechPending');
    } catch (_) {
        // ignore storage errors
    }
}

function speakSystemMessage(message, options = {}) {
    const synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') return;

    let didSpeak = false;
    const speak = () => {
        if (didSpeak) return;
        didSpeak = true;
        try {
            if (options.cancel !== false) synth.cancel();
            const utterance = new SpeechSynthesisUtterance(String(message || ''));
            utterance.lang = options.lang || 'en-US';
            utterance.rate = Number(options.rate || 0.95);
            utterance.pitch = Number(options.pitch || 1);
            utterance.volume = Number(options.volume || 0.9);
            synth.speak(utterance);
        } catch (_) {
            // Speech is optional; never block the UI.
        }
    };

    if (typeof synth.getVoices === 'function' && synth.getVoices().length === 0) {
        const handleVoices = () => {
            synth.removeEventListener?.('voiceschanged', handleVoices);
            speak();
        };
        synth.addEventListener?.('voiceschanged', handleVoices, { once: true });
        window.setTimeout(speak, 350);
        return;
    }

    speak();
}

function speakWelcomeAfterLogin(user, fullName) {
    if (!shouldPlayWelcomeSpeech()) return;
    clearWelcomeSpeechFlag();

    const roleLabel = getWelcomeRoleLabel(user);
    const displayName = String(fullName || user?.username || 'User').trim();
    speakSystemMessage(`Welcome. You are signed in as ${roleLabel}, ${displayName}.`);
}

const SESSION_IDLE_MONITOR = {
    bound: false,
    warningTimer: null,
    expiryTimer: null,
    timeoutMs: 0,
    warningLeadMs: 60000,
    lastActivityMs: Date.now(),
    lastEventMs: 0,
    lastPingMs: 0,
    warned: false
};

function clearSessionIdleTimers() {
    if (SESSION_IDLE_MONITOR.warningTimer) {
        window.clearTimeout(SESSION_IDLE_MONITOR.warningTimer);
        SESSION_IDLE_MONITOR.warningTimer = null;
    }
    if (SESSION_IDLE_MONITOR.expiryTimer) {
        window.clearTimeout(SESSION_IDLE_MONITOR.expiryTimer);
        SESSION_IDLE_MONITOR.expiryTimer = null;
    }
}

function scheduleSessionIdleTimers() {
    clearSessionIdleTimers();
    if (!SESSION_IDLE_MONITOR.timeoutMs) return;

    const now = Date.now();
    const warnAt = SESSION_IDLE_MONITOR.lastActivityMs + SESSION_IDLE_MONITOR.timeoutMs - SESSION_IDLE_MONITOR.warningLeadMs;
    const expireAt = SESSION_IDLE_MONITOR.lastActivityMs + SESSION_IDLE_MONITOR.timeoutMs + 1000;
    const warnDelay = Math.max(0, warnAt - now);
    const expireDelay = Math.max(1000, expireAt - now);

    SESSION_IDLE_MONITOR.warningTimer = window.setTimeout(showSessionTimeoutWarning, warnDelay);
    SESSION_IDLE_MONITOR.expiryTimer = window.setTimeout(() => {
        handleExpiredSession('Session expired');
    }, expireDelay);
}

function showSessionTimeoutWarning() {
    if (SESSION_IDLE_MONITOR.warned || window.__sessionExpiredDisplayShown) return;
    SESSION_IDLE_MONITOR.warned = true;
    const warningMessage = 'Your session timeout is about to expire. Please continue using the system to stay signed in.';
    if (typeof showNotification === 'function') {
        showNotification(warningMessage, 'info');
    }
    speakSystemMessage(warningMessage);
}

async function refreshSessionActivityQuietly() {
    const now = Date.now();
    if (now - SESSION_IDLE_MONITOR.lastPingMs < 60000) return;
    SESSION_IDLE_MONITOR.lastPingMs = now;

    try {
        const res = await fetch(`${window.API_BASE}/auth/me.php`, {
            credentials: 'include',
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-store' }
        });
        if (res.status === 401) {
            handleExpiredSession('Session expired');
            return;
        }
        if (!res.ok) return;
        const payload = await res.json().catch(() => null);
        const timeoutSeconds = Number(payload?.data?.session_idle_timeout_seconds || 0);
        if (timeoutSeconds > 0) {
            SESSION_IDLE_MONITOR.timeoutMs = Math.max(300000, timeoutSeconds * 1000);
            SESSION_IDLE_MONITOR.warningLeadMs = Math.min(60000, Math.max(30000, SESSION_IDLE_MONITOR.timeoutMs * 0.2));
        }
    } catch (_) {
        // A transient network miss should not interrupt active work.
    }
}

function recordSessionActivity() {
    const now = Date.now();
    if (now - SESSION_IDLE_MONITOR.lastEventMs < 1000) return;
    SESSION_IDLE_MONITOR.lastEventMs = now;
    SESSION_IDLE_MONITOR.lastActivityMs = now;
    SESSION_IDLE_MONITOR.warned = false;
    scheduleSessionIdleTimers();
    refreshSessionActivityQuietly();
}

function bindSessionActivityEvents() {
    if (SESSION_IDLE_MONITOR.bound) return;
    SESSION_IDLE_MONITOR.bound = true;
    ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((eventName) => {
        window.addEventListener(eventName, recordSessionActivity, { passive: true });
    });
}

function startSessionTimeoutMonitor(user) {
    const timeoutSeconds = Number(user?.session_idle_timeout_seconds || 0);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return;

    SESSION_IDLE_MONITOR.timeoutMs = Math.max(300000, timeoutSeconds * 1000);
    SESSION_IDLE_MONITOR.warningLeadMs = Math.min(60000, Math.max(30000, SESSION_IDLE_MONITOR.timeoutMs * 0.2));
    SESSION_IDLE_MONITOR.lastActivityMs = Date.now();
    SESSION_IDLE_MONITOR.lastPingMs = Date.now();
    SESSION_IDLE_MONITOR.warned = false;
    bindSessionActivityEvents();
    scheduleSessionIdleTimers();
}

function getAccountDisplayName(user) {
    const firstName = String(user?.first_name || '').trim();
    const lastName = String(user?.last_name || '').trim();
    const name = `${firstName} ${lastName}`.trim();
    return name || String(user?.full_name || '').trim() || String(user?.username || '').trim() || 'User';
}

function isDeveloperProfile(user) {
    return String(user?.position_name || '').trim().toLowerCase() === 'developer';
}

function renderDeveloperApprovedBadgeMarkup(user) {
    if (!isDeveloperProfile(user)) return '';
    const src = `${getAppPathPrefix()}/assets/icons/contacts/approved.png`;
    return `<img class="developer-approved-badge" src="${src}" alt="Approved developer" title="Approved developer">`;
}

function applyDeveloperApprovedBadge(target, user) {
    if (!target) return;

    target.querySelectorAll('.developer-approved-badge').forEach((badge) => badge.remove());
    const isDeveloper = isDeveloperProfile(user);
    target.classList.toggle('developer-profile-name', isDeveloper);
    if (!isDeveloper) return;

    const badge = document.createElement('img');
    badge.className = 'developer-approved-badge';
    badge.src = `${getAppPathPrefix()}/assets/icons/contacts/approved.png`;
    badge.alt = 'Approved developer';
    badge.title = 'Approved developer';
    target.appendChild(badge);
}

window.isDeveloperProfile = isDeveloperProfile;
window.renderDeveloperApprovedBadgeMarkup = renderDeveloperApprovedBadgeMarkup;
window.applyDeveloperApprovedBadge = applyDeveloperApprovedBadge;

function getAccountInitials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'U';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

const ACCOUNT_PRESENCE_WINDOW_SECONDS = 300;

function getAccountPresence(account) {
    const source = account?.presence && typeof account.presence === 'object'
        ? account.presence
        : (account || {});
    const lastSeenAt = String(source.last_seen_at || '').trim();
    const lastLogin = String(source.last_login || '').trim();
    const parseOptionalSeconds = (value) => {
        if (value === null || value === undefined
            || (typeof value === 'string' && value.trim() === '')) {
            return Number.POSITIVE_INFINITY;
        }
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric >= 0
            ? numeric
            : Number.POSITIVE_INFINITY;
    };
    const explicitLastSeenSeconds = parseOptionalSeconds(source.last_seen_seconds_ago);
    const explicitLastLoginSeconds = parseOptionalSeconds(source.last_login_seconds_ago);
    const parsedLastSeen = lastSeenAt ? new Date(lastSeenAt.replace(' ', 'T')) : null;
    const lastSeenSeconds = Number.isFinite(explicitLastSeenSeconds) && explicitLastSeenSeconds >= 0
        ? explicitLastSeenSeconds
        : parsedLastSeen && !Number.isNaN(parsedLastSeen.getTime())
        ? Math.max(0, Math.floor((Date.now() - parsedLastSeen.getTime()) / 1000))
        : Number.POSITIVE_INFINITY;
    const hasExplicitOnlineState = Object.prototype.hasOwnProperty.call(source, 'is_online');
    const isOnline = hasExplicitOnlineState
        ? (source.is_online === true || ['1', 'true', 'yes'].includes(String(source.is_online || '').toLowerCase()))
        : lastSeenSeconds <= ACCOUNT_PRESENCE_WINDOW_SECONDS;

    const lastLoginSeconds = Number.isFinite(explicitLastLoginSeconds) && explicitLastLoginSeconds >= 0
        ? explicitLastLoginSeconds
        : Number.POSITIVE_INFINITY;
    return { isOnline, lastSeenAt, lastLogin, lastSeenSeconds, lastLoginSeconds };
}

function formatLastSeen(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'last seen unknown';
    const parsed = new Date(raw.replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) return 'last seen unknown';

    const seconds = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}hr ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}wk ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(days / 365)}yr ago`;
}

function formatLastSeenSeconds(seconds) {
    const age = Number(seconds);
    if (!Number.isFinite(age) || age < 0) return 'last seen unknown';
    if (age < 60) return 'Just now';
    const minutes = Math.floor(age / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}hr ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}wk ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(days / 365)}yr ago`;
}

function getAccountPresenceLabel(account) {
    const presence = getAccountPresence(account);
    if (presence.isOnline) return 'Active';
    const ageSeconds = Number.isFinite(presence.lastSeenSeconds) && presence.lastSeenSeconds >= 0
        ? presence.lastSeenSeconds
        : presence.lastLoginSeconds;
    return Number.isFinite(ageSeconds) && ageSeconds >= 0
        ? formatLastSeenSeconds(ageSeconds)
        : formatLastSeen(presence.lastSeenAt || presence.lastLogin);
}

function applyAccountPresence(avatar, account) {
    if (!avatar) return;
    const presence = getAccountPresence(account);
    avatar.classList.add('presence-avatar');
    avatar.dataset.presenceState = presence.isOnline ? 'online' : 'offline';
    avatar.title = getAccountPresenceLabel(account);

    let indicator = avatar.querySelector(':scope > .presence-indicator');
    if (!indicator) {
        indicator = document.createElement('span');
        indicator.className = 'presence-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        avatar.appendChild(indicator);
    }
}

function renderPresenceAvatarMarkup({ initials, genderClass = 'gender-neutral', account = {}, avatarClass = '', ariaLabel = '' } = {}) {
    const presence = getAccountPresence(account);
    const label = ariaLabel || getAccountPresenceLabel(account);
    return `<span class="presence-avatar ${avatarClass}" data-presence-state="${presence.isOnline ? 'online' : 'offline'}" title="${escapeHtml(label)}">
        <span class="${avatarClass} ${genderClass}">${escapeHtml(initials || 'U')}</span>
        <span class="presence-indicator" aria-hidden="true"></span>
    </span>`;
}

function normalizeAccountGender(gender) {
    const value = String(gender || '').trim().toLowerCase();
    if (value === 'm' || value === 'male' || value === 'man' || value === 'boy') return 'male';
    if (value === 'f' || value === 'female' || value === 'woman' || value === 'girl') return 'female';
    if (value) return 'other';
    return 'neutral';
}

function applyAccountIdentity(user, fullName) {
    const initials = getAccountInitials(fullName);
    const genderClass = `gender-${normalizeAccountGender(user?.gender)}`;
    document.querySelectorAll('.user-avatar').forEach((avatar) => {
        avatar.classList.remove('gender-male', 'gender-female', 'gender-other', 'gender-neutral');
        avatar.classList.add(genderClass);
        avatar.textContent = initials;
        avatar.setAttribute('aria-label', `${fullName} profile`);
        applyAccountPresence(avatar, user);
    });
}

async function loadUserSession() {
    try {
        const response = await axios.get(`${window.API_BASE}/auth/me.php`);
        if (!response.data?.success) {
            return;
        }

        const user = response.data.data || {};

        // Expose session info for UI helpers.
        window.CURRENT_USER_ID = Number(user.user_id || 0);
        window.CURRENT_ROLE_ID = Number(user.role_id || 0);
        window.CURRENT_ROLE_NAME = String(user.role_name || '');
        window.CURRENT_DEVICE_IS_MAIN = user.session_device?.is_main_device === true;
        window.CURRENT_USER_PRESENCE = user.presence || { is_online: true };

        if (user.must_change_password) {
            try {
                sessionStorage.setItem('passwordChangeRequired', '1');
            } catch (_) {
                // ignore storage errors
            }
        }
        setTimeout(() => showSkippedPasswordPolicyWarningOnce(user), 350);

        // Ensure the correct dashboard for the current role.
        enforceDashboardForRole(user);

        const nameEl = document.querySelector('.user-name');
        const roleEl = document.querySelector('.user-role');
        const fullName = getAccountDisplayName(user);
        if (nameEl) {
            nameEl.textContent = fullName;
            applyDeveloperApprovedBadge(nameEl, user);
        }
        if (roleEl) roleEl.textContent = user.role_name || 'Role';
        const sidebarNameEl = document.querySelector('.sidebar-profile-name');
        const sidebarRoleEl = document.querySelector('.sidebar-profile-role');
        if (sidebarNameEl) {
            sidebarNameEl.textContent = fullName;
            applyDeveloperApprovedBadge(sidebarNameEl, user);
        }
        if (sidebarRoleEl) sidebarRoleEl.textContent = user.role_name || 'Role';
        applyAccountIdentity(user, fullName);
        speakWelcomeAfterLogin(user, fullName);
        startSessionTimeoutMonitor(user);

        const roleNorm = normalizeRoleName(user.role_name);
        const isLearner = roleNorm.includes('learner') || roleNorm.includes('student') || Number(user.role_id) === 10;

        document.body.classList.toggle('learner-mobile-topbar', isLearner);

        if (isLearner) {
            disableGlobalProfileSearchForLearner();
        }

        const portalEl = document.querySelector('.logo-text p');
        if (portalEl) {
            if (isLearner) {
                portalEl.textContent = 'Learner Portal';
            } else if (roleNorm.includes('teacher') || roleNorm.includes('adviser') || roleNorm.includes('advisor') || Number(user.role_id) === 9) {
                portalEl.textContent = 'Teacher Portal';
            } else {
                portalEl.textContent = 'Administrative Dashboard';
            }
        }

        const userDropdownLinks = document.querySelectorAll('#userDropdown a');
        userDropdownLinks.forEach((a) => {
            const href = String(a.getAttribute('href') || '');
            if (href.includes('profile.html') && isLearner) {
                a.setAttribute('href', href.replace(/profile\.html/, 'learner-profile.html'));
                const icon = a.querySelector('i');
                a.innerHTML = '';
                if (icon) a.appendChild(icon);
                a.appendChild(document.createTextNode(' My Profile'));
            }
        });

        // Render role-appropriate sidebar navigation after we know the role.
        // Clear canonical flag so it re-renders once.
        try {
            const list = document.querySelector('#sidebar .sidebar-nav .nav-list');
            if (list) {
                delete list.dataset.canonicalNav;
            }
        } catch (_) {
            // ignore
        }

        const serverRoleKey = String(user?.role_key || '').trim().toLowerCase();

        let roleKey = serverRoleKey;
        if (!roleKey) {
            roleKey = normalizeRoleName(user?.role_name).includes('admin')
                ? 'admin'
                : (normalizeRoleName(user?.role_name).includes('teacher') || normalizeRoleName(user?.role_name).includes('adviser') || normalizeRoleName(user?.role_name).includes('advisor'))
                    ? 'teacher'
                    : (Number(user?.role_id) === 10 || normalizeRoleName(user?.role_name).includes('learner') || normalizeRoleName(user?.role_name).includes('student'))
                        ? 'learners'
                        : (Number(user?.role_id) === 9 ? 'teacher' : (Number(user?.role_id) === 8 ? 'admin' : ((Number(user?.role_id) === 7 || Number(user?.role_id) === 11) ? 'registrar' : '')));
        }

        if (!roleKey) {
            const rn = normalizeRoleName(user?.role_name);
            if (rn && rn.includes('registrar')) {
                roleKey = 'registrar';
            }
        }

        window.CURRENT_ROLE_KEY = roleKey;
        syncTopbarCenterAnalytics(roleKey);

        applyDashboardStudentRecoveryPermission({ ...user, role_key: roleKey });
        applyDashboardAuditLogPermission({ ...user, role_key: roleKey });
        applyDashboardAccountDeactivationPermission({ ...user, role_key: roleKey });
        syncSidebarProfileMenu();

        // Enforce page access rules (e.g., prevent learners from opening admin modules by URL).
        enforcePageAccessForRole(roleKey);

        ensureCanonicalSidebarNav({ roleKey });
        const profileLink = document.querySelector('.dashboard-profile-link');
        if (profileLink) {
            profileLink.href = `${getAppPathPrefix()}/pages/${isLearner ? 'learner-profile' : 'profile'}.html`;
            const profileName = profileLink.querySelector('.dashboard-profile-name');
            if (profileName) {
                profileName.textContent = String(user.full_name || '').trim() || [user.first_name, user.middle_name, user.last_name, user.extension_name].filter(Boolean).join(' ').trim() || fullName;
                applyDeveloperApprovedBadge(profileName, user);
            }
            applyAccountIdentity(user, fullName);
        }
        document.getElementById('userMenuBtn')?.setAttribute('aria-label', `Open profile menu for ${fullName}`);
        document.querySelector('.sidebar-profile-button')?.setAttribute('aria-label', `Open profile menu for ${fullName}`);
    } catch (error) {
        if (error?.response?.status === 401) {
            handleExpiredSession(error?.response?.data?.message || 'Session expired');
            return;
        }
        console.warn('Session check failed', error);
    }
}

// ===========================
// Sidebar Toggle Functions
// ===========================

function initializeSidebarToggle() {
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebar');
    let overlay = document.getElementById('sidebarOverlay');

    // Ensure overlay exists on all pages (e.g., masterfiles)
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'sidebarOverlay';
        overlay.className = 'sidebar-overlay';
        document.body.appendChild(overlay);
    }

    if (!menuToggle || !sidebar) return;

    const menuToggleIcon = menuToggle.querySelector('i');
    const updateMenuToggleState = (isOpen) => {
        menuToggle.classList.toggle('is-sidebar-open', isOpen);
        menuToggle.setAttribute('aria-expanded', String(isOpen));
        menuToggle.setAttribute('aria-label', 'Open sidebar');
        menuToggle.title = 'Open sidebar';

        if (menuToggleIcon) {
            menuToggleIcon.classList.add('fa-bars');
            menuToggleIcon.classList.remove('fa-arrow-left');
        }
    };

    const openSidebar = () => {
        sidebar.classList.add('show');
        document.body.classList.add('sidebar-open');
        updateMenuToggleState(true);
    };

    const closeSidebar = () => {
        sidebar.classList.remove('show');
        document.body.classList.remove('sidebar-open');
        window.closeSidebarProfileMenu?.();
        updateMenuToggleState(false);
    };

    // Expose the same close action to page-level navigation handlers. This
    // keeps hash navigation and full-page links from leaving the mobile rail
    // covering the destination content.
    window.closeDashboardSidebar = closeSidebar;

    const toggleSidebar = () => {
        if (sidebar.classList.contains('show')) {
            closeSidebar();
        } else {
            openSidebar();
        }
    };

    menuToggle.addEventListener('click', toggleSidebar);
    updateMenuToggleState(sidebar.classList.contains('show'));

    sidebar.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (!link || !sidebar.contains(link)) return;
        if (link.getAttribute('href') === '#' || link.dataset.toggle === 'submenu') return;
        closeSidebar();
    });

    if (overlay) {
        overlay.addEventListener('click', closeSidebar);
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeSidebar();
        }
    });
}

// ===========================
// Dashboard Data Loading
// ===========================

async function loadDashboardData() {
    const dashboardKind = getCurrentDashboardKind();
    if (dashboardKind !== 'admin' && dashboardKind !== 'teacher') {
        // Metrics endpoint is for admin/teacher dashboard analytics.
        // Skip on learner dashboards and generic pages that also include dashboard.js.
        return;
    }

    try {
        const metrics = await fetchMetrics();

        // Cache and broadcast metrics so charts can reuse them
        window.dashboardMetrics = metrics;
        document.dispatchEvent(new CustomEvent('dashboard:metrics', { detail: metrics }));

        // Load summary statistics
        loadSummaryStats(metrics.stats);

        // Load alerts (still using sample data unless an alerts API is added)
        await loadAlerts();

        // Charts are initialized in dashboard-charts.js; they listen for dashboard:metrics
    } catch (error) {
        console.error('Error loading dashboard data:', error);

        if (window.location.protocol === 'file:') {
            showNotification('Dashboard cannot load via file://. Open using http://localhost/...', 'error');
            return;
        }

        const status = error?.response?.status;
        const msg = status ? `Error loading dashboard data (HTTP ${status})` : 'Error loading dashboard data';
        showNotification(msg, 'error');
    }
}

async function fetchMetrics() {
    const response = await axios.get(`${window.API_BASE}/dashboard/metrics.php`, {
        params: { _cb: Date.now() }
    });
    if (!response.data?.success) {
        throw new Error(response.data?.message || 'Failed to load metrics');
    }
    return response.data.data;
}

function loadSummaryStats(stats) {
    if (!stats) return;
    updateElement('totalStudents', stats.totalStudents ?? 0);
    updateElement('totalTeachers', stats.totalTeachers ?? 0);
    updateElement('totalClasses', stats.totalClasses ?? 0);
    updateElement('schoolYearLabel', stats.schoolYear ?? '');
    updateElement('currentSchoolYear', stats.schoolYear ?? '—');
    updateElement('dashboardSchoolYear', stats.schoolYear ?? '—');
}

async function loadAlerts() {
    try {
        // Fetch real alerts from API
        const response = await axios.get(`${window.API_BASE}/dashboard/alerts.php`);

        if (response.data?.success && response.data?.data) {
            const alerts = response.data.data;
            displayAlerts(alerts);
        } else {
            // Fallback to computed alerts if API returns no data
            const computedAlerts = generateAlerts();
            displayAlerts(computedAlerts);
        }
    } catch (error) {
        console.warn('Error loading alerts from API, generating computed alerts:', error);
        // Generate alerts based on current metrics
        const computedAlerts = generateAlerts();
        displayAlerts(computedAlerts);
    }
}

function generateAlerts() {
    const alerts = [];
    const metrics = window.dashboardMetrics;

    if (!metrics) return [];

    // Alert 1: At-risk students
    const atRiskCount = metrics.stats?.atRiskStudents ?? 0;
    if (atRiskCount > 0) {
        alerts.push({
            id: 1,
            message: `${atRiskCount} students identified as at-risk`,
            severity: atRiskCount > 10 ? 'high' : 'medium',
            time: 'Just now'
        });
    }

    // Alert 2: Enrollment stats
    const totalStudents = metrics.stats?.totalStudents ?? 0;
    if (totalStudents > 0) {
        alerts.push({
            id: 2,
            message: `Total enrolled students: ${totalStudents}`,
            severity: 'info',
            time: 'Current S.Y.'
        });
    }

    // Alert 3: Classes
    const totalClasses = metrics.stats?.totalClasses ?? 0;
    if (totalClasses > 0) {
        alerts.push({
            id: 3,
            message: `${totalClasses} active classes this school year`,
            severity: 'info',
            time: 'Current S.Y.'
        });
    }

    // Alert 4: Teachers
    const totalTeachers = metrics.stats?.totalTeachers ?? 0;
    if (totalTeachers > 0) {
        alerts.push({
            id: 4,
            message: `${totalTeachers} instructors assigned`,
            severity: 'info',
            time: 'Current S.Y.'
        });
    }

    return alerts.length > 0 ? alerts : [
        {
            id: 1,
            message: 'Dashboard system initialized and running',
            severity: 'info',
            time: 'Now'
        }
    ];
}

function displayAlerts(alerts) {
    const alertsLists = [
        document.getElementById('alertsList'),
        document.getElementById('alertsListOverview')
    ].filter(Boolean);
    if (!alertsLists.length) return;

    alertsLists.forEach((alertsList) => {
        alertsList.innerHTML = '';
    });

    if (!alerts || alerts.length === 0) {
        const noAlertsItem = document.createElement('div');
        noAlertsItem.className = 'alert-item info';
        noAlertsItem.innerHTML = `
            <div class="alert-message">
                <i class="fas fa-check-circle"></i>
                All systems operating normally
            </div>
        `;
        alertsLists.forEach((alertsList) => {
            alertsList.appendChild(noAlertsItem.cloneNode(true));
        });
        return;
    }

    alerts.forEach(alert => {
        const alertItem = document.createElement('div');
        alertItem.className = `alert-item ${alert.severity || 'info'}`;
        const iconClass = alert.icon || 'fa-info-circle';
        const timeStr = alert.time ? `<span class="alert-time">${alert.time}</span>` : '';

        alertItem.innerHTML = `
            <div class="alert-icon">
                <i class="fas ${iconClass}"></i>
            </div>
            <div class="alert-content">
                <div class="alert-message">${alert.message}</div>
                ${timeStr}
            </div>
        `;
        alertsLists.forEach((alertsList) => {
            alertsList.appendChild(alertItem.cloneNode(true));
        });
    });
}

// ===========================
// Utility Functions
// ===========================

function updateElement(id, value) {
    const element = document.getElementById(id);
    if (element) {
        // Animate number changes
        if (typeof value === 'number') {
            animateValue(element, 0, value, 1000);
        } else {
            element.textContent = value;
        }
    }
}

function animateValue(element, start, end, duration) {
    const range = end - start;
    const increment = range / (duration / 16);
    let current = start;

    const timer = setInterval(() => {
        current += increment;
        if ((increment > 0 && current >= end) || (increment < 0 && current <= end)) {
            current = end;
            clearInterval(timer);
        }
        element.textContent = Math.round(current);
    }, 16);
}

function showConfirmationDialog(options = {}) {
    let dialog = document.getElementById('appConfirmDialog');

    if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.id = 'appConfirmDialog';
        dialog.className = 'app-confirm-dialog';
        dialog.setAttribute('aria-labelledby', 'appConfirmDialogTitle');
        dialog.setAttribute('aria-describedby', 'appConfirmDialogMessage');
        dialog.innerHTML = `
            <div class="app-confirm-dialog__panel">
                <header class="app-confirm-dialog__header">
                    <div class="app-confirm-dialog__icon" data-confirm-icon aria-hidden="true"></div>
                    <div class="app-confirm-dialog__heading">
                        <p class="app-confirm-dialog__kicker">Confirm action</p>
                        <h2 id="appConfirmDialogTitle" data-confirm-title></h2>
                    </div>
                    <button type="button" class="app-confirm-dialog__close" data-confirm-cancel aria-label="Close confirmation">
                        <i class="fas fa-times" aria-hidden="true"></i>
                    </button>
                </header>
                <div class="app-confirm-dialog__body">
                    <p id="appConfirmDialogMessage" data-confirm-message></p>
                </div>
                <footer class="app-confirm-dialog__footer">
                    <button type="button" class="btn btn-outline" data-confirm-cancel-action></button>
                    <button type="button" class="btn btn-primary app-confirm-dialog__confirm" data-confirm-submit></button>
                </footer>
            </div>
        `;
        document.body.appendChild(dialog);

        const settle = (result) => {
            const resolve = dialog._appConfirmResolve;
            dialog._appConfirmResolve = null;
            if (dialog.open) dialog.close();
            if (typeof resolve === 'function') resolve(result);
        };
        dialog._appConfirmSettle = settle;

        dialog.addEventListener('click', (event) => {
            if (event.target === dialog || event.target.closest('[data-confirm-cancel]')) {
                settle(false);
            } else if (event.target.closest('[data-confirm-submit]')) {
                settle(true);
            }
        });
        dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            settle(false);
        });
        dialog.addEventListener('close', () => {
            const resolve = dialog._appConfirmResolve;
            dialog._appConfirmResolve = null;
            if (typeof resolve === 'function') resolve(false);
            if (dialog._appConfirmReturnFocus?.isConnected) dialog._appConfirmReturnFocus.focus();
            dialog._appConfirmReturnFocus = null;
        });
    }

    const title = String(options.title || 'Confirm action');
    const message = String(options.message || 'Are you sure you want to continue?');
    const confirmText = String(options.confirmText || 'Confirm');
    const cancelText = String(options.cancelText || 'Cancel');
    const tone = options.tone === 'primary' ? 'primary' : 'danger';
    const icon = String(options.icon || (tone === 'danger' ? 'fa-triangle-exclamation' : 'fa-circle-question'));

    dialog.classList.toggle('is-danger', tone === 'danger');
    dialog.classList.toggle('is-primary', tone === 'primary');
    dialog.querySelector('[data-confirm-title]').textContent = title;
    dialog.querySelector('[data-confirm-message]').textContent = message;
    dialog.querySelector('[data-confirm-cancel-action]').textContent = cancelText;
    dialog.querySelector('[data-confirm-submit]').textContent = confirmText;
    dialog.querySelector('[data-confirm-icon]').innerHTML = `<i class="fas ${icon}" aria-hidden="true"></i>`;
    dialog._appConfirmReturnFocus = document.activeElement;
    if (dialog.open) dialog.close();

    return new Promise((resolve) => {
        dialog._appConfirmResolve = resolve;
        dialog.showModal();
        dialog.querySelector('[data-confirm-submit]')?.focus();
    });
}

window.showConfirmationDialog = showConfirmationDialog;

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
// Scroll Animation Functions
// ===========================

function initializeScrollAnimations() {
    const animatedElements = document.querySelectorAll('[data-animate]');
    if (!animatedElements.length) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (prefersReducedMotion.matches) {
        animatedElements.forEach((element) => element.classList.add('is-visible'));
        return;
    }

    const observer = new IntersectionObserver((entries, obs) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                const element = entry.target;
                if (element.dataset.animateDelay) {
                    element.style.transitionDelay = element.dataset.animateDelay;
                }
                element.classList.add('is-visible');
                obs.unobserve(element);
            }
        });
    }, {
        threshold: 0.2,
        rootMargin: '0px 0px -5% 0px'
    });

    animatedElements.forEach((element) => observer.observe(element));
}

// ===========================
// Export functions for use in other files
// ===========================
window.dashboardUtils = {
    updateElement,
    showConfirmationDialog,
    showNotification,
    loadDashboardData
};
