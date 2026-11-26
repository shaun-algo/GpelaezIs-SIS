function getAppBaseUrl() {
    if (isLikelyLiveServerOrigin()) {
        const host = window.location.hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost';
        return `http://${host}/deped_capstone2`;
    }

    const pathname = String(window.location.pathname || '/');
    let appPrefix = '';

    if (pathname.includes('/dashboard/')) {
        appPrefix = pathname.split('/dashboard/')[0] || '';
    } else if (pathname.includes('/pages/')) {
        appPrefix = pathname.split('/pages/')[0] || '';
    } else if (pathname.includes('/assets/')) {
        appPrefix = pathname.split('/assets/')[0] || '';
    } else if (pathname.includes('/api/')) {
        appPrefix = pathname.split('/api/')[0] || '';
    } else if (pathname.endsWith('.html')) {
        appPrefix = pathname.substring(0, pathname.lastIndexOf('/')) || '';
    } else {
        appPrefix = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    }

    if (appPrefix === '/') appPrefix = '';
    return appPrefix;
}

function isLikelyLiveServerOrigin() {
    const port = Number(window.location.port || 0);
    return window.location.protocol !== 'file:' && port >= 5500 && port <= 5599;
}

const APP_BASE_URL = getAppBaseUrl();
const API_BASE_URL = window.API_BASE || `${APP_BASE_URL}/api`;

function getClientTimezone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (_) {
        return '';
    }
}

async function getGeolocationPermissionState() {
    try {
        if (!navigator.permissions?.query) return 'prompt';
        const permission = await navigator.permissions.query({ name: 'geolocation' });
        return permission?.state || 'prompt';
    } catch (_) {
        return 'prompt';
    }
}

function readClientLocation() {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const latitude = Number(position?.coords?.latitude);
                const longitude = Number(position?.coords?.longitude);
                const accuracy = Number(position?.coords?.accuracy);
                if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                    resolve(null);
                    return;
                }
                resolve({
                    latitude,
                    longitude,
                    accuracy: Number.isFinite(accuracy) ? accuracy : null
                });
            },
            () => resolve(null),
            {
                enableHighAccuracy: false,
                maximumAge: 300000,
                timeout: 3000
            }
        );
    });
}

function isLocationPermissionContext() {
    const hostname = String(window.location.hostname || '').toLowerCase();
    return Boolean(window.isSecureContext)
        || hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '::1';
}

function showLoginLocationConsent(permissionState) {
    const modal = document.getElementById('loginLocationModal');
    const allowButton = modal?.querySelector('[data-login-location-allow]');
    const skipButton = modal?.querySelector('[data-login-location-skip]');
    if (!modal || !allowButton || !skipButton) return Promise.resolve(false);

    if (!isLocationPermissionContext()) {
        allowButton.disabled = true;
    } else if (!navigator.geolocation) {
        allowButton.disabled = true;
    } else if (permissionState === 'denied') {
        allowButton.disabled = true;
    } else {
        allowButton.disabled = false;
    }

    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('login-location-modal-open');

    return new Promise((resolve) => {
        const finish = (allow) => {
            modal.hidden = true;
            modal.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('login-location-modal-open');
            allowButton.removeEventListener('click', allowLocation);
            skipButton.removeEventListener('click', skipLocation);
            resolve(allow);
        };
        const allowLocation = () => finish(true);
        const skipLocation = () => finish(false);
        allowButton.addEventListener('click', allowLocation, { once: true });
        skipButton.addEventListener('click', skipLocation, { once: true });
        skipButton.focus();
    });
}

async function getClientLocation() {
    const hasGeolocation = Boolean(navigator.geolocation);
    const permissionState = hasGeolocation ? await getGeolocationPermissionState() : 'unsupported';
    if (permissionState !== 'granted') {
        const allow = await showLoginLocationConsent(permissionState);
        if (!allow) return null;
    }
    if (!hasGeolocation) return null;
    return readClientLocation();
}

const authApi = {
    login: async (payload) => axios.post(`${API_BASE_URL}/auth/login.php`, payload).then(r => r.data)
};

const ROLE_REDIRECTS = {
    Teacher: 'dashboard/teacher_dashboard.html',
    // DepEd term: Learner. Keep Student mapping for existing DB role names.
    Student: 'dashboard/learner_dashboard.html',
    Learner: 'dashboard/learner_dashboard.html'
};

function normalizeRoleName(roleName) {
    return String(roleName || '').trim().toLowerCase();
}

function getRedirectForRole(roleName, roleId) {
    // Prefer numeric role_id when available (most reliable).
    // DB currently uses: 8=admin, 9=teacher, 10=learners
    const rid = Number(roleId);
    if (Number.isFinite(rid)) {
        if (rid === 9) return `${APP_BASE_URL}/dashboard/teacher_dashboard.html`;
        if (rid === 10) return `${APP_BASE_URL}/dashboard/learner_dashboard.html`;
        if (rid === 8) return `${APP_BASE_URL}/dashboard/admin_dashboard.html`;
        if (rid === 7 || rid === 11) return `${APP_BASE_URL}/dashboard/registrar_dashboard.html`;
    }

    const normalized = normalizeRoleName(roleName);

    // Prefer tolerant matching so DB values like "Learners" / "teacher " still work.
    if (normalized.includes('teacher')) {
        return `${APP_BASE_URL}/dashboard/teacher_dashboard.html`;
    }
    if (normalized.includes('learner') || normalized.includes('student')) {
        return `${APP_BASE_URL}/dashboard/learner_dashboard.html`;
    }
    if (normalized.includes('registrar')) {
        return `${APP_BASE_URL}/dashboard/registrar_dashboard.html`;
    }
    if (normalized.includes('admin')) {
        return `${APP_BASE_URL}/dashboard/admin_dashboard.html`;
    }

    // Backward-compatible exact map
    const exactKey = String(roleName || '').trim();
    const route = ROLE_REDIRECTS[exactKey];
    if (route) return `${APP_BASE_URL}/${route}`;

    return `${APP_BASE_URL}/dashboard/admin_dashboard.html`;
}

function getPasswordChangeTarget() {
    return `${APP_BASE_URL}/pages/profile-security.html?force_password=1`;
}

function setFieldError(field, isError) {
    if (!field) return;
    const group = field.closest('.form-group') || field.parentElement;
    if (!group) return;
    if (isError) {
        group.classList.add('error');
    } else {
        group.classList.remove('error');
    }
}

function setStatus(message, isError) {
    const note = document.getElementById('loginStatus');
    if (!note) return;
    note.textContent = message || '';
    note.dataset.state = isError ? 'error' : 'info';
    note.style.display = message ? 'block' : 'none';
}

function setLoading(isLoading) {
    const loginBtn = document.getElementById('loginBtn');
    if (!loginBtn) return;
    if (isLoading) {
        loginBtn.disabled = true;
        loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing In...';
    } else {
        loginBtn.disabled = false;
        loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
    }
}

function queueWelcomeSpeech() {
    try {
        sessionStorage.setItem('welcomeSpeechPending', '1');
    } catch (_) {
        // ignore storage errors
    }
}

function showSessionEndMessage() {
    try {
        const reason = sessionStorage.getItem('sessionEndReason');
        if (reason === 'history') {
            setStatus('This browser history entry is no longer authorized. Please sign in again.', true);
            sessionStorage.removeItem('sessionEndReason');
        } else if (reason === 'expired') {
            setStatus('Your session has expired. Please sign in again to continue.', true);
            sessionStorage.removeItem('sessionEndReason');
        }
    } catch (_) {
        // ignore storage errors
    }
}

let historySessionEndPromise = null;

function endSessionAfterHistoryNavigation() {
    if (historySessionEndPromise) return historySessionEndPromise;

    try {
        sessionStorage.setItem('sessionEnded', '1');
        sessionStorage.setItem('sessionEndReason', 'expired');
    } catch (_) {
        // Continue even when session storage is unavailable.
    }

    const loginButton = document.getElementById('loginBtn');
    if (loginButton) loginButton.disabled = true;
    setStatus('Your session has expired. Please sign in again to continue.', true);

    historySessionEndPromise = fetch(`${API_BASE_URL}/auth/logout.php`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' }
    }).catch(() => null).finally(() => {
        historySessionEndPromise = null;
        if (loginButton) loginButton.disabled = false;
        setStatus('Your session has expired. Please sign in again to continue.', true);
    });

    return historySessionEndPromise;
}

const loginNavigationEntry = performance.getEntriesByType('navigation')[0];
if (loginNavigationEntry?.type === 'back_forward') {
    endSessionAfterHistoryNavigation();
}
window.addEventListener('pageshow', (event) => {
    if (event.persisted) endSessionAfterHistoryNavigation();
});
window.addEventListener('popstate', endSessionAfterHistoryNavigation);

document.addEventListener('DOMContentLoaded', () => {
    if (window.axios) {
        try {
            window.axios.defaults.withCredentials = true;
        } catch (_) {
            // ignore
        }
    }
    if (window.AOS) {
        AOS.init({
            duration: 800,
            easing: 'ease-out',
            once: true
        });
    }

    const togglePassword = document.getElementById('togglePassword');
    const passwordInput = document.getElementById('password');

    if (togglePassword && passwordInput) {
        togglePassword.addEventListener('click', function() {
            const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
            passwordInput.setAttribute('type', type);
            this.classList.toggle('is-visible', type === 'text');
            this.setAttribute('aria-label', type === 'password' ? 'Show password' : 'Hide password');
            this.setAttribute('aria-pressed', String(type === 'text'));
        });
    }

    const loginForm = document.getElementById('loginForm');
    if (!loginForm) return;
    showSessionEndMessage();

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = document.getElementById('username');
        const password = document.getElementById('password');

        const usernameValue = username?.value.trim() || '';
        const passwordValue = password?.value || '';

        setFieldError(username, !usernameValue);
        setFieldError(password, !passwordValue);

        if (!usernameValue || !passwordValue) {
            setStatus('Please enter your username and password.', true);
            return;
        }

        setStatus('', false);
        setLoading(true);

        try {
            const clientLocation = await getClientLocation();
            const response = await authApi.login({
                username: usernameValue,
                password: passwordValue,
                client_timezone: getClientTimezone(),
                client_location: clientLocation
            });

            if (!response?.success) {
                setStatus(response?.message || 'Login failed.', true);
                setLoading(false);
                return;
            }

            let roleName = response?.data?.role_name || '';
            const roleId = response?.data?.role_id;

            if (!String(roleName || '').trim() && roleId != null) {
                try {
                    const rolesResp = await axios.get(`${API_BASE_URL}/roles/roles.php?operation=getAllRoles`);
                    const roles = Array.isArray(rolesResp.data) ? rolesResp.data : [];
                    const match = roles.find((r) => String(r.role_id) === String(roleId));
                    if (match?.role_name) {
                        roleName = match.role_name;
                    }
                } catch (_) {
                    // ignore mapping failures; fall back to default redirect
                }
            }

            const mustChangePassword = Boolean(response?.data?.must_change_password);
            const target = mustChangePassword ? getPasswordChangeTarget() : getRedirectForRole(roleName, roleId);
            try {
                sessionStorage.removeItem('sessionEnded');
                sessionStorage.removeItem('sessionEndReason');
                sessionStorage.removeItem('depedSessionHistoryIndex');
                if (mustChangePassword) {
                    sessionStorage.setItem('passwordChangeRequired', '1');
                } else {
                    sessionStorage.removeItem('passwordChangeRequired');
                }
            } catch (_) {
                // ignore storage errors
            }
            if (!mustChangePassword) {
                queueWelcomeSpeech();
            }
            window.location.href = target;
        } catch (error) {
            const status = error?.response?.status;
            const apiMessage = error?.response?.data?.message;

            if (window.location.protocol === 'file:') {
                setStatus('Login won\'t work on file://. Open via http://localhost/deped_capstone2/.', true);
                setLoading(false);
                return;
            }

            if (status === 405) {
                setStatus(
                    'Login endpoint is not reachable (HTTP 405). Open the system via XAMPP/Apache: http://localhost/deped_capstone2/ (not VS Code Live Server).',
                    true
                );
                setLoading(false);
                return;
            }

            if (apiMessage) {
                setStatus(apiMessage, true);
            } else if (status) {
                setStatus(`Unable to sign in (HTTP ${status}). Please try again.`, true);
            } else {
                setStatus('Unable to sign in. Please check your connection and try again.', true);
            }
            setLoading(false);
        }
    });
});
