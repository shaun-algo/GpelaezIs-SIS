'use strict';

const form = document.getElementById('recoveryForm');
if (!form) {
    throw new Error('Recovery form is missing.');
}

const statusNote = document.getElementById('status');

function showStatus(message, error = false) {
    if (!statusNote) return;
    statusNote.textContent = message || '';
    statusNote.hidden = !message;
    statusNote.dataset.error = String(error);
    if (message) statusNote.focus();
}

function setBusy(button, busy, idleText, busyText) {
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? busyText : idleText;
}

async function postJson(url, data) {
    const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    let result = null;
    try {
        result = await response.json();
    } catch (_) {
        throw new Error('Invalid server response.');
    }
    return { response, result };
}

function bootOtpRecovery() {
    const apiBase = String(form.dataset.apiBase || 'api/auth/email_otp').replace(/\/$/, '');
    const usernameInput = document.getElementById('otpUsername');
    const codeInput = document.getElementById('otpCode');
    const newPasswordInput = document.getElementById('newPassword');
    const confirmPasswordInput = document.getElementById('confirmPassword');
    const sendButton = document.getElementById('sendOtpButton');
    const verifyButton = document.getElementById('verifyOtpButton');
    const resendButton = document.getElementById('resendOtpButton');
    const changeUsernameButton = document.getElementById('changeUsernameButton');
    const adviserStartOverButton = document.getElementById('adviserStartOver');
    const adviserMessage = document.getElementById('adviserMessage');
    const destination = document.getElementById('otpDestination');
    const showPassword = document.getElementById('showPassword');
    const panels = [...form.querySelectorAll('[data-otp-step]')];
    let activeStep = 'username';
    let username = '';
    let resetCsrf = '';
    let requestInFlight = false;
    let cooldownUntil = 0;

    function setStep(step) {
        activeStep = step;
        panels.forEach((panel) => {
            const selected = panel.dataset.otpStep === step;
            panel.hidden = !selected;
            panel.classList.toggle('is-active', selected);
        });
        if (step === 'username') usernameInput?.focus();
        else if (step === 'code') codeInput?.focus();
        else if (step === 'password') newPasswordInput?.focus();
        else adviserStartOverButton?.focus();
    }

    function updateCooldown() {
        if (!resendButton) return;
        const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
        resendButton.disabled = requestInFlight || remaining > 0;
        resendButton.textContent = remaining ? `Resend in ${remaining}s` : 'Resend code';
    }

    function startCooldown(seconds) {
        cooldownUntil = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
        updateCooldown();
    }

    function updatePasswordRules() {
        const value = newPasswordInput?.value || '';
        const rules = {
            length: [...value].length >= 8,
            capital: /[A-Z]/.test(value),
            number: /[0-9]/.test(value)
        };
        form.querySelectorAll('.password-checks [data-rule]').forEach((input) => {
            const met = rules[input.dataset.rule] === true;
            input.checked = met;
            const label = input.closest('label');
            label?.classList.toggle('met', met);
            input.setAttribute('aria-label', `${label?.textContent.trim() || input.dataset.rule}${met ? ', met' : ''}`);
        });
        if (newPasswordInput) {
            newPasswordInput.setCustomValidity(
                Object.values(rules).every(Boolean) ? '' : 'Use at least 8 characters, a capital letter and a number.'
            );
        }
    }

    async function sendCode() {
        const value = String(usernameInput?.value || '').trim();
        if (!value || value.length > 191 || /[\u0000-\u001f\u007f]/.test(value)) {
            showStatus('Enter your username.', true);
            usernameInput?.focus();
            return;
        }

        requestInFlight = true;
        setBusy(sendButton, true, 'Send verification code', 'Sending code');
        setBusy(resendButton, true, 'Resend code', 'Sending code');
        try {
            const { result } = await postJson(`${apiBase}/send-otp.php`, { username: value });
            if (!result.success) {
                if (result.retry_after) startCooldown(result.retry_after);
                showStatus(result.message || 'We could not send the code. Please try again.', true);
                return;
            }
            username = value;
            if (result.flow === 'adviser') {
                if (adviserMessage) {
                    adviserMessage.textContent = result.message || 'Your adviser must verify your identity before a private password reset link can be issued.';
                }
                startCooldown(result.retry_after || 60);
                showStatus('Your recovery request was sent for adviser review.');
                setStep('adviser');
                return;
            }
            if (destination) destination.textContent = `Code sent to ${result.destination || 'your school-record email'}.`;
            startCooldown(result.retry_after || 60);
            showStatus(result.message || 'A verification code has been sent.');
            setStep('code');
        } catch (_) {
            showStatus('Unable to connect. Please try again.', true);
        } finally {
            requestInFlight = false;
            setBusy(sendButton, false, 'Send verification code', 'Sending code');
            updateCooldown();
        }
    }

    async function verifyCode() {
        const value = String(codeInput?.value || '').trim();
        if (!/^\d{6}$/.test(value)) {
            showStatus('Enter the 6-digit verification code.', true);
            codeInput?.focus();
            return;
        }

        requestInFlight = true;
        setBusy(verifyButton, true, 'Verify code', 'Checking code');
        if (resendButton) resendButton.disabled = true;
        try {
            const { result } = await postJson(`${apiBase}/verify-otp.php`, { username, otp: value });
            if (!result.success) {
                showStatus(result.message || 'That code is invalid or expired.', true);
                return;
            }
            resetCsrf = String(result.reset_csrf || '');
            showStatus(result.message || 'Code verified. Choose a new password.');
            setStep('password');
        } catch (_) {
            showStatus('Unable to connect. Please try again.', true);
        } finally {
            requestInFlight = false;
            setBusy(verifyButton, false, 'Verify code', 'Checking code');
            updateCooldown();
        }
    }

    async function resetPassword() {
        const newPassword = String(newPasswordInput?.value || '');
        const confirmPassword = String(confirmPasswordInput?.value || '');
        updatePasswordRules();
        if (!newPasswordInput?.checkValidity()) {
            showStatus('Use at least 8 characters, a capital letter and a number.', true);
            newPasswordInput?.focus();
            return;
        }
        if (newPassword !== confirmPassword) {
            showStatus('Passwords do not match.', true);
            confirmPasswordInput?.focus();
            return;
        }

        requestInFlight = true;
        const resetButton = document.getElementById('resetPasswordButton');
        setBusy(resetButton, true, 'Set new password', 'Saving password');
        try {
            const { result } = await postJson(`${apiBase}/reset-password.php`, {
                new_password: newPassword,
                confirm_password: confirmPassword,
                csrf: resetCsrf
            });
            showStatus(result.message || 'Please try again.', !result.success);
            if (result.success) {
                form.reset();
                username = '';
                resetCsrf = '';
                if (destination) destination.textContent = 'Sent to your school-record email.';
                setStep('username');
            }
        } catch (_) {
            showStatus('Unable to connect. Please try again.', true);
        } finally {
            requestInFlight = false;
            setBusy(resetButton, false, 'Set new password', 'Saving password');
        }
    }

    usernameInput?.addEventListener('input', () => {
        showStatus('');
    });
    codeInput?.addEventListener('input', () => {
        codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    });
    newPasswordInput?.addEventListener('input', updatePasswordRules);
    showPassword?.addEventListener('change', () => {
        const type = showPassword.checked ? 'text' : 'password';
        if (newPasswordInput) newPasswordInput.type = type;
        if (confirmPasswordInput) confirmPasswordInput.type = type;
    });
    resendButton?.addEventListener('click', () => {
        if (!requestInFlight && cooldownUntil <= Date.now()) sendCode();
    });
    changeUsernameButton?.addEventListener('click', () => {
        codeInput.value = '';
        showStatus('');
        setStep('username');
    });
    adviserStartOverButton?.addEventListener('click', () => {
        usernameInput.value = '';
        showStatus('');
        setStep('username');
    });
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (requestInFlight) return;
        if (activeStep === 'username') sendCode();
        else if (activeStep === 'code') verifyCode();
        else resetPassword();
    });
    setInterval(updateCooldown, 1000);
    updatePasswordRules();
    setStep('username');
    updateCooldown();
}

function bootLegacyReset() {
    const button = document.getElementById('submitButton');
    const newPasswordInput = document.getElementById('newPassword');
    const confirmPasswordInput = document.getElementById('confirmPassword');
    const showPassword = document.getElementById('showPassword');
    let token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    let requesting = false;

    function passwordRules(value) {
        return {
            length: [...value].length >= 8,
            capital: /[A-Z]/.test(value),
            number: /[0-9]/.test(value)
        };
    }

    function updateRules() {
        const value = newPasswordInput?.value || '';
        const rules = passwordRules(value);
        form.querySelectorAll('[data-rule]').forEach((input) => {
            input.checked = rules[input.dataset.rule];
            input.parentElement?.classList.toggle('met', input.checked);
        });
        newPasswordInput?.setCustomValidity(Object.values(rules).every(Boolean) ? '' : 'Use at least 8 characters, a capital letter and a number.');
        return rules;
    }

    function setFieldError(input, message = '') {
        if (!input) return;
        const errorNote = document.getElementById(`${input.id}Error`);
        const hasError = Boolean(message);
        input.classList.toggle('field-invalid', hasError);
        input.setAttribute('aria-invalid', String(hasError));
        if (errorNote) {
            errorNote.textContent = message;
            errorNote.hidden = !hasError;
        }
    }

    function validateResetFields() {
        const rules = updateRules();
        const newPassword = String(newPasswordInput?.value || '');
        const confirmPassword = String(confirmPasswordInput?.value || '');
        let valid = true;

        setFieldError(newPasswordInput, '');
        setFieldError(confirmPasswordInput, '');

        if (!newPassword) {
            setFieldError(newPasswordInput, 'Enter a new password.');
            valid = false;
        } else if (!Object.values(rules).every(Boolean)) {
            setFieldError(newPasswordInput, 'Use at least 8 characters, one capital letter, and one number.');
            valid = false;
        }

        if (!confirmPassword) {
            setFieldError(confirmPasswordInput, 'Confirm your new password.');
            valid = false;
        } else if (newPassword !== confirmPassword) {
            setFieldError(confirmPasswordInput, 'Passwords do not match.');
            valid = false;
        }

        if (!/^[a-f0-9]{64}$/.test(token)) {
            showStatus('This one-time reset link is missing or invalid. Request a new link through your adviser or registrar.', true);
            valid = false;
        } else if (!valid) {
            showStatus('Please correct the highlighted fields.', true);
        }

        return valid;
    }

    button.disabled = false;
    history.replaceState(null, '', location.pathname);
    newPasswordInput?.addEventListener('input', () => {
        const rules = updateRules();
        if (newPasswordInput.classList.contains('field-invalid') && Object.values(rules).every(Boolean)) {
            setFieldError(newPasswordInput, '');
        }
    });
    confirmPasswordInput?.addEventListener('input', () => {
        if (confirmPasswordInput.classList.contains('field-invalid') && confirmPasswordInput.value === newPasswordInput?.value) {
            setFieldError(confirmPasswordInput, '');
        }
    });
    showPassword?.addEventListener('change', (event) => {
        const type = event.target.checked ? 'text' : 'password';
        newPasswordInput.type = type;
        confirmPasswordInput.type = type;
    });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (requesting) return;
        const data = Object.fromEntries(new FormData(form));
        if (!validateResetFields()) return;
        requesting = true;
        setBusy(button, true, 'Reset password', 'Resetting password');
        try {
            const { result } = await postJson('api/auth/reset_password.php', { ...data, token });
            showStatus(result.message || 'Please try again.', !result.success);
            if (result.success) {
                token = '';
                form.reset();
                form.querySelectorAll('input').forEach((input) => { input.disabled = true; });
            }
        } catch (_) {
            showStatus('Unable to connect. Please try again.', true);
        } finally {
            requesting = false;
            button.disabled = false;
            button.textContent = token ? 'Reset password' : 'Password reset complete';
        }
    });
    updateRules();
}

if (form.dataset.mode === 'otp') {
    bootOtpRecovery();
} else {
    bootLegacyReset();
}
