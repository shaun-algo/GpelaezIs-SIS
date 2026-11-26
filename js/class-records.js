const API_BASE_URL = window.API_BASE || ((!!window.location.port && !['80', '443'].includes(String(window.location.port)))
    ? `${window.location.protocol}//${window.location.hostname}/deped_capstone2/api`
    : '/deped_capstone2/api');
const PERIOD_STATUS_SYNC_INTERVAL_MS = 10000;

axios.defaults.withCredentials = true;

const state = {
    classOfferings: [],
    gradingPeriods: [],
    selectedClassId: null,
    selectedSectionId: null,
    selectedSchoolYearId: null,
    selectedGradingPeriodId: null,
    classMeta: null,
    rosterGenderFilter: 'all',
    sheetGenderFilter: 'all',
    allSubjectClasses: [],
    allSubjectRows: [],
    roster: [],
    fullRoster: [],
    observedValuesData: null,
    observedGenderFilter: 'all',
    honorsData: null,
    currentUserName: '',
    schoolHeadName: '',
    recordSheet: null,
    activeTab: 'grades',
    userRole: null,
    roleKey: '',
    canEdit: false,
    isAdviser: false,
    isAdmin: false,
    gradeDirty: false,
    gradeDirtyKeys: new Set(),
    observedDirty: false,
    observedDirtyKeys: new Set(),
    paceRoster: [],
    paceData: null,
    paceEnrollmentId: null,
    paceDirty: false,
    paceRatingsSnapshot: '',
    paceLoadSequence: 0,
    paceRosterLoadSequence: 0,
    periodSyncTimer: null,
    periodSyncInFlight: false,
    periodSyncSignature: '',
    periodSyncBound: false,
    periodSyncNoticeSignature: '',
    rosterLoadSequence: 0,
    rosterLoadInFlight: false,
    gradeSaveInFlight: false,
};

function toast(icon, title) {
    const kind = String(icon || 'info').toLowerCase();
    const tone = (kind === 'success' || kind === 'error' || kind === 'warning' || kind === 'info') ? kind : 'info';
    const normalized = tone === 'warning' ? 'info' : tone;

    if (typeof window.showNotification === 'function') {
        window.showNotification(title, normalized);
        return Promise.resolve();
    }

    if (typeof Swal !== 'undefined' && typeof Swal.fire === 'function') {
        return Swal.fire({
            toast: true,
            position: 'bottom-end',
            showConfirmButton: false,
            timer: 2400,
            timerProgressBar: true,
            icon: tone,
            title,
            customClass: {
                popup: `deped-toast deped-toast--${tone}`,
            },
        });
    }

    if (typeof window.alert === 'function') {
        window.alert(title);
    }
    return Promise.resolve();
}

function apiErrorMessage(error, fallback = 'Request failed') {
    const data = error?.response?.data;
    if (data && typeof data === 'object' && String(data.message || '').trim()) {
        return String(data.message).trim();
    }
    if (typeof data === 'string' && data.trim()) {
        return data.trim();
    }
    return String(error?.message || fallback);
}

function fmt2(v) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
    return Number(v).toFixed(2);
}

function gradeValueOutlineHtml(value, passingMark = 75) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return '<span style="color:var(--gray-400);">—</span>';
    }
    const grade = Number(value);
    const passed = grade >= Number(passingMark || 75);
    const border = passed ? '#16a34a' : '#dc2626';
    const background = passed ? '#f0fdf4' : '#fef2f2';
    const color = passed ? '#166534' : '#991b1b';
    return `<span style="display:inline-block; min-width:58px; padding:4px 8px; border:1px solid ${border}; border-radius:6px; background:${background}; color:${color}; font-weight:800;">${fmt2(grade)}</span>`;
}

function gradeInputToneStyle(value, passingMark = 75) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '';
    const passed = Number(value) >= Number(passingMark || 75);
    return passed
        ? 'border-color:#16a34a; background:#f0fdf4; color:#166534; font-weight:800;'
        : 'border-color:#dc2626; background:#fef2f2; color:#991b1b; font-weight:800;';
}

function applyGradeInputTone(input, passingMark = 75) {
    if (!input) return;
    const grade = safeNum(input.value);
    input.style.borderColor = '';
    input.style.background = '';
    input.style.color = '';
    input.style.fontWeight = '';
    if (grade === null) return;
    const passed = grade >= Number(passingMark || 75);
    input.style.borderColor = passed ? '#16a34a' : '#dc2626';
    input.style.background = passed ? '#f0fdf4' : '#fef2f2';
    input.style.color = passed ? '#166534' : '#991b1b';
    input.style.fontWeight = '800';
}

function normalizeGradeInputValue(raw) {
    const text = String(raw ?? '').trim();
    if (text === '' || text === '—' || text === '-') {
        return { ok: true, value: '', grade: null };
    }
    const normalized = text.replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(normalized)) {
        return { ok: false, reason: 'Grade must be numeric' };
    }
    const grade = Number(normalized);
    if (!Number.isFinite(grade) || grade < 60 || grade > 100) {
        return { ok: false, reason: 'Grade must be between 60 and 100' };
    }
    const rounded = Math.round(grade * 100) / 100;
    return {
        ok: true,
        value: Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''),
        grade: rounded,
    };
}

function gradeCellKey(input) {
    const enrollmentId = Number(input?.dataset?.enrollmentId || input?.closest('tr')?.dataset?.enrollmentId || 0);
    const classId = Number(input?.dataset?.classId || state.selectedClassId || 0);
    return enrollmentId && classId ? `${classId}:${enrollmentId}` : '';
}

function normalizedGradeComparable(value) {
    const parsed = normalizeGradeInputValue(value);
    if (!parsed.ok || parsed.grade === null) return '';
    return Number(parsed.grade).toFixed(2);
}

function originalGradeComparable(input) {
    const enrollmentId = Number(input?.dataset?.enrollmentId || input?.closest('tr')?.dataset?.enrollmentId || 0);
    const classId = Number(input?.dataset?.classId || 0);
    if (classId) {
        const row = state.allSubjectRows.find((x) => Number(x.enrollment_id) === enrollmentId);
        const saved = row?.subject_grades?.[classId]?._savedQuarterlyGrade ?? null;
        return saved === null || saved === undefined || saved === '' ? '' : Number(saved).toFixed(2);
    }
    const row = state.fullRoster.find((x) => Number(x.enrollment_id) === enrollmentId);
    const saved = row?._savedQuarterlyGrade ?? null;
    return saved === null || saved === undefined || saved === '' ? '' : Number(saved).toFixed(2);
}

function setGradeDirty(isDirty) {
    state.gradeDirty = Boolean(isDirty);
    const btn = el('btnSave');
    if (btn) {
        btn.classList.toggle('cr-unsaved', state.gradeDirty);
        btn.title = state.gradeDirty ? 'Unsaved Grade Records' : '';
    }
}

function resetGradeDirty() {
    state.gradeDirtyKeys.clear();
    document.querySelectorAll('.cr-grade-input.cr-field-unsaved').forEach((input) => {
        input.classList.remove('cr-field-unsaved');
    });
    setGradeDirty(false);
}

function updateGradeDirtyFromInput(input) {
    const key = gradeCellKey(input);
    if (!key) return;
    const current = normalizedGradeComparable(input.value);
    const original = originalGradeComparable(input);
    if (current !== original) {
        state.gradeDirtyKeys.add(key);
    } else {
        state.gradeDirtyKeys.delete(key);
    }
    input.classList.toggle('cr-field-unsaved', current !== original);
    setGradeDirty(state.gradeDirtyKeys.size > 0);
}

function setObservedDirty(isDirty) {
    state.observedDirty = Boolean(isDirty);
    const btn = el('btnSaveObserved');
    if (btn) {
        btn.classList.toggle('cr-unsaved', state.observedDirty);
        btn.title = state.observedDirty ? 'Unsaved Observed Values' : '';
    }
}

function resetObservedDirty() {
    state.observedDirtyKeys.clear();
    document.querySelectorAll('.cr-observed-select.cr-field-unsaved').forEach((select) => {
        select.classList.remove('cr-field-unsaved');
    });
    setObservedDirty(false);
}

function observedValueComparable(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    return normalized === '—' || normalized === '-' ? '' : normalized;
}

function getObservedSavedValue(learner, indicatorId) {
    const savedValues = Object.prototype.hasOwnProperty.call(learner || {}, '_savedValues')
        ? learner._savedValues
        : learner?.values;
    return savedValues?.[indicatorId] ?? savedValues?.[String(indicatorId)] ?? '';
}

function syncObservedUnsavedIndicators() {
    document.querySelectorAll('#tbodyObservedValues .cr-observed-select').forEach((select) => {
        const key = `${Number(select.dataset.enrollmentId || 0)}:${Number(select.dataset.indicatorId || 0)}`;
        const dirty = state.observedDirtyKeys.has(key);
        select.classList.toggle('cr-field-unsaved', dirty);
    });
}

function updateObservedDirtyState() {
    const data = state.observedValuesData;
    state.observedDirtyKeys.clear();
    if (data && Array.isArray(data.learners) && Array.isArray(data.indicators)) {
        data.learners.forEach((learner) => {
            data.indicators.forEach((indicator) => {
                const enrollmentId = Number(learner.enrollment_id || 0);
                const indicatorId = Number(indicator.indicator_id || 0);
                if (!enrollmentId || !indicatorId) return;
                const current = observedValueComparable(learner.values?.[indicatorId] ?? learner.values?.[String(indicatorId)]);
                const saved = observedValueComparable(getObservedSavedValue(learner, indicatorId));
                if (current !== saved) {
                    state.observedDirtyKeys.add(`${enrollmentId}:${indicatorId}`);
                }
            });
        });
    }
    syncObservedUnsavedIndicators();
    setObservedDirty(state.observedDirtyKeys.size > 0);
}

function hasUnsavedChanges() {
    return Boolean(state.gradeDirty || state.observedDirty || state.paceDirty);
}

function resetUnsavedChanges() {
    resetGradeDirty();
    resetObservedDirty();
    state.paceDirty = false;
    state.paceRatingsSnapshot = serializePaceRatingFields();
    updatePaceSaveControl();
}

function closeOpenChoicesForUnsavedPrompt() {
    document.querySelectorAll('select').forEach(select => {
        try {
            select._choicesInstance?.hideDropdown();
            select._choicesInstance?.containerOuter?.element?.classList.remove('is-open');
        } catch (_) {}
    });
    document.querySelectorAll('.choices.is-open').forEach(choices => {
        choices.classList.remove('is-open', 'is-focused');
        choices.querySelector('.choices__list--dropdown.is-active, .choices__list[aria-expanded="true"]')?.classList.remove('is-active');
        choices.querySelector('.choices__list--dropdown, .choices__list[aria-expanded]')?.setAttribute('aria-expanded', 'false');
        choices.querySelector('.choices__input')?.blur();
    });
    document.querySelectorAll('.choices__list--dropdown.is-active, .choices__list[aria-expanded="true"]').forEach(dropdown => {
        dropdown.classList.remove('is-active');
        dropdown.setAttribute('aria-expanded', 'false');
        dropdown.closest('.choices')?.classList.remove('is-open', 'is-focused');
    });
    const active = document.activeElement;
    if (active && typeof active.blur === 'function') active.blur();
}

async function confirmDiscardUnsavedGrades() {
    if (!hasUnsavedChanges()) return true;
    const hasGrades = Boolean(state.gradeDirty);
    const hasObserved = Boolean(state.observedDirty);
    const hasPace = Boolean(state.paceDirty);
    const title = hasPace && !hasGrades && !hasObserved
        ? 'Unsaved Grade 1 PACE ratings'
        : hasObserved && !hasGrades && !hasPace ? 'Unsaved observed values' : 'Unsaved grade records';
    const message = hasPace && !hasGrades && !hasObserved
        ? 'Save PACE ratings first. Unsaved Grade 1 entries will be lost.'
        : hasObserved && !hasGrades && !hasPace
        ? 'Save observed values first. Unsaved observed value entries will be lost.'
        : hasGrades && hasObserved && hasPace
        ? 'Save your records first. Unsaved grades, observed values, and PACE ratings will be lost.'
        : hasGrades && hasObserved
        ? 'Save your records first. Unsaved grade and observed value entries will be lost.'
        : hasGrades && hasPace
        ? 'Save your records first. Unsaved grades and PACE ratings will be lost.'
        : hasObserved && hasPace
        ? 'Save your records first. Unsaved observed values and PACE ratings will be lost.'
        : 'Save grade records first. Unsaved grade inputs will be lost.';
    if (typeof window.confirmUnsavedChanges === 'function') {
        return window.confirmUnsavedChanges({
            title,
            message,
            confirmLabel: 'Leave without saving',
            cancelLabel: 'Stay',
            beforeOpen: closeOpenChoicesForUnsavedPrompt
        });
    }

    closeOpenChoicesForUnsavedPrompt();
    return window.confirm(`${title}\n\n${message}\n\nContinue without saving?`);
}

function installUnsavedGradeLeaveGuard() {
    window.addEventListener('beforeunload', (event) => {
        if (!hasUnsavedChanges()) return;
        event.preventDefault();
        event.returnValue = '';
    });

    document.addEventListener('click', async (event) => {
        if (!hasUnsavedChanges()) return;
        const link = event.target?.closest?.('a[href]');
        if (!link) return;
        const href = String(link.getAttribute('href') || '');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        event.preventDefault();
        event.stopPropagation();
        if (await confirmDiscardUnsavedGrades()) {
            resetUnsavedChanges();
            window.location.href = link.href;
        }
    }, true);
}

function bindSelectChangeWithGradeGuard(select, handler) {
    if (!select) return;
    select.dataset.previousValue = select.value || '';
    const remember = () => {
        select.dataset.previousValue = select.value || '';
    };
    select.addEventListener('focus', remember);
    select.addEventListener('pointerdown', remember);
    select.addEventListener('keydown', remember);
    select.addEventListener('change', async () => {
        const previousValue = select.dataset.previousValue || '';
        if (hasUnsavedChanges() && !(await confirmDiscardUnsavedGrades())) {
            select.value = previousValue;
            return;
        }
        if (hasUnsavedChanges()) resetUnsavedChanges();
        try {
            await handler();
            select.dataset.previousValue = select.value || '';
        } catch (error) {
            select.dataset.previousValue = select.value || '';
            throw error;
        }
    });
}

function updateGradeModelFromInput(input) {
    if (!input) return;
    const enrollmentId = Number(input.dataset.enrollmentId || input.closest('tr')?.dataset?.enrollmentId || 0);
    const classId = Number(input.dataset.classId || 0);
    const grade = input.value === '' ? null : safeNum(input.value);

    if (classId) {
        const row = state.allSubjectRows.find((x) => Number(x.enrollment_id) === enrollmentId);
        if (!row) return;
        row.subject_grades = row.subject_grades || {};
        row.subject_grades[classId] = row.subject_grades[classId] || {};
        row.subject_grades[classId].quarterly_grade = grade;
        applyGradeInputTone(input, Number(input.dataset.passingMark || 75));
        return;
    }

    const row = state.fullRoster.find((x) => Number(x.enrollment_id) === enrollmentId);
    if (!row) return;
    row.quarterly_grade = grade;
    row._computed_qg = grade;

    const passingMark = Number(state.classMeta?.passing_mark ?? 75);
    const tds = input.closest('tr')?.querySelectorAll('td') || [];
    applyGradeInputTone(input, passingMark);
    if (tds[2]) tds[2].innerHTML = grade === null ? '' : remarkBadgeHtml(grade, passingMark);
}

function setGradeInputFromSpreadsheetValue(input, raw) {
    if (!input || input.readOnly || input.disabled) return { applied: false, skipped: false, reason: 'Cell is locked' };
    const parsed = normalizeGradeInputValue(raw);
    if (!parsed.ok) {
        input.classList.add('cr-grade-invalid');
        setTimeout(() => input.classList.remove('cr-grade-invalid'), 1500);
        return { applied: false, skipped: true, reason: parsed.reason };
    }
    input.value = parsed.value;
    updateGradeModelFromInput(input);
    updateGradeDirtyFromInput(input);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { applied: true, skipped: false };
}

function getGradeGridInput(rowIndex, colIndex) {
    return el('tbodyGrades')?.querySelector(`.cr-grade-input[data-row-index="${rowIndex}"][data-col-index="${colIndex}"]`) || null;
}

function focusGradeGridCell(rowIndex, colIndex) {
    const target = getGradeGridInput(rowIndex, colIndex);
    if (!target || target.readOnly || target.disabled) return false;
    target.focus();
    target.select();
    return true;
}

function moveGradeGridFocus(input, rowDelta, colDelta) {
    const rowIndex = Number(input.dataset.rowIndex || 0);
    const colIndex = Number(input.dataset.colIndex || 0);
    const maxAttempts = Math.max(1, document.querySelectorAll('#tbodyGrades .cr-grade-input').length);
    let nextRow = rowIndex + rowDelta;
    let nextCol = colIndex + colDelta;

    for (let i = 0; i < maxAttempts; i += 1) {
        if (focusGradeGridCell(nextRow, nextCol)) return true;
        if (colDelta !== 0 && rowDelta === 0) {
            const rowInputs = Array.from(el('tbodyGrades')?.querySelectorAll(`.cr-grade-input[data-row-index="${nextRow}"]`) || []);
            const colValues = rowInputs.map((node) => Number(node.dataset.colIndex || 0));
            const minCol = colValues.length ? Math.min(...colValues) : 0;
            const maxCol = colValues.length ? Math.max(...colValues) : 0;
            if (nextCol > maxCol) {
                nextRow += 1;
                nextCol = minCol;
            } else if (nextCol < minCol) {
                nextRow -= 1;
                nextCol = maxCol;
            } else {
                nextCol += colDelta;
            }
        } else {
            nextRow += rowDelta;
            nextCol += colDelta;
        }
    }
    return false;
}

function handleGradeGridPaste(event, startInput) {
    const text = (event.clipboardData || window.clipboardData)?.getData('text') || '';
    if (!text.includes('\t') && !text.includes('\n') && !text.includes('\r')) return false;
    event.preventDefault();

    const rows = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    if (!rows.length) return true;

    const startRow = Number(startInput.dataset.rowIndex || 0);
    const startCol = Number(startInput.dataset.colIndex || 0);
    let applied = 0;
    let skipped = 0;
    const reasons = new Set();

    rows.forEach((line, rowOffset) => {
        line.split('\t').forEach((cell, colOffset) => {
            const input = getGradeGridInput(startRow + rowOffset, startCol + colOffset);
            if (!input) {
                // Spreadsheet selections can include trailing blank cells beyond the visible grid.
                // They do not represent skipped grade values and should not make a valid paste look incomplete.
                if (String(cell ?? '').trim() === '') return;
                skipped += 1;
                reasons.add('Pasted range exceeded the visible table');
                return;
            }
            const result = setGradeInputFromSpreadsheetValue(input, cell);
            if (result.applied) applied += 1;
            if (result.skipped) {
                skipped += 1;
                if (result.reason) reasons.add(result.reason);
            }
        });
    });

    renderGradeMetrics();
    const lastRow = Math.min(startRow + rows.length - 1, startRow + rows.length);
    const lastCol = startCol + Math.max(...rows.map((line) => line.split('\t').length)) - 1;
    focusGradeGridCell(lastRow, lastCol);

    const overflowOnly = skipped > 0 && reasons.size === 1 && reasons.has('Pasted range exceeded the visible table');
    if (applied > 0 && (skipped === 0 || overflowOnly)) {
        toast('success', 'All visible grade values were pasted successfully.');
    } else {
        const detail = skipped ? `, skipped ${skipped}${reasons.size ? ` (${Array.from(reasons).slice(0, 2).join('; ')})` : ''}` : '';
        toast(skipped ? 'warning' : 'success', `Pasted ${applied} grade${applied === 1 ? '' : 's'}${detail}`);
    }
    return true;
}

function attachGradeSpreadsheetHandlers(container = el('tbodyGrades')) {
    const inputs = Array.from(container?.querySelectorAll('.cr-grade-input') || []);
    inputs.forEach((input) => {
        input.addEventListener('focus', () => input.classList.add('cr-grade-active'));
        input.addEventListener('blur', () => {
            input.classList.remove('cr-grade-active');
            const parsed = normalizeGradeInputValue(input.value);
            if (!parsed.ok) {
                input.value = '';
                input.classList.add('cr-grade-invalid');
                setTimeout(() => input.classList.remove('cr-grade-invalid'), 1500);
                toast('error', parsed.reason);
            } else {
                input.value = parsed.value;
            }
            updateGradeModelFromInput(input);
            updateGradeDirtyFromInput(input);
            renderGradeMetrics();
        });
        input.addEventListener('keydown', (event) => {
            if (event.ctrlKey || event.metaKey) return;
            if (event.key === 'Enter') {
                event.preventDefault();
                moveGradeGridFocus(input, event.shiftKey ? -1 : 1, 0);
                return;
            }
            if (event.key === 'Tab') {
                event.preventDefault();
                moveGradeGridFocus(input, 0, event.shiftKey ? -1 : 1);
                return;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                moveGradeGridFocus(input, -1, 0);
                return;
            }
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveGradeGridFocus(input, 1, 0);
                return;
            }
            const allowed = ['Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
            if (allowed.includes(event.key)) return;
            if (/^\d$/.test(event.key)) return;
            if (event.key === '.' && !input.value.includes('.')) return;
            event.preventDefault();
        });
        input.addEventListener('paste', (event) => {
            if (handleGradeGridPaste(event, input)) return;
            event.preventDefault();
            const raw = (event.clipboardData || window.clipboardData)?.getData('text') || '';
            const result = setGradeInputFromSpreadsheetValue(input, raw);
            if (result.skipped) toast('error', result.reason || 'Invalid grade');
            renderGradeMetrics();
        });
        input.addEventListener('input', () => {
            updateGradeModelFromInput(input);
            updateGradeDirtyFromInput(input);
            renderGradeMetrics();
        });
    });
}

function safeNum(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    if (Number.isNaN(n)) return null;
    return n;
}

function fileSafe(value) {
    return String(value ?? '')
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, '_')
        .slice(0, 90);
}

function exportFileName(value, fallback = 'Export') {
    const cleaned = String(value ?? fallback)
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/\s+-\s+/g, ' - ')
        .replace(/^[. ]+|[. ]+$/g, '')
        .slice(0, 140)
        .trim();
    return cleaned || fallback;
}

function remarkFor(qg, passingMark) {
    if (qg === null) return '';
    return qg >= passingMark ? 'Passed' : 'Failed';
}

function remarkBadgeHtml(remarkOrGrade, passingMark = 75) {
    const raw = String(remarkOrGrade ?? '').trim();
    const remark = Number.isNaN(Number(remarkOrGrade)) ? raw : remarkFor(Number(remarkOrGrade), passingMark);
    if (!remark) return '';
    const failed = /fail/i.test(remark);
    const border = failed ? '#dc2626' : '#16a34a';
    const background = failed ? '#fef2f2' : '#f0fdf4';
    const color = failed ? '#991b1b' : '#166534';
    return `<span class="tx-badge" style="border:1px solid ${border}; background:${background}; color:${color}; font-weight:800;">${escapeHtml(remark)}</span>`;
}

async function apiGet(path, params) {
    const res = await axios.get(`${API_BASE_URL}${path}`, { params: { ...params, _: Date.now() } });
    return res.data;
}

async function apiPost(path, params, body) {
    const res = await axios.post(`${API_BASE_URL}${path}?${new URLSearchParams(params)}`, body);
    return res.data;
}

async function apiPostOperation(path, operation, body) {
    const res = await axios.post(`${API_BASE_URL}${path}?operation=${encodeURIComponent(operation)}`, body);
    return res.data;
}

function crLoadScriptOnce(src, key) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-lib="${key}"]`);
        if (existing) {
            if (existing.dataset.loaded === '1') return resolve();
            if (existing.dataset.failed === '1') {
                existing.remove();
            } else {
                existing.addEventListener('load', resolve, { once: true });
                existing.addEventListener('error', () => reject(new Error(`Failed to load ${key}`)), { once: true });
                return;
            }
        }

        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.dataset.lib = key;
        script.addEventListener('load', () => {
            script.dataset.loaded = '1';
            resolve();
        }, { once: true });
        script.addEventListener('error', () => {
            script.dataset.failed = '1';
            reject(new Error(`Failed to load ${key}`));
        }, { once: true });
        document.head.appendChild(script);
    });
}

async function ensureXlsx() {
    if (window.XLSX) return window.XLSX;
    const prefixes = [
        window.APP_BASE || '',
        '/deped_capstone2',
        '..',
        ''
    ].filter((value, index, arr) => value != null && arr.indexOf(value) === index);
    const errors = [];
    for (const prefix of prefixes) {
        const src = `${String(prefix).replace(/\/$/, '')}/assets/vendor/xlsx/xlsx.full.min.js`;
        try {
            await crLoadScriptOnce(src, 'xlsx');
            if (window.XLSX) return window.XLSX;
        } catch (error) {
            errors.push(`${src}: ${error?.message || 'failed'}`);
        }
    }
    if (!window.XLSX) throw new Error(`Excel library is unavailable. Tried: ${errors.join('; ')}`);
    return window.XLSX;
}

function el(id) {
    return document.getElementById(id);
}

function observedValuesTemplateAvailableForSchoolYear(schoolYearId) {
    const offering = state.classOfferings.find((item) => Number(item.school_year_id) === Number(schoolYearId));
    const yearLabel = String(offering?.year_label || '');
    const yearPair = yearLabel.match(/(?:20)?(\d{2})\s*[-–/]\s*(?:20)?(\d{2})/);
    return !(yearPair && yearPair[1] === '26' && yearPair[2] === '27');
}

function observedValuesAllowedForSection(sectionId) {
    const selectedSchoolYearId = Number(el('selClassRecordSchoolYear')?.value || state.selectedSchoolYearId || 0);
    const meta = getSectionMeta(sectionId, selectedSchoolYearId);
    const schoolYearId = Number(meta?.school_year_id || selectedSchoolYearId);
    if (!observedValuesTemplateAvailableForSchoolYear(schoolYearId)) return false;
    // Grades 2-10 use numeric SF9 templates; historical Grade 1 descriptive years
    // retain the legacy observed-values panel when their school year supports it.
    return !meta || isGradeOnePaceSection(sectionId) || Number(meta.grade_level_id || 0) === 1;
}

function isGradeOnePaceSection(sectionId = Number(el('selSection')?.value || 0)) {
    const schoolYearId = Number(el('selClassRecordSchoolYear')?.value || state.selectedSchoolYearId || 0);
    return state.classOfferings.some((offering) =>
        Number(offering.section_id) === Number(sectionId)
        && (!schoolYearId || Number(offering.school_year_id) === schoolYearId)
        && String(offering.grading_mode || '').toLowerCase() === 'descriptive'
        && String(offering.sf9_template_variant || '').toUpperCase() === 'G1'
    );
}

function setActiveTab(tab) {
    const sectionId = Number(el('selSection')?.value || 0);
    const paceAllowed = isGradeOnePaceSection(sectionId);
    if (tab === 'grades' && paceAllowed) tab = 'pace';
    if (tab === 'pace' && !paceAllowed) tab = 'grades';
    if (tab === 'observed' && !observedValuesAllowedForSection(sectionId)) {
        tab = 'grades';
    }
    const tabs = {
        grades: { btn: el('tabBtnGrades'), section: el('tabGrades'), title: 'Grade Encoding', sub: '' },
        pace: { btn: el('tabBtnPace'), section: el('tabPace'), title: 'Grade 1 PACE Entry', sub: '' },
        observed: { btn: el('tabBtnObserved'), section: el('tabObserved'), title: 'Observed Values', sub: '' },
        honors: { btn: el('tabBtnHonors'), section: el('tabHonors'), title: 'Honors Rank Reports'},
    };

    Object.keys(tabs).forEach((key) => {
        const { btn, section } = tabs[key];
        if (key === tab) {
            btn?.classList.add('active');
            section.style.display = 'block';
        } else {
            btn?.classList.remove('active');
            section.style.display = 'none';
        }
    });

    state.activeTab = tab;
    el('cr-header-title').textContent = tabs[tab].title;
    el('cr-header-sub').textContent = tabs[tab].sub;

    const bar = el('crContextBar');
    if (bar) {
        bar.style.display = (tab === 'grades' || tab === 'observed' || tab === 'pace') ? 'grid' : 'none';
    }
    updateContextBar(Number(el('selSection')?.value || 0));
    updatePeriodStatusControl();
    updatePaceSaveControl();
}

function uniqueBy(arr, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of arr) {
        const k = keyFn(item);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(item);
    }
    return out;
}

function populateSelect(selectEl, items, { valueKey, labelKey, placeholder } = {}) {
    selectEl.innerHTML = '';

    if (placeholder) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = placeholder;
        selectEl.appendChild(opt);
    }

    for (const it of items) {
        const opt = document.createElement('option');
        opt.value = String(it[valueKey]);
        opt.textContent = String(it[labelKey]);
        selectEl.appendChild(opt);
    }
}

function enhanceClassRecordDropdowns() {
    const ChoicesCtor = window.Choices;
    if (typeof ChoicesCtor !== 'function') return false;

    const selectIds = [
        'selClassRecordSchoolYear', 'selGradeLevel', 'selSection', 'selSubject', 'selPeriod',
        'selPacePeriod', 'selPaceLearner',
        'selHonScope', 'selHonSection', 'selHonSchoolYear', 'selHonGradeLevel', 'selHonMode', 'selHonPeriod'
    ];
    selectIds.forEach((id) => {
        const selectEl = el(id);
        if (!selectEl || selectEl.dataset.native === 'true' || selectEl.dataset.enhanced === 'choices') return;
        if (selectEl.closest('.choices')) return;

        const instance = new ChoicesCtor(selectEl, {
            allowHTML: false,
            shouldSort: false,
            searchEnabled: selectEl.dataset.searchEnabled === 'true' || (selectEl.options?.length || 0) > 8,
            searchPlaceholderValue: selectEl.dataset.searchPlaceholder || 'Search...',
            searchResultLimit: 50,
            itemSelectText: '',
            placeholder: true,
            placeholderValue: selectEl.getAttribute('placeholder') || '',
        });
        selectEl.dataset.enhanced = 'choices';
        selectEl._choicesInstance = instance;

        let refreshTimer = null;
        const observer = new MutationObserver(() => {
            if (refreshTimer) window.clearTimeout(refreshTimer);
            refreshTimer = window.setTimeout(() => {
                try { instance.refresh(); } catch (_) { /* keep the select usable */ }
            }, 50);
        });
        observer.observe(selectEl, { childList: true, subtree: true });
        selectEl._choicesObserver = observer;
    });

    return true;
}

function scheduleClassRecordDropdownEnhancement() {
    let attempts = 0;
    const attempt = () => {
        attempts += 1;
        try { window.enhanceControls?.(); } catch (_) { /* direct fallback below */ }
        enhanceClassRecordDropdowns();

        const pending = [
            'selClassRecordSchoolYear', 'selGradeLevel', 'selSection', 'selSubject', 'selPeriod',
            'selPacePeriod', 'selPaceLearner',
            'selHonScope', 'selHonSection', 'selHonSchoolYear', 'selHonGradeLevel', 'selHonMode', 'selHonPeriod'
        ]
            .some((id) => {
                const selectEl = el(id);
                return selectEl && selectEl.dataset.enhanced !== 'choices';
            });
        if (pending && attempts < 40) window.setTimeout(attempt, 150);
    };
    attempt();
}

function getQueryInt(name) {
    try {
        const params = new URLSearchParams(window.location.search || '');
        const raw = params.get(name);
        if (raw === null || raw === undefined || raw === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) ? Math.trunc(n) : null;
    } catch (_) {
        return null;
    }
}

function selectHasValue(selectEl, value) {
    const v = String(value);
    return Array.from(selectEl.options || []).some((o) => String(o.value) === v);
}

function selectFirstNonEmpty(selectEl) {
    const opt = Array.from(selectEl.options || []).find((o) => String(o.value || '').trim() !== '');
    if (opt) selectEl.value = opt.value;
}

function pickDefaultSchoolYearId(preferredSectionId = null, preferredClassId = null) {
    if (preferredSectionId) {
        const hit = state.classOfferings.find((o) => Number(o.section_id) === Number(preferredSectionId));
        if (hit) return Number(hit.school_year_id);
    }

    if (preferredClassId) {
        const hit = state.classOfferings.find((o) => Number(o.class_id) === Number(preferredClassId));
        if (hit) return Number(hit.school_year_id);
    }

    const years = getClassRecordSchoolYears();
    if (!years.length) return null;

    const activeWithOpen = years.find((sy) =>
        Number(sy.school_year_is_active || 0) === 1 && schoolYearHasOpenPeriod(sy.school_year_id)
    );
    if (activeWithOpen) return Number(activeWithOpen.school_year_id);

    const active = years.find((sy) => Number(sy.school_year_is_active || 0) === 1);
    if (active) return Number(active.school_year_id);

    return Number(years[0].school_year_id);
}

function pickDefaultSectionId(preferredSectionId = null, preferredClassId = null, schoolYearId = null) {
    const inSchoolYear = (o) => !schoolYearId || Number(o.school_year_id) === Number(schoolYearId);

    if (preferredSectionId && state.classOfferings.some((o) => Number(o.section_id) === Number(preferredSectionId) && inSchoolYear(o))) {
        return Number(preferredSectionId);
    }

    if (preferredClassId) {
        const hit = state.classOfferings.find((o) => Number(o.class_id) === Number(preferredClassId) && inSchoolYear(o));
        if (hit) return Number(hit.section_id);
    }

    const offerings = Array.isArray(state.classOfferings) ? state.classOfferings : [];
    const scopedOfferings = schoolYearId
        ? offerings.filter((o) => Number(o.school_year_id) === Number(schoolYearId))
        : offerings;
    if (!scopedOfferings.length) return null;

    // Prefer school years that actually have open grading periods so the period dropdown isn't empty.
    const withOpenPeriods = scopedOfferings.filter((o) => schoolYearHasOpenPeriod(o.school_year_id));
    if (withOpenPeriods.length) {
        const active = withOpenPeriods.filter((o) => Number(o.school_year_is_active || 0) === 1);
        const base = active.length ? active : withOpenPeriods;
        const first = base[0];
        if (first) return Number(first.section_id);
    }

    const active = scopedOfferings.filter((o) => Number(o.school_year_is_active || 0) === 1);

    const base = active.length ? active : scopedOfferings;
    const syIds = base.map((o) => Number(o.school_year_id) || 0);
    const maxSy = syIds.length ? Math.max(...syIds) : 0;
    const latest = maxSy ? base.filter((o) => (Number(o.school_year_id) || 0) === maxSy) : base;

    // Prefer the teacher's assigned/advisory section when it exists in the dataset.
    // (sections.adviser_id matches the teacher's employee_id, which is also co.teacher_id.)
    const teacherIds = new Set(latest.map((o) => Number(o.teacher_id || 0)).filter((x) => x > 0));
    if (teacherIds.size === 1) {
        const adviserHit = latest.find((o) => {
            const adviserId = Number(o.adviser_id || 0);
            const teacherId = Number(o.teacher_id || 0);
            return adviserId > 0 && teacherId > 0 && adviserId === teacherId;
        });
        if (adviserHit) return Number(adviserHit.section_id);
    }

    const first = latest[0] || scopedOfferings[0];
    return first ? Number(first.section_id) : null;
}

function isPeriodOpen(p) {
    const status = String(p?.status_name ?? p?.status ?? '').trim().toLowerCase();
    return status === 'open';
}

function periodStatusName(p) {
    return String(p?.status_name ?? p?.status ?? 'Open').trim() || 'Open';
}

function csvCell(value) {
    const text = String(value ?? '');
    if (/[",\r\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function normalizeImportHeader(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/^\uFEFF/, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    const src = String(text || '').replace(/^\uFEFF/, '');

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        const next = src[i + 1];

        if (inQuotes) {
            if (ch === '"' && next === '"') {
                cell += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                cell += ch;
            }
            continue;
        }

        if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            row.push(cell);
            cell = '';
        } else if (ch === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else if (ch !== '\r') {
            cell += ch;
        }
    }

    row.push(cell);
    if (row.some((v) => String(v).trim() !== '') || rows.length === 0) rows.push(row);
    return rows;
}

function crEscapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    }[ch]));
}

function formatLearnerNameForTable(value) {
    const name = String(value || '').trim();
    const comma = name.indexOf(',');
    if (comma < 0) return name;

    const surname = name.slice(0, comma).trim();
    const givenAndMiddle = name.slice(comma + 1).trim();
    const parts = givenAndMiddle.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return name;

    const suffixes = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v']);
    const suffix = suffixes.has(parts[parts.length - 1].toLowerCase()) ? parts.pop() : '';
    if (parts.length < 2) return name;

    const firstName = parts.shift();
    const middleInitials = parts.map((part) => {
        if (/^[A-Za-z]\.$/.test(part)) return part;
        if (/^[IVXLC]+\.$/i.test(part)) return part;
        const segments = part.split('-').filter(Boolean);
        return `${segments.map((segment) => `${Array.from(segment.replace(/\.+$/, ''))[0] || ''}.`).join('-')}`;
    }).filter(Boolean);
    return `${surname}, ${[firstName, ...middleInitials, suffix].filter(Boolean).join(' ')}`;
}

function learnerSortKey(row) {
    return String(row?.learner_name || '').trim().toLowerCase();
}

function sortLearnersByName(rows) {
    return [...(rows || [])].sort((a, b) => {
        const byName = learnerSortKey(a).localeCompare(learnerSortKey(b));
        if (byName !== 0) return byName;
        return String(a?.lrn || '').localeCompare(String(b?.lrn || ''));
    });
}

function mapehComponentRank(name) {
    const normalized = String(name || '').toLowerCase();
    if (/\bmusic\s*(and|&)\s*arts?\b/.test(normalized)) return 1;
    if (/\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/.test(normalized)) return 2;
    if (/\bmusic\b/.test(normalized)) return 1;
    if (/\barts?\b/.test(normalized)) return 2;
    if (/\bphysical education\b|\bpe\b|\bp\.e\.\b/.test(normalized)) return 3;
    if (/\bhealth\b/.test(normalized)) return 4;
    return 0;
}

function isMapehComponentName(name) {
    const normalized = String(name || '').toLowerCase();
    if (normalized.includes('mapeh') && normalized.includes('component')) return true;
    if (normalized.includes('mapeh')) return false;
    return /\bmusic\s*(and|&)\s*arts?\b/.test(normalized)
        || /\b(physical education|pe|p\.e\.)\s*(and|&)\s*health\b/.test(normalized)
        || /\b(music|arts|physical education|health|pe|p\.e\.)\b/.test(normalized);
}

function subjectSortKey(subject) {
    const name = String(subject?.subject_name || subject?.label || '').trim();
    const mapehRank = mapehComponentRank(name);
    return {
        mapehRank,
        name,
        id: Number(subject?.subject_id || subject?.class_id || 0),
    };
}

function compareSubjects(a, b) {
    const aa = subjectSortKey(a);
    const bb = subjectSortKey(b);
    if (aa.mapehRank && bb.mapehRank && aa.mapehRank !== bb.mapehRank) {
        return aa.mapehRank - bb.mapehRank;
    }
    if (aa.mapehRank && !bb.mapehRank) return 1;
    if (!aa.mapehRank && bb.mapehRank) return -1;
    const byName = aa.name.localeCompare(bb.name);
    if (byName !== 0) return byName;
    return aa.id - bb.id;
}

function normalizeGender(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'm' || raw === 'male') return 'male';
    if (raw === 'f' || raw === 'female') return 'female';
    return raw;
}

function normalizeEnrollmentStatusLabel(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.toLowerCase() === 'no status') return 'Enrolled';
    if (raw.toLowerCase() === 'dropped out') return 'Dropped';
    if (raw.toLowerCase() === 'transferred') return 'Transferred Out';
    return raw;
}

function enrollmentStatusBadgeHtml(value) {
    const status = normalizeEnrollmentStatusLabel(value);
    if (status === 'Enrolled') return '';

    const palette = {
        'Dropped': 'background:#fef2f2; color:#991b1b; border:1px solid #fecaca;',
        'Transferred Out': 'background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe;',
        'Completed': 'background:#f5f3ff; color:#6d28d9; border:1px solid #ddd6fe;',
    };
    const style = palette[status] || 'background:#f3f4f6; color:#374151; border:1px solid #d1d5db;';
    const historyLabel = ['Dropped', 'Transferred Out'].includes(status) ? ' · history only' : '';
    return `<span class="cr-enrollment-status" style="display:inline-flex; align-items:center; gap:4px; margin-left:4px; padding:2px 6px; border-radius:999px; font-size:10px; font-weight:800; line-height:1.2; ${style}" title="${escapeHtml(status)} enrollment">${escapeHtml(status)}${historyLabel}</span>`;
}

function filterLearnersForTable(rows, searchInputId, genderFilter) {
    const searchTerm = String(el(searchInputId)?.value || '').trim().toLowerCase();
    return sortLearnersByName(rows || []).filter((r) => {
        const gender = String(genderFilter || 'all').toLowerCase();
        if (gender !== 'all' && normalizeGender(r.gender) !== gender) return false;
        if (!searchTerm) return true;
        const name = String(r.learner_name || '').toLowerCase();
        const lrn = String(r.lrn || '').toLowerCase();
        return name.includes(searchTerm) || lrn.includes(searchTerm);
    });
}

function appendGenderGroupedRows(tbody, rows, renderRow) {
    const groups = [
        { key: 'male', label: 'Male' },
        { key: 'female', label: 'Female' },
        { key: 'other', label: 'Other' },
    ];
    const columnCount = Math.max(1, tbody.closest('table')?.querySelectorAll('thead th').length || 1);
    let rowIndex = 0;

    groups.forEach((group) => {
        const groupRows = rows.filter((row) => {
            const gender = normalizeGender(row.gender);
            return group.key === 'other' ? !['male', 'female'].includes(gender) : gender === group.key;
        });
        if (!groupRows.length) return;

        const groupRow = document.createElement('tr');
        groupRow.className = 'cr-gender-group-row';
        const groupCell = document.createElement('td');
        groupCell.className = 'cr-gender-group-cell';
        groupCell.textContent = group.label;
        groupRow.appendChild(groupCell);
        for (let columnIndex = 1; columnIndex < columnCount; columnIndex += 1) {
            const fillCell = document.createElement('td');
            fillCell.className = 'cr-gender-group-fill';
            fillCell.setAttribute('aria-hidden', 'true');
            groupRow.appendChild(fillCell);
        }
        tbody.appendChild(groupRow);

        groupRows.forEach((row) => {
            const renderedRow = renderRow(row, rowIndex);
            if (renderedRow) tbody.appendChild(renderedRow);
            rowIndex += 1;
        });
    });
}

function getTemplateLearnersForCurrentGender() {
    const gender = String(state.rosterGenderFilter || 'all').toLowerCase();
    return sortLearnersByName(state.fullRoster || []).filter((row) =>
        gender === 'all' || normalizeGender(row.gender) === gender
    );
}

function genderFilterLabel(value) {
    const gender = String(value || 'all').toLowerCase();
    if (gender === 'male') return 'Male';
    if (gender === 'female') return 'Female';
    return 'All';
}

function setGenderFilterButtons(selector, activeValue) {
    document.querySelectorAll(selector).forEach((btn) => {
        const value = btn.getAttribute(selector.includes('roster') ? 'data-cr-roster-gender' : 'data-cr-sheet-gender');
        btn.classList.toggle('active', String(value || 'all') === String(activeValue || 'all'));
    });
}

function schoolYearHasOpenPeriod(schoolYearId) {
    return (state.gradingPeriods || []).some((p) =>
        Number(p.school_year_id) === Number(schoolYearId) && isPeriodOpen(p)
    );
}

function pickDefaultGradingPeriodId(schoolYearId, preferredGradingPeriodId = null, { openOnly = false } = {}) {
    if (preferredGradingPeriodId) {
        const preferred = state.gradingPeriods.find((p) =>
            Number(p.grading_period_id) === Number(preferredGradingPeriodId) &&
            Number(p.school_year_id) === Number(schoolYearId) &&
            (!openOnly || isPeriodOpen(p))
        );
        if (preferred) return Number(preferredGradingPeriodId);
    }

    let periods = state.gradingPeriods.filter((p) => Number(p.school_year_id) === Number(schoolYearId));
    if (openOnly) {
        periods = periods.filter((p) => isPeriodOpen(p));
    }
    if (!periods.length) return null;

    // Use the first grading period as the shared default for every role whenever it is open.
    // Period numbering also covers Grade 1 terms, whose selector is backed by this same list.
    const openPeriodOne = periods.find((period) =>
        Number(period.period_no || 0) === 1 && isPeriodOpen(period)
    );
    if (openPeriodOne) return Number(openPeriodOne.grading_period_id);

    const now = Date.now();
    const scored = periods.map((p) => {
        const start = p?.date_start ? Date.parse(p.date_start) : NaN;
        const end = p?.date_end ? Date.parse(p.date_end) : NaN;
        const inRange = Number.isFinite(start) && Number.isFinite(end) ? (start <= now && now <= end) : false;
        return {
            id: Number(p.grading_period_id),
            open: isPeriodOpen(p),
            inRange,
            start: Number.isFinite(start) ? start : Number.POSITIVE_INFINITY,
        };
    });

    // For grade encoding: Open periods are required. Among open periods, prefer the one currently in-range,
    // then the earliest start date. This matches "grading periods based on opened forms".
    scored.sort((a, b) => {
        if (a.open !== b.open) return a.open ? -1 : 1;
        if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
        if (a.start !== b.start) return a.start - b.start;
        return a.id - b.id;
    });

    return scored[0]?.id ?? null;
}

function pickDefaultPacePeriodId(schoolYearId, preferredGradingPeriodId = null) {
    const periods = state.gradingPeriods
        .filter((period) => Number(period.school_year_id) === Number(schoolYearId)
            && Number(period.period_no || 0) >= 1
            && Number(period.period_no || 0) <= 3)
        .sort((a, b) => Number(a.period_no || 0) - Number(b.period_no || 0)
            || Number(a.grading_period_id || 0) - Number(b.grading_period_id || 0));

    if (preferredGradingPeriodId) {
        const preferred = periods.find((period) => Number(period.grading_period_id) === Number(preferredGradingPeriodId));
        if (preferred && (state.isAdmin || isPeriodOpen(preferred))) return Number(preferred.grading_period_id);
    }

    const openPeriods = periods.filter(isPeriodOpen);
    const openTermOne = openPeriods.find((period) => Number(period.period_no || 0) === 1);
    if (openTermOne) return Number(openTermOne.grading_period_id);
    if (openPeriods.length) return Number(openPeriods[0].grading_period_id);

    // Admins can still review a closed PACE term when no term is currently open.
    return state.isAdmin ? Number(periods[0]?.grading_period_id || 0) || null : null;
}

function updateOpenPeriodsSelectForSchoolYear(schoolYearId, targetSelect) {
    const adminCanSeeAll = state.isAdmin;
    const paceMode = isGradeOnePaceSection();
    const items = state.gradingPeriods
        .filter((p) => Number(p.school_year_id) === Number(schoolYearId)
            && (!paceMode || Number(p.period_no || 0) >= 1 && Number(p.period_no || 0) <= 3)
            && (adminCanSeeAll || isPeriodOpen(p)))
        .sort((a, b) => Number(a.period_no || 0) - Number(b.period_no || 0))
        .map((p) => ({
            grading_period_id: Number(p.grading_period_id),
            label: `${p.period_name}${periodStatusName(p) ? ` · ${periodStatusName(p)}` : ''}`,
        }));

    const normalizedSystem = String(getGradingSystemType(schoolYearId)).toLowerCase();
    const label = (normalizedSystem.includes('three-term') || normalizedSystem.includes('three term') || normalizedSystem.includes('trimester') || normalizedSystem === 'term')
        ? 'All Terms'
        : 'All Periods';
    if (items.length && !paceMode) {
        items.unshift({ grading_period_id: 'all', label });
    }

    const selectOptions = {
        valueKey: 'grading_period_id',
        labelKey: 'label',
        placeholder: items.length
            ? 'Select period'
            : (adminCanSeeAll ? 'No periods for this school year' : 'No open periods for this school year'),
    };
    const previousPacePeriod = String(el('selPacePeriod')?.value || '');
    populateSelect(targetSelect, items, selectOptions);
    if (targetSelect === el('selPeriod') && el('selPacePeriod')) {
        populateSelect(el('selPacePeriod'), items, { ...selectOptions, placeholder: 'Select term' });
        if (previousPacePeriod && selectHasValue(el('selPacePeriod'), previousPacePeriod)) {
            el('selPacePeriod').value = previousPacePeriod;
        } else {
            selectFirstNonEmpty(el('selPacePeriod'));
        }
    }

    updatePeriodStatusControl();
}

function updateObservedPeriodSelectForSchoolYear(schoolYearId, preferredGradingPeriodId = null) {
    const select = el('selObservedPeriod');
    if (!select) return;
    const adminCanSeeAll = state.isAdmin;
    const items = state.gradingPeriods
        .filter((p) => Number(p.school_year_id) === Number(schoolYearId) && (adminCanSeeAll || isPeriodOpen(p)))
        .sort((a, b) => Number(a.period_no || 0) - Number(b.period_no || 0))
        .map((p) => ({
            grading_period_id: Number(p.grading_period_id),
            label: `${p.period_name}${periodStatusName(p) ? ` · ${periodStatusName(p)}` : ''}`,
        }));

    populateSelect(select, items, {
        valueKey: 'grading_period_id',
        labelKey: 'label',
        placeholder: items.length
            ? 'Select period'
            : (adminCanSeeAll ? 'No periods for this school year' : 'No open periods for this school year'),
    });

    const preferred = preferredGradingPeriodId ? Number(preferredGradingPeriodId) : Number(el('selPeriod')?.value || 0);
    if (preferred && selectHasValue(select, preferred)) {
        select.value = String(preferred);
        return;
    }
    const suggested = pickDefaultGradingPeriodId(schoolYearId, null, { openOnly: !state.isAdmin });
    if (suggested && selectHasValue(select, suggested)) {
        select.value = String(suggested);
        return;
    }
    selectFirstNonEmpty(select);
}

function getClassRecordSchoolYears() {
    return uniqueBy(
        state.classOfferings
            .map((o) => ({
                school_year_id: Number(o.school_year_id),
                year_label: String(o.year_label || o.school_year_id || ''),
                school_year_is_active: Number(o.school_year_is_active || 0),
            }))
            .filter((x) => x.school_year_id),
        (x) => String(x.school_year_id)
    ).sort((a, b) => {
        if (Number(a.school_year_is_active) !== Number(b.school_year_is_active)) {
            return Number(b.school_year_is_active) - Number(a.school_year_is_active);
        }
        return Number(b.school_year_id) - Number(a.school_year_id);
    });
}

function populateClassRecordSchoolYearSelect(preferredSchoolYearId = null) {
    const select = el('selClassRecordSchoolYear');
    if (!select) return;

    const years = getClassRecordSchoolYears().map((sy) => ({
        school_year_id: sy.school_year_id,
        label: `${sy.year_label}${Number(sy.school_year_is_active || 0) === 1 ? ' (Active)' : ''}`,
    }));
    populateSelect(select, years, {
        valueKey: 'school_year_id',
        labelKey: 'label',
        placeholder: years.length ? 'Select school year' : 'No school years',
    });

    const preferred = preferredSchoolYearId ? Number(preferredSchoolYearId) : null;
    if (preferred && selectHasValue(select, preferred)) {
        select.value = String(preferred);
    } else {
        selectFirstNonEmpty(select);
    }
}

function normalizeSearchText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function getClassRecordGradeLevelsForSelectedYear() {
    const syId = Number(el('selClassRecordSchoolYear')?.value || 0);
    if (!syId) return [];

    return uniqueBy(
        state.classOfferings
            .filter((o) => Number(o.school_year_id) === syId && Number(o.grade_level_id) > 0)
            .map((o) => ({
                grade_level_id: Number(o.grade_level_id),
                label: String(o.grade_name || `Grade ${o.grade_level_id}`).trim(),
            })),
        (o) => String(o.grade_level_id)
    ).sort((a, b) => Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0));
}

function renderClassRecordGradeLevelSelect(preferredGradeLevelId = null) {
    const select = el('selGradeLevel');
    if (!select) return null;

    const current = Number(select.value || 0);
    const syId = Number(el('selClassRecordSchoolYear')?.value || 0);
    const gradeLevels = getClassRecordGradeLevelsForSelectedYear();
    populateSelect(select, gradeLevels, {
        valueKey: 'grade_level_id',
        labelKey: 'label',
        placeholder: !syId ? 'Select school year first' : (gradeLevels.length ? 'Select year level' : 'No year levels found'),
    });

    const preferred = preferredGradeLevelId ? Number(preferredGradeLevelId) : null;
    if (preferred && selectHasValue(select, preferred)) {
        select.value = String(preferred);
        return preferred;
    }
    if (current && selectHasValue(select, current)) {
        select.value = String(current);
        return current;
    }

    return null;
}

function getClassRecordSectionsForSelectedYear() {
    const syId = Number(el('selClassRecordSchoolYear')?.value || 0);
    const gradeLevelId = Number(el('selGradeLevel')?.value || 0);
    if (!syId || !gradeLevelId) return [];

    return uniqueBy(
        state.classOfferings
            .filter((o) => Number(o.school_year_id) === syId && Number(o.grade_level_id) === gradeLevelId)
            .map((o) => ({
                section_id: Number(o.section_id),
                school_year_id: Number(o.school_year_id),
                label: `${o.grade_name || 'Grade'} - ${o.section_name || 'Section'}`,
            })),
        (o) => `${o.school_year_id}:${o.section_id}`
    ).sort((a, b) => a.label.localeCompare(b.label));
}

function renderClassRecordSectionSelect(preferredSectionId = null) {
    const select = el('selSection');
    if (!select) return null;

    const current = Number(select.value || 0);
    const syId = Number(el('selClassRecordSchoolYear')?.value || 0);
    const gradeLevelId = Number(el('selGradeLevel')?.value || 0);
    const sections = getClassRecordSectionsForSelectedYear();
    populateSelect(select, sections, {
        valueKey: 'section_id',
        labelKey: 'label',
        placeholder: !syId
            ? 'Select school year first'
            : !gradeLevelId
                ? 'Select year level first'
                : (sections.length ? 'Select section' : 'No sections found'),
    });

    const preferred = preferredSectionId ? Number(preferredSectionId) : null;
    if (preferred && selectHasValue(select, preferred)) {
        select.value = String(preferred);
        return preferred;
    }
    if (current && selectHasValue(select, current)) {
        select.value = String(current);
        return current;
    }

    return null;
}

async function applyInitialGradeEncodingSelection() {
    if (!Array.isArray(state.classOfferings) || !state.classOfferings.length) {
        populateClassRecordSchoolYearSelect();
        populateSelect(el('selGradeLevel'), [], { valueKey: 'grade_level_id', labelKey: 'label', placeholder: 'No year levels found' });
        populateSelect(el('selSection'), [], { valueKey: 'section_id', labelKey: 'label', placeholder: 'No assigned sections' });
        populateSelect(el('selSubject'), [], { valueKey: 'class_id', labelKey: 'label', placeholder: 'No assigned subjects' });
        populateSelect(el('selPeriod'), [], { valueKey: 'grading_period_id', labelKey: 'label', placeholder: 'No grading periods' });
        populateSelect(el('selPacePeriod'), [], { valueKey: 'grading_period_id', labelKey: 'label', placeholder: 'No grading periods' });
        return;
    }

    // Optional deep-linking support.
    const qpSectionId = getQueryInt('section_id');
    const qpClassId = getQueryInt('class_id');
    const qpGpId = getQueryInt('grading_period_id');

    const preferredSchoolYearId = pickDefaultSchoolYearId(qpSectionId, qpClassId);
    populateClassRecordSchoolYearSelect(preferredSchoolYearId);

    const selectedSchoolYearId = Number(el('selClassRecordSchoolYear')?.value || 0);
    const preferredSectionId = pickDefaultSectionId(qpSectionId, qpClassId, selectedSchoolYearId);
    const preferredGradeLevelId = preferredSectionId ? getSectionMeta(preferredSectionId, selectedSchoolYearId)?.grade_level_id : null;
    renderClassRecordGradeLevelSelect(preferredGradeLevelId);
    renderClassRecordSectionSelect(preferredSectionId);

    const sectionId = Number(el('selSection')?.value || 0);
    if (!sectionId) return;
    state.selectedSectionId = sectionId;

    const meta = getSectionMeta(sectionId, selectedSchoolYearId);
    state.selectedSchoolYearId = meta?.school_year_id ?? null;

    updateSubjectSelectForSection(sectionId, meta?.school_year_id ?? null);
    if (meta?.school_year_id) {
        updateOpenPeriodsSelectForSchoolYear(meta.school_year_id, el('selPeriod'));
        updateObservedPeriodSelectForSchoolYear(meta.school_year_id);
    } else {
        populateSelect(el('selPeriod'), [], { valueKey: 'grading_period_id', labelKey: 'label', placeholder: 'Select period' });
        populateSelect(el('selPacePeriod'), [], { valueKey: 'grading_period_id', labelKey: 'label', placeholder: 'Select term' });
        populateSelect(el('selObservedPeriod'), [], { valueKey: 'grading_period_id', labelKey: 'label', placeholder: 'Select period' });
    }

    // Prefer query-provided subject if valid; otherwise default to all subjects.
    if (qpClassId && selectHasValue(el('selSubject'), qpClassId)) {
        el('selSubject').value = String(qpClassId);
    } else {
        el('selSubject').value = selectHasValue(el('selSubject'), 'all') ? 'all' : '';
        if (!el('selSubject').value) selectFirstNonEmpty(el('selSubject'));
    }

    // Prefer query-provided grading period if it is Open; otherwise pick the Open period in range.
    if (meta?.school_year_id) {
        const suggestedGpId = isGradeOnePaceSection(sectionId)
            ? pickDefaultPacePeriodId(meta.school_year_id, qpGpId)
            : pickDefaultGradingPeriodId(meta.school_year_id, qpGpId, { openOnly: !state.isAdmin });
        if (suggestedGpId && selectHasValue(el('selPeriod'), suggestedGpId)) {
            el('selPeriod').value = String(suggestedGpId);
        } else {
            selectFirstNonEmpty(el('selPeriod'));
        }
    } else {
        selectFirstNonEmpty(el('selPeriod'));
    }
    syncPacePeriodSelect(el('selPeriod')?.value || '');

    updatePeriodStatusControl();
    if (isGradeOnePaceSection(sectionId)) setActiveTab('pace');
    else updateContextBar(sectionId);
    if (state.activeTab === 'pace') {
        await loadPaceRoster();
        return;
    }
    if (state.activeTab === 'observed') {
        await loadObservedValues();
        return;
    }
    await loadRoster();
}

async function loadClassOfferings() {
    const resp = await apiGet('/class_records/class_records.php', { operation: 'getMyClassOfferings' });
    if (!resp?.success) throw new Error(resp?.message || 'Failed to load class offerings');
    // Grade 1 descriptive ratings use the PACE form in this page. Other
    // descriptive elementary grades remain outside numeric Grade Input.
    state.classOfferings = (Array.isArray(resp.data) ? resp.data : []).filter((offering) => !(
        String(offering?.grading_mode || '').toLowerCase() === 'descriptive'
        && ['G2', 'G3'].includes(String(offering?.sf9_template_variant || '').toUpperCase())
    ));

    populateClassRecordSchoolYearSelect();
    renderClassRecordGradeLevelSelect();
    renderClassRecordSectionSelect();

    // Honors filters are intentionally scoped to one school year. This keeps
    // the section and year-level choices from mixing offerings across years.
    const years = uniqueBy(
        state.classOfferings
            .map((o) => ({
                school_year_id: Number(o.school_year_id),
                year_label: o.year_label || String(o.school_year_id || ''),
            }))
            .filter((x) => x.school_year_id),
        (x) => String(x.school_year_id)
    ).sort((a, b) => String(b.year_label).localeCompare(String(a.year_label)));

    const syEl = el('selHonSchoolYear');
    if (syEl) {
        populateSelect(syEl, years, { valueKey: 'school_year_id', labelKey: 'year_label', placeholder: 'Select school year' });
        selectFirstNonEmpty(syEl);
    }

    const schoolYearId = Number(syEl?.value || 0);
    updateHonorsSectionSelectForSchoolYear(schoolYearId);
    updateHonorsGradeLevelSelectForSchoolYear(schoolYearId);
    if (schoolYearId && el('selHonPeriod')) {
        updatePeriodsSelectForSchoolYear(schoolYearId, el('selHonPeriod'));
        selectFirstNonEmpty(el('selHonPeriod'));
    }
}

function getPaceRatingFields() {
    const frameDocument = el('g1PaceFrame')?.contentDocument;
    return Array.from(frameDocument?.querySelectorAll('[data-pace-rating="true"]') || []);
}

function serializePaceRatingFields(fields = getPaceRatingFields()) {
    return fields.map((field) => [
        String(field.dataset.gradingPeriodId || ''),
        String(field.dataset.catalogKey || ''),
        String(field.innerText || '').trim().toUpperCase(),
    ].join(':')).join('|');
}

function updatePaceSaveControl() {
    const button = el('btnSavePaceRatings');
    const hint = el('paceEntryHint');
    if (!button) return;
    const period = getSelectedPeriod();
    const editable = canEditSelectedGradePeriod() && Number(period?.period_no || 0) >= 1
        && Number(period?.period_no || 0) <= 3;
    const fields = getPaceRatingFields();
    fields.forEach((field) => {
        field.setAttribute('contenteditable', editable ? 'true' : 'false');
        field.setAttribute('aria-readonly', String(!editable));
    });
    button.disabled = !editable || !state.paceEnrollmentId || !fields.length || !state.paceDirty;
    button.title = !state.canEdit
        ? 'Your role is view-only for Grade 1 PACE ratings.'
        : !period || !editable
            ? 'Select an open Grade 1 term to enter ratings.'
            : state.paceDirty ? 'Save the changed Grade 1 PACE ratings.' : 'No unsaved PACE ratings.';
    if (hint) {
        const hintMessage = !state.selectedSectionId
            ? 'Choose a Grade 1 section to load its PACE learners.'
            : !state.paceEnrollmentId
                ? 'Select a learner to view the Grade 1 PACE form.'
                : !period
                    ? 'Select a Grade 1 term to enable its rating cells.'
                        : !editable
                            ? 'View only'
                        : state.paceDirty
                            ? ''
                            : 'Only the selected term is editable; use Ctrl/Cmd+C to copy selected cells or Ctrl/Cmd+V to paste a vertical A–E list.';
        hint.textContent = hintMessage;
        hint.classList.toggle(
            'cr-g1-pace-hint--important',
            hintMessage.startsWith('Only the selected term is editable')
        );
    }
}

function showPaceEntryEmpty(message) {
    const empty = el('paceEntryEmpty');
    const frame = el('g1PaceFrame');
    if (empty) {
        empty.innerHTML = `
            <div class="cr-grade-empty-state cr-g1-pace-empty-state">
                <video class="mp4-surface-blend cr-grade-empty-icon cr-grade-empty-video" autoplay loop muted playsinline preload="auto" aria-hidden="true">
                    <source src="../assets/icons/learners.mp4" type="video/mp4">
                </video>
                <p>${escapeHtml(message)}</p>
            </div>
        `;
        empty.style.display = 'grid';
    }
    if (frame) {
        frame.style.display = 'none';
        frame.onload = null;
        frame.srcdoc = '';
    }
    state.paceData = null;
    state.paceEnrollmentId = null;
    state.paceDirty = false;
    state.paceRatingsSnapshot = '';
    updatePaceSaveControl();
}

function setPaceRatingCell(field, value) {
    const normalized = String(value || '').trim().toUpperCase();
    field.textContent = /^[A-E]$/.test(normalized) ? normalized : '';
    updatePaceDirtyState();
}

function focusPaceRatingField(field) {
    if (!field) return;
    field.focus();
    const doc = field.ownerDocument;
    const selection = doc?.getSelection?.();
    if (!selection || !doc.createRange) return;
    const range = doc.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
}

function movePaceRatingField(field, offset) {
    const fields = getPaceRatingFields();
    const currentIndex = fields.indexOf(field);
    if (currentIndex < 0) return;
    focusPaceRatingField(fields[currentIndex + offset]);
}

function getSelectedPaceRatingFields(doc) {
    const selection = doc?.getSelection?.();
    if (!selection || !selection.rangeCount) return [];
    const range = selection.getRangeAt(0);
    return getPaceRatingFields().filter((field) => {
        try {
            return range.intersectsNode(field);
        } catch (_) {
            return false;
        }
    });
}

function handlePaceRatingCopy(event) {
    if (event.defaultPrevented) return;
    const selectedFields = getSelectedPaceRatingFields(event.currentTarget);
    if (selectedFields.length < 2 || !event.clipboardData) return;

    event.preventDefault();
    event.clipboardData.setData(
        'text/plain',
        selectedFields.map((field) => String(field.innerText || '').trim().toUpperCase()).join('\n')
    );
}

function handlePaceRatingPaste(event) {
    const field = event.target?.closest?.('[data-pace-rating="true"]');
    if (!field || field.getAttribute('contenteditable') === 'false') return;

    const raw = String(event.clipboardData?.getData('text') || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
    const isMultiCellPaste = /[\n\t]/.test(raw);
    const rows = raw.split('\n');
    if (isMultiCellPaste && rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
    const values = isMultiCellPaste
        ? rows.flatMap((row) => row.split('\t'))
        : [raw];

    event.preventDefault();
    const fields = getPaceRatingFields();
    const startIndex = fields.indexOf(field);
    if (startIndex < 0) return;

    values.forEach((value, valueIndex) => {
        const target = fields[startIndex + valueIndex];
        if (target) setPaceRatingCell(target, value);
    });
    focusPaceRatingField(fields[Math.min(startIndex + values.length - 1, fields.length - 1)]);
}

function handlePaceRatingKeydown(event) {
    const field = event.currentTarget;
    if (event.key === 'ArrowDown' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        movePaceRatingField(field, 1);
        return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey)) {
        event.preventDefault();
        movePaceRatingField(field, -1);
        return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.key === 'Tab'
        || event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') return;
    if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        setPaceRatingCell(field, '');
        return;
    }
    if (/^[a-e]$/i.test(event.key)) {
        event.preventDefault();
        setPaceRatingCell(field, event.key);
        return;
    }
    event.preventDefault();
}

function bindPaceFrameInputs() {
    const fields = getPaceRatingFields();
    const frameDocument = el('g1PaceFrame')?.contentDocument;
    const frameRoot = frameDocument?.documentElement;
    if (frameDocument && frameRoot?.dataset.paceClipboardBound !== 'true') {
        frameDocument.addEventListener('copy', handlePaceRatingCopy);
        frameDocument.addEventListener('paste', handlePaceRatingPaste);
        if (frameRoot) frameRoot.dataset.paceClipboardBound = 'true';
    }
    fields.forEach((field) => {
        field.addEventListener('keydown', handlePaceRatingKeydown);
        field.addEventListener('input', () => {
            const normalized = String(field.innerText || '').trim().toUpperCase();
            if (normalized !== field.textContent) field.textContent = /^[A-E]$/.test(normalized) ? normalized : '';
            updatePaceDirtyState();
        });
    });
    state.paceRatingsSnapshot = serializePaceRatingFields(fields);
    state.paceDirty = false;
    updatePaceSaveControl();
}

function updatePaceDirtyState() {
    state.paceDirty = serializePaceRatingFields() !== state.paceRatingsSnapshot;
    updatePaceSaveControl();
}

async function loadPaceRoster(preferredEnrollmentId = null) {
    const requestId = ++state.paceRosterLoadSequence;
    const sectionId = Number(el('selSection')?.value || 0);
    const schoolYearId = Number(el('selClassRecordSchoolYear')?.value || state.selectedSchoolYearId || 0);
    const learnerSelect = el('selPaceLearner');
    const retainedEnrollmentId = Number(preferredEnrollmentId || state.paceEnrollmentId || learnerSelect?.value || 0);
    if (!sectionId || !schoolYearId || !isGradeOnePaceSection(sectionId)) {
        state.paceRoster = [];
        if (learnerSelect) learnerSelect.innerHTML = '<option value="">Select learner</option>';
        showPaceEntryEmpty('Choose a Grade 1 descriptive section to load its PACE learners.');
        return;
    }

    showPaceEntryEmpty('Loading Grade 1 learners…');
    let response;
    try {
        response = await apiGet('/report_cards/report_cards.php', {
            operation: 'getSF9Roster',
            section_id: sectionId,
            school_year_id: schoolYearId,
        });
    } catch (error) {
        if (requestId === state.paceRosterLoadSequence) showPaceEntryEmpty(apiErrorMessage(error, 'Unable to load PACE learners.'));
        throw error;
    }
    if (requestId !== state.paceRosterLoadSequence) return;
    if (response?.success === false) {
        showPaceEntryEmpty(response.message || 'Unable to load PACE learners.');
        throw new Error(response.message || 'Unable to load PACE learners');
    }
    const rows = Array.isArray(response) ? response : (Array.isArray(response?.data) ? response.data : []);
    state.paceRoster = rows.filter((row) =>
        String(row?.grading_mode || '').toLowerCase() === 'descriptive'
        && String(row?.sf9_template_variant || '').toUpperCase() === 'G1'
    );

    if (learnerSelect) {
        learnerSelect.innerHTML = '<option value="">Select learner</option>';
        state.paceRoster.forEach((learner) => {
            const option = document.createElement('option');
            option.value = String(Number(learner.enrollment_id || 0));
            option.textContent = `${formatLearnerNameForTable(learner.learner_name || 'Learner')}${learner.lrn ? ` · LRN ${learner.lrn}` : ''}`;
            learnerSelect.appendChild(option);
        });
    }
    if (!state.paceRoster.length) {
        showPaceEntryEmpty('No Grade 1 learners are enrolled in this section.');
        return;
    }

    const preferredId = retainedEnrollmentId;
    learnerSelect.value = preferredId && Array.from(learnerSelect.options).some((option) => Number(option.value) === preferredId)
        ? String(preferredId)
        : String(state.paceRoster[0].enrollment_id);
    await loadPaceLearner();
}

async function loadPaceLearner() {
    const enrollmentId = Number(el('selPaceLearner')?.value || 0);
    const selectedPeriod = getSelectedPeriod();
    const periodId = Number(selectedPeriod?.grading_period_id || 0);
    const requestId = ++state.paceLoadSequence;
    if (!enrollmentId) {
        showPaceEntryEmpty('Select a learner to view the Grade 1 PACE form.');
        return;
    }
    if (selectedPeriod && (Number(selectedPeriod.period_no || 0) < 1 || Number(selectedPeriod.period_no || 0) > 3)) {
        showPaceEntryEmpty('The Grade 1 PACE form supports Terms 1–3. Select one of those terms.');
        return;
    }

    showPaceEntryEmpty('Loading the learner’s Grade 1 PACE form…');
    let response;
    try {
        response = await apiGet('/report_cards/report_cards.php', {
            operation: 'getSF9DataByEnrollment',
            enrollment_id: enrollmentId,
        });
        if (!window.Sf9PaceTemplate) throw new Error('The shared Grade 1 PACE form is unavailable.');
        await window.Sf9PaceTemplate.load();
    } catch (error) {
        if (requestId === state.paceLoadSequence) showPaceEntryEmpty(apiErrorMessage(error, 'Unable to load the learner PACE form.'));
        throw error;
    }
    if (requestId !== state.paceLoadSequence) return;
    if (!response || response.success === false) {
        showPaceEntryEmpty(response?.message || 'Unable to load learner PACE data.');
        throw new Error(response?.message || 'Unable to load learner PACE data');
    }
    if (String(response?.enrollment?.grading_mode || '').toLowerCase() !== 'descriptive'
        || String(response?.enrollment?.sf9_template_variant || '').toUpperCase() !== 'G1') {
        showPaceEntryEmpty('The selected learner does not use the Grade 1 descriptive PACE form.');
        throw new Error('The selected learner does not use the Grade 1 descriptive PACE form.');
    }
    const rosterLearner = state.paceRoster.find((learner) => Number(learner.enrollment_id) === enrollmentId) || {};
    state.paceData = {
        ...response,
        enrollment: {
            ...(response.enrollment || {}),
            section: response.enrollment?.section || response.enrollment?.section_name || rosterLearner.section_name || '',
        },
    };
    state.paceEnrollmentId = enrollmentId;
    const editable = Boolean(periodId && canEditSelectedGradePeriod());
    const frame = el('g1PaceFrame');
    const empty = el('paceEntryEmpty');
    if (!frame) {
        showPaceEntryEmpty('Grade 1 PACE form frame is missing.');
        throw new Error('Grade 1 PACE form frame is missing.');
    }
    if (empty) empty.style.display = 'none';
    frame.style.display = 'block';
    frame.onload = bindPaceFrameInputs;
    frame.srcdoc = window.Sf9PaceTemplate.createPaceDocument(state.paceData, {
        editable,
        editablePeriodId: periodId,
    });
    updatePaceSaveControl();
}

async function savePaceRatings() {
    if (!state.paceEnrollmentId || !state.paceDirty || !canEditSelectedGradePeriod()) return;
    const fields = getPaceRatingFields();
    if (!fields.length) return;
    const button = el('btnSavePaceRatings');
    if (button) {
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving';
    }
    const ratings = fields.map((field) => ({
        grading_period_id: Number(field.dataset.gradingPeriodId || 0),
        catalog_key: String(field.dataset.catalogKey || ''),
        rating_code: String(field.innerText || '').trim().toUpperCase(),
    }));
    try {
        const response = await axios.post(`${API_BASE_URL}/report_cards/report_cards.php?operation=saveSF9PaceRatings`, {
            enrollment_id: state.paceEnrollmentId,
            ratings,
        }, { withCredentials: true });
        if (response.data?.success === false) throw new Error(response.data.message || 'Unable to save PACE ratings');
        if (Array.isArray(response.data?.pace_ratings)) state.paceData.pace_ratings = response.data.pace_ratings;
        state.paceRatingsSnapshot = serializePaceRatingFields(fields);
        state.paceDirty = false;
        await toast('success', 'Grade 1 PACE ratings saved for this learner.');
    } catch (error) {
        await toast('error', apiErrorMessage(error, 'Unable to save PACE ratings'));
    } finally {
        if (button) button.innerHTML = '<i class="fas fa-save"></i> Save PACE Ratings';
        updatePaceSaveControl();
    }
}

function updateHonorsSectionSelectForSchoolYear(schoolYearId = null, preferredSectionId = null) {
    const select = el('selHonSection');
    if (!select) return;

    const syId = Number(schoolYearId || el('selHonSchoolYear')?.value || 0);
    const offerings = syId
        ? state.classOfferings.filter((o) => Number(o.school_year_id) === syId)
        : [];
    const sections = uniqueBy(offerings, (o) => String(o.section_id))
        .map((o) => ({
            section_id: Number(o.section_id),
            label: `${o.grade_name || 'Grade'} - ${o.section_name || 'Section'}`.trim(),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));

    populateSelect(select, sections, {
        valueKey: 'section_id',
        labelKey: 'label',
        placeholder: syId ? 'Select section' : 'Select school year first',
    });

    if (preferredSectionId && selectHasValue(select, preferredSectionId)) {
        select.value = String(preferredSectionId);
    } else {
        selectFirstNonEmpty(select);
    }
}

function updateHonorsGradeLevelSelectForSchoolYear(schoolYearId = null, preferredGradeLevelId = null) {
    const select = el('selHonGradeLevel');
    if (!select) return;

    const syId = Number(schoolYearId || el('selHonSchoolYear')?.value || 0);
    const offerings = syId
        ? state.classOfferings.filter((o) => Number(o.school_year_id) === syId)
        : [];
    const gradeLevels = uniqueBy(
        offerings
            .map((o) => ({
                grade_level_id: Number(o.grade_level_id),
                grade_name: o.grade_name || String(o.grade_level_id || ''),
            }))
            .filter((x) => x.grade_level_id),
        (x) => String(x.grade_level_id)
    ).sort((a, b) => Number(a.grade_level_id || 0) - Number(b.grade_level_id || 0));

    populateSelect(select, gradeLevels, {
        valueKey: 'grade_level_id',
        labelKey: 'grade_name',
        placeholder: syId ? 'Select year level' : 'Select school year first',
    });

    if (preferredGradeLevelId && selectHasValue(select, preferredGradeLevelId)) {
        select.value = String(preferredGradeLevelId);
    } else {
        selectFirstNonEmpty(select);
    }
}

async function loadGradingPeriods() {
    const resp = await apiGet('/grading_periods/grading_periods.php', { operation: 'getAllGradingPeriods' });
    // The API may return either a direct array or {success: true, data: [...]}.
    state.gradingPeriods = Array.isArray(resp) ? resp : (Array.isArray(resp?.data) ? resp.data : []);
}

function getPeriodStatusSignature(periods = state.gradingPeriods) {
    return (Array.isArray(periods) ? periods : [])
        .map((period) => [
            Number(period?.grading_period_id || 0),
            Number(period?.school_year_id || 0),
            periodStatusName(period).toLowerCase(),
        ].join(':'))
        .sort()
        .join('|');
}

function syncPeriodSelectorsForStatusChange() {
    const before = {
        grade: String(getGradeInputPeriodSelect()?.value || ''),
        observed: String(el('selObservedPeriod')?.value || ''),
        honors: String(el('selHonPeriod')?.value || ''),
    };

    const sectionId = Number(el('selSection')?.value || 0);
    const meta = getSectionMeta(sectionId, Number(el('selClassRecordSchoolYear')?.value || state.selectedSchoolYearId || 0));
    if (meta?.school_year_id) {
        const gradeSelect = el('selPeriod');
        updateOpenPeriodsSelectForSchoolYear(meta.school_year_id, gradeSelect);
        if (gradeSelect && before.grade && selectHasValue(gradeSelect, before.grade)) {
            gradeSelect.value = before.grade;
        } else if (gradeSelect) {
            const suggested = isGradeOnePaceSection(sectionId)
                ? pickDefaultPacePeriodId(meta.school_year_id)
                : pickDefaultGradingPeriodId(meta.school_year_id, null, { openOnly: !state.isAdmin });
            if (suggested && selectHasValue(gradeSelect, suggested)) {
                gradeSelect.value = String(suggested);
            } else {
                selectFirstNonEmpty(gradeSelect);
            }
        }
        syncPacePeriodSelect(gradeSelect?.value || '');
        updateObservedPeriodSelectForSchoolYear(meta.school_year_id, before.observed || before.grade || null);
    }

    const honorsSelect = el('selHonPeriod');
    const honorsSchoolYearId = Number(el('selHonSchoolYear')?.value || 0);
    if (honorsSelect && honorsSchoolYearId) {
        updatePeriodsSelectForSchoolYear(honorsSchoolYearId, honorsSelect);
        if (before.honors && selectHasValue(honorsSelect, before.honors)) {
            honorsSelect.value = before.honors;
        } else {
            selectFirstNonEmpty(honorsSelect);
        }
    }

    updatePeriodStatusControl();
    updateGradeEncodingEditability();

    return {
        gradeChanged: before.grade !== String(getGradeInputPeriodSelect()?.value || ''),
        observedChanged: before.observed !== String(el('selObservedPeriod')?.value || ''),
        honorsChanged: before.honors !== String(el('selHonPeriod')?.value || ''),
    };
}

async function refreshPeriodStatusRealtime() {
    if (state.periodSyncInFlight) return;
    state.periodSyncInFlight = true;

    try {
        const previousSignature = state.periodSyncSignature || getPeriodStatusSignature();
        await loadGradingPeriods();
        const nextSignature = getPeriodStatusSignature();
        state.periodSyncSignature = nextSignature;
        if (!previousSignature || previousSignature === nextSignature) return;

        const keepingUnsavedChanges = (state.gradeDirty && state.activeTab === 'grades')
            || (state.observedDirty && state.activeTab === 'observed')
            || (state.paceDirty && state.activeTab === 'pace');
        if (keepingUnsavedChanges) {
            updatePeriodStatusControl();
            updateGradeEncodingEditability();
            if (state.periodSyncNoticeSignature !== nextSignature) {
                state.periodSyncNoticeSignature = nextSignature;
                await toast('warning', 'The grading period status changed. Unsaved entries were kept on screen.');
            }
            return;
        }

        syncPeriodSelectorsForStatusChange();
        if (state.activeTab === 'grades') {
            await loadRoster();
        } else if (state.activeTab === 'pace') {
            await loadPaceLearner();
        } else if (state.activeTab === 'observed') {
            await loadObservedValues();
        } else if (state.activeTab === 'honors') {
            await loadHonors();
        }
        await toast('info', 'Grading period status updated.');
    } catch (error) {
        console.debug('[Class Records] Period status sync skipped:', error);
    } finally {
        state.periodSyncInFlight = false;
    }
}

function startPeriodStatusSync() {
    if (state.periodSyncTimer) window.clearInterval(state.periodSyncTimer);
    state.periodSyncSignature = getPeriodStatusSignature();

    const refreshWhenActive = () => {
        if (!document.hidden) refreshPeriodStatusRealtime();
    };

    state.periodSyncTimer = window.setInterval(refreshWhenActive, PERIOD_STATUS_SYNC_INTERVAL_MS);
    if (!state.periodSyncBound) {
        document.addEventListener('visibilitychange', refreshWhenActive);
        window.addEventListener('focus', refreshWhenActive);
        state.periodSyncBound = true;
    }
}

function getSectionMeta(sectionId, schoolYearId = null) {
    const candidates = state.classOfferings.filter((o) => Number(o.section_id) === Number(sectionId));
    const requestedSchoolYearId = Number(schoolYearId || 0);
    const any = requestedSchoolYearId
        ? candidates.find((o) => Number(o.school_year_id) === requestedSchoolYearId)
        : candidates[0];
    if (!any) return null;
    return {
        section_id: Number(any.section_id),
        school_year_id: Number(any.school_year_id),
        grade_level_id: Number(any.grade_level_id || 0),
        section_name: any.section_name,
        grade_name: any.grade_name,
        year_label: any.year_label,
        grading_system_type: any.grading_system_type || 'Quarterly',
    };
}

function getGradingSystemType(schoolYearId) {
    const offering = state.classOfferings.find((o) => Number(o.school_year_id) === Number(schoolYearId));
    if (offering?.grading_system_type) return String(offering.grading_system_type);
    const gp = state.gradingPeriods.find((p) => Number(p.school_year_id) === Number(schoolYearId));
    if (gp?.grading_system_type) return String(gp.grading_system_type);
    return 'Quarterly';
}

function systemShortLabel(periodNo, systemType) {
    const n = Number(periodNo);
    if (!Number.isFinite(n) || n < 1) return '';
    const normalizedSystem = String(systemType).toLowerCase();
    const prefix = normalizedSystem === 'semester' ? 'S' :
                   ['three-term', 'three term', 'trimester', 'term'].includes(normalizedSystem) ? 'T' : 'Q';
    return `${prefix}${n}`;
}

function updateContextBar(sectionId) {
    const bar = el('crContextBar');
    if (!bar) return;
    if (state.activeTab !== 'grades' && state.activeTab !== 'observed' && state.activeTab !== 'pace') {
        bar.style.display = 'none';
        const paceButton = el('tabBtnPace');
        if (paceButton) paceButton.style.display = isGradeOnePaceSection(sectionId) ? '' : 'none';
        return;
    }
    const meta = getSectionMeta(sectionId, Number(el('selClassRecordSchoolYear')?.value || state.selectedSchoolYearId || 0));
    const paceAllowed = isGradeOnePaceSection(sectionId);
    const gradesButton = el('tabBtnGrades');
    const paceButton = el('tabBtnPace');
    const observedButton = el('tabBtnObserved');
    const observedAllowed = observedValuesAllowedForSection(sectionId);
    if (gradesButton) gradesButton.style.display = paceAllowed ? 'none' : '';
    if (paceButton) paceButton.style.display = paceAllowed ? '' : 'none';
    if (observedButton) {
        observedButton.style.display = observedAllowed ? '' : 'none';
    }
    if (!observedAllowed && state.activeTab === 'observed') {
        setActiveTab(paceAllowed ? 'pace' : 'grades');
        return;
    }
    if (!meta) {
        bar.style.display = 'grid';
        const subjectWrap = el('crContextSubjectWrap');
        if (subjectWrap) subjectWrap.style.display = (state.activeTab === 'observed' || state.activeTab === 'pace') ? 'none' : 'flex';
        return;
    }
    bar.style.display = 'grid';
    const subjectWrap = el('crContextSubjectWrap');
    const syWrap = el('crContextSyWrap');
    const gradeLevelWrap = el('crContextGradeLevelWrap');
    if (subjectWrap) subjectWrap.style.display = (state.activeTab === 'observed' || state.activeTab === 'pace') ? 'none' : 'flex';
    if (syWrap) syWrap.style.display = 'flex';
    if (gradeLevelWrap) gradeLevelWrap.style.display = 'flex';
}

function updateSubjectSelectForSection(sectionId, schoolYearId = null) {
    const sectionOfferings = state.classOfferings.filter((o) => Number(o.section_id) === Number(sectionId));
    if (!sectionOfferings.length) {
        populateSelect(el('selSubject'), [], { valueKey: 'class_id', labelKey: 'label', placeholder: 'No subjects for selected section' });
        return;
    }

    // If school year wasn't passed, infer it from the section's offerings so the dropdown
    // is always scoped to the selected section's actual school year.
    if (!schoolYearId) {
        const inferred = sectionOfferings.find((o) => Number(o.school_year_id || 0) > 0);
        if (inferred) schoolYearId = Number(inferred.school_year_id);
    }

    const offerings = sectionOfferings
        .filter((o) => (schoolYearId ? Number(o.school_year_id) === Number(schoolYearId) : true));
    const hasMapehComponents = offerings.some((o) => {
        return isMapehComponentName(o.subject_name);
    });

    // Some datasets can contain duplicate offerings for the same subject.
    // Deduplicate by subject only and keep the latest class_id.
    const byKey = new Map();
    for (const o of offerings) {
        const name = String(o.subject_name || '').toLowerCase();
        if (hasMapehComponents && name.includes('mapeh') && !name.includes('component')) {
            continue;
        }
        const sid = Number(o.subject_id || 0);
        const key = sid > 0 ? `sid:${sid}` : `sname:${String(o.subject_name || '').toLowerCase()}`;

        const existing = byKey.get(key);
        if (!existing || Number(o.class_id) > Number(existing.class_id)) {
            byKey.set(key, o);
        }
    }

    const subs = Array.from(byKey.values())
        .map((o) => ({
            class_id: Number(o.class_id),
            label: String(o.subject_name || ''),
            subject_name: String(o.subject_name || ''),
            subject_id: Number(o.subject_id || 0),
        }))
        .sort(compareSubjects);

    populateSelect(el('selSubject'), [
        { class_id: 'all', label: 'All Subjects', subject_id: 0 },
        ...subs,
    ], { valueKey: 'class_id', labelKey: 'label', placeholder: 'Select subject' });
}

function isAllSubjectsMode() {
    return String(el('selSubject')?.value || '').toLowerCase() === 'all';
}

function getSubjectOptionsForSelectedSection() {
    const sectionId = Number(el('selSection')?.value || 0);
    const schoolYearId = Number(el('selClassRecordSchoolYear')?.value || state.selectedSchoolYearId || 0);
    const options = Array.from(el('selSubject')?.options || [])
        .filter((opt) => String(opt.value || '') && String(opt.value || '').toLowerCase() !== 'all')
        .map((opt) => {
            const classId = Number(opt.value || 0);
            const offering = state.classOfferings.find((o) =>
                Number(o.class_id) === classId
                && (!sectionId || Number(o.section_id) === sectionId)
                && (!schoolYearId || Number(o.school_year_id) === schoolYearId)
            );
            return {
                class_id: classId,
                subject_id: Number(offering?.subject_id || 0),
                subject_name: String(offering?.subject_name || opt.textContent || '').trim(),
            };
        })
        .filter((o) => o.class_id);
    return options.sort(compareSubjects);
}

async function handleClassRecordSectionChange() {
    const sectionId = Number(el('selSection')?.value || 0);
    state.paceRosterLoadSequence += 1;
    state.paceLoadSequence += 1;
    state.selectedSectionId = sectionId;

    if (!sectionId) {
        if (el('selSubject')) el('selSubject').innerHTML = '';
        populateSelect(el('selPeriod'), [], { valueKey: 'grading_period_id', labelKey: 'label', placeholder: 'Select period' });
        populateSelect(el('selPacePeriod'), [], { valueKey: 'grading_period_id', labelKey: 'label', placeholder: 'Select term' });
        if (el('tbodyGrades')) el('tbodyGrades').innerHTML = '';
        clearGradeTableEmptyOverlay();
        if (el('metricsGrades')) el('metricsGrades').innerHTML = '';
        state.paceRoster = [];
        if (el('selPaceLearner')) el('selPaceLearner').innerHTML = '<option value="">Select learner</option>';
        if (state.activeTab === 'pace') setActiveTab('grades');
        updateContextBar(null);
        if (state.activeTab === 'observed') {
            await loadObservedValues();
        }
        return;
    }

    const meta = getSectionMeta(sectionId, Number(el('selClassRecordSchoolYear')?.value || state.selectedSchoolYearId || 0));
    state.selectedSchoolYearId = meta?.school_year_id ?? null;

    updateSubjectSelectForSection(sectionId, meta?.school_year_id ?? null);
    if (meta?.school_year_id) {
        updateOpenPeriodsSelectForSchoolYear(meta.school_year_id, el('selPeriod'));
        updateObservedPeriodSelectForSchoolYear(meta.school_year_id);
    } else {
        populateSelect(el('selPeriod'), [], { valueKey: 'grading_period_id', labelKey: 'label', placeholder: 'Select period' });
        populateSelect(el('selPacePeriod'), [], { valueKey: 'grading_period_id', labelKey: 'label', placeholder: 'Select term' });
        populateSelect(el('selObservedPeriod'), [], { valueKey: 'grading_period_id', labelKey: 'label', placeholder: 'Select period' });
    }

    // Default to all subjects and an Open/in-range grading period when possible.
    el('selSubject').value = selectHasValue(el('selSubject'), 'all') ? 'all' : '';
    if (!el('selSubject').value) selectFirstNonEmpty(el('selSubject'));
    if (meta?.school_year_id) {
        const suggestedGpId = isGradeOnePaceSection(sectionId)
            ? pickDefaultPacePeriodId(meta.school_year_id)
            : pickDefaultGradingPeriodId(meta.school_year_id, null, { openOnly: !state.isAdmin });
        if (suggestedGpId && selectHasValue(el('selPeriod'), suggestedGpId)) {
            el('selPeriod').value = String(suggestedGpId);
        } else {
            selectFirstNonEmpty(el('selPeriod'));
        }
    } else {
        selectFirstNonEmpty(el('selPeriod'));
    }
    syncPacePeriodSelect(el('selPeriod')?.value || '');

    updatePeriodStatusControl();
    if (isGradeOnePaceSection(sectionId)) setActiveTab('pace');
    else if (state.activeTab === 'pace') setActiveTab('grades');
    else updateContextBar(sectionId);
    if (state.activeTab === 'pace') {
        await loadPaceRoster();
        return;
    }
    if (state.activeTab === 'observed') {
        await loadObservedValues();
    } else {
        await loadRoster();
    }
}

function updatePeriodsSelectForSchoolYear(schoolYearId, targetSelect) {
    const items = state.gradingPeriods
        .filter((p) => Number(p.school_year_id) === Number(schoolYearId))
        .map((p) => ({
            grading_period_id: Number(p.grading_period_id),
            label: `${p.period_name}${p.status_name ? ` · ${p.status_name}` : ''}`,
        }));

    populateSelect(targetSelect, items, {
        valueKey: 'grading_period_id',
        labelKey: 'label',
        placeholder: 'Select grading period',
    });
}

function getGradeInputPeriodSelect() {
    return state.activeTab === 'pace' ? (el('selPacePeriod') || el('selPeriod')) : el('selPeriod');
}

function syncPacePeriodSelect(value = el('selPeriod')?.value || '') {
    const paceSelect = el('selPacePeriod');
    if (!paceSelect) return;
    if (selectHasValue(paceSelect, value)) {
        paceSelect.value = String(value);
    } else {
        selectFirstNonEmpty(paceSelect);
    }
}

function getSelectedPeriod() {
    const select = getGradeInputPeriodSelect();
    if (String(select?.value || '').toLowerCase() === 'all') return null;
    const gpId = Number(select?.value || 0);
    if (!gpId) return null;
    return state.gradingPeriods.find((p) => Number(p.grading_period_id) === gpId) || null;
}

function isAllPeriodsMode() {
    return String(el('selPeriod')?.value || '').toLowerCase() === 'all';
}

function updatePeriodStatusControl() {
    const btn = el('btnTogglePeriodStatus');
    const text = el('periodStatusBtnText');
    const control = el('crPeriodAdminControl');
    if (!btn || !text) return;

    if (!state.isAdmin) {
        if (control) control.style.display = 'none';
        btn.style.display = 'none';
        return;
    }

    if (control) control.style.display = 'flex';
    btn.style.display = 'inline-flex';
    const period = getSelectedPeriod();
    if (!period) {
        btn.disabled = true;
        text.textContent = isAllPeriodsMode() ? 'Summary' : 'Lock';
        btn.setAttribute('aria-label', isAllPeriodsMode() ? 'Summary mode' : 'Lock grading period');
        btn.title = isAllPeriodsMode() ? 'Select a specific grading period to lock or open it' : 'Select a grading period first';
        return;
    }

    const status = periodStatusName(period);
    const open = status.toLowerCase() === 'open';
    btn.disabled = false;
    text.textContent = open ? 'Lock' : 'Open';
    btn.setAttribute('aria-label', open ? 'Lock grading period' : 'Open grading period');
    btn.title = open ? 'Lock this grading period for encoding' : `Reopen this ${status} grading period`;
    const icon = btn.querySelector('i');
    if (icon) {
        icon.className = open ? 'fas fa-lock' : 'fas fa-lock-open';
    }
}

function canEditSelectedGradePeriod() {
    const period = getSelectedPeriod();
    return Boolean(state.canEdit && period && isPeriodOpen(period));
}

function updateGradeEncodingEditability() {
    const editable = canEditSelectedGradePeriod() && state.classMeta?.curriculum_aligned !== false;
    document.querySelectorAll('.cr-grade-input').forEach((input) => {
        input.readOnly = !editable;
    });

    const save = el('btnSave');
    updatePaceSaveControl();
    if (!save || !state.canEdit) return;
    save.disabled = state.gradeSaveInFlight || state.rosterLoadInFlight || !editable;
    if (state.gradeSaveInFlight) {
        save.title = 'Saving grade records…';
    }
    if (!editable && getSelectedPeriod()) {
        save.title = 'This grading period is locked. Grades are read-only.';
    } else if (!state.gradeDirty) {
        save.title = '';
    }
}

async function toggleSelectedPeriodStatus() {
    if (!state.isAdmin) return;
    const period = getSelectedPeriod();
    if (!period) {
        await toast('warning', 'Select a grading period first');
        return;
    }

    const currentStatus = periodStatusName(period);
    const nextStatus = currentStatus.toLowerCase() === 'open' ? 'Locked' : 'Open';
    const statusId = nextStatus === 'Open' ? 1 : 4;

    if (nextStatus === 'Open') {
        const schoolYear = state.classOfferings.find((offering) =>
            Number(offering.school_year_id) === Number(period.school_year_id)
        );
        if (Number(schoolYear?.school_year_is_active || 0) !== 1) {
            await toast(
                'error',
                'Cannot open this period because its school year is inactive.'
            );
            return;
        }
    }

    const payload = {
        grading_period_id: Number(period.grading_period_id),
        school_year_id: Number(period.school_year_id),
        period_name: period.period_name,
        date_start: period.date_start || null,
        date_end: period.date_end || null,
        grading_period_status_id: statusId,
    };
    if (Number(period.period_no || 0) > 0) {
        payload.period_no = Number(period.period_no);
    }

    const btn = el('btnTogglePeriodStatus');
    if (btn) btn.disabled = true;

    try {
        const res = await apiPostOperation('/grading_periods/grading_periods.php', 'updateGradingPeriod', payload);
        if (!res?.success) throw new Error(res?.message || 'Failed to update period status');

        const selectedId = Number(period.grading_period_id);
        await loadGradingPeriods();
        state.periodSyncSignature = getPeriodStatusSignature();
        const syId = Number(el('selClassRecordSchoolYear')?.value || state.selectedSchoolYearId || period.school_year_id || 0);
        updateOpenPeriodsSelectForSchoolYear(syId, el('selPeriod'));
        if (selectedId && selectHasValue(el('selPeriod'), selectedId)) {
            el('selPeriod').value = String(selectedId);
        }
        syncPacePeriodSelect(el('selPeriod')?.value || '');
        updatePeriodStatusControl();
        await toast('success', `Period is now ${nextStatus}`);
        if (state.activeTab === 'pace') await loadPaceLearner();
        else await loadRoster();
    } catch (e) {
        await toast('error', apiErrorMessage(e, 'Failed to update period status'));
    } finally {
        updatePeriodStatusControl();
    }
}

function renderGradeMetrics() {
    const wrap = el('metricsGrades');
    // Metrics removed per UI request.
    if (!wrap) return;
    wrap.innerHTML = '';
    wrap.style.display = 'none';
}

function renderMapehNotice() {
    const wrap = el('mapehNotice');
    if (!wrap) return;
    wrap.innerHTML = '';

    const notices = [];
    if (state.isAdmin) {
        notices.push({
            message: '<i class="fas fa-eye"></i> <strong>View only:</strong> Administrators can review grades but cannot enter, import, or save them.',
            style: 'background:#fffbeb; border:1px solid #fde68a; color:#854d0e; padding:10px 12px; border-radius:6px; font-size:0.9rem;',
        });
    }

    const subjectId = Number(state.classMeta?.subject_id || 0);
    if (isAllPeriodsMode()) {
        notices.push({
            message: '<i class="fas fa-clock-rotate-left"></i> <strong>History view:</strong> This summary preserves learners who dropped or transferred out and any grades already recorded. Departed learner rows are read-only.',
            style: 'background:#eff6ff; border:1px solid #bfdbfe; color:#1e3a8a; padding:10px 12px; border-radius:6px; font-size:0.9rem;',
        });
    } else if (subjectId) {
        notices.push({
            message: '<i class="fas fa-users"></i> <strong>Current grade-entry roster:</strong> Learners marked Dropped or Transferred Out are excluded from new grade entry. Their saved grades remain available in All Periods history.',
            style: 'background:#fffbeb; border:1px solid #fde68a; color:#854d0e; padding:10px 12px; border-radius:6px; font-size:0.9rem;',
        });
    }
    let message = '';
    let style = '';

    if (subjectId && state.classMeta?.curriculum_aligned === false) {
        message = '<i class="fas fa-triangle-exclamation"></i> <strong>Curriculum mismatch:</strong> This legacy class offering is not part of the selected section curriculum. Rebuild class offerings from the curriculum before encoding grades.';
        style = 'background: #fff7ed; border-left: 4px solid #f97316; color: #9a3412; padding: 10px 12px; border-radius: 6px; font-size: 0.9rem;';
    } else if (subjectId && state.classMeta?.is_mapeh_component) {
        message = '<i class="fas fa-info-circle"></i> <strong>Auto-computed MAPEH:</strong> Saving grades for this MAPEH component will automatically update the official MAPEH grade from the configured component subjects.';
        style = 'background: #eff6ff; border-left: 4px solid #2563eb; color: #1e40af; padding: 10px 12px; border-radius: 6px; font-size: 0.9rem;';
    } else if (subjectId && state.classMeta?.is_mapeh_cluster && state.classMeta?.has_mapeh_components) {
        message = '<i class="fas fa-calculator"></i> <strong>Official MAPEH grade:</strong> This grade is automatically computed from the configured MAPEH component grades. You can edit it directly if no component classes exist.';
        style = 'background: #f0fdf4; border-left: 4px solid #16a34a; color: #166534; padding: 10px 12px; border-radius: 6px; font-size: 0.9rem;';
    }

    if (message) notices.push({ message, style });
    if (!notices.length) return;

    wrap.innerHTML = notices.map((notice) => `<div style="${notice.style} margin-bottom: 8px;">${notice.message}</div>`).join('');
}

function observedRatingOptions(selected = '', disabled = false) {
    const value = String(selected || '').toUpperCase();
    const options = [
        ['', '—'],
        ['AO', 'AO'],
        ['SO', 'SO'],
        ['RO', 'RO'],
        ['NO', 'NO'],
    ];
    return options.map(([code, label]) => (
        `<option value="${code}" ${value === code ? 'selected' : ''}>${label}</option>`
    )).join('');
}

function populateObservedIndicatorSelect(indicators = []) {
    const select = el('selObservedIndicator');
    if (!select) return;
    const items = [{ indicator_id: 'all', label: 'All fields' }].concat(
        indicators.map((item, index) => ({
            indicator_id: Number(item.indicator_id || 0),
            label: `${index + 1}. ${item.core_value || ''}`,
        })).filter((item) => item.indicator_id)
    );
    populateSelect(select, items, {
        valueKey: 'indicator_id',
        labelKey: 'label',
        placeholder: 'All fields',
    });
    if (selectHasValue(select, 'all')) select.value = 'all';
}

function renderObservedNotice() {
    const wrap = el('observedNotice');
    if (!wrap) return;
    const data = state.observedValuesData;
    if (!data) {
        wrap.innerHTML = '';
        return;
    }

    const period = data.grading_period || {};
    const status = periodStatusName(period);
    const parts = [];
    if (data.migration_required) {
        parts.push('<strong>Database migration needed:</strong> run <code>api/database/migrations/add_observed_values_encoding.sql</code> before saving observed values.');
    }
    if (status && status.toLowerCase() !== 'open') {
        parts.push(`This period is ${escapeHtml(status)}. Values can be viewed but not edited.`);
    }
    if (state.isAdmin) {
        parts.push('<strong>View only:</strong> Administrators can review observed values but cannot enter or save them.');
    }
    if (!parts.length) {
        wrap.innerHTML = '';
        return;
    }
    wrap.innerHTML = `<div style="background:#fffbeb; border:1px solid #fde68a; color:#854d0e; padding:10px 12px; border-radius:6px; font-size:0.9rem;">${parts.join(' ')}</div>`;
}

function canUseTeacherRecordControls() {
    return !state.isAdmin && Boolean(state.canEdit);
}

function canEditObservedValues() {
    const data = state.observedValuesData;
    if (!data || data.can_save === false || data.migration_required) return false;
    const status = periodStatusName(data.grading_period || {});
    return canUseTeacherRecordControls() && status.toLowerCase() === 'open';
}

function prepareObservedValuesData(data) {
    if (!data || !Array.isArray(data.learners)) return data;
    return {
        ...data,
        learners: data.learners.map((learner) => {
            const values = learner?.values && typeof learner.values === 'object' ? learner.values : {};
            return {
                ...learner,
                values: { ...values },
                _savedValues: { ...values },
            };
        }),
    };
}

function renderObservedValuesTable() {
    const data = state.observedValuesData || {};
    const table = el('tblObservedValues');
    const thead = el('theadObservedValues');
    const tbody = el('tbodyObservedValues');
    if (!table || !thead || !tbody) return;
    tbody.innerHTML = '';
    clearObservedTableEmptyOverlay();
    updateObservedDirtyState();

    const indicators = Array.isArray(data.indicators) ? data.indicators : [];
    populateObservedIndicatorSelect(indicators);
    renderObservedNotice();

    thead.innerHTML = `
        <tr>
            <th>Learner</th>
            ${indicators.map((indicator, index) => `
                <th class="cr-observed-statement">
                    <div class="cr-observed-core">${escapeHtml(indicator.core_value || '')}</div>
                    <div>${escapeHtml(indicator.behavior_statement || `Field ${index + 1}`)}</div>
                </th>
            `).join('')}
        </tr>
    `;

    setGenderFilterButtons('[data-cr-observed-gender]', state.observedGenderFilter);
    const learners = filterLearnersForTable(Array.isArray(data.learners) ? data.learners : [], 'cr-observed-search', state.observedGenderFilter);
    const editable = canEditObservedValues();
    const colCount = 1 + indicators.length;
    if (!learners.length) {
        const overlay = el('crObservedEmptyOverlay');
        if (overlay) {
            overlay.innerHTML = `
                <div class="cr-grade-empty-state">
                    <video class="mp4-surface-blend cr-grade-empty-icon cr-grade-empty-video" autoplay loop muted playsinline preload="auto" aria-hidden="true">
                        <source src="../assets/icons/learners.mp4" type="video/mp4">
                    </video>
                    <h3>No learners found</h3>
                </div>
            `;
            overlay.hidden = false;
        }
        tbody.innerHTML = `
            <tr class="cr-grade-empty-row">
                <td class="cr-grade-empty-cell" colspan="${colCount}">
                    <div class="cr-grade-empty-reserve" aria-hidden="true"></div>
                </td>
            </tr>
        `;
        updateObservedTableScrollCue();
        return;
    }

    appendGenderGroupedRows(tbody, learners, (learner) => {
        const tr = document.createElement('tr');
        tr.dataset.enrollmentId = String(learner.enrollment_id);
        const values = learner.values || {};
        tr.innerHTML = `
            <td>
                <div class="cr-learner-cell">
                    <span class="cr-learner-name">${escapeHtml(formatLearnerNameForTable(learner.learner_name || ''))}</span>
                    <span class="cr-learner-meta">LRN: ${escapeHtml(learner.lrn || '—')}</span>
                </div>
            </td>
            ${indicators.map((indicator) => {
                const indicatorId = Number(indicator.indicator_id || 0);
                const value = values[indicatorId] || values[String(indicatorId)] || '';
                return `<td class="cr-observed-value-cell">
                    <select class="form-control cr-observed-select" data-enrollment-id="${Number(learner.enrollment_id)}" data-indicator-id="${indicatorId}" ${editable && indicatorId ? '' : 'disabled'}>
                        ${observedRatingOptions(value)}
                    </select>
                </td>`;
            }).join('')}
        `;
        return tr;
    });

    tbody.querySelectorAll('.cr-observed-select').forEach((select) => {
        select.addEventListener('change', () => {
            const enrollmentId = Number(select.dataset.enrollmentId || 0);
            const indicatorId = Number(select.dataset.indicatorId || 0);
            const learner = (state.observedValuesData?.learners || []).find((row) => Number(row.enrollment_id) === enrollmentId);
            if (!learner || !indicatorId) return;
            learner.values = learner.values || {};
            learner.values[indicatorId] = String(select.value || '').toUpperCase();
            updateObservedDirtyState();
        });
    });
    syncObservedUnsavedIndicators();
    updateObservedTableScrollCue();
}

function updateObservedTableScrollCue() {
    const wrap = el('crObservedTableWrap');
    const cue = el('crObservedScrollCue');
    if (!wrap || !cue) return;

    const hasIndicatorInputs = Boolean(wrap.querySelector('.cr-observed-select'));
    const maxScrollLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    const requiresScroll = hasIndicatorInputs && maxScrollLeft > 2;
    const canScrollRight = wrap.scrollLeft < maxScrollLeft - 2;
    cue.hidden = !(requiresScroll && canScrollRight);
}

function bindObservedTableScrollCue() {
    const wrap = el('crObservedTableWrap');
    if (!wrap) return;

    if (wrap.dataset.scrollCueBound !== 'true') {
        wrap.dataset.scrollCueBound = 'true';
        wrap.addEventListener('scroll', updateObservedTableScrollCue, { passive: true });
        window.addEventListener('resize', updateObservedTableScrollCue);
    }
    updateObservedTableScrollCue();
}

function clearObservedTableEmptyOverlay() {
    const overlay = el('crObservedEmptyOverlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.innerHTML = '';
}

async function loadObservedValues(options = {}) {
    const sectionId = Number(el('selSection')?.value || 0);
    const gpId = Number(options.gradingPeriodId || el('selObservedPeriod')?.value || 0);
    if (!sectionId || !gpId) {
        state.observedValuesData = null;
        resetObservedDirty();
        if (el('theadObservedValues')) el('theadObservedValues').innerHTML = '';
        if (el('tbodyObservedValues')) el('tbodyObservedValues').innerHTML = '';
        if (el('observedNotice')) el('observedNotice').innerHTML = '';
        updateObservedTableScrollCue();
        return null;
    }

    const resp = await apiGet('/class_records/class_records.php', {
        operation: 'getObservedValues',
        section_id: sectionId,
        grading_period_id: gpId,
    });
    if (!resp?.success) throw new Error(resp?.message || 'Failed to load observed values');
    if (!options.peek) {
        state.observedValuesData = prepareObservedValuesData(resp.data || null);
        resetObservedDirty();
        renderObservedValuesTable();
    }
    return resp.data || null;
}

function applyObservedBulk() {
    const data = state.observedValuesData;
    if (!data || !canEditObservedValues()) {
        toast('warning', 'Observed values are not editable for this period');
        return;
    }
    const targetIndicator = String(el('selObservedIndicator')?.value || 'all');
    const rating = String(el('selObservedBulkRating')?.value || '').toUpperCase();
    const visibleEnrollmentIds = Array.from(el('tbodyObservedValues')?.querySelectorAll('tr[data-enrollment-id]') || [])
        .map((tr) => Number(tr.dataset.enrollmentId || 0))
        .filter(Boolean);
    const visibleMap = new Set(visibleEnrollmentIds);
    const indicators = (data.indicators || [])
        .map((item) => Number(item.indicator_id || 0))
        .filter((id) => id && (targetIndicator === 'all' || Number(targetIndicator) === id));

    (data.learners || []).forEach((learner) => {
        if (!visibleMap.has(Number(learner.enrollment_id))) return;
        learner.values = learner.values || {};
        indicators.forEach((indicatorId) => {
            learner.values[indicatorId] = rating;
        });
    });
    updateObservedDirtyState();
    renderObservedValuesTable();
}

async function copyObservedFromPrevious() {
    const data = state.observedValuesData;
    const currentPeriodId = Number(el('selObservedPeriod')?.value || 0);
    const currentPeriod = state.gradingPeriods.find((p) => Number(p.grading_period_id) === currentPeriodId);
    if (!data || !currentPeriod) {
        await toast('warning', 'Select a section and period first');
        return;
    }
    if (!canEditObservedValues()) {
        await toast('warning', 'Observed values are not editable for this period');
        return;
    }
    const previous = state.gradingPeriods
        .filter((p) => Number(p.school_year_id) === Number(currentPeriod.school_year_id))
        .filter((p) => Number(p.period_no || 0) > 0 && Number(p.period_no || 0) < Number(currentPeriod.period_no || 0))
        .sort((a, b) => Number(b.period_no || 0) - Number(a.period_no || 0))[0];
    if (!previous) {
        await toast('warning', 'No previous period found');
        return;
    }

    const previousData = await loadObservedValues({ gradingPeriodId: Number(previous.grading_period_id), peek: true });
    const previousByEnrollment = new Map((previousData?.learners || []).map((learner) => [Number(learner.enrollment_id), learner.values || {}]));
    (data.learners || []).forEach((learner) => {
        const previousValues = previousByEnrollment.get(Number(learner.enrollment_id)) || {};
        learner.values = learner.values || {};
        (data.indicators || []).forEach((indicator) => {
            const indicatorId = Number(indicator.indicator_id || 0);
            if (!indicatorId) return;
            learner.values[indicatorId] = previousValues[indicatorId] || previousValues[String(indicatorId)] || '';
        });
    });
    updateObservedDirtyState();
    renderObservedValuesTable();
    await toast('success', `Copied values from ${previous.period_name || 'previous period'}`);
}

async function saveObservedValues() {
    const data = state.observedValuesData;
    if (!data) {
        await toast('warning', 'Load observed values first');
        return;
    }
    if (!canEditObservedValues()) {
        await toast('warning', 'Observed values are not editable for this period');
        return;
    }

    const values = [];
    (data.learners || []).forEach((learner) => {
        (data.indicators || []).forEach((indicator) => {
            const indicatorId = Number(indicator.indicator_id || 0);
            if (!indicatorId) return;
            values.push({
                enrollment_id: Number(learner.enrollment_id),
                indicator_id: indicatorId,
                rating_code: String((learner.values || {})[indicatorId] || (learner.values || {})[String(indicatorId)] || '').toUpperCase(),
            });
        });
    });

    const resp = await apiPost('/class_records/class_records.php', { operation: 'saveObservedValues' }, {
        section_id: Number(el('selSection')?.value || data.section?.section_id || 0),
        grading_period_id: Number(el('selObservedPeriod')?.value || data.grading_period?.grading_period_id || 0),
        values,
    });
    if (!resp?.success) {
        throw new Error(resp?.message || 'Save failed');
    }
    await toast('success', `Observed values saved (${resp.data?.saved || 0})`);
    await loadObservedValues();
}

function renderRosterTable() {
    const tbody = el('tbodyGrades');
    tbody.innerHTML = '';
    clearGradeTableEmptyOverlay();
    updateGradeEncodingEditability();

    if (isAllSubjectsMode()) {
        renderAllSubjectsTable();
        return;
    }
    resetSingleSubjectHeader();

    setGenderFilterButtons('[data-cr-roster-gender]', state.rosterGenderFilter);
    const filteredRoster = filterLearnersForTable(state.fullRoster, 'cr-roster-search', state.rosterGenderFilter);

    if (!filteredRoster.length) {
        const hasLearners = state.fullRoster.length > 0;
        renderGradeTableEmptyState({
            title: hasLearners ? 'No learners match the current filter' : 'No learners found',
            showLearnersVideo: true,
        });
        renderGradeMetrics();
        renderMapehNotice();
        return;
    }

    const passingMark = Number(state.classMeta?.passing_mark ?? 75);
    const canEditGrades = canEditSelectedGradePeriod() && state.classMeta?.curriculum_aligned !== false;

    appendGenderGroupedRows(tbody, filteredRoster, (r, idx) => {
        const qg = safeNum(r.quarterly_grade);
        r._computed_qg = qg;
        const statusBadge = enrollmentStatusBadgeHtml(r.enrollment_status);

        const tr = document.createElement('tr');
        tr.dataset.enrollmentId = String(r.enrollment_id);

        tr.innerHTML = `
            <td>
                <div class="cr-learner-cell">
                    <span class="cr-learner-name">${escapeHtml(formatLearnerNameForTable(r.learner_name || ''))}</span>
                    <span class="cr-learner-meta">LRN: ${escapeHtml(r.lrn || '—')}${statusBadge}</span>
                </div>
            </td>
            <td><input class="form-control cr-grade-input" type="text" inputmode="decimal" value="${qg === null ? '' : qg}" data-field="quarterly_grade" data-enrollment-id="${Number(r.enrollment_id)}" data-row-index="${idx}" data-col-index="0" placeholder="—" style="${gradeInputToneStyle(qg, passingMark)}" ${canEditGrades ? '' : 'readonly'}></td>
            <td>${qg === null ? '' : remarkBadgeHtml(qg, passingMark)}</td>
        `;

        return tr;
    });

    attachGradeSpreadsheetHandlers(tbody);

    renderGradeMetrics();
    renderMapehNotice();
}

function updateGradeSheetScrollCue() {
    const wrap = el('crGradeSheetWrap');
    const cue = el('crGradeScrollCue');
    if (!wrap || !cue) return;

    const hasSubjectInputs = Boolean(wrap.querySelector('.cr-all-subject-input'));
    const maxScrollLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    const requiresScroll = isAllSubjectsMode() && hasSubjectInputs && maxScrollLeft > 2;
    const canScrollRight = wrap.scrollLeft < maxScrollLeft - 2;
    cue.hidden = !(requiresScroll && canScrollRight);
}

function clearGradeTableEmptyOverlay() {
    const overlay = el('crGradeEmptyOverlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.innerHTML = '';
}

function bindGradeSheetScrollCue() {
    const wrap = el('crGradeSheetWrap');
    if (!wrap) return;

    if (wrap.dataset.scrollCueBound !== 'true') {
        wrap.dataset.scrollCueBound = 'true';
        wrap.addEventListener('scroll', updateGradeSheetScrollCue, { passive: true });
        window.addEventListener('resize', updateGradeSheetScrollCue);
    }
    updateGradeSheetScrollCue();
}

function renderGradeTableEmptyState({ title, message, showBlueScreen = false, showServerVideo = false, showLearnersVideo = false } = {}) {
    const tbody = el('tbodyGrades');
    const table = el('tblGrades');
    if (!tbody || !table) return;

    const columnCount = Math.max(1, table.querySelectorAll('thead th').length || 5);
    const icon = showServerVideo
        ? '<video class="mp4-surface-blend cr-grade-empty-icon cr-grade-empty-video cr-grade-server-video" autoplay loop muted playsinline preload="auto" aria-hidden="true"><source src="../assets/icons/server.mp4" type="video/mp4"></video>'
        : showLearnersVideo
        ? '<video class="mp4-surface-blend cr-grade-empty-icon cr-grade-empty-video" autoplay loop muted playsinline preload="auto" aria-hidden="true"><source src="../assets/icons/learners.mp4" type="video/mp4"></video>'
        : showBlueScreen
        ? '<img class="cr-grade-empty-icon" src="../assets/icons/blue-screen.png" alt="">'
        : '';
    const detail = message
        ? `<p>${escapeHtml(message)}</p>`
        : '';
    const emptyContent = `
        <div class="cr-grade-empty-state">
            ${icon}
            <h3>${escapeHtml(title || 'Nothing to display')}</h3>
            ${detail}
        </div>
    `;
    const overlay = el('crGradeEmptyOverlay');
    if (overlay) {
        overlay.innerHTML = emptyContent;
        overlay.hidden = false;
    }
    tbody.innerHTML = `
        <tr class="cr-grade-empty-row">
            <td class="cr-grade-empty-cell" colspan="${columnCount}">
                <div class="cr-grade-empty-reserve" aria-hidden="true"></div>
            </td>
        </tr>
    `;
    updateGradeSheetScrollCue();
}

async function renderNoPeriodState() {
    const sectionId = Number(el('selSection')?.value || state.selectedSectionId || 0);
    const meta = getSectionMeta(sectionId, Number(el('selClassRecordSchoolYear')?.value || state.selectedSchoolYearId || 0));
    if (!sectionId || !meta?.school_year_id) return;

    const noOpenPeriods = !schoolYearHasOpenPeriod(meta.school_year_id);
    const hasPeriods = state.gradingPeriods.some((period) =>
        Number(period.school_year_id) === Number(meta.school_year_id)
    );
    const periodsLocked = noOpenPeriods && hasPeriods;
    if (!noOpenPeriods) {
        renderGradeTableEmptyState({
            title: 'Select a grading period',
            message: 'Choose an available period to load the class roster.',
        });
        return;
    }

    try {
        const resp = await apiGet('/class_records/class_records.php', {
            operation: 'getClassRecordSheet',
            section_id: sectionId,
        });
        if (!resp?.success || !Array.isArray(resp?.data?.summary?.learners)) {
            throw new Error(resp?.message || 'Unable to verify class enrollment');
        }
        const learners = resp.data.summary.learners;

        if (learners.length === 0) {
            renderGradeTableEmptyState({
                title: 'Nothing to encode yet',
                showLearnersVideo: !periodsLocked,
                showServerVideo: periodsLocked,
            });
            return;
        }

        renderGradeTableEmptyState({
            title: 'No open periods for this school year',
            showBlueScreen: !periodsLocked,
            showServerVideo: periodsLocked,
        });
    } catch (error) {
        renderGradeTableEmptyState({
            title: 'No open periods for this school year',
            message: 'Open a grading period to load the Grade Encoding roster.',
            showServerVideo: periodsLocked,
        });
    }
}

function renderAllSubjectsTable() {
    const tbody = el('tbodyGrades');
    const table = el('tblGrades');
    if (!tbody || !table) return;
    tbody.innerHTML = '';
    clearGradeTableEmptyOverlay();
    updateGradeEncodingEditability();

    const theadRow = table.querySelector('thead tr');
    if (theadRow) {
        theadRow.innerHTML = `
            <th>Learner</th>
            ${state.allSubjectClasses.map((subject) => `<th class="cr-subject-header"><span class="cr-subject-label">${escapeHtml(subject.subject_name || '')}</span></th>`).join('')}
        `;
    }

    setGenderFilterButtons('[data-cr-roster-gender]', state.rosterGenderFilter);
    const rows = filterLearnersForTable(state.allSubjectRows, 'cr-roster-search', state.rosterGenderFilter);
    const canEditGrades = canEditSelectedGradePeriod();

    if (!rows.length) {
        const hasLearners = state.allSubjectRows.length > 0;
        renderGradeTableEmptyState({
            title: hasLearners ? 'No learners match the current filter' : 'No learners found',
            showLearnersVideo: true,
        });
        renderGradeMetrics();
        renderMapehNotice();
        return;
    }

    appendGenderGroupedRows(tbody, rows, (r, rowIndex) => {
        const tr = document.createElement('tr');
        tr.dataset.enrollmentId = String(r.enrollment_id);
        const statusBadge = enrollmentStatusBadgeHtml(r.enrollment_status);
        let html = `
            <td>
                <div class="cr-learner-cell">
                    <span class="cr-learner-name">${escapeHtml(formatLearnerNameForTable(r.learner_name || ''))}</span>
                    <span class="cr-learner-meta">LRN: ${escapeHtml(r.lrn || '—')}${statusBadge}</span>
                </div>
            </td>`;
        state.allSubjectClasses.forEach((subject, colIndex) => {
            const grade = safeNum(r.subject_grades?.[Number(subject.class_id)]?.quarterly_grade);
            const passingMark = Number(subject.passing_mark ?? 75);
            html += `<td class="cr-subject-grade-cell">
                <input class="form-control cr-grade-input cr-all-subject-input" type="text" inputmode="decimal"
                    value="${grade === null ? '' : grade}" data-class-id="${Number(subject.class_id)}" data-enrollment-id="${Number(r.enrollment_id)}" data-passing-mark="${passingMark}" data-row-index="${rowIndex}" data-col-index="${colIndex}" placeholder="—" style="${gradeInputToneStyle(grade, passingMark)}" ${canEditGrades ? '' : 'readonly'}>
            </td>`;
        });
        tr.innerHTML = html;
        return tr;
    });

    attachGradeSpreadsheetHandlers(tbody);

    renderGradeMetrics();
    renderMapehNotice();
    updateGradeSheetScrollCue();
}

function resetSingleSubjectHeader() {
    const header = el('tblGrades')?.querySelector('thead tr');
    if (!header) return;
    header.innerHTML = `
        <th>Learner</th>
        <th style="width: 160px;">Enter Grade</th>
        <th style="width: 110px;">Remark</th>
    `;
    updateGradeSheetScrollCue();
}

async function loadRoster() {
    const requestId = ++state.rosterLoadSequence;
    state.rosterLoadInFlight = true;
    try {
        const subjectValue = String(el('selSubject').value || '');
        const periodValue = String(el('selPeriod').value || '');
        if (periodValue.toLowerCase() === 'all') {
            await loadAllPeriodsSummary(requestId);
            return;
        }

        const gpId = Number(periodValue || 0);
        if (!subjectValue || !gpId) {
            state.roster = [];
            state.fullRoster = [];
            state.allSubjectClasses = [];
            state.allSubjectRows = [];
            state.classMeta = null;
            state.selectedClassId = null;
            state.selectedGradingPeriodId = null;
            resetSingleSubjectHeader();
            el('tbodyGrades').innerHTML = '';
            clearGradeTableEmptyOverlay();
            el('metricsGrades').innerHTML = '';
            if (!gpId) await renderNoPeriodState();
            return;
        }

        if (subjectValue.toLowerCase() === 'all') {
            await loadAllSubjectRoster(gpId, requestId);
            return;
        }

        const classId = Number(subjectValue || 0);
        if (!classId) return;

        let resp;
        try {
            resp = await apiGet('/class_records/class_records.php', {
                operation: 'getRosterGrades',
                class_id: classId,
                grading_period_id: gpId,
            });
        } catch (error) {
            if (requestId !== state.rosterLoadSequence) return;
            throw error;
        }

        if (requestId !== state.rosterLoadSequence) return;

        if (!resp?.success) throw new Error(resp?.message || 'Failed to load roster');

        state.selectedClassId = classId;
        state.selectedGradingPeriodId = gpId;
        state.classMeta = resp.data?.class || null;
        state.allSubjectClasses = [];
        state.allSubjectRows = [];
        state.roster = sortLearnersByName((Array.isArray(resp.data?.learners) ? resp.data.learners : []).map((learner) => ({
            ...learner,
            _savedQuarterlyGrade: learner.quarterly_grade === null || learner.quarterly_grade === undefined ? null : safeNum(learner.quarterly_grade),
        })));
        state.fullRoster = [...state.roster];
        resetGradeDirty();

        renderRosterTable();
    } finally {
        if (requestId === state.rosterLoadSequence) {
            state.rosterLoadInFlight = false;
            updateGradeEncodingEditability();
        }
    }
}

async function loadAllPeriodsSummary(requestId = state.rosterLoadSequence) {
    const sectionId = Number(el('selSection')?.value || 0);
    if (!sectionId) {
        state.recordSheet = null;
        el('tbodyGrades').innerHTML = '';
        clearGradeTableEmptyOverlay();
        el('metricsGrades').innerHTML = '';
        return;
    }

    let resp;
    try {
        resp = await apiGet('/class_records/class_records.php', {
            operation: 'getClassRecordSheet',
            section_id: sectionId,
        });
    } catch (error) {
        if (requestId !== state.rosterLoadSequence) return;
        throw error;
    }
    if (requestId !== state.rosterLoadSequence) return;
    if (!resp?.success) throw new Error(resp?.message || 'Failed to load all periods');

    state.selectedClassId = 0;
    state.selectedGradingPeriodId = 0;
    state.classMeta = {
        ...(resp.data?.section || {}),
        class_id: 0,
        subject_id: 0,
        subject_name: 'All Periods',
        is_all_periods: true,
    };
    state.recordSheet = resp.data;
    state.roster = sortLearnersByName(resp.data?.summary?.learners || []);
    state.fullRoster = state.roster;
    state.allSubjectClasses = [];
    state.allSubjectRows = [];
    renderAllPeriodsSummaryTable(resp.data);
}

function renderAllPeriodsSummaryTable(data = state.recordSheet) {
    const tbody = el('tbodyGrades');
    const table = el('tblGrades');
    if (!tbody || !table) return;
    tbody.innerHTML = '';
    clearGradeTableEmptyOverlay();
    updateGradeEncodingEditability();
    updateGradeSheetScrollCue();

    const periods = Array.isArray(data?.periods) ? data.periods : [];
    const systemType = data?.section?.grading_system_type || getGradingSystemType(data?.section?.school_year_id);
    const header = table.querySelector('thead tr');
    if (header) {
        header.innerHTML = `
            <th>Learner</th>
            ${periods.map((p) => {
                const short = systemShortLabel(Number(p.period_no || 0), systemType) || p.period_name;
                return `<th style="min-width: 110px; text-align:center;">${escapeHtml(short)} Avg.</th>`;
            }).join('')}
            <th style="width: 100px; text-align:center;">Final</th>
            <th style="width: 110px; text-align:center;">Remark</th>
        `;
    }

    setGenderFilterButtons('[data-cr-roster-gender]', state.rosterGenderFilter);
    const learners = filterLearnersForTable(data?.summary?.learners || [], 'cr-roster-search', state.rosterGenderFilter);
    if (!learners.length) {
        const hasLearners = Array.isArray(data?.summary?.learners) && data.summary.learners.length > 0;
        renderGradeTableEmptyState({
            title: hasLearners ? 'No learners match the current filter' : 'No learners found',
            showLearnersVideo: true,
        });
        renderGradeMetrics();
        renderMapehNotice();
        return;
    }

    appendGenderGroupedRows(tbody, learners, (r) => {
        const tr = document.createElement('tr');
        const status = normalizeEnrollmentStatusLabel(r.enrollment_status);
        const statusBadge = enrollmentStatusBadgeHtml(status);
        if (['Dropped', 'Transferred Out'].includes(status)) {
            tr.classList.add('cr-history-row');
            tr.setAttribute('aria-label', `${status} learner; historical record only`);
        }
        let rowHtml = `
            <td>
                <div class="cr-learner-cell">
                    <span class="cr-learner-name">${escapeHtml(formatLearnerNameForTable(r.learner_name || ''))}</span>
                    <span class="cr-learner-meta">LRN: ${escapeHtml(r.lrn || '—')}${statusBadge}</span>
                </div>
            </td>`;
        periods.forEach((p) => {
            const grade = r.period_averages?.[Number(p.grading_period_id)] ?? null;
            const complete = r.periods_complete?.[Number(p.grading_period_id)] === true;
            rowHtml += `<td style="text-align:center;">${complete && grade !== null ? gradeValueOutlineHtml(grade) : '<span style="color:var(--gray-400);">—</span>'}</td>`;
        });
        const final = r.all_periods_complete && r.final_grade !== null ? gradeValueOutlineHtml(r.final_grade) : '<span style="color:var(--gray-400);">—</span>';
        const remark = r.remark ? remarkBadgeHtml(r.remark) : '';
        rowHtml += `<td style="text-align:center;">${final}</td><td style="text-align:center;">${remark}</td>`;
        tr.innerHTML = rowHtml;
        return tr;
    });

    renderGradeMetrics();
    renderMapehNotice();
    updateGradeSheetScrollCue();
}

async function loadAllSubjectRoster(gpId, requestId = state.rosterLoadSequence) {
    const subjects = getSubjectOptionsForSelectedSection();
    if (!subjects.length || !gpId) {
        state.roster = [];
        state.fullRoster = [];
        state.allSubjectClasses = [];
        state.allSubjectRows = [];
        el('tbodyGrades').innerHTML = '';
        clearGradeTableEmptyOverlay();
        el('metricsGrades').innerHTML = '';
        updateGradeSheetScrollCue();
        return;
    }

    let responses;
    try {
        responses = await Promise.all(subjects.map((subject) =>
            apiGet('/class_records/class_records.php', {
                operation: 'getRosterGrades',
                class_id: subject.class_id,
                grading_period_id: gpId,
            }).then((resp) => ({ subject, resp }))
        ));
    } catch (error) {
        if (requestId !== state.rosterLoadSequence) return;
        throw error;
    }

    if (requestId !== state.rosterLoadSequence) return;

    const rowsByEnrollment = new Map();
    const classRows = [];
    let firstMeta = null;

    responses.forEach(({ subject, resp }) => {
        if (!resp?.success) throw new Error(resp?.message || `Failed to load ${subject.subject_name}`);
        const classMeta = resp.data?.class || {};
        if (!firstMeta) firstMeta = classMeta;
        classRows.push({
            class_id: Number(classMeta.class_id || subject.class_id),
            subject_id: Number(classMeta.subject_id || subject.subject_id || 0),
            subject_name: String(classMeta.subject_name || subject.subject_name || ''),
            curriculum_aligned: classMeta.curriculum_aligned !== false,
            passing_mark: Number(classMeta.passing_mark ?? 75),
        });
        (resp.data?.learners || []).forEach((learner) => {
            const enrollmentId = Number(learner.enrollment_id);
            if (!rowsByEnrollment.has(enrollmentId)) {
                rowsByEnrollment.set(enrollmentId, {
                    enrollment_id: enrollmentId,
                    learner_id: Number(learner.learner_id || 0),
                    lrn: learner.lrn || '',
                    learner_name: learner.learner_name || '',
                    gender: learner.gender || '',
                    subject_grades: {},
                });
            }
            rowsByEnrollment.get(enrollmentId).subject_grades[Number(classMeta.class_id || subject.class_id)] = {
                quarterly_grade: learner.quarterly_grade === null || learner.quarterly_grade === undefined ? null : safeNum(learner.quarterly_grade),
                _savedQuarterlyGrade: learner.quarterly_grade === null || learner.quarterly_grade === undefined ? null : safeNum(learner.quarterly_grade),
            };
        });
    });

    state.selectedClassId = 0;
    state.selectedGradingPeriodId = gpId;
    state.classMeta = firstMeta ? {
        ...firstMeta,
        class_id: 0,
        subject_id: 0,
        subject_name: 'All Subjects',
        is_all_subjects: true,
        is_mapeh_component: false,
        is_mapeh_cluster: false,
        has_mapeh_components: false,
    } : null;
    state.allSubjectClasses = classRows.sort(compareSubjects);
    state.allSubjectRows = sortLearnersByName(Array.from(rowsByEnrollment.values()));
    state.roster = state.allSubjectRows;
    state.fullRoster = state.allSubjectRows;
    resetGradeDirty();

    renderRosterTable();
}

async function saveGrades() {
    if (!state.canEdit) {
        await toast('error', 'Only the assigned teacher can save grades');
        return;
    }
    if (state.rosterLoadInFlight) {
        await toast('warning', 'The class roster is still loading. Please wait a moment before saving.');
        return;
    }
    if (isAllPeriodsMode()) {
        await toast('warning', 'Select a specific open period to save grades');
        return;
    }
    if (isAllSubjectsMode()) {
        await saveAllSubjectGrades();
        return;
    }
    if (state.classMeta?.curriculum_aligned === false) {
        await toast('error', 'This subject is not part of the section curriculum. Rebuild class offerings first.');
        return;
    }

    if (!Array.isArray(state.roster) || !state.roster.length) {
        await toast('warning', 'No roster is loaded. Reload the class records before saving.');
        return;
    }

    const classId = state.selectedClassId;
    const gpId = state.selectedGradingPeriodId;
    const selectedSubjectId = Number(el('selSubject')?.value || 0);
    const selectedPeriodId = Number(el('selPeriod')?.value || 0);

    if (!classId || !gpId || selectedSubjectId !== Number(classId) || selectedPeriodId !== Number(gpId)) {
        await toast('warning', 'Select subject and grading period first');
        return;
    }

    const grades = state.roster.map((r) => ({
        enrollment_id: Number(r.enrollment_id),
        quarterly_grade: r.quarterly_grade === '' ? null : safeNum(r.quarterly_grade),
    }));

    const resp = await apiPost('/class_records/class_records.php', { operation: 'saveRosterGrades' }, {
        class_id: classId,
        grading_period_id: gpId,
        grades,
    });

    if (!resp?.success) {
        throw new Error(resp?.message || 'Save failed');
    }

    await completeGradeSaveWithResponse(resp, 'Grades saved successfully');
}

function gradeSaveFeedback(resp, successMessage = 'Grades saved successfully') {
    const data = resp?.data || {};
    const errors = Array.isArray(data.errors) ? data.errors : [];
    const skipped = Math.max(0, Number(data.skipped || 0));
    const saved = Math.max(0, Number(data.saved || 0));
    const details = errors
        .slice(0, 2)
        .map((item) => String(item?.reason || '').trim())
        .filter(Boolean);
    const nonErrorSkipped = Math.max(0, skipped - errors.length);
    if (errors.length > 0 && nonErrorSkipped > 0) {
        details.push(`${nonErrorSkipped} additional row${nonErrorSkipped === 1 ? '' : 's'} skipped`);
    } else if (!errors.length && saved === 0 && skipped > 0) {
        details.push(`${skipped} row${skipped === 1 ? '' : 's'} skipped`);
    }
    if (!details.length) {
        return { message: successMessage, tone: 'success', saved };
    }

    const suffix = details.join('; ');
    return {
        message: saved > 0
            ? `${successMessage}, but ${suffix}.`
            : `No grades were saved. ${suffix}.`,
        tone: 'warning',
        saved,
    };
}

function combineGradeSaveFeedback(feedbacks, successMessage = 'Grades saved successfully') {
    const warnings = feedbacks.filter((feedback) => feedback?.tone === 'warning');
    if (!warnings.length) return { message: successMessage, tone: 'success' };

    const saved = feedbacks.reduce((total, feedback) => total + Number(feedback?.saved || 0), 0);
    const details = warnings
        .map((feedback) => String(feedback.message || '').replace(/^Grades saved successfully, but\s*/i, '').replace(/^No grades were saved\.\s*/i, ''))
        .filter(Boolean)
        .slice(0, 3)
        .join(' ');
    return {
        message: saved > 0
            ? `${successMessage}, but ${details}`
            : `No grades were saved. ${details}`,
        tone: 'warning',
    };
}

async function completeGradeSaveWithResponse(resp, successMessage) {
    const feedback = gradeSaveFeedback(resp, successMessage);
    await completeGradeSave(feedback.message, feedback.tone);
}

async function completeGradeSave(message, tone = 'success') {
    resetGradeDirty();
    try {
        await loadRoster();
        if (state.activeTab === 'honors') {
            await loadHonors();
        } else {
            state.recordSheet = null;
        }
        await toast(tone, message);
    } catch (refreshError) {
        console.error('[Class Records] Grades saved but roster refresh failed:', refreshError);
        await toast(
            'warning',
            `${message}. The grades were saved, but the roster could not refresh: ${apiErrorMessage(refreshError, 'reload the page to verify')}.`
        );
    }
}

async function saveAllSubjectGrades() {
    const gpId = state.selectedGradingPeriodId || Number(el('selPeriod')?.value || 0);
    if (!gpId || !state.allSubjectClasses.length) {
        await toast('warning', 'Select section and grading period first');
        return;
    }
    if (!state.allSubjectRows.length) {
        await toast('warning', 'No learners are loaded. Reload the class records before saving.');
        return;
    }

    const feedbacks = [];
    for (const subject of state.allSubjectClasses) {
        const grades = state.allSubjectRows.map((row) => ({
            enrollment_id: Number(row.enrollment_id),
            quarterly_grade: row.subject_grades?.[Number(subject.class_id)]?.quarterly_grade ?? null,
        }));

        const resp = await apiPost('/class_records/class_records.php', { operation: 'saveRosterGrades' }, {
            class_id: Number(subject.class_id),
            grading_period_id: gpId,
            grades,
        });

        if (!resp?.success) {
            throw new Error(resp?.message || `Failed to save ${subject.subject_name}`);
        }
        feedbacks.push(gradeSaveFeedback(resp, 'Grades saved successfully'));
    }

    const feedback = combineGradeSaveFeedback(feedbacks);
    await completeGradeSave(feedback.message, feedback.tone);
}

function canImportGrades() {
    return canUseTeacherRecordControls() && state.classMeta?.curriculum_aligned !== false;
}

function getGradeImportContext() {
    if (isAllPeriodsMode()) {
        throw new Error('Select a specific open period before downloading or importing grades');
    }
    const allSubjects = isAllSubjectsMode();
    const classId = allSubjects ? 0 : Number(el('selSubject')?.value || state.selectedClassId || 0);
    const gpId = Number(el('selPeriod')?.value || state.selectedGradingPeriodId || 0);
    const period = getSelectedPeriod();

    if ((!allSubjects && !classId) || !gpId) {
        throw new Error('Select section, subject, and grading period first');
    }
    if (!state.fullRoster.length || (!allSubjects && Number(state.selectedClassId || 0) !== classId) || Number(state.selectedGradingPeriodId || 0) !== gpId) {
        throw new Error('Load the class roster before using grade import');
    }
    if (state.classMeta?.curriculum_aligned === false) {
        throw new Error('This subject is not part of the section curriculum. Rebuild class offerings first.');
    }
    if (!canImportGrades()) {
        throw new Error('Only advisers or assigned teachers can import grades');
    }
    if (!period || !isPeriodOpen(period)) {
        throw new Error('Open this grading period before importing grades');
    }

    return {
        classId,
        gpId,
        period,
        classMeta: state.classMeta || {},
        allSubjects,
        subjects: allSubjects ? [...state.allSubjectClasses] : [],
    };
}

function getGradeImportTemplateInfo(ctx) {
    const sectionLabel = `${ctx.classMeta.grade_name || ''} ${ctx.classMeta.section_name || ''}`.trim();
    return {
        title: [
            'Grade Import Template',
            ctx.classMeta.year_label,
            sectionLabel,
            ctx.classMeta.subject_name,
            ctx.period.period_name,
        ].filter(Boolean).join(' - '),
        schoolYear: ctx.classMeta.year_label || '',
        section: sectionLabel,
        subject: ctx.classMeta.subject_name || '',
        period: ctx.period.period_name || '',
    };
}

function getPeriodExportLabel(period) {
    const periodNo = Number(period?.period_no || 0);
    if (periodNo > 0) return `TERM ${periodNo}`;

    const periodName = String(period?.period_name || '').split('·')[0].trim();
    const ordinal = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
    const match = periodName.toLowerCase().match(/^(first|second|third|fourth|fifth|sixth)\b/);
    return match ? `TERM ${ordinal[match[1]]}` : (periodName.toUpperCase() || 'TERM');
}

async function downloadGradeImportTemplate() {
    const ctx = getGradeImportContext();
    const info = getGradeImportTemplateInfo(ctx);
    const XLSX = await ensureXlsx();
    const subjectColumns = ctx.allSubjects ? ctx.subjects : [];
    const templateLearners = getTemplateLearnersForCurrentGender();
    if (!templateLearners.length) {
        throw new Error(`No ${genderFilterLabel(state.rosterGenderFilter).toLowerCase()} learners found for this template`);
    }
    const headers = ctx.allSubjects
        ? ['LRN', 'Learner Name', ...subjectColumns.map((s) => s.subject_name || `Subject ${s.class_id}`)]
        : ['LRN', 'Learner Name', 'Grade'];
    const rows = templateLearners.map((r) => {
        const base = [r.lrn || '', r.learner_name || ''];
        if (ctx.allSubjects) {
            return [...base, ...subjectColumns.map(() => '')];
        }
        return [...base, ''];
    });
    const learnerSheetRows = [
        headers,
        ...rows,
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(learnerSheetRows);
    worksheet['!cols'] = [
        { wch: 18 },
        { wch: 42 },
        ...headers.slice(2).map(() => ({ wch: 14 })),
    ];
    const lastCol = XLSX.utils.encode_col(Math.max(0, headers.length - 1));
    worksheet['!autofilter'] = { ref: `A1:${lastCol}${Math.max(1, learnerSheetRows.length)}` };
    worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };

    for (let r = 1; r < learnerSheetRows.length; r++) {
        const lrnCell = worksheet[`A${r + 1}`];
        if (lrnCell) {
            lrnCell.t = 's';
            lrnCell.z = '@';
        }
    }

    const validationRows = [
        ['class_id', ctx.classId],
        ['grading_period_id', ctx.gpId],
        ['school_year', info.schoolYear],
        ['section', info.section],
        ['subject', info.subject],
        ['period', info.period],
        ['mode', ctx.allSubjects ? 'all_subjects' : 'single_subject'],
        ['gender_filter', genderFilterLabel(state.rosterGenderFilter)],
    ];
    if (ctx.allSubjects) {
        subjectColumns.forEach((subject, index) => {
            validationRows.push(['subject_column', Number(subject.class_id), subject.subject_name || '', index + 3]);
        });
    }
    templateLearners.forEach((r) => {
        validationRows.push(['learner', r.lrn || '', r.enrollment_id || '', r.learner_name || '']);
    });
    const validationSheet = XLSX.utils.aoa_to_sheet(validationRows);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Grade Entry');
    XLSX.utils.book_append_sheet(workbook, validationSheet, 'System Validation');
    workbook.Workbook = workbook.Workbook || {};
    workbook.Workbook.Sheets = workbook.Workbook.Sheets || [];
    workbook.Workbook.Sheets[1] = { Hidden: 1 };

    const sectionLabel = `${ctx.classMeta.grade_name || ''} ${ctx.classMeta.section_name || ''}`.trim();
    const operationName = `${getPeriodExportLabel(ctx.period)} Grade Import Template`;
    const nameParts = [
        operationName,
        sectionLabel,
        !ctx.allSubjects ? ctx.classMeta.subject_name : '',
    ].filter(Boolean);
    XLSX.writeFile(workbook, `${exportFileName(nameParts.join(' - '), 'Grade Import Template')}.xlsx`);
}

function findGradeImportHeaderIndex(rows) {
    return rows.findIndex((row) => {
        const headers = new Set((row || []).map(normalizeImportHeader).filter(Boolean));
        return headers.has('lrn') && (headers.has('grade') || headers.has('learner_name'));
    });
}

function csvRowsToObjects(rows) {
    const headerIndex = findGradeImportHeaderIndex(rows);
    if (headerIndex < 0) {
        throw new Error('Missing required columns: LRN and Grade');
    }

    const headerRow = rows[headerIndex] || [];
    const headers = headerRow.map(normalizeImportHeader);
    return rows.slice(headerIndex + 1).map((row, index) => {
        const obj = { __rowNumber: headerIndex + index + 2, __sourceIndex: index, __raw: row };
        headers.forEach((header, colIndex) => {
            if (!header) return;
            obj[header] = row[colIndex] ?? '';
        });
        return obj;
    });
}

function importValue(row, keys) {
    for (const key of keys) {
        const normalized = normalizeImportHeader(key);
        if (Object.prototype.hasOwnProperty.call(row, normalized)) {
            return String(row[normalized] ?? '').trim();
        }
    }
    return '';
}

function getImportMetadata(rows, validationRows = []) {
    const headerIndex = findGradeImportHeaderIndex(rows);
    const metadataRows = headerIndex > 0 ? rows.slice(0, headerIndex) : [];
    const metadata = {};
    metadataRows.forEach((row) => {
        const key = normalizeImportHeader(row?.[0] || '');
        if (!key || !row || row.length < 2) return;
        metadata[key] = String(row[1] ?? '').trim();
    });
    validationRows.forEach((row) => {
        const key = normalizeImportHeader(row?.[0] || '');
        if (!key || key === 'learner' || !row || row.length < 2) return;
        metadata[key] = String(row[1] ?? '').trim();
    });
    return metadata;
}

function normalizeContextValue(value) {
    return normalizeSearchText(value).replace(/\s+/g, ' ').trim();
}

function metadataMatches(actual, expected) {
    const a = normalizeContextValue(actual);
    const e = normalizeContextValue(expected);
    return !a || !e || a === e;
}

function parseImportGradeValue(raw) {
    const cleaned = String(raw ?? '')
        .trim()
        .replace(/%/g, '')
        .replace(/,/g, '')
        .replace(/\s+/g, '');
    if (cleaned === '') return null;
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return NaN;
    return Number(cleaned);
}

function normalizeImportLrn(raw) {
    let value = String(raw ?? '').trim();
    if (/^\d+(\.\d+)?E\+?\d+$/i.test(value)) {
        value = Number(value).toFixed(0);
    }
    return value.replace(/[\s-]/g, '');
}

function normalizeImportName(raw) {
    return normalizeSearchText(raw)
        .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function getValidationLearners(validationRows = []) {
    return validationRows
        .filter((row) => normalizeImportHeader(row?.[0] || '') === 'learner')
        .map((row, index) => ({
            sourceIndex: index,
            lrn: normalizeImportLrn(row?.[1] || ''),
            enrollmentId: Number(row?.[2] || 0),
            learnerName: String(row?.[3] || '').trim(),
        }));
}

function getValidationSubjectColumns(validationRows = []) {
    return validationRows
        .filter((row) => normalizeImportHeader(row?.[0] || '') === 'subject_column')
        .map((row) => ({
            classId: Number(row?.[1] || 0),
            subjectName: String(row?.[2] || '').trim(),
            columnNumber: Number(row?.[3] || 0),
        }))
        .filter((row) => row.classId && row.subjectName && row.columnNumber);
}

function analyzeAllSubjectsImport(ctx, rows, validationRows, validationLearners) {
    const headerIndex = findGradeImportHeaderIndex(rows);
    const headers = (rows[headerIndex] || []).map((h) => String(h || '').trim());
    const subjectColumns = getValidationSubjectColumns(validationRows);
    if (!subjectColumns.length) {
        throw new Error('All Subjects import requires subject validation columns. Download a fresh template.');
    }

    const objects = csvRowsToObjects(rows).filter((row) =>
        (row.__raw || []).some((cell) => String(cell || '').trim() !== '')
    );
    const rosterByLrn = new Map();
    state.allSubjectRows.forEach((r) => {
        const lrn = normalizeImportLrn(r.lrn || '');
        if (lrn) rosterByLrn.set(lrn, r);
    });

    const seenLrn = new Set();
    const valid = [];
    const invalid = [];
    const unchanged = [];
    const skipped = [];

    objects.forEach((row) => {
        const rowNumber = row.__rowNumber;
        const lrn = normalizeImportLrn(importValue(row, ['LRN']));
        const learnerNameRaw = importValue(row, ['Learner Name', 'Learner', 'Name']);
        const expectedLearner = validationLearners[row.__sourceIndex] || null;
        const fail = (reason) => invalid.push({ rowNumber, lrn, reason });

        if (!lrn) {
            fail('Missing LRN');
            return;
        }
        if (seenLrn.has(lrn)) {
            fail('Duplicate LRN in import file');
            return;
        }
        seenLrn.add(lrn);
        if (expectedLearner?.lrn && expectedLearner.lrn !== lrn) {
            fail('LRN was changed from the downloaded template row');
            return;
        }

        const rosterRow = rosterByLrn.get(lrn);
        if (!rosterRow) {
            fail('LRN does not belong to the selected roster');
            return;
        }
        if (learnerNameRaw && normalizeImportName(learnerNameRaw) !== normalizeImportName(rosterRow.learner_name || '')) {
            fail('Learner name does not match the LRN');
            return;
        }
        if (expectedLearner?.enrollmentId && Number(rosterRow.enrollment_id) !== expectedLearner.enrollmentId) {
            fail('Learner row does not match the downloaded template');
            return;
        }

        subjectColumns.forEach((subjectColumn) => {
            const header = headers[subjectColumn.columnNumber - 1] || subjectColumn.subjectName;
            const raw = row.__raw?.[subjectColumn.columnNumber - 1] ?? '';
            const grade = parseImportGradeValue(raw);
            if (grade === null) {
                skipped.push({ rowNumber, lrn, learnerName: rosterRow.learner_name || '', subjectName: subjectColumn.subjectName, reason: 'Blank grade' });
                return;
            }
            if (Number.isNaN(grade)) {
                invalid.push({ rowNumber, lrn, reason: `${header}: grade must be numeric` });
                return;
            }
            if (grade < 60 || grade > 100) {
                invalid.push({ rowNumber, lrn, reason: `${header}: grade must be between 60 and 100` });
                return;
            }
            const current = safeNum(rosterRow.subject_grades?.[subjectColumn.classId]?.quarterly_grade);
            const normalizedGrade = Math.round(grade * 100) / 100;
            if (current !== null && Number(current).toFixed(2) === normalizedGrade.toFixed(2)) {
                unchanged.push({ rowNumber, lrn, learnerName: rosterRow.learner_name || '', subjectName: subjectColumn.subjectName, grade: normalizedGrade });
                return;
            }
            valid.push({
                rowNumber,
                lrn,
                learnerName: rosterRow.learner_name || '',
                enrollmentId: Number(rosterRow.enrollment_id),
                classId: subjectColumn.classId,
                subjectName: subjectColumn.subjectName,
                current,
                grade: normalizedGrade,
            });
        });
    });

    return { ctx, valid, invalid, unchanged, skipped, totalRows: objects.length, allSubjects: true };
}

function analyzeGradeImport(rows) {
    const ctx = getGradeImportContext();
    const validationRows = Array.isArray(rows.__validationRows) ? rows.__validationRows : [];
    const validationLearners = getValidationLearners(validationRows);
    const metadata = getImportMetadata(rows, validationRows);
    const info = getGradeImportTemplateInfo(ctx);
    const metadataIssues = [];
    if (!metadataMatches(metadata.school_year, info.schoolYear)) {
        metadataIssues.push('School year in the file does not match the selected school year');
    }
    if (!metadataMatches(metadata.section, info.section)) {
        metadataIssues.push('Section in the file does not match the selected section');
    }
    if (!metadataMatches(metadata.subject, info.subject)) {
        metadataIssues.push('Subject in the file does not match the selected subject');
    }
    if (!metadataMatches(metadata.period, info.period)) {
        metadataIssues.push('Period in the file does not match the selected grading period');
    }
    if (metadataIssues.length) {
        throw new Error(metadataIssues[0]);
    }
    if (ctx.allSubjects) {
        return analyzeAllSubjectsImport(ctx, rows, validationRows, validationLearners);
    }

    const objects = csvRowsToObjects(rows).filter((row) =>
        (row.__raw || []).some((cell) => String(cell || '').trim() !== '')
    );
    const rosterByLrn = new Map();
    const rosterByEnrollmentId = new Map();
    state.fullRoster.forEach((r) => {
        const lrn = String(r.lrn || '').trim();
        if (lrn) rosterByLrn.set(lrn, r);
        rosterByEnrollmentId.set(String(r.enrollment_id), r);
    });

    const seenLrn = new Set();
    const valid = [];
    const invalid = [];
    const unchanged = [];
    const skipped = [];

    objects.forEach((row) => {
        const rowNumber = row.__rowNumber;
        const lrn = normalizeImportLrn(importValue(row, ['LRN']));
        const learnerNameRaw = importValue(row, ['Learner Name', 'Learner', 'Name']);
        const gradeRaw = importValue(row, ['Grade', 'Enter Grade', 'Period Grade', 'Quarterly Grade', 'quarterly_grade']);
        const classIdRaw = importValue(row, ['class_id']);
        const gpIdRaw = importValue(row, ['grading_period_id']);
        const enrollmentIdRaw = importValue(row, ['enrollment_id']);
        const expectedLearner = validationLearners[row.__sourceIndex] || null;

        const fail = (reason) => invalid.push({ rowNumber, lrn, reason });

        if (!lrn) {
            fail('Missing LRN');
            return;
        }
        if (seenLrn.has(lrn)) {
            fail('Duplicate LRN in import file');
            return;
        }
        seenLrn.add(lrn);

        if (classIdRaw && Number(classIdRaw) !== ctx.classId) {
            fail('Template class/subject does not match the selected class record');
            return;
        }
        if (gpIdRaw && Number(gpIdRaw) !== ctx.gpId) {
            fail('Template period does not match the selected grading period');
            return;
        }
        if (expectedLearner?.lrn && expectedLearner.lrn !== lrn) {
            fail('LRN was changed from the downloaded template row');
            return;
        }

        const rosterRow = enrollmentIdRaw
            ? rosterByEnrollmentId.get(String(Number(enrollmentIdRaw))) || rosterByLrn.get(lrn)
            : rosterByLrn.get(lrn);
        if (!rosterRow || String(rosterRow.lrn || '').trim() !== lrn) {
            fail('LRN does not belong to the selected roster');
            return;
        }
        if (learnerNameRaw && normalizeImportName(learnerNameRaw) !== normalizeImportName(rosterRow.learner_name || '')) {
            fail('Learner name does not match the LRN');
            return;
        }
        if (expectedLearner?.enrollmentId && Number(rosterRow.enrollment_id) !== expectedLearner.enrollmentId) {
            fail('Learner row does not match the downloaded template');
            return;
        }

        if (gradeRaw === '') {
            skipped.push({ rowNumber, lrn, learnerName: rosterRow.learner_name || '', reason: 'Blank grade' });
            return;
        }
        const grade = parseImportGradeValue(gradeRaw);
        if (Number.isNaN(grade)) {
            fail('Grade must be numeric');
            return;
        }

        if (grade < 60 || grade > 100) {
            fail('Grade must be between 60 and 100');
            return;
        }

        const current = safeNum(rosterRow.quarterly_grade);
        const normalizedGrade = Math.round(grade * 100) / 100;
        if (current !== null && Number(current).toFixed(2) === normalizedGrade.toFixed(2)) {
            unchanged.push({ rowNumber, lrn, learnerName: rosterRow.learner_name || '', grade: normalizedGrade });
            return;
        }

        valid.push({
            rowNumber,
            lrn,
            learnerName: rosterRow.learner_name || '',
            enrollmentId: Number(rosterRow.enrollment_id),
            current,
            grade: normalizedGrade,
        });
    });

    return { ctx, valid, invalid, unchanged, skipped, totalRows: objects.length };
}

function importPreviewSubjectName(analysis, row) {
    return String(row?.subjectName || analysis?.ctx?.classMeta?.subject_name || 'Subject').trim() || 'Subject';
}

function importPreviewSubjectCode(subjectName) {
    const firstWord = String(subjectName || '').match(/[A-Za-z0-9]+/)?.[0] || 'SUB';
    return firstWord.slice(0, 3).toUpperCase();
}

function importPreviewLearnerCell(learnerName, lrn) {
    const name = formatLearnerNameForTable(learnerName) || 'Unknown learner';
    const learnerLrn = String(lrn || '').trim();
    return `<div class="cr-import-preview-learner">
        <span class="cr-import-preview-learner-name">${crEscapeHtml(name)}</span>
        <span class="cr-import-preview-learner-lrn">LRN: ${crEscapeHtml(learnerLrn || '—')}</span>
    </div>`;
}

function importPreviewSubjectColumns(analysis) {
    const columns = [];
    const seen = new Set();
    const addColumn = (key, name) => {
        const normalizedKey = String(key || name || '').trim();
        if (!normalizedKey || seen.has(normalizedKey)) return;
        seen.add(normalizedKey);
        columns.push({ key: normalizedKey, name: String(name || 'Subject').trim() || 'Subject' });
    };

    (analysis?.ctx?.subjects || []).forEach((subject) => {
        addColumn(String(subject.class_id || ''), subject.subject_name || `Subject ${subject.class_id || ''}`);
    });
    [...(analysis?.valid || []), ...(analysis?.unchanged || [])].forEach((row) => {
        const subjectName = importPreviewSubjectName(analysis, row);
        const known = columns.find((column) => normalizeImportHeader(column.name) === normalizeImportHeader(subjectName));
        addColumn(String(row.classId || known?.key || subjectName), subjectName);
    });

    return columns;
}

function buildAllSubjectsImportPreviewRows(analysis, subjectColumns) {
    const learners = new Map();
    const rows = [
        ...(analysis.valid || []).map((row) => ({ ...row, _unchanged: false })),
        ...(analysis.unchanged || []).map((row) => ({ ...row, _unchanged: true })),
    ];

    rows.forEach((row) => {
        const learnerKey = String(row.enrollmentId || row.lrn || row.learnerName || 'unknown');
        if (!learners.has(learnerKey)) {
            learners.set(learnerKey, {
                learnerName: row.learnerName || '',
                lrn: row.lrn || '',
                subjects: new Map(),
            });
        }
        const learner = learners.get(learnerKey);
        const subjectName = importPreviewSubjectName(analysis, row);
        const known = subjectColumns.find((column) => normalizeImportHeader(column.name) === normalizeImportHeader(subjectName));
        const subjectKey = String(row.classId || known?.key || subjectName);
        learner.subjects.set(subjectKey, row);
    });

    return Array.from(learners.values()).map((learner) => `
        <tr>
            <td>${importPreviewLearnerCell(learner.learnerName, learner.lrn)}</td>
            ${subjectColumns.map((column) => {
                const entry = learner.subjects.get(column.key);
                const imported = entry ? fmt2(entry.grade) : '—';
                return `<td><strong>${imported}</strong></td>`;
            }).join('')}
        </tr>`).join('');
}

function buildImportPreviewHtml(analysis) {
    const subjectColumns = importPreviewSubjectColumns(analysis);
    const validRows = analysis.allSubjects
        ? buildAllSubjectsImportPreviewRows(analysis, subjectColumns)
        : analysis.valid.map((r) => {
        const subjectName = importPreviewSubjectName(analysis, r);
        return `
            <tr>
                <td>${importPreviewLearnerCell(r.learnerName, r.lrn)}</td>
                <td title="${crEscapeHtml(subjectName)}"><strong>${fmt2(r.grade)}</strong></td>
            </tr>`;
        }).join('');
    const invalidRows = analysis.invalid.map((r) => {
        const subjectName = r.subjectName ? importPreviewSubjectName(analysis, r) : '';
        const subjectCell = subjectName
            ? `<span class="cr-import-preview-subject" title="${crEscapeHtml(subjectName)}">${crEscapeHtml(importPreviewSubjectCode(subjectName))}</span>`
            : '—';
        return `
            <tr>
                <td>${importPreviewLearnerCell(r.learnerName, r.lrn)}</td>
                <td>${subjectCell}</td>
                <td class="cr-import-preview-invalid">${crEscapeHtml(r.reason)}</td>
            </tr>`;
    }).join('');

    const validTable = validRows ? `
        <div class="cr-import-preview${analysis.allSubjects ? ' cr-import-preview-all-subjects-wrap' : ''}">
            <table class="cr-import-preview-table${analysis.allSubjects ? ' cr-import-preview-all-subjects' : ' cr-import-preview-single-subject'}">
                <thead><tr><th>Learner</th>${subjectColumns.map((column) => `<th title="${crEscapeHtml(column.name)}">${crEscapeHtml(importPreviewSubjectCode(column.name))}</th>`).join('')}</tr></thead>
                <tbody>${validRows}</tbody>
            </table>
        </div>` : '';
    const invalidTable = invalidRows ? `
        <p style="margin:0 0 6px; font-weight:800; color:#b91c1c; text-align:left;">Invalid entries</p>
        <div class="cr-import-preview">
            <table class="cr-import-preview-table cr-import-preview-invalid-table">
                <thead><tr><th>Learner</th><th>Subject</th><th>Issue</th></tr></thead>
                <tbody>${invalidRows}</tbody>
            </table>
        </div>` : '';

    return `${invalidTable}${validTable}`;
}

async function confirmGradeImport(analysis) {
    const html = buildImportPreviewHtml(analysis);
    if (analysis.invalid.length) {
        if (typeof Swal !== 'undefined' && typeof Swal.fire === 'function') {
            await Swal.fire({
                title: 'Fix Import Issues',
                html,
                width: 'min(1400px, calc(100vw - 16px))',
                icon: 'error',
                customClass: { popup: 'cr-import-preview-popup' },
                confirmButtonText: 'Review File',
                confirmButtonColor: 'var(--deped-blue)',
            });
        } else {
            window.alert(`Fix ${analysis.invalid.length} invalid import row(s) before saving.`);
        }
        return false;
    }

    if (!analysis.valid.length) {
        await toast('warning', 'No changed grades found');
        return false;
    }

    if (typeof Swal !== 'undefined' && typeof Swal.fire === 'function') {
        const result = await Swal.fire({
            title: 'Preview Grade Import',
            html,
            width: 'min(1400px, calc(100vw - 16px))',
            icon: 'info',
            customClass: { popup: 'cr-import-preview-popup' },
            showCancelButton: true,
            confirmButtonText: 'Save Grades',
            cancelButtonText: 'Cancel',
            confirmButtonColor: 'var(--deped-blue)',
        });
        return !!result.isConfirmed;
    }

    return window.confirm(`Save ${analysis.valid.length} imported grade(s)?`);
}

async function saveImportedGrades(analysis) {
    if (analysis.allSubjects) {
        return saveImportedAllSubjectGrades(analysis);
    }

    const grades = analysis.valid.map((r) => ({
        enrollment_id: r.enrollmentId,
        quarterly_grade: r.grade,
    }));

    const resp = await apiPost('/class_records/class_records.php', { operation: 'saveRosterGrades' }, {
        class_id: analysis.ctx.classId,
        grading_period_id: analysis.ctx.gpId,
        grades,
    });

    if (!resp?.success) {
        throw new Error(resp?.message || 'Import failed');
    }

    await completeGradeSaveWithResponse(resp, 'Grades saved successfully');
}

async function saveImportedAllSubjectGrades(analysis) {
    const byClass = new Map();
    analysis.valid.forEach((row) => {
        if (!byClass.has(row.classId)) byClass.set(row.classId, []);
        byClass.get(row.classId).push({
            enrollment_id: row.enrollmentId,
            quarterly_grade: row.grade,
        });
    });

    const feedbacks = [];
    for (const [classId, grades] of byClass.entries()) {
        const resp = await apiPost('/class_records/class_records.php', { operation: 'saveRosterGrades' }, {
            class_id: Number(classId),
            grading_period_id: analysis.ctx.gpId,
            grades,
        });
        if (!resp?.success) throw new Error(resp?.message || 'Import failed');
        feedbacks.push(gradeSaveFeedback(resp, 'Grades saved successfully'));
    }

    const feedback = combineGradeSaveFeedback(feedbacks);
    await completeGradeSave(feedback.message, feedback.tone);
}

async function handleGradeImportFile(file) {
    if (!file) return;
    const name = String(file.name || '').toLowerCase();
    const isWorkbookFile = name.endsWith('.xlsx') || name.endsWith('.numbers');
    if (!isWorkbookFile && !name.endsWith('.csv')) {
        await toast('error', 'Upload the XLSX grade template file');
        return;
    }

    let rows = [];
    if (isWorkbookFile) {
        const XLSX = await ensureXlsx();
        const buffer = await file.arrayBuffer();
        let workbook;
        try {
            workbook = XLSX.read(buffer, { type: 'array', raw: false });
        } catch (e) {
            if (name.endsWith('.numbers')) {
                throw new Error('This Numbers file could not be read. In Apple Numbers, export it to Excel (.xlsx), then import that file.');
            }
            throw e;
        }
        const entrySheetName = workbook.SheetNames.includes('Grade Entry') ? 'Grade Entry' : workbook.SheetNames[0];
        const entrySheet = workbook.Sheets[entrySheetName];
        rows = XLSX.utils.sheet_to_json(entrySheet, { header: 1, defval: '', raw: false });
        if (!workbook.Sheets['System Validation']) {
            throw new Error('Use the downloaded grade template. The validation sheet is missing, so this file cannot be verified.');
        }
        rows.__validationRows = XLSX.utils.sheet_to_json(workbook.Sheets['System Validation'], { header: 1, defval: '', raw: false });
    } else {
        const text = await file.text();
        rows = parseCsvRows(text);
    }

    if (rows.length < 2) {
        await toast('error', 'The import file has no learner rows');
        return;
    }

    const analysis = analyzeGradeImport(rows);
    const confirmed = await confirmGradeImport(analysis);
    if (!confirmed) return;
    await saveImportedGrades(analysis);
}

function isHonorsYearLevelScope(data) {
    return String(el('selHonScope')?.value || '').toLowerCase() === 'grade'
        || Number(data?.section?.section_id || 0) === 0;
}

function getHonorsDenseRanks(honorees) {
    let previousAverage = null;
    let rank = 0;

    return (Array.isArray(honorees) ? honorees : []).map((honoree, index) => {
        const numericAverage = Number(honoree?.general_average);
        const averageKey = Number.isFinite(numericAverage) ? numericAverage.toFixed(2) : '';
        if (previousAverage === null || averageKey !== previousAverage) {
            rank += 1;
        }
        previousAverage = averageKey;

        const apiRank = Number(honoree?.rank);
        return Number.isFinite(apiRank) && apiRank > 0 ? apiRank : rank;
    });
}

function renderHonors(data) {
    const honorees = Array.isArray(data?.honorees) ? data.honorees : [];
    const showSectionColumn = isHonorsYearLevelScope(data);
    const ranks = getHonorsDenseRanks(honorees);

    const head = el('theadHonors');
    const body = el('tbodyHonors');

    head.innerHTML = '';
    body.innerHTML = '';

    const trh = document.createElement('tr');
    trh.innerHTML = `
        <th>Learner</th>
        ${showSectionColumn ? '<th style="width: 160px;">Section</th>' : ''}
        <th style="text-align:center; width: 90px;">Rank</th>
        <th style="text-align:center; width: 120px;">Rating</th>
        <th style="width: 180px; text-align:center;">Honor Level</th>
    `;
    head.appendChild(trh);

    if (!honorees.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="cr-honors-empty-cell" colspan="${showSectionColumn ? 5 : 4}">
                <div class="cr-honors-empty-state">
                    <video class="mp4-surface-blend cr-honors-empty-icon" autoplay loop muted playsinline preload="auto" aria-hidden="true">
                        <source src="../assets/icons/medal.mp4" type="video/mp4">
                    </video>
                    <h3>No honor qualifiers yet.</h3>
                    <p class="cr-honors-empty-note">Encode complete grades first.</p>
                </div>
            </td>
        `;
        body.appendChild(tr);
        return;
    }

    honorees.forEach((h, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <div class="cr-honors-learner-name">${escapeHtml(formatLearnerNameForTable(h.learner_name || ''))}</div>
                <div class="cr-honors-learner-lrn">LRN: ${escapeHtml(h.lrn || '—')}</div>
            </td>
            ${showSectionColumn ? `<td>${escapeHtml(h.section_name || '—')}</td>` : ''}
            <td style="text-align:center; font-weight: 900;">${ranks[index]}</td>
            <td style="text-align:center; font-weight: 900;">${fmt2(h.general_average)}</td>
            <td style="text-align:center;"><span class="tx-badge">${escapeHtml(h.honor?.honor_name || '')}</span></td>
        `;
        body.appendChild(tr);
    });
}

function getHonorsPeriodDisplay(data) {
    if (data?.mode === 'final') return 'FINAL';

    const periodId = Number(el('selHonPeriod')?.value || 0);
    const selectedPeriod = state.gradingPeriods.find((period) => Number(period.grading_period_id) === periodId);
    const periodNo = Number(selectedPeriod?.period_no || 0);
    if (periodNo > 0) return `TERM ${periodNo}`;

    const selected = el('selHonPeriod')?.selectedOptions?.[0];
    const label = String(selected?.textContent || '').split('·')[0].trim().toUpperCase();
    return label || 'Grading period';
}

function renderHonorsSelectionPrompt(message = 'Please choose the required records above to view the Honors ranking.') {
    const head = el('theadHonors');
    const body = el('tbodyHonors');
    if (head) head.innerHTML = '';
    if (!body) return;

    body.innerHTML = `
        <tr>
            <td class="cr-honors-empty-cell" colspan="4">
                <div class="cr-honors-empty-state">
                    <video class="mp4-surface-blend cr-honors-empty-icon" autoplay loop muted playsinline preload="auto" aria-hidden="true">
                        <source src="../assets/icons/search.mp4" type="video/mp4">
                    </video>
                    <h3>Select your records</h3>
                    <p class="cr-honors-empty-note">${escapeHtml(message)}</p>
                </div>
            </td>
        </tr>`;
}

function getHonorsPrintStyles() {
    return `
        @page{size:8.5in 11in;margin:0;}
        :root{
            --honors-paper-width:8.5in;
            --honors-paper-height:11in;
            --honors-ink:#111827;
            --honors-navy:#1b2a5c;
            --honors-red:#a31515;
            --honors-line:#1f2937;
            --honors-head:#edf0f5;
        }
        .honors-print-pages{
            display:flex;
            flex-direction:column;
            align-items:center;
            gap:18px;
            color:var(--honors-ink);
            font-family:Arial,Helvetica,sans-serif;
        }
        .honors-print-sheet{
            width:var(--honors-paper-width);
            height:var(--honors-paper-height);
            margin:0;
            padding:.4in;
            box-sizing:border-box;
            background:#fff;
            box-shadow:0 2px 14px rgba(0,0,0,.28);
            flex:none;
            overflow:hidden;
            position:relative;
            break-after:auto;
            page-break-after:auto;
        }
        .honors-print-sheet:not(:last-child){
            break-after:page;
            page-break-after:always;
        }
        .honors-print-frame{
            height:100%;
            border:1.5px solid var(--honors-line);
            display:flex;
            flex-direction:column;
            padding:.22in .4in .16in;
            position:relative;
            box-sizing:border-box;
        }
        .honors-print-header{
            display:grid;
            grid-template-columns:1.25in minmax(0,1fr) 1.25in;
            align-items:center;
            column-gap:.1in;
        }
        .honors-print-logo{
            width:1.15in;
            height:1.15in;
            display:flex;
            align-items:center;
            justify-content:center;
        }
        .honors-print-logo img{
            display:block;
            width:100%;
            height:100%;
            object-fit:contain;
        }
        .honors-print-logo--right{justify-self:end;}
        .honors-print-title{text-align:center;min-width:0;}
        .honors-congrats{
            display:block;
            margin-top:2px;
            color:var(--honors-ink);
            font-family:"UnifrakturCook","Old English Text MT","Blackadder ITC","Georgia",serif;
            font-size:25pt;
            font-weight:700;
            line-height:1;
        }
        .honors-government{font-weight:700;font-size:11pt;letter-spacing:.04em;line-height:1.3;text-transform:uppercase;}
        .honors-system{margin-top:3px;color:var(--honors-navy);font-weight:700;font-size:11.5pt;line-height:1.1;}
        .honors-list-title{margin-top:3px;font-weight:800;font-size:25pt;letter-spacing:.07em;line-height:1.1;text-transform:uppercase;}
        .honors-period{margin-top:6px;color:var(--honors-red);font-weight:800;font-size:14pt;letter-spacing:.07em;line-height:1;text-transform:uppercase;}
        .honors-scope-meta{display:flex;justify-content:center;align-items:baseline;gap:10px;margin-top:6px;line-height:1.1;}
        .honors-grade{font-size:14pt;font-weight:800;letter-spacing:.08em;text-transform:uppercase;}
        .honors-section{color:#374151;font-size:11pt;font-weight:700;letter-spacing:.03em;}
        .honors-table-meta{margin:.14in 0 .07in;text-align:right;color:#1f2937;font-size:10.5pt;font-weight:700;letter-spacing:.05em;}
        .honors-table-frame{width:100%;}
        .honors-print-table{width:100%;border-collapse:collapse;table-layout:fixed;border:1.5px solid var(--honors-line);color:var(--honors-ink);font-size:11pt;}
        .honors-print-table th{height:.4in;background:var(--honors-head);border:1.5px solid var(--honors-line);padding:0 10px;font-size:10.5pt;font-weight:800;letter-spacing:.06em;text-align:left;text-transform:uppercase;}
        .honors-print-table td{height:calc((var(--honors-paper-height) - 6.4in) / 12);border:1.5px solid var(--honors-line);padding:0 10px;vertical-align:middle;line-height:1.2;}
        .honors-print-table .rank{width:.7in;text-align:center;font-weight:700;}
        .honors-print-table .name{text-align:left;}
        .honors-print-table .average{width:1.3in;text-align:center;}
        .honors-print-table .honor{width:1.95in;text-align:center;}
        .honors-print-table--with-section .section{width:1.25in;text-align:center;}
        .honors-print-table .name > div:first-child{font-size:11.5pt;font-weight:800;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .honors-learner-lrn{display:block;margin-top:3px;color:#4b5a73;font-size:8.5pt;font-weight:700;letter-spacing:.02em;}
        .honors-print-empty-row td{color:transparent;}
        .honors-print-signatures{position:absolute;left:.5in;right:.5in;bottom:.16in;display:grid;grid-template-columns:1fr 1fr;column-gap:.7in;padding:0 .1in;}
        .honors-signature-name{height:.6in;display:flex;align-items:flex-end;justify-content:center;padding-bottom:3px;text-align:center;font-weight:800;font-size:11pt;letter-spacing:.03em;text-transform:uppercase;}
        .honors-signature-line{border-top:1.3px solid var(--honors-line);}
        .honors-signature-title{margin-top:4px;text-align:center;font-size:10pt;font-weight:700;}
        .honors-no-qualifiers{padding:18px;text-align:center;font-style:italic;}
        @media print{
            .honors-print-pages{display:block;}
            .honors-print-sheet{box-shadow:none;break-inside:avoid;page-break-inside:avoid;margin:0;}
            .honors-print-table tr{break-inside:avoid;page-break-inside:avoid;}
        }
    `;
}

function buildPrintArea(data, options = {}) {
    const section = data?.section || {};
    const honorees = Array.isArray(data?.honorees) ? data.honorees : [];
    const ranks = getHonorsDenseRanks(honorees);
    const showSectionColumn = isHonorsYearLevelScope(data);
    const learnersPerPage = 12;
    const totalPages = Math.max(1, Math.ceil(honorees.length / learnersPerPage));
    const preparedByName = String(options.preparedByName || state.currentUserName || '').trim() || '—';
    const schoolHeadName = String(options.schoolHeadName || state.schoolHeadName || '').trim() || '—';

    const periodDisplay = getHonorsPeriodDisplay(data);
    const gradeLabel = String(section.grade_name || '—').toUpperCase();
    const sectionLabel = String(section.section_name || '').trim();
    const scopeMetaHtml = `
        <div class="honors-scope-meta">
            <strong class="honors-grade">${escapeHtml(gradeLabel)}</strong>
            ${!showSectionColumn && sectionLabel ? `<span class="honors-section">${escapeHtml(sectionLabel)}</span>` : ''}
        </div>`;

    const appBase = (typeof window !== 'undefined' && window.APP_BASE) ? String(window.APP_BASE) : '';
    const leftLogoUrl = options.leftLogoUrl || `${appBase}/assets/img/logo/Seal_of_the_Department_of_Education_of_the_Philippines.png`;
    const rightLogoUrl = options.rightLogoUrl || `${appBase}/assets/img/logo/logo.png`;

    const buildTableHtml = (pageRows, rankOffset) => {
        const thead = `
            <thead>
                <tr>
                    <th class="rank">Rank</th>
                    <th class="name">Name</th>
                    ${showSectionColumn ? '<th class="section">Section</th>' : ''}
                    <th class="average">Rating</th>
                    <th class="honor">Honor</th>
                </tr>
            </thead>`;

        const rows = pageRows.map((h, i) => {
            return `
                <tr>
                    <td class="rank">${ranks[rankOffset + i] ?? rankOffset + i + 1}</td>
                    <td class="name">
                        <div>${escapeHtml(formatLearnerNameForTable(h.learner_name || ''))}</div>
                        <div class="honors-learner-lrn">LRN: ${escapeHtml(h.lrn || '—')}</div>
                    </td>
                    ${showSectionColumn ? `<td class="section">${escapeHtml(h.section_name || '—')}</td>` : ''}
                    <td class="average">${fmt2(h.general_average)}</td>
                    <td class="honor">${escapeHtml(h.honor?.honor_name || '')}</td>
                </tr>`;
        });

        while (rows.length < learnersPerPage) {
            rows.push(`
                <tr class="honors-print-empty-row" aria-hidden="true">
                    <td class="rank">&nbsp;</td>
                    <td class="name">&nbsp;</td>
                    ${showSectionColumn ? '<td class="section">&nbsp;</td>' : ''}
                    <td class="average">&nbsp;</td>
                    <td class="honor">&nbsp;</td>
                </tr>`);
        }

        return `<table class="honors-print-table${showSectionColumn ? ' honors-print-table--with-section' : ''}">${thead}<tbody>${rows.join('')}</tbody></table>`;
    };

    const signaturesHtml = `
        <div class="honors-print-signatures">
            <div>
                <div class="honors-signature-name">${escapeHtml(preparedByName)}</div>
                <div class="honors-signature-line"></div>
                <div class="honors-signature-title">Prepared by</div>
            </div>
            <div>
                <div class="honors-signature-name">${escapeHtml(schoolHeadName)}</div>
                <div class="honors-signature-line"></div>
                <div class="honors-signature-title">School Head</div>
            </div>
        </div>`;

    const buildPageHtml = (pageIndex) => {
        const pageRows = honorees.slice(pageIndex * learnersPerPage, (pageIndex + 1) * learnersPerPage);
        const tableHtml = honorees.length
            ? buildTableHtml(pageRows, pageIndex * learnersPerPage)
            : '<div class="honors-no-qualifiers">No honor qualifiers.</div>';

        return `
            <article class="honors-print-sheet">
                <div class="honors-print-frame">
                    <header class="honors-print-header">
                        <div class="honors-print-logo">
                            <img src="${escapeHtml(leftLogoUrl)}" alt="DepEd Seal" />
                        </div>
                        <div class="honors-print-title">
                            <div class="honors-government">Republic of the Philippines<br>Department of Education</div>
                            <div class="honors-system">G.Pelaez Integrated School</div>
                            <div class="honors-congrats">Congratulations</div>
                            <div class="honors-list-title">Honors List</div>
                            <div class="honors-period">${escapeHtml(periodDisplay)}</div>
                            ${scopeMetaHtml}
                        </div>
                        <div class="honors-print-logo honors-print-logo--right">
                            <img src="${escapeHtml(rightLogoUrl)}" alt="School logo" />
                        </div>
                    </header>

                    <div class="honors-table-meta">SY: ${escapeHtml(section.year_label || '—')}</div>
                    <section class="honors-table-frame" aria-label="Honors ranking">${tableHtml}</section>
                    ${signaturesHtml}
                </div>
            </article>`;
    };

    return `<div class="honors-print-pages">${Array.from({ length: totalPages }, (_, pageIndex) => buildPageHtml(pageIndex)).join('')}</div>`;
}

async function loadUserRole() {
    try {
        const resp = await axios.get(`${API_BASE_URL}/auth/me.php`, { withCredentials: true });
        if (resp.data?.success) {
            const me = resp.data.data || {};
            state.userRole = me?.role_id ?? null;
            state.roleKey = String(me?.role_key || '');
            state.privileges = me?.privileges || {};
            state.isRegistrar = !!me?.is_registrar;
            state.isAdviser = !!me?.is_adviser;
            state.isAdmin = Number(me?.role_id || 0) === 8 || String(me?.role_key || '').toLowerCase() === 'admin';
            state.canEdit = (state.roleKey === 'teacher' || Number(state.userRole) === 9);
            state.currentUserName = String(
                me?.full_name || `${me?.first_name || ''} ${me?.last_name || ''}`.trim() || me?.username || ''
            ).trim();
        }
    } catch (e) {
        console.error('Failed to load user role:', e);
    }

    try {
        const [principalResult] = await Promise.allSettled([
            axios.get(`${API_BASE_URL}/employees/employees.php`, {
                params: { operation: 'getActivePrincipal', _: Date.now() },
                withCredentials: true,
            }),
        ]);
        // The signature must come from the one active employee account whose
        // work-position text is Principal; settings are not a second source.
        state.schoolHeadName = '';
        if (principalResult.status === 'fulfilled') {
            const principal = principalResult.value.data?.data || principalResult.value.data;
            if (principal && typeof principal === 'object') {
                state.schoolHeadName = String(
                    principal.full_name || `${principal.first_name || ''} ${principal.last_name || ''}`.trim()
                ).trim();
            }
        }
    } catch (e) {
        console.error('Failed to load school head setting:', e);
    }
}

function downloadTextFile(filename, text, mime = 'text/csv;charset=utf-8;') {
    const blob = new Blob(["\uFEFF" + text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function downloadBlobFile(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Failed to read blob'));
        reader.onload = () => resolve(String(reader.result || ''));
        reader.readAsDataURL(blob);
    });
}

async function tryFetchAsDataUrl(url) {
    try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return null;
        const blob = await res.blob();
        return await blobToDataUrl(blob);
    } catch (_) {
        return null;
    }
}

function buildHonorsExportHtmlDocument(data, options = {}) {
    const content = buildPrintArea(data, options);

    // Minimal CSS variables so the print document preserves the in-app template.
    const style = `
        :root{
            --gray-900:#111827;
            --gray-600:#4B5563;
        }
        ${getHonorsPrintStyles()}
        *{box-sizing:border-box;}
        html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
        body{font-family:Arial,Helvetica,sans-serif;color:var(--gray-900);}
        img{display:block;}
        table{width:100%;border-collapse:collapse;}
        thead{display:table-header-group;}
        tr{break-inside:avoid;page-break-inside:avoid;}
        @media screen{
            html,body{background:#e3e8ee;}
            body{padding:18px;}
        }
        @media print{
            @page{size:letter portrait;margin:0;}
            body{margin:0;padding:0;}
            a[href]::after{content:"";}
        }
    `;

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.5, maximum-scale=5, user-scalable=yes" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=UnifrakturCook:wght@700&display=swap" rel="stylesheet" />
  <title>${escapeHtml(getHonorsExportTitle(data))}</title>
  <style>${style}</style>
</head>
<body>
  ${content}
</body>
</html>`;
}

async function waitForPrintAreaImages(container, timeoutMs = 5000) {
    const images = Array.from(container?.querySelectorAll?.('img') || []);
    if (!images.length) return;

    const start = Date.now();
    await Promise.all(images.map((img) => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise((resolve) => {
            const done = () => resolve();
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
            const poll = () => {
                if ((img.complete && img.naturalWidth > 0) || (Date.now() - start) > timeoutMs) {
                    resolve();
                    return;
                }
                setTimeout(poll, 120);
            };
            poll();
        });
    }));
}

function openHonorsPrintPreview() {
    const modal = el('honorsPrintModal');
    if (!modal) return;
    modal.classList.add('show');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    const frame = el('honorsPrintFrame');
    window.refitPrintPreviewFrame?.(frame, frame?.dataset?.printPreviewItems);
}

function closeHonorsPrintPreview() {
    const modal = el('honorsPrintModal');
    const frame = el('honorsPrintFrame');
    modal?.classList.remove('show', 'active');
    if (modal) modal.style.display = '';
    modal?.setAttribute('aria-hidden', 'true');
    if (frame) {
        frame.onload = null;
        frame.srcdoc = '';
    }
}

function printHonorsPreview() {
    const frame = el('honorsPrintFrame');
    if (!frame?.contentWindow) return;
    frame.contentWindow.focus();
    frame.contentWindow.print();
}

async function generateHonorsPreview() {
    const button = el('btnHonExport');
    const originalButtonHtml = button?.innerHTML || '';
    if (button) {
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading preview';
    }

    try {
        if (!state.honorsData) {
            const ok = await loadHonors({ requireReady: true });
            if (!ok) return;
        }

        const data = state.honorsData;
        const honorees = Array.isArray(data?.honorees) ? data.honorees : [];
        if (!honorees.length) {
            await toast('info', 'No honor qualifiers to preview');
            return;
        }

        const appBase = (typeof window !== 'undefined' && window.APP_BASE) ? String(window.APP_BASE) : '';
        const leftPath = `${appBase}/assets/img/logo/Seal_of_the_Department_of_Education_of_the_Philippines.png`;
        const rightPath = `${appBase}/assets/img/logo/logo.png`;
        const leftAbs = new URL(leftPath, window.location.origin).toString();
        const rightAbs = new URL(rightPath, window.location.origin).toString();
        const [leftDataUrl, rightDataUrl] = await Promise.all([
            tryFetchAsDataUrl(leftAbs),
            tryFetchAsDataUrl(rightAbs),
        ]);

        const frame = el('honorsPrintFrame');
        if (!frame) throw new Error('Honors preview frame is missing');
        frame.srcdoc = buildHonorsExportHtmlDocument(data, {
            leftLogoUrl: leftDataUrl || leftAbs,
            rightLogoUrl: rightDataUrl || rightAbs,
            preparedByName: state.currentUserName,
            schoolHeadName: state.schoolHeadName,
        });
        openHonorsPrintPreview();
    } finally {
        if (button) {
            button.disabled = false;
            button.innerHTML = originalButtonHtml || '<i class="fas fa-file-alt"></i> Generate Preview';
        }
    }
}

function getHonorsExportTitle(data) {
    const section = data?.section || {};
    const scopeLabel = isHonorsYearLevelScope(data)
        ? section.grade_name
        : section.section_name;
    return [`${getHonorsPeriodDisplay(data)} Honors List`, scopeLabel].filter(Boolean).join(' - ') || 'Honors List';
}

async function printHonorsExport() {
    return generateHonorsPreview();
}


async function loadHonors(options = {}) {
    const requireReady = Boolean(options.requireReady);
    const mode = String(el('selHonMode').value || 'quarter');

    const scope = String(el('selHonScope')?.value || 'section');
    const isGrade = scope === 'grade';

    let params;
    if (isGrade) {
        const sy = Number(el('selHonSchoolYear')?.value || 0);
        const gl = Number(el('selHonGradeLevel')?.value || 0);
        if (!sy || !gl) {
            const mh = el('metricsHonors'); if (mh) mh.innerHTML = '';
            renderHonorsSelectionPrompt('Please select a school year and year level from the dropdowns to load the ranking.');
            state.honorsData = null;
            const pa = el('cr-print-area'); if (pa) pa.innerHTML = '';
            if (requireReady) await toast('warning', 'Select school year and year level first');
            return false;
        }
        params = { operation: 'getHonorsListByGradeLevel', school_year_id: sy, grade_level_id: gl, mode };
    } else {
        const sectionId = Number(el('selHonSection').value || 0);
        if (!sectionId) {
            const mh = el('metricsHonors'); if (mh) mh.innerHTML = '';
            renderHonorsSelectionPrompt();
            state.honorsData = null;
            const pa = el('cr-print-area'); if (pa) pa.innerHTML = '';
            if (requireReady) await toast('warning', 'Select section first');
            return false;
        }
        params = { operation: 'getHonorsList', section_id: sectionId, mode };
    }

    if (mode === 'quarter') {
        const gpId = Number(el('selHonPeriod').value || 0);
        if (!gpId) {
            const mh = el('metricsHonors'); if (mh) mh.innerHTML = '';
            renderHonorsSelectionPrompt('Please select a grading period from the dropdown to load the ranking.');
            state.honorsData = null;
            const pa = el('cr-print-area'); if (pa) pa.innerHTML = '';
            if (requireReady) await toast('warning', 'Select grading period');
            return false;
        }
        params = { ...params, grading_period_id: gpId };
    }

    const resp = await apiGet('/class_records/class_records.php', params);
    if (!resp?.success) throw new Error(resp?.message || 'Failed to load honors');

    state.honorsData = resp.data;

    renderHonors(resp.data);

    const printArea = el('cr-print-area');
    printArea.innerHTML = buildPrintArea(resp.data);

    return true;
}

function updateHonorsModeUI() {
    const mode = String(el('selHonMode').value || 'quarter');
    el('wrapHonPeriod').style.display = (mode === 'quarter') ? 'block' : 'none';
}

function updateHonorsScopeUI() {
    const scope = String(el('selHonScope')?.value || 'section');
    const isGrade = scope === 'grade';
    const sectionGroup = el('selHonSection')?.closest('.form-group');
    if (sectionGroup) sectionGroup.style.display = isGrade ? 'none' : 'block';
    const wrapSy = el('wrapHonSchoolYear');
    const wrapGl = el('wrapHonGradeLevel');
    if (wrapSy) wrapSy.style.display = 'block';
    if (wrapGl) wrapGl.style.display = isGrade ? 'block' : 'none';
}

function setGradeActionsMenuOpen(isOpen) {
    const toggle = el('btnGradeActions');
    const dropdown = el('crGradeActionsDropdown');
    if (!toggle || !dropdown) return;
    const open = Boolean(isOpen);
    toggle.setAttribute('aria-expanded', String(open));
    dropdown.classList.toggle('open', open);
    dropdown.setAttribute('aria-hidden', String(!open));
}

function toggleGradeActionsMenu() {
    const toggle = el('btnGradeActions');
    setGradeActionsMenuOpen(toggle?.getAttribute('aria-expanded') !== 'true');
}

async function handleGradeSaveClick() {
    if (state.gradeSaveInFlight) return;
    state.gradeSaveInFlight = true;
    updateGradeEncodingEditability();
    try {
        await saveGrades();
    } catch (error) {
        console.error('[Class Records] Grade save failed:', error);
        await toast('error', apiErrorMessage(error, 'Grade save failed'));
    } finally {
        state.gradeSaveInFlight = false;
        updateGradeEncodingEditability();
    }
}

async function init() {
    setActiveTab('grades');

    await loadUserRole();

    if (!state.canEdit) {
        const btnSave = el('btnSave');
        if (btnSave) btnSave.style.display = 'none';
        const btnFinalize = el('btnFinalize');
        if (btnFinalize) {
            btnFinalize.disabled = true;
            btnFinalize.title = 'Only assigned teachers can finalize grades';
        }
    }
    if (!canUseTeacherRecordControls()) {
        ['crGradeActionsMenu', 'btnDownloadGradeTemplate', 'btnImportGrades', 'btnApplyObservedBulk', 'btnCopyObservedPrevious', 'btnSaveObserved']
            .forEach((id) => {
                const button = el(id);
                if (button) button.style.display = 'none';
            });
    }
    updatePeriodStatusControl();
    installUnsavedGradeLeaveGuard();

    el('tabBtnGrades').addEventListener('click', async () => {
        if (state.activeTab === 'grades') return;
        if (await confirmDiscardUnsavedGrades()) {
            if (hasUnsavedChanges()) resetUnsavedChanges();
            setActiveTab('grades');
            const load = state.activeTab === 'pace' ? loadPaceLearner() : loadRoster();
            load.catch((e) => toast('error', apiErrorMessage(e, 'Failed to load grade input')));
        }
    });
    el('tabBtnPace')?.addEventListener('click', async () => {
        if (state.activeTab === 'pace') return;
        if (!(await confirmDiscardUnsavedGrades())) return;
        if (hasUnsavedChanges()) resetUnsavedChanges();
        setActiveTab('pace');
        loadPaceRoster().catch((e) => toast('error', apiErrorMessage(e, 'Failed to load Grade 1 PACE form')));
    });
    el('tabBtnObserved')?.addEventListener('click', async () => {
        if (!(await confirmDiscardUnsavedGrades())) return;
        if (hasUnsavedChanges()) resetUnsavedChanges();
        setActiveTab('observed');
        const meta = getSectionMeta(
            Number(el('selSection')?.value || 0),
            Number(el('selClassRecordSchoolYear')?.value || state.selectedSchoolYearId || 0)
        );
        if (meta?.school_year_id) updateObservedPeriodSelectForSchoolYear(meta.school_year_id, Number(el('selPeriod')?.value || 0));
        loadObservedValues().catch((e) => {
            console.error(e);
            toast('error', apiErrorMessage(e, 'Failed to load observed values'));
        });
    });
    el('tabBtnHonors').addEventListener('click', async () => {
        if (!(await confirmDiscardUnsavedGrades())) return;
        if (hasUnsavedChanges()) resetUnsavedChanges();
        setActiveTab('honors');
        loadHonors().catch((e) => {
            console.error(e);
            toast('error', apiErrorMessage(e, 'Failed to load honors'));
        });
    });

    await loadGradingPeriods();
    await loadClassOfferings();
    bindGradeSheetScrollCue();
    bindObservedTableScrollCue();

    // Default to the teacher's assigned section (latest SY) and load its roster.
    await applyInitialGradeEncodingSelection();
    scheduleClassRecordDropdownEnhancement();

    bindSelectChangeWithGradeGuard(el('selClassRecordSchoolYear'), async () => {
        const syId = Number(el('selClassRecordSchoolYear')?.value || 0);
        const defaultSectionId = pickDefaultSectionId(null, null, syId);
        const defaultGradeLevelId = defaultSectionId ? getSectionMeta(defaultSectionId, syId)?.grade_level_id : null;
        renderClassRecordGradeLevelSelect(defaultGradeLevelId);
        renderClassRecordSectionSelect(defaultSectionId);
        await handleClassRecordSectionChange().catch((e) => toast('error', apiErrorMessage(e, 'Failed to load school year sections')));
    });

    bindSelectChangeWithGradeGuard(el('selGradeLevel'), async () => {
        renderClassRecordSectionSelect();
        await handleClassRecordSectionChange().catch((e) => toast('error', apiErrorMessage(e, 'Failed to load year level sections')));
    });

    bindSelectChangeWithGradeGuard(el('selSection'), async () => {
        await handleClassRecordSectionChange().catch((e) => toast('error', apiErrorMessage(e, 'Failed to load section')));
    });

    bindSelectChangeWithGradeGuard(el('selSubject'), async () => {
        await loadRoster().catch((e) => toast('error', apiErrorMessage(e, 'Failed')));
    });
    bindSelectChangeWithGradeGuard(el('selPeriod'), async () => {
        updatePeriodStatusControl();
        updateGradeEncodingEditability();
        const gpId = Number(el('selPeriod')?.value || 0);
        syncPacePeriodSelect(gpId ? String(gpId) : '');
        if (gpId && el('selObservedPeriod') && selectHasValue(el('selObservedPeriod'), gpId)) {
            el('selObservedPeriod').value = String(gpId);
        }
        const load = state.activeTab === 'pace' ? loadPaceLearner() : loadRoster();
        await load.catch((e) => toast('error', apiErrorMessage(e, 'Failed to load selected term')));
    });
    bindSelectChangeWithGradeGuard(el('selPacePeriod'), async () => {
        const selectedPeriodId = String(el('selPacePeriod')?.value || '');
        if (selectHasValue(el('selPeriod'), selectedPeriodId)) el('selPeriod').value = selectedPeriodId;
        const numericPeriodId = Number(selectedPeriodId || 0);
        if (numericPeriodId && selectHasValue(el('selObservedPeriod'), numericPeriodId)) {
            el('selObservedPeriod').value = String(numericPeriodId);
        }
        updatePeriodStatusControl();
        updateGradeEncodingEditability();
        await loadPaceLearner().catch((e) => toast('error', apiErrorMessage(e, 'Failed to load selected term')));
    });
    bindSelectChangeWithGradeGuard(el('selPaceLearner'), async () => {
        await loadPaceLearner().catch((e) => toast('error', apiErrorMessage(e, 'Failed to load selected learner')));
    });
    el('btnSavePaceRatings')?.addEventListener('click', () => {
        savePaceRatings();
    });
    bindSelectChangeWithGradeGuard(el('selObservedPeriod'), async () => {
        await loadObservedValues().catch((e) => toast('error', apiErrorMessage(e, 'Failed to load observed values')));
    });

    el('btnTogglePeriodStatus')?.addEventListener('click', async () => {
        if (!(await confirmDiscardUnsavedGrades())) return;
        if (hasUnsavedChanges()) resetUnsavedChanges();
        toggleSelectedPeriodStatus().catch((e) => toast('error', apiErrorMessage(e, 'Failed to update period status')));
    });

    el('btnGradeActions')?.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleGradeActionsMenu();
    });
    document.addEventListener('click', (event) => {
        if (!event.target?.closest?.('#crGradeActionsMenu')) setGradeActionsMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setGradeActionsMenuOpen(false);
    });

    el('btnDownloadGradeTemplate')?.addEventListener('click', () => {
        setGradeActionsMenuOpen(false);
        downloadGradeImportTemplate().catch((e) => {
            console.error(e);
            toast('error', apiErrorMessage(e, 'Unable to download template'));
        });
    });

    el('btnImportGrades')?.addEventListener('click', async () => {
        setGradeActionsMenuOpen(false);
        if (!(await confirmDiscardUnsavedGrades())) return;
        if (hasUnsavedChanges()) resetUnsavedChanges();
        const input = el('gradeImportFile');
        if (!input) return;
        input.value = '';
        input.click();
    });

    el('gradeImportFile')?.addEventListener('change', () => {
        const file = el('gradeImportFile')?.files?.[0] || null;
        handleGradeImportFile(file).catch((e) => {
            console.error(e);
            toast('error', apiErrorMessage(e, 'Import failed'));
        });
    });

    // Search input for roster filtering
    const rosterSearch = el('cr-roster-search');
    if (rosterSearch) {
        rosterSearch.addEventListener('input', () => {
            if (isAllPeriodsMode()) renderAllPeriodsSummaryTable();
            else renderRosterTable();
        });
    }
    const observedSearch = el('cr-observed-search');
    if (observedSearch) {
        observedSearch.addEventListener('input', () => renderObservedValuesTable());
    }
    document.querySelectorAll('[data-cr-roster-gender]').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.rosterGenderFilter = String(btn.getAttribute('data-cr-roster-gender') || 'all').toLowerCase();
            if (isAllPeriodsMode()) renderAllPeriodsSummaryTable();
            else renderRosterTable();
        });
    });
    document.querySelectorAll('[data-cr-observed-gender]').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.observedGenderFilter = String(btn.getAttribute('data-cr-observed-gender') || 'all').toLowerCase();
            renderObservedValuesTable();
        });
    });

    el('btnApplyObservedBulk')?.addEventListener('click', () => applyObservedBulk());
    el('btnCopyObservedPrevious')?.addEventListener('click', () => {
        copyObservedFromPrevious().catch((e) => {
            console.error(e);
            toast('error', apiErrorMessage(e, 'Copy failed'));
        });
    });

    // Reload button removed from UI.
    el('btnSave').addEventListener('click', () => {
        handleGradeSaveClick();
    });
    el('btnSaveObserved')?.addEventListener('click', () => saveObservedValues().catch((e) => {
        console.error(e);
        toast('error', apiErrorMessage(e, 'Save failed'));
    }));


    // Honors controls
    el('selHonScope')?.addEventListener('change', () => {
        updateHonorsScopeUI();
        const sy = Number(el('selHonSchoolYear')?.value || 0);
        updateHonorsSectionSelectForSchoolYear(sy);
        updateHonorsGradeLevelSelectForSchoolYear(sy);

        if (sy) {
            updatePeriodsSelectForSchoolYear(sy, el('selHonPeriod'));
            if (el('selHonPeriod').options.length > 1) el('selHonPeriod').selectedIndex = 1;
        }

        loadHonors().catch((e) => toast('error', apiErrorMessage(e, 'Failed')));
    });

    el('selHonSection').addEventListener('change', () => {
        const sectionId = Number(el('selHonSection').value || 0);
        if (!sectionId) return;
        const meta = getSectionMeta(sectionId, Number(el('selHonSchoolYear')?.value || 0));
        if (meta) {
            updatePeriodsSelectForSchoolYear(meta.school_year_id, el('selHonPeriod'));
            if (el('selHonPeriod').options.length > 1) el('selHonPeriod').selectedIndex = 1;
        }
        loadHonors().catch((e) => toast('error', apiErrorMessage(e, 'Failed')));
    });

    el('selHonSchoolYear')?.addEventListener('change', () => {
        const sy = Number(el('selHonSchoolYear')?.value || 0);
        const sectionId = Number(el('selHonSection')?.value || 0);
        const gradeLevelId = Number(el('selHonGradeLevel')?.value || 0);
        updateHonorsSectionSelectForSchoolYear(sy, sectionId);
        updateHonorsGradeLevelSelectForSchoolYear(sy, gradeLevelId);
        if (sy) {
            updatePeriodsSelectForSchoolYear(sy, el('selHonPeriod'));
            if (el('selHonPeriod').options.length > 1) el('selHonPeriod').selectedIndex = 1;
        }
        loadHonors().catch((e) => toast('error', apiErrorMessage(e, 'Failed')));
    });

    el('selHonGradeLevel')?.addEventListener('change', () => loadHonors().catch((e) => toast('error', apiErrorMessage(e, 'Failed'))));

    el('selHonMode').addEventListener('change', () => {
        updateHonorsModeUI();
        loadHonors().catch((e) => toast('error', apiErrorMessage(e, 'Failed')));
    });

    el('selHonPeriod').addEventListener('change', () => loadHonors().catch((e) => toast('error', apiErrorMessage(e, 'Failed'))));

    el('btnHonExport')?.addEventListener('click', () => {
        const scope = String(el('selHonScope')?.value || 'section');
        const isGradeLevel = scope === 'grade';
        const canExportYearLevel = !!(state?.privileges && state.privileges.can_export_honors_year_level);
        const isAdmin = Number(state.userRole || 0) === 8 || String(state.roleKey || '').toLowerCase() === 'admin';

        if (isGradeLevel && !(canExportYearLevel || isAdmin)) {
            toast('error', 'Export for year level is restricted to admins, registrars, and advisors only.');
            return;
        }

        generateHonorsPreview().catch((e) => {
            console.error(e);
            toast('error', apiErrorMessage(e, 'Unable to generate honors preview'));
        });
    });

    el('btnHonPrint')?.addEventListener('click', async () => {
        generateHonorsPreview().catch((e) => {
            console.error(e);
            toast('error', apiErrorMessage(e, 'Unable to generate honors preview'));
        });
    });

    el('btnCloseHonorsPrintPreview')?.addEventListener('click', closeHonorsPrintPreview);
    el('btnCloseHonorsPrintPreviewFooter')?.addEventListener('click', closeHonorsPrintPreview);
    el('btnPrintHonorsPreview')?.addEventListener('click', printHonorsPreview);
    el('honorsPrintModal')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) closeHonorsPrintPreview();
    });

    updateHonorsModeUI();
    updateHonorsScopeUI();
    startPeriodStatusSync();
}

document.addEventListener('DOMContentLoaded', () => {
    init().catch((e) => {
        console.error(e);
        toast('error', apiErrorMessage(e, 'Failed to initialize'));
    });
});
