function getAppBaseUrl() {
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

const API_BASE_URL = window.API_BASE || `${getAppBaseUrl()}/api`;

// Keep session cookies when applicable.
axios.defaults.withCredentials = true;

let currentUser = null;
let employee = null;
let positions = [];
let nameExtensions = [];
let editMode = false;
let passwordStep = 1;

function getSecurityView() {
    return new URLSearchParams(window.location.search).get('view') === 'profile-info'
        ? 'profile-info'
        : 'password';
}

function applySecurityView(view) {
    const normalizedView = view === 'profile-info' ? 'profile-info' : 'password';
    document.documentElement.dataset.securityView = normalizedView;
    const isProfileInfo = normalizedView === 'profile-info';
    setText('securityPageTitle', isProfileInfo ? 'Profile info' : 'ACCOUNT SECURITY');
    document.title = `${isProfileInfo ? 'Profile info' : 'Password security'} - DepEd Academic Monitoring System`;
}

// These are masked by default.
const maskable = new Set([
    'employee_number',
    'username',
    'date_of_birth',
    'date_hired',
    'contact_number',
    'email',
    'address'
]);

document.addEventListener('DOMContentLoaded', () => {
    applySecurityView(getSecurityView());
    initMaskButtons();
    initEditButtons();
    initPasswordForm();
    loadPage();
});

function initMaskButtons() {
    document.querySelectorAll('[data-mask]').forEach((btn) => {
        btn.addEventListener('click', () => toggleMask(btn.dataset.mask));
    });
}

function initEditButtons() {
    const revealAllBtn = document.getElementById('revealAllBtn');
    const saveBtn = document.getElementById('saveBtn');

    if (revealAllBtn) revealAllBtn.addEventListener('click', toggleRevealAll);
    if (saveBtn) saveBtn.addEventListener('click', save);
}

function initPasswordForm() {
    const form = document.getElementById('passwordForm');
    if (form) form.addEventListener('submit', changePassword);

    const skipBtn = document.getElementById('skipPasswordBtn');
    if (skipBtn) skipBtn.addEventListener('click', skipPasswordChange);

    initPasswordWizard();
}

function initPasswordWizard() {
    if (!document.getElementById('passwordForm')) return;

    document.querySelectorAll('[data-password-next]').forEach((button) => {
        button.addEventListener('click', () => {
            const nextStep = Number(button.dataset.passwordNext);
            if (validatePasswordWizardStep(passwordStep)) setPasswordWizardStep(nextStep);
        });
    });

    document.querySelectorAll('[data-password-back]').forEach((button) => {
        button.addEventListener('click', () => setPasswordWizardStep(Number(button.dataset.passwordBack)));
    });

    document.querySelectorAll('[data-password-toggle]').forEach((button) => {
        button.addEventListener('click', () => togglePasswordVisibility(button.dataset.passwordToggle, button));
    });

    document.getElementById('new_password')?.addEventListener('input', updatePasswordRequirements);
    updatePasswordRequirements();
    setPasswordWizardStep(1, false);
}

function setPasswordWizardStep(step, focus = true) {
    passwordStep = Math.min(3, Math.max(1, Number(step) || 1));

    document.querySelectorAll('[data-password-step]').forEach((panel) => {
        const isActive = Number(panel.dataset.passwordStep) === passwordStep;
        panel.hidden = !isActive;
        panel.classList.toggle('is-active', isActive);
        panel.setAttribute('aria-hidden', String(!isActive));
    });

    document.querySelectorAll('[data-password-step-indicator]').forEach((indicator) => {
        const indicatorStep = Number(indicator.dataset.passwordStepIndicator);
        indicator.classList.toggle('is-active', indicatorStep === passwordStep);
        indicator.classList.toggle('is-complete', indicatorStep < passwordStep);
        if (indicatorStep === passwordStep) indicator.setAttribute('aria-current', 'step');
        else indicator.removeAttribute('aria-current');
    });

    setPasswordWizardStatus('', '');

    if (focus) {
        const activePanel = document.querySelector(`[data-password-step="${passwordStep}"]`);
        window.setTimeout(() => activePanel?.querySelector('input')?.focus(), 0);
    }
}

function validatePasswordWizardStep(step) {
    const current = document.getElementById('current_password');
    const next = document.getElementById('new_password');
    const confirm = document.getElementById('confirm_password');

    if (step === 1 && !current?.value.trim()) {
        setPasswordWizardStatus('Enter your current password to continue.', 'error');
        current?.focus();
        return false;
    }

    if (step === 2) {
        const value = next?.value || '';
        const missingRequirements = [];
        if (value.length < 8) missingRequirements.push('at least 8 characters');
        if (!/[A-Z]/.test(value)) missingRequirements.push('one uppercase letter');
        if (!/[0-9]/.test(value)) missingRequirements.push('one number');

        if (missingRequirements.length) {
            setPasswordWizardStatus(`Use ${missingRequirements.join(', ')} before continuing.`, 'error');
            next?.focus();
            return false;
        }
    }

    if (step === 3 && (!confirm?.value || confirm.value !== next?.value)) {
        setPasswordWizardStatus('Your password confirmation does not match.', 'error');
        confirm?.focus();
        return false;
    }

    return true;
}

function togglePasswordVisibility(fieldId, button) {
    const field = document.getElementById(fieldId);
    if (!field || !button) return;

    const shouldShow = field.type === 'password';
    field.type = shouldShow ? 'text' : 'password';
    button.textContent = shouldShow ? 'Hide' : 'Show';
    button.setAttribute('aria-pressed', String(shouldShow));
    button.setAttribute('aria-label', `${shouldShow ? 'Hide' : 'Show'} ${field.labels?.[0]?.textContent?.toLowerCase() || 'password'}`);
}

function updatePasswordRequirements() {
    const value = document.getElementById('new_password')?.value || '';
    const requirements = {
        length: value.length >= 8,
        uppercase: /[A-Z]/.test(value),
        number: /[0-9]/.test(value)
    };

    Object.entries(requirements).forEach(([name, isValid]) => {
        const item = document.querySelector(`[data-password-requirement="${name}"]`);
        if (!item) return;
        item.classList.toggle('is-valid', isValid);
        const icon = item.querySelector('i');
        if (icon) icon.className = `fas ${isValid ? 'fa-check-circle' : 'fa-circle'}`;
    });
}

function setPasswordWizardStatus(message, type = '') {
    const status = document.getElementById('passwordWizardStatus');
    if (!status) return;

    status.className = `password-wizard-status${type ? ` password-wizard-status--${type}` : ''}`;
    status.textContent = message;
    status.hidden = !message;
}

function getDashboardForCurrentUser(user) {
    const roleName = String(user?.role_name || '').trim().toLowerCase();
    const roleKey = String(user?.role_key || '').trim().toLowerCase();
    const roleId = Number(user?.role_id || 0);
    const appBase = getAppBaseUrl();

    if (roleId === 9 || roleKey === 'teacher' || roleName.includes('teacher') || roleName.includes('adviser') || roleName.includes('advisor')) {
        return `${appBase}/dashboard/teacher_dashboard.html`;
    }
    if (roleId === 10 || roleKey === 'learners' || roleName.includes('learner') || roleName.includes('student')) {
        return `${appBase}/dashboard/learner_dashboard.html`;
    }
    if (roleId === 7 || roleId === 11 || roleKey === 'registrar' || roleName.includes('registrar')) {
        return `${appBase}/dashboard/registrar_dashboard.html`;
    }
    return `${appBase}/dashboard/admin_dashboard.html`;
}

function skipPasswordChange() {
    const destination = () => {
        // Show logo loader before redirect
        showLogoLoader();
        // Wait for loader to appear, then redirect
        setTimeout(() => {
            window.location.href = getDashboardForCurrentUser(currentUser);
        }, 800);
    };

    const mustChange = Boolean(currentUser?.must_change_password);
    if (!mustChange) {
        try {
            sessionStorage.removeItem('passwordChangeRequired');
            sessionStorage.removeItem('passwordChangeSkipped');
            sessionStorage.removeItem('passwordChangeSkipAlertShown');
        } catch (_) {
            // ignore storage errors
        }
        destination();
        return;
    }

    try {
        sessionStorage.setItem('passwordChangeRequired', '1');
        sessionStorage.setItem('passwordChangeSkipped', '1');
    } catch (_) {
        // ignore storage errors
    }
    showSkipPasswordWarning(destination);
}

function setPasswordPolicyAlert(user) {
    const alert = document.getElementById('passwordPolicyAlert');
    if (!alert) return;

    const required = Boolean(user?.must_change_password);
    if (!required) {
        alert.style.display = 'none';
        alert.textContent = '';
        return;
    }

    alert.style.display = 'block';
    alert.textContent = 'Using a temporary password. Change it now.';
}

function showSkipPasswordWarning(onContinue) {
    const message = 'Using a temporary password risks unauthorized access. Change it now.';

    try {
        sessionStorage.setItem('passwordChangeSkipAlertShown', '1');
    } catch (_) {
        // ignore storage errors
    }

    const icon = `<div class="security-caution security-caution-danger" aria-hidden="true"><div class="security-caution-shake">
        <svg width="104" height="104" viewBox="0 0 48 48" focusable="false">
            <circle class="security-caution-ring" cx="24" cy="24" r="18" fill="none" stroke="#ef4444" stroke-width="2"/>
            <circle cx="24" cy="24" r="18" fill="#fee2e2" stroke="#b91c1c" stroke-width="2"/>
            <rect x="20.5" y="12" width="7" height="15" rx="3.5" fill="#991b1b"/>
            <circle cx="24" cy="33" r="3.2" fill="#991b1b"/>
        </svg>
    </div></div>`;
    const cancelSkip = () => {
        try {
            sessionStorage.removeItem('passwordChangeSkipped');
            sessionStorage.removeItem('passwordChangeSkipAlertShown');
        } catch (_) { /* Storage may be unavailable. */ }
        document.getElementById('skipPasswordBtn')?.focus();
    };

    if (window.Swal && typeof window.Swal.fire === 'function') {
        window.Swal.fire({
            title: 'Security Alert',
            width: 'min(680px, calc(100vw - 2rem))',
            backdrop: 'rgba(15,23,42,.82)',
            customClass: { popup: 'password-skip-large', container: 'password-skip-backdrop' },
            html: `${icon}<p>${message}</p>`,
            showCancelButton: true,
            cancelButtonText: 'Go Back',
            focusCancel: true,
            confirmButtonText: 'Skip Anyway',
            confirmButtonColor: '#b91c1c'
        }).then((result) => {
            if (result.isConfirmed) onContinue();
            else cancelSkip();
        });
        return;
    }

    if (!document.getElementById('passwordSkipModalStyles')) {
        const style = document.createElement('style');
        style.id = 'passwordSkipModalStyles';
        style.textContent = `
            .password-skip-modal-overlay{position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(15,23,42,.82);backdrop-filter:blur(8px)}
            .password-skip-modal{width:min(680px,100%);min-height:min(480px,calc(100dvh - 2rem));max-height:calc(100dvh - 2rem);overflow-y:auto;display:flex;flex-direction:column;justify-content:center;background:var(--surface-0,#fff);border-radius:12px;box-shadow:0 20px 60px rgba(15,23,42,.2);padding:clamp(1.5rem,4vw,2rem);text-align:center;border:1px solid #f1c8c8}
            .password-skip-modal__icon{width:54px;height:54px;margin:0 auto .75rem;display:grid;place-items:center;border-radius:999px;background:#fee2e2;color:#b91c1c;font-size:1.45rem}
            .password-skip-modal h2{margin:0;color:var(--gray-900,#111827);font-size:clamp(1.4rem,3vw,2rem);font-weight:850}
            .password-skip-modal p{margin:1.25rem 0 0;color:var(--gray-700,#374151);font-size:1.05rem;line-height:1.7}
            .password-skip-modal__actions{display:flex;justify-content:center;gap:.75rem;flex-wrap:wrap;margin-top:2rem}
            .password-skip-modal__actions .btn{min-width:130px;padding:.85rem 1.5rem}
        `;
        document.head.appendChild(style);
    }

    const overlay = document.createElement('div');
    overlay.className = 'password-skip-modal-overlay';
    overlay.innerHTML = `
        <div class="password-skip-modal" role="alertdialog" aria-modal="true" aria-labelledby="passwordSkipTitle">
            ${icon}
            <h2 id="passwordSkipTitle">Security Alert</h2>
            <p>${message}</p>
            <div class="password-skip-modal__actions">
                <button type="button" class="btn btn-outline" data-password-skip-back>Go Back</button>
                <button type="button" class="btn btn-primary" data-password-skip-continue>Skip Anyway</button>
            </div>
        </div>
    `;
    const back = overlay.querySelector('[data-password-skip-back]');
    const forward = overlay.querySelector('[data-password-skip-continue]');
    const close = (proceed) => {
        document.removeEventListener('keydown', handleKeys);
        overlay.remove();
        if (proceed) onContinue();
        else cancelSkip();
    };
    const handleKeys = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(false); }
        if (event.key === 'Tab') {
            event.preventDefault();
            (document.activeElement === back ? forward : back).focus();
        }
    };
    back.addEventListener('click', () => close(false));
    forward.addEventListener('click', () => close(true));
    document.addEventListener('keydown', handleKeys);
    document.body.appendChild(overlay);
    back.focus();
}

async function loadPage() {
    try {
        if (window.location.protocol === 'file:') {
            showNotification('Open this page via http://localhost/deped_capstone2/ so login/session works.', 'error');
            return;
        }

        const meResp = await axios.get(`${API_BASE_URL}/auth/me.php`);
        if (!meResp.data?.success) {
            showNotification('Not authenticated. Please sign in again.', 'error');
            return;
        }
        currentUser = meResp.data.data;
        const securityView = currentUser.must_change_password ? 'password' : getSecurityView();
        applySecurityView(securityView);
        document.documentElement.classList.toggle('password-focus', Boolean(currentUser.must_change_password));
        document.documentElement.classList.remove('security-session-pending');
        if (currentUser.must_change_password) document.getElementById('current_password')?.focus();
        setPasswordPolicyAlert(currentUser);
        setText('headerUserName', currentUser.full_name || currentUser.username || 'User');
        window.applyDeveloperApprovedBadge?.(document.getElementById('headerUserName'), currentUser);
        setText('headerUserRole', currentUser.role_name || '');
        if (securityView === 'profile-info') {
            await Promise.all([loadPositions(), loadNameExtensions(), loadMyEmployee()]);
        }
    } catch (err) {
        const status = err.response?.status;
        const apiMessage = err.response?.data?.message;
        const hint = status === 401
            ? 'Not authenticated. Please login again.'
            : status === 404
                ? (apiMessage || 'API endpoint not found. Check the URL and server.')
                : (apiMessage || err.message || 'Network error.');
        console.error('Security load failed:', { status, url: err.config?.url, data: err.response?.data, err });
        showNotification(`Unable to load security details. ${hint}`, 'error');
    }
}

async function changePassword(event) {
    event.preventDefault();

    const btn = document.getElementById('changePasswordBtn');
    const current = document.getElementById('current_password');
    const next = document.getElementById('new_password');
    const confirm = document.getElementById('confirm_password');

    const payload = {
        current_password: current?.value || '',
        new_password: next?.value || '',
        confirm_password: confirm?.value || ''
    };

    if (!payload.current_password) {
        setPasswordWizardStep(1);
        setPasswordWizardStatus('Enter your current password to continue.', 'error');
        return;
    }
    if (!payload.new_password) {
        setPasswordWizardStep(2);
        setPasswordWizardStatus('Create a new password before continuing.', 'error');
        return;
    }
    if (payload.new_password.length < 8 || !/[A-Z]/.test(payload.new_password) || !/[0-9]/.test(payload.new_password)) {
        setPasswordWizardStep(2);
        setPasswordWizardStatus('Use at least 8 characters, one uppercase letter, and one number.', 'error');
        return;
    }
    if (!payload.confirm_password) {
        setPasswordWizardStatus('Confirm your new password before saving.', 'error');
        confirm?.focus();
        return;
    }
    if (payload.new_password !== payload.confirm_password) {
        setPasswordWizardStatus('Your password confirmation does not match.', 'error');
        confirm?.focus();
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Changing...';
    }

    try {
        const resp = await axios.post(`${API_BASE_URL}/auth/change_password.php`, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (!resp.data?.success) {
            setPasswordWizardStatus(resp.data?.message || 'Password change failed.', 'error');
            return;
        }

        [current, next, confirm].forEach((el) => {
            if (el) el.value = '';
        });
        try {
            sessionStorage.removeItem('passwordChangeRequired');
            sessionStorage.removeItem('passwordChangeSkipped');
            sessionStorage.removeItem('passwordChangeSkipAlertShown');
        } catch (_) {
            // ignore storage errors
        }
        if (currentUser) currentUser.must_change_password = false;
        setPasswordPolicyAlert(currentUser);
        setPasswordWizardStatus('Password changed. Redirecting to your dashboard.', 'success');
        showNotification('Password changed successfully.', 'success');

        // Show logo loader and redirect to dashboard after short delay
        setTimeout(() => {
            showLogoLoader();
            setTimeout(() => {
                window.location.href = getDashboardForCurrentUser(currentUser);
            }, 800);
        }, 1500);
    } catch (err) {
        const msg = err.response?.data?.message || err.message || 'Unable to change password.';
        setPasswordWizardStatus(msg, 'error');
        showNotification(msg, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-key"></i> Change Password';
        }
    }
}

function renderEmployeeProfile() {
    if (!employee || !employee.employee_id) {
        console.log('No employee data available, hiding profile');
        hideEmployeeProfile();
        showStaticInfo('This account has no employee profile record yet. Contact an administrator to link an employee record before editing profile info.');
        return;
    }

    fillForm(employee);
    // Show the employee profile section
    const employeeSection = document.querySelector('.employee-profile-section');
    if (employeeSection) {
        employeeSection.style.display = 'block';
    }
}


function hideEmployeeProfile() {
    disableSecurityEditing();
}

function disableSecurityEditing() {
    // Disable editing actions for non-employee accounts.
    const revealAllBtn = document.getElementById('revealAllBtn');
    const saveBtn = document.getElementById('saveBtn');

    if (revealAllBtn) revealAllBtn.disabled = true;
    if (saveBtn) saveBtn.disabled = true;

    // Keep the form read-only/disabled.
    setEditMode(false);
}

function showStaticInfo(message) {
    const form = document.getElementById('securityForm');
    if (!form) return;

    let panel = document.getElementById('securityInfoPanel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'securityInfoPanel';
        panel.style.cssText = 'margin-bottom: 1rem; padding: 0.9rem 1rem; border: 0; box-shadow: var(--shadow-sm); background: var(--gray-50); color: var(--gray-800); border-radius: 6px;';
        form.prepend(panel);
    }
    panel.textContent = message;
}

async function loadPositions() {
    try {
        const resp = await axios.get(`${API_BASE_URL}/positions/positions.php?operation=getAllPositions`);
        positions = Array.isArray(resp.data) ? resp.data : [];

        const select = document.getElementById('position_id');
        if (!select) return;

        // Keep the first option.
        while (select.options.length > 1) select.remove(1);

        positions.forEach((p) => {
            const option = document.createElement('option');
            option.value = p.position_id;
            option.textContent = p.position_name;
            select.appendChild(option);
        });
    } catch (err) {
        console.error('Positions error:', err);
    }
}

async function loadNameExtensions() {
    try {
        const resp = await axios.get(`${API_BASE_URL}/name_extensions/name_extensions.php?operation=getAllNameExtensions`);
        const rows = Array.isArray(resp.data)
            ? resp.data
            : (Array.isArray(resp.data?.data) ? resp.data.data : []);
        nameExtensions = rows.filter((row) => String(row?.extension_name || '').trim() !== '');
    } catch (err) {
        nameExtensions = [];
        console.error('Name extensions error:', err);
    }
}

function populateNameExtensions(currentValue = '') {
    const select = document.getElementById('name_extension');
    if (!select) return;

    while (select.options.length > 1) select.remove(1);
    nameExtensions.forEach((extension) => {
        const option = document.createElement('option');
        option.value = extension.extension_name;
        option.textContent = extension.extension_name;
        select.appendChild(option);
    });

    const value = String(currentValue || '').trim();
    if (value && !Array.from(select.options).some((option) => option.value === value)) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
    }
    setSelectValue('name_extension', value);
}

async function loadMyEmployee() {
    try {
        const resp = await axios.get(`${API_BASE_URL}/employees/employees.php?operation=getMyEmployee`);
        if (!resp.data?.success) {
            showNotification(resp.data?.message || 'Unable to load your employee record.', 'error');
            return;
        }
        employee = resp.data.data;
        if (!employee) {
            // User doesn't have an employee record (likely a learner/student)
            console.log('No employee record found for this user');
            // Hide employee-related UI elements
            hideEmployeeProfile();
            showStaticInfo('This account has no employee profile record yet. Contact an administrator to link an employee record before editing profile info.');
            return;
        }
        renderEmployeeProfile();
    } catch (err) {
        console.error('Error loading employee data:', err);
        // Don't show error for missing employee records
        if (err.response?.status !== 404) {
            showNotification('Unable to load employee data.', 'error');
        }
    }
}

function fillForm(row) {
    if (!row) {
        console.error('fillForm called with null or undefined row');
        return;
    }

    setPlainValue('employee_id', row.employee_id || '');

    // Masked by default.
    setMaskedValue('employee_number', row.employee_number || '');
    setMaskedValue('username', row.username || row.employee_number || '');
    setMaskedValue('date_of_birth', row.date_of_birth, 'date');
    setMaskedValue('date_hired', row.date_hired, 'date');
    setMaskedValue('contact_number', row.contact_number || '');
    setMaskedValue('email', row.email || '');
    setMaskedValue('address', row.address || '');

    // Not masked by default.
    setPlainValue('first_name', row.first_name || '');
    setPlainValue('middle_name', row.middle_name || '');
    setPlainValue('last_name', row.last_name || '');
    populateNameExtensions(row.name_extension || '');
    setPlainValue('department', row.department || '');

    setSelectValue('gender', row.gender || '');
    setSelectValue('position_id', row.position_id || '');

    setPlainValue('role_name', row.role_name || '');

    // Only allow editing when this user has a real employee record.
    const hasEmployeeRecord = Boolean(row.employee_id);
    setEditMode(hasEmployeeRecord);
    if (!hasEmployeeRecord) {
        disableSecurityEditing();
        showStaticInfo('This account has no employee profile record yet. Contact an administrator to link an employee record before editing profile info.');
    }

    // Sync reveal-all toggle state.
    updateRevealAllButton();
}

function setEditMode(enabled) {
    editMode = enabled;
    const saveBtn = document.getElementById('saveBtn');

    // Always keep these read-only.
    const alwaysReadOnly = new Set(['employee_number', 'username', 'role_name', 'employee_id']);

    document.querySelectorAll('#securityForm input, #securityForm textarea, #securityForm select').forEach((el) => {
        if (alwaysReadOnly.has(el.id)) {
            if (el.tagName === 'SELECT') {
                el.disabled = true;
            } else {
                // Keep readable and focusable; just not editable.
                el.disabled = false;
                el.removeAttribute('disabled');
                el.readOnly = true;
            }
            el.classList.add('read-only');
            return;
        }

        // If the field is maskable and currently masked, force it disabled
        // until the user clicks Show. This prevents editing bullet characters.
        const isMaskable = maskable.has(el.id);
        const isMasked = el.dataset.masked === 'true';
        if (enabled && isMaskable && isMasked) {
            el.disabled = true;
            el.setAttribute('disabled', 'disabled');
            if (el.tagName !== 'SELECT') el.readOnly = true;
            el.classList.add('read-only');
            return;
        }

        if (el.tagName === 'SELECT') {
            el.disabled = !enabled;
            if (enabled) {
                // Be explicit for browsers that keep the attribute around.
                el.removeAttribute('disabled');
            } else {
                el.setAttribute('disabled', 'disabled');
            }
        } else {
            // For inputs/textarea, always clear disabled and toggle readOnly instead.
            // This fixes fields that start with disabled="disabled" in HTML:
            // without removeAttribute here, el.value returns '' even after setPlainValue sets the value.
            el.disabled = false;
            el.removeAttribute('disabled');
            el.readOnly = !enabled;
        }

        el.classList.toggle('read-only', !enabled);
    });

    if (saveBtn) saveBtn.disabled = !enabled;
}

function isAnyMasked() {
    for (const fieldId of maskable) {
        const el = document.getElementById(fieldId);
        if (!el) continue;
        if (el.dataset.masked !== 'false') return true;
    }
    return false;
}

function updateRevealAllButton() {
    const btn = document.getElementById('revealAllBtn');
    if (!btn) return;

    const anyMasked = isAnyMasked();
    const icon = anyMasked ? 'fa-eye' : 'fa-eye-slash';
    const title = anyMasked ? 'Reveal All' : 'Hide All';

    btn.innerHTML = `<i class="fas ${icon}"></i>`;
    btn.title = title;
    btn.setAttribute('aria-label', title);
}

function revealAll() {
    [...maskable].forEach((fieldId) => {
        const el = document.getElementById(fieldId);
        if (!el) return;
        if (el.dataset.masked === 'true') toggleMask(fieldId);
    });

    updateRevealAllButton();
}

function hideAll() {
    [...maskable].forEach((fieldId) => {
        const el = document.getElementById(fieldId);
        if (!el) return;
        if (el.dataset.masked === 'false') toggleMask(fieldId);
    });

    updateRevealAllButton();
}

function toggleRevealAll() {
    if (isAnyMasked()) {
        revealAll();
    } else {
        hideAll();
    }
}

function toggleMask(fieldId) {
    const el = document.getElementById(fieldId);
    if (!el) return;

    const button = document.querySelector(`[data-mask="${fieldId}"]`);
    const isMasked = el.dataset.masked !== 'false';

    if (isMasked) {
        el.dataset.masked = 'false';
        el.value = el.dataset.actual || '';
        if (el.dataset.originalType && el.tagName === 'INPUT') {
            el.setAttribute('type', el.dataset.originalType);
        }
        if (button) button.textContent = 'Hide';

        // If editing is enabled, reveal also enables input.
        if (editMode) {
            const alwaysReadOnly = new Set(['employee_number', 'username', 'role_name', 'employee_id']);
            if (!alwaysReadOnly.has(el.id)) {
                el.disabled = false;
                el.removeAttribute('disabled');
                if (el.tagName !== 'SELECT') el.readOnly = false;
                el.classList.remove('read-only');
            }
        }
    } else {
        el.dataset.actual = el.value;
        el.dataset.masked = 'true';
        if (el.tagName === 'INPUT') el.setAttribute('type', 'text');
        el.value = maskValue(el.dataset.actual || '');
        if (button) button.textContent = 'Show';

        // If editing is enabled, masking again disables input.
        if (editMode) {
            el.disabled = true;
            el.setAttribute('disabled', 'disabled');
            if (el.tagName !== 'SELECT') el.readOnly = true;
            el.classList.add('read-only');
        }
    }

    updateRevealAllButton();
}

function setMaskedValue(id, value, inputType) {
    const el = document.getElementById(id);
    if (!el) return;

    const actual = value ?? '';
    el.dataset.actual = actual;
    el.dataset.masked = maskable.has(id) ? 'true' : 'false';

    if (el.tagName === 'INPUT') {
        el.dataset.originalType = inputType || el.getAttribute('type') || 'text';
        el.setAttribute('type', 'text');
    }

    el.value = maskValue(actual);

    const button = document.querySelector(`[data-mask="${id}"]`);
    if (button) button.textContent = 'Show';
}

function setPlainValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.actual = value ?? '';
    el.dataset.masked = 'false';
    el.value = value ?? '';
}

function setSelectValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value ?? '';
}

async function save() {
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    }

    try {
        const payload = {
            first_name: getValue('first_name'),
            middle_name: getValue('middle_name'),
            last_name: getValue('last_name'),
            name_extension: getValue('name_extension'),
            date_of_birth: getActualOrPlain('date_of_birth'),
            gender: getValue('gender'),
            contact_number: getActualOrPlain('contact_number'),
            email: getActualOrPlain('email'),
            address: getActualOrPlain('address'),
            department: getValue('department'),
            position_id: getValue('position_id'),
            date_hired: getActualOrPlain('date_hired'),
            employee_id: employee?.employee_id || null
        };

        const resp = await axios.post(
            `${API_BASE_URL}/employees/employees.php?operation=updateMyEmployee`,
            payload,
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (resp.data?.success) {
            showNotification('Your employee record was updated.', 'success');
            await loadMyEmployee();
            setEditMode(true);
        } else {
            showNotification(resp.data?.message || 'Update failed.', 'error');
        }
    } catch (err) {
        const msg = err.response?.data?.message || err.message || 'An error occurred while saving.';
        showNotification(msg, 'error');
        console.error('Save error', err.response?.data || err);
    } finally {
        if (saveBtn) {
            saveBtn.innerHTML = '<i class="fas fa-save"></i> Save';
            saveBtn.disabled = !editMode;
        }
    }
}

function getValue(id) {
    const el = document.getElementById(id);
    if (!el) return '';
    const val = el.value;
    return typeof val === 'string' ? val.trim() : val;
}

function getActualOrPlain(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    if (el.dataset.masked === 'true') {
        return (el.dataset.actual || '').trim() || null;
    }
    return (el.value || '').trim() || null;
}

function maskValue(value) {
    if (!value) return '••••';
    const str = String(value);
    if (str.length <= 2) return '••';
    return `${'•'.repeat(Math.max(2, str.length - 2))}${str.slice(-2)}`;
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function showNotification(message, type = 'info') {
    const ensureStyles = () => {
        if (document.getElementById('govToastStyles')) return;
        const style = document.createElement('style');
        style.id = 'govToastStyles';
        style.textContent = `
            .gov-toast{position:fixed;bottom:80px;right:20px;background:var(--surface-0);border:0;box-shadow:var(--shadow-sm);border-radius:6px;padding:.9rem 1rem;z-index:10001;min-width:320px;max-width:420px;opacity:0;transform:translateX(30px);transition:opacity .25s ease,transform .25s ease}
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

    ensureStyles();
    document.querySelectorAll('.gov-toast').forEach((el) => el.remove());

    const normalized = type === 'success' || type === 'error' || type === 'info' ? type : 'info';
    const title = normalized === 'success' ? 'Completed' : normalized === 'error' ? 'Action Required' : 'Notice';
    const icon = normalized === 'success' ? 'fa-circle-check' : normalized === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info';

    const toast = document.createElement('div');
    toast.className = `gov-toast gov-toast--${normalized}`;
    toast.innerHTML = `
        <div class="gov-toast__content">
            <i class="fas ${icon} gov-toast__icon"></i>
            <div class="gov-toast__text">
                <div class="gov-toast__title">${title}</div>
                <div class="gov-toast__message">${message}</div>
            </div>
            <button type="button" class="gov-toast__dismiss" aria-label="Dismiss">&times;</button>
        </div>
    `;

    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    const dismiss = toast.querySelector('.gov-toast__dismiss');
    if (dismiss) dismiss.addEventListener('click', () => toast.remove());

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
    }, 4000);
}
